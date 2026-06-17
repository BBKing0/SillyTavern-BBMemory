/**
 * memory-maintainer.js —— BB-Memory v5.0 记忆维护系统
 *
 * 双区结构：待维护 + 已维护（7天后自动清空）。
 * 阈值触发提醒，用户主导裁决，与升降格系统联动。
 */

import {
    getSettings, updateSettings,
    getNpcProfiles, getItems, getTimeline, getMemories,
    updateNpcProfile, updateItem, updateTimelineEntry, updateMemory,
    removeNpcProfile, removeItem, removeTimelineEntry, removeMemory,
    getTimelineThreads, saveTimelineThreads,
    getCalendarDescription,
} from './memory-store.js';
import { callCustomApi, callMainApi } from './auto-generator.js';
import {
    DEFAULT_CONCRETE_TIME_RULE,
    DEFAULT_THREAD_SUMMARY_PROMPT,
    fillPromptTemplate,
    getPromptTemplate,
} from './prompt-templates.js';

// ═══════════════════════════════════════════════════════════
//  维护状态
// ═══════════════════════════════════════════════════════════

export const MEMORY_STATUS = Object.freeze({
    active:    { id: 'active',    label: '正常', icon: 'fa-solid fa-check',       color: '#4caf50' },
    transient: { id: 'transient', label: '瞬时', icon: 'fa-solid fa-seedling',    color: '#81c784' },
    stable:    { id: 'stable',    label: '稳定', icon: 'fa-solid fa-shield',      color: '#2196f3' },
    core:      { id: 'core',      label: '核心', icon: 'fa-solid fa-star',        color: '#ff9800' },
    eternal:   { id: 'eternal',   label: '永恒', icon: 'fa-solid fa-crown',       color: '#e91e63' },
    archived:  { id: 'archived',  label: '归档', icon: 'fa-solid fa-box-archive', color: '#9e9e9e' },
});

let maintenanceCache = {};

function getCache(chatId) {
    if (!maintenanceCache[chatId]) {
        maintenanceCache[chatId] = { pending: [], resolved: [], lastCheck: 0 };
    }
    return maintenanceCache[chatId];
}

function cleanResolved(cache) {
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    cache.resolved = cache.resolved.filter(r => (now - r.resolvedAt) < sevenDays);
}

// ═══════════════════════════════════════════════════════════
//  静默自动维护（auto/semi 模式用）
// ═══════════════════════════════════════════════════════════

export async function autoMaintainSilent(chatId) {
    const settings = getSettings();
    if (settings.maintenanceMode === 'manual') return { actions: 0, details: [] };

    const now = Date.now();
    const roundMs = 60 * 1000;
    const results = { actions: 0, details: [] };
    const log = (msg) => { results.details.push(msg); results.actions++; };

    // 1. 自动降级状态变更物品
    const items = await getItems(chatId);
    for (const item of items) {
        if (item.keepPermanent || item.itemTier === 'background') continue;
        if (item.status === 'used' || item.status === 'lost' || item.status === 'destroyed') {
            await updateItem(chatId, item.id, { itemTier: 'background' });
            if (settings.debugLogging) log(`降级物品: ${(item.name || item.id).slice(0, 30)}`);
        }
    }

    // 2. 自动压缩已结束的时间线
    const timeline = await getTimeline(chatId);
    for (const t of timeline) {
        if (t.memoryTier === 'eternal' || t.isActive || t.status === 'ongoing') continue;
        const roundsSinceEnd = Math.floor((now - t.updatedAt) / roundMs);
        if (roundsSinceEnd >= 60) {
            await updateTimelineEntry(chatId, t.id, { isActive: false, status: 'ended' });
            if (settings.debugLogging) log(`压缩时间线: ${(t.event || t.id).slice(0, 30)}`);
        }
    }

    return results;
}

// ═══════════════════════════════════════════════════════════
//  触发检查
// ═══════════════════════════════════════════════════════════

export async function checkMaintenanceNeeded(chatId) {
    const settings = getSettings();
    const cache = getCache(chatId);
    cleanResolved(cache);

    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);

    const issues = [];
    const now = Date.now();
    const roundMs = 60 * 1000;

    // 1. 瞬时记忆（长期未命中）
    for (const m of memories) {
        if (m.memoryTier !== 'transient') continue;
        const lastHit = m.lastHitAt || m.createdAt;
        if ((now - lastHit) / roundMs < 30) continue;
        issues.push({
            type: 'idle_transient_memory', collection: 'mem', item: m,
            reason: `${m.title || '无标题'} — 长期未命中（${Math.floor((now - (m.lastHitAt || m.createdAt)) / roundMs)}轮）`,
            severity: 'info',
        });
    }

    // 2. 状态变更物品（排除永久保留）
    for (const item of items) {
        if (item.status === 'held' || item.keepPermanent) continue;
        issues.push({
            type: 'status_changed_item', collection: 'item', item,
            reason: `${item.name} — 状态：${item.status}${item.keepPermanent ? '（永久保留）' : ''}`,
            severity: 'warning',
        });
    }

    // 3. 可压缩时间线
    for (const t of timeline) {
        if (t.isActive || t.status === 'ongoing') continue;
        if (t.memoryTier === 'eternal') continue;
        issues.push({
            type: 'compressible_timeline', collection: 'timeline', item: t,
            reason: `${t.event} — 已结束，可压缩归档`,
            severity: 'info',
        });
    }

    // 4. 低 tier NPC
    for (const n of npc) {
        if (n.memoryTier === 'eternal') continue;
        if (n.npcTier === 'background' || (n.npcTier === 'minor' && n.memoryTier === 'transient')) {
            issues.push({
                type: 'low_tier_npc', collection: 'npc', item: n,
                reason: `${n.name} — ${n.npcTier}级角色`,
                severity: 'info',
            });
        }
    }

    // 5. 伏笔
    for (const t of timeline) {
        if (t.status !== 'foreshadow') continue;
        issues.push({
            type: 'foreshadow', collection: 'timeline', item: t,
            reason: `${t.event} — 待确认伏笔`,
            severity: 'info',
        });
    }

    cache.pending = issues;
    cache.lastCheck = now;

    const thresholdNpc = settings.maintenanceNpcThreshold || 5;
    const thresholdItem = settings.maintenanceItemThreshold || 20;
    const thresholdMem = settings.maintenanceMemThreshold || 20;
    const totalCount = npc.length + items.length + timeline.length + memories.length;

    const needsReminder = issues.length > 0 && (
        npc.length >= thresholdNpc || items.length >= thresholdItem ||
        memories.length >= thresholdMem || issues.some(i => i.severity === 'warning')
    );

    return {
        needed: needsReminder,
        totalItems: totalCount,
        issueCount: issues.length,
        issues,
        stats: { npc: npc.length, items: items.length, timeline: timeline.length, memories: memories.length },
    };
}

// ═══════════════════════════════════════════════════════════
//  维护操作
// ═══════════════════════════════════════════════════════════

const loadFns = { npc: getNpcProfiles, item: getItems, timeline: getTimeline, mem: getMemories };
const updateFns = { npc: updateNpcProfile, item: updateItem, timeline: updateTimelineEntry, mem: updateMemory };
const removeFns = { npc: removeNpcProfile, item: removeItem, timeline: removeTimelineEntry, mem: removeMemory };

export async function performMaintenance(chatId, actions) {
    const cache = getCache(chatId);
    const results = { kept: 0, deleted: 0, promoted: 0, demoted: 0, compressed: 0 };

    for (const action of actions) {
        const { collection, id, op } = action;
        const updateFn = updateFns[collection];
        const removeFn = removeFns[collection];
        const loadFn = loadFns[collection];

        switch (op) {
            case 'keep':
                await updateFn(chatId, id, { lastHitAt: Date.now() });
                results.kept++;
                break;
            case 'delete':
                await removeFn(chatId, id);
                results.deleted++;
                break;
            case 'promote': {
                const items = await loadFn(chatId);
                const entry = items.find(e => e.id === id);
                if (entry) {
                    const tiers = ['transient', 'stable', 'core', 'eternal'];
                    const idx = tiers.indexOf(entry.memoryTier || 'transient');
                    await updateFn(chatId, id, { memoryTier: tiers[Math.min(idx + 1, 3)], lastHitAt: Date.now() });
                    results.promoted++;
                }
                break;
            }
            case 'demote': {
                const items = await loadFn(chatId);
                const entry = items.find(e => e.id === id);
                if (entry) {
                    const tiers = ['transient', 'stable', 'core', 'eternal'];
                    const idx = tiers.indexOf(entry.memoryTier || 'transient');
                    await updateFn(chatId, id, { memoryTier: tiers[Math.max(idx - 1, 0)] });
                    results.demoted++;
                }
                break;
            }
            case 'compress_timeline':
                await updateTimelineEntry(chatId, id, {
                    isActive: false, status: 'ended',
                    summary: `[归档] ${(await getTimeline(chatId)).find(t => t.id === id)?.event || ''}: ${(await getTimeline(chatId)).find(t => t.id === id)?.summary || ''}`,
                });
                results.compressed++;
                break;
        }
    }

    const now = Date.now();
    const resultEntry = { resolvedAt: now, actions: actions.length, results: { ...results } };
    cache.resolved.push(resultEntry);
    const actionIds = new Set(actions.map(a => a.id));
    cache.pending = cache.pending.filter(i => !actionIds.has(i.item.id));
    // Also persist to sessionStorage for the maintenance UI
    addMaintenanceResolved(chatId, resultEntry.results, actions.length);

    return results;
}

// ═══════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
}

export function dismissMaintenanceRemind() {
    updateSettings({ _lastMaintenanceRemind: Date.now() });
}

export async function fuzzyMemory(chatId, memoryId) {
    const updates = { memoryTier: 'transient', hitScore: 0, archived: false, status: 'active' };
    // 若无 summary，从 content 截取前 50 字作为摘要
    const memories = await getMemories(chatId);
    const mem = memories.find(m => m.id === memoryId);
    if (mem && !mem.summary && mem.content) {
        updates.summary = mem.content.slice(0, 50).replace(/\n/g, ' ').trim();
        if (mem.content.length > 50) updates.summary += '…';
    }
    return updateMemory(chatId, memoryId, updates);
}

export async function archiveMemory(chatId, memoryId) {
    return updateMemory(chatId, memoryId, { archived: true, status: 'archived' });
}

export async function restoreMemory(chatId, memoryId) {
    return updateMemory(chatId, memoryId, { archived: false, status: 'active' });
}

// ═══════════════════════════════════════════════════════════
//  v6.7.0 命名线程系统 — 线程总结生成
// ═══════════════════════════════════════════════════════════

/**
 * 从时间线条目重新生成线程总结
 * 读取所有时间线条目 + 现有线程，让 LLM 输出更新后的线程列表
 */
export async function regenerateThreadSummary(chatId, options = {}) {
    const timeline = await getTimeline(chatId);
    const existingThreads = await getTimelineThreads(chatId);
    const settings = getSettings();

    // 将时间线条目按重要性排序：ongoing + foreshadow 优先，ended 次之
    const sorted = [...timeline].sort((a, b) => {
        const scoreA = (a.status === 'ongoing' || a.status === 'foreshadow' ? 2 : a.status === 'ended' ? 1 : 0);
        const scoreB = (b.status === 'ongoing' || b.status === 'foreshadow' ? 2 : b.status === 'ended' ? 1 : 0);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return (b.storyTimeSort ?? 0) - (a.storyTimeSort ?? 0);
    });

    // 取最近的重要条目（最多 30 条，避免 prompt 太长）
    const recentEntries = sorted.slice(0, 30);

    // 构建时间线条目文本
    const entriesText = recentEntries.map((t, i) =>
        `${i + 1}. [${t.storyTime || '?'}] ${t.event} (${t.status || 'ongoing'})\n   ${t.summary}${t.impact ? ' // 影响: ' + t.impact : ''}`
    ).join('\n');

    // 构建已有线程文本
    const threadsText = existingThreads.length > 0
        ? existingThreads.map(t => {
            const entries = (t.entries || []).map(e => `  ${e.period || ''} ${e.event || ''} [${e.status || ''}]`).join('\n');
            return `- [${t.id}] ${t.name} (type:${t.type}, status:${t.status}, priority:${t.priority})${t.parentThreadId ? ', parent:' + t.parentThreadId : ''}\n${entries || '  (无条目)'}`;
        }).join('\n')
        : '(无已有线程)';

    const maxActive = options.maxActiveThreads || settings.maxActiveThreads || 5;
    const calDesc2 = (await getCalendarDescription(chatId))?.trim();
    const calRef2 = calDesc2
        ? `\n**世界历法参考**：${calDesc2}\n（仅用于推断和整理故事时间，无需计算天数）\n` : '';

    const prompt = fillPromptTemplate(
        getPromptTemplate(settings, 'maintenance.threadSummary', DEFAULT_THREAD_SUMMARY_PROMPT),
        {
            calRef: calRef2,
            CONCRETE_TIME_RULE: getPromptTemplate(settings, 'extract.concreteTimeRule', DEFAULT_CONCRETE_TIME_RULE),
            entriesText: entriesText || '(无)',
            threadsText,
            maxActive,
        }
    ) || `你是一个故事时间线组织助手。根据时间线条目和已有线程，重新整理故事线程。${calRef2}

═══════════════════════════════════════════════════════
## 时间线条目（按重要性排序）
═══════════════════════════════════════════════════════
${entriesText || '(无)'}

═══════════════════════════════════════════════════════
## 已有线程
═══════════════════════════════════════════════════════
${threadsText}

═══════════════════════════════════════════════════════
## 任务
═══════════════════════════════════════════════════════

根据时间线条目，重新整理为命名线程。每条线程是一个独立的故事线索。

规则：
1. 每个线程有独立的 name（如"第一幕·战前"、"感情线·charA"、"支线·寻找圣剑"）
2. 将相关的时间线条目归入对应线程的 entries 中
3. 合并同类项——时间相近、主题相同的事件合并为一条 entry
4. 保持活跃线程在 ${maxActive} 条以内（resident 不计入）
5. 已结束的线程标记 status:"ended"（不注入，但可被向量检索）
6. 重要的、贯穿始终的线程标记 status:"resident"（永远注入，永不降级）
7. 线程类型 type: plot(主线剧情) / emotional(感情线) / side(支线) / world(世界观)

返回纯JSON对象（不要markdown代码块）：
{"threads":[{"id":"保留已有ID或生成新ID","name":"线程名","type":"plot|emotional|side|world","status":"ongoing|ended|paused|resident","priority":"high|medium|low","parentThreadId":null或父线程ID,"entries":[{"period":"时间区间","event":"事件描述","status":"ongoing|ended|milestone"}]}]}
只输出JSON。`;

    let responseText;
    try {
        if (settings.autoGenMode === 'custom' && settings.autoGenEndpoint) {
            responseText = await callCustomApi(prompt);
        } else {
            responseText = await callMainApi(prompt);
        }
    } catch (e) {
        console.warn('[BB-Memory] 线程总结生成API调用失败:', e.message);
        return { threadCount: 0, error: e.message };
    }

    try {
        let text = responseText.trim();
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            console.warn('[BB-Memory] 线程总结响应未找到JSON');
            return { threadCount: 0, error: 'No JSON found in response' };
        }
        const parsed = JSON.parse(match[0]);
        const newThreads = Array.isArray(parsed.threads) ? parsed.threads : [];

        // 保留已有线程的 id 和 createdAt
        for (const nt of newThreads) {
            const existing = existingThreads.find(t => t.id === nt.id);
            if (existing) {
                nt.createdAt = existing.createdAt;
            }
            nt.updatedAt = Date.now();
        }

        await saveTimelineThreads(chatId, newThreads);
        console.log(`[BB-Memory] 线程总结更新: ${newThreads.length} 条线程`);
        return { threadCount: newThreads.length };
    } catch (e) {
        console.warn('[BB-Memory] 线程总结JSON解析失败:', e.message);
        return { threadCount: 0, error: e.message };
    }
}

// ═══ 已维护记录 ═══

export function getMaintenanceResolved(chatId) {
    const key = `bb_maint_resolved_${chatId}`;
    try {
        const raw = sessionStorage.getItem(key);
        if (!raw) return [];
        const data = JSON.parse(raw);
        // Clean entries older than 7 days
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const fresh = data.filter(e => e.resolvedAt > cutoff);
        if (fresh.length !== data.length) {
            sessionStorage.setItem(key, JSON.stringify(fresh));
        }
        return fresh;
    } catch { return []; }
}

export function clearMaintenanceResolved(chatId) {
    const key = `bb_maint_resolved_${chatId}`;
    try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}

export function addMaintenanceResolved(chatId, results, actionsCount = 0) {
    const key = `bb_maint_resolved_${chatId}`;
    try {
        const existing = getMaintenanceResolved(chatId);
        existing.push({
            resolvedAt: Date.now(),
            actions: actionsCount,
            results,
        });
        // Keep only last 50 entries
        if (existing.length > 50) existing.splice(0, existing.length - 50);
        sessionStorage.setItem(key, JSON.stringify(existing));
    } catch { /* ignore */ }
}
