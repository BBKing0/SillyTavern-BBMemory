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
    addMemory,
} from './memory-store.js';
import { callCustomApi, callMainApi } from './auto-generator.js';

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
    addMaintenanceResolved(chatId, resultEntry.results);

    return results;
}

// ═══════════════════════════════════════════════════════════
//  维护面板 HTML
// ═══════════════════════════════════════════════════════════

export function buildMaintenanceHTML(result) {
    if (!result || !result.issues?.length) {
        return `<div class="bb-maintenance">
            <div class="bb-maintenance-header">记忆维护</div>
            <div class="bb-maintenance-empty">暂无需要维护的项目</div>
        </div>`;
    }

    const grouped = {};
    for (const issue of result.issues) {
        if (!grouped[issue.type]) grouped[issue.type] = [];
        grouped[issue.type].push(issue);
    }

    const typeLabels = {
        idle_transient_memory:  { icon: '', label: '瞬时记忆（长期未命中）', desc: '这些记忆很久没有被触发' },
        status_changed_item:    { icon: '', label: '状态变更的物品',     desc: '以下物品已使用/失去/销毁' },
        compressible_timeline:  { icon: '', label: '可压缩的时间线',     desc: '这些事件已结束，可以压缩归档' },
        low_tier_npc:           { icon: '', label: '低优先级NPC',        desc: '这些角色可能需要升级或清理' },
        foreshadow:             { icon: '', label: '待确认伏笔',         desc: '这些伏笔可能需要关联到主事件' },
    };

    let sections = '';
    for (const [type, issues] of Object.entries(grouped)) {
        const meta = typeLabels[type] || { icon: '', label: type, desc: '' };
        let items = '';
        const display = issues.slice(0, 10);
        for (const issue of display) {
            const item = issue.item;
            const label = item.name || item.title || item.event || item.id;
            items += `<div class="bb-maint-item" data-id="${escapeHtml(item.id)}" data-collection="${issue.collection}">
                <span class="bb-maint-item-text">${escapeHtml(label)}</span>
                <span class="bb-maint-item-reason">${escapeHtml(issue.reason)}</span>
                <div class="bb-maint-item-actions">
                    <button class="bb-maint-btn keep" data-op="keep">保留</button>
                    ${issue.type === 'compressible_timeline' ? '<button class="bb-maint-btn compress" data-op="compress_timeline">压缩</button>' : ''}
                    <button class="bb-maint-btn promote" data-op="promote">升级</button>
                    <button class="bb-maint-btn demote" data-op="demote">降级</button>
                    <button class="bb-maint-btn delete" data-op="delete">删除</button>
                </div>
            </div>`;
        }
        if (issues.length > 10) {
            items += `<div class="bb-maint-more">...还有 ${issues.length - 10} 条</div>`;
        }
        sections += `<div class="bb-maint-section">
            <div class="bb-maint-section-header">${meta.icon} ${meta.label} <span class="bb-maint-count">${issues.length}条</span></div>
            <div class="bb-maint-section-desc">${meta.desc}</div>
            <div class="bb-maint-items">${items}</div>
        </div>`;
    }

    return `<div class="bb-maintenance">
        <div class="bb-maintenance-header">
            记忆维护
            <span class="bb-maint-total">共 ${result.issueCount} 条待处理</span>
        </div>
        <div class="bb-maintenance-stats">
            总条目: ${result.totalItems || 0} | NPC: ${result.stats?.npc || 0} | 物品: ${result.stats?.items || 0} | 时间线: ${result.stats?.timeline || 0} | 记忆: ${result.stats?.memories || 0}
        </div>
        ${sections}
        <div class="bb-maintenance-actions">
            <button class="bb-maint-btn-all keep-all">全部保留</button>
            <button class="bb-maint-btn-all dismiss">稍后处理</button>
        </div>
    </div>`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════
//  兼容旧接口
// ═══════════════════════════════════════════════════════════

export function dismissMaintenanceRemind() {
    updateSettings({ _lastMaintenanceRemind: Date.now() });
}

export async function diagnoseMemories(memories) {
    return memories
        .filter(m => m.memoryTier === 'transient')
        .map(m => ({ memory: m, reason: `${m.title || '无标题'}`, category: 'weak', severity: 'info' }));
}

export async function autoMaintain(chatId, issues) {
    let count = 0;
    for (const issue of issues) {
        if (issue.memory?.id) {
            await updateMemory(chatId, issue.memory.id, { memoryTier: 'transient' });
            count++;
        }
    }
    return count;
}

export async function fuzzyMemory(chatId, memoryId) {
    return updateMemory(chatId, memoryId, { memoryTier: 'transient' });
}

export async function archiveMemory(chatId, memoryId) {
    return updateMemory(chatId, memoryId, { status: 'archived' });
}

export async function restoreMemory(chatId, memoryId) {
    return updateMemory(chatId, memoryId, { status: 'active', memoryTier: 'transient' });
}

// ═══════════════════════════════════════════════════════════
//  时间线总结（保留 v4.4.0 功能）
// ═══════════════════════════════════════════════════════════

export async function generateTimelineSummary(chatId, options = {}) {
    const timeline = await getTimeline(chatId);
    const endedEvents = timeline.filter(t => !t.isActive || t.status === 'ended');
    if (endedEvents.length < 2) return { summaryCount: 0, mergedCount: 0, errors: [] };

    const sorted = [...endedEvents].sort((a, b) => (a.storyTimeSort ?? 0) - (b.storyTimeSort ?? 0));
    const groups = [];
    let currentGroup = [sorted[0]];
    const gapThreshold = options.gapThreshold ?? 500;

    for (let i = 1; i < sorted.length; i++) {
        const gap = (sorted[i].storyTimeSort ?? 0) - (sorted[i - 1].storyTimeSort ?? 0);
        if (gap < gapThreshold) { currentGroup.push(sorted[i]); }
        else { groups.push(currentGroup); currentGroup = [sorted[i]]; }
    }
    groups.push(currentGroup);

    const errors = [];
    let summaryCount = 0, mergedCount = 0;

    for (const group of groups) {
        if (group.length < 2) continue;
        try {
            const result = await generateGroupSummary(chatId, group, options);
            if (result) {
                if (result.merged) mergedCount++;
                else summaryCount++;
            }
        } catch (e) { errors.push(e.message); }
    }

    return { summaryCount, mergedCount, errors };
}

async function generateGroupSummary(chatId, group, _options = {}) {
    const lines = group.map((t, i) =>
        `${i + 1}. [${t.storyTime || '?'}] ${t.event}: ${t.summary}`
    ).join('\n');

    const prompt = `将以下时间线条目合并为一条总结（JSON）：
${lines}
返回格式：{"n":"标题","c":"内容(100字)","m":"摘要(20字)","i":0.7}
只输出JSON。`;

    let responseText;
    try {
        const settings = getSettings();
        if (settings.autoGenMode === 'custom' && settings.autoGenEndpoint) {
            responseText = await callCustomApi(prompt);
        } else {
            responseText = await callMainApi(prompt);
        }
    } catch { return null; }

    try {
        let text = responseText.trim();
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        const parsed = JSON.parse(match[0]);

        const existingKey = `tl_summary_${group[0].storyTimeSort || group[0].createdAt}`;
        const existing = (await getMemories(chatId)).find(m => m.timelineGroupKey === existingKey);

        if (existing) {
            await updateMemory(chatId, existing.id, {
                content: parsed.c || parsed.content || existing.content,
                summary: parsed.m || parsed.summary || existing.summary,
            });
            return { merged: true };
        }

        await addMemory(chatId, {
            title: parsed.n || parsed.title || '事件总结',
            type: 'event',
            content: parsed.c || parsed.content || '',
            summary: parsed.m || parsed.summary || '',
            importance: typeof parsed.i === 'number' ? parsed.i : 0.7,
            isTimelineSummary: true,
            timelineGroupKey: existingKey,
            source: 'timeline_summary',
        });
        return { merged: false };
    } catch { return null; }
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

export function addMaintenanceResolved(chatId, results) {
    const key = `bb_maint_resolved_${chatId}`;
    try {
        const existing = getMaintenanceResolved(chatId);
        existing.push({
            resolvedAt: Date.now(),
            results,
        });
        // Keep only last 50 entries
        if (existing.length > 50) existing.splice(0, existing.length - 50);
        sessionStorage.setItem(key, JSON.stringify(existing));
    } catch { /* ignore */ }
}
