/**
 * memory-maintainer.js —— BB-Memory v5.0 记忆维护系统
 *
 * 双区结构：待维护 + 已维护（7天后自动清空）。
 * 阈值触发提醒，用户主导裁决，与升降格系统联动。
 */

import {
    getSettings, updateSettings,
    getNpcProfiles, getItems, getMilestones, getTimeline, getMemories,
    updateNpcProfile, updateItem, updateMilestone, updateMemory,
    removeNpcProfile, removeItem, removeMilestone, removeMemory,
} from './memory-store.js';
import { filterIgnoredIssues } from './maintenance-state.js';
import { timelineTextSize } from './timeline-compression.js';

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

    // 2. 自动压缩已结束的里程碑
    const milestones = await getMilestones(chatId);
    for (const t of milestones) {
        if (t.memoryTier === 'eternal' || t.isActive || t.status === 'ongoing') continue;
        const roundsSinceEnd = Math.floor((now - t.updatedAt) / roundMs);
        if (roundsSinceEnd >= 60) {
            await updateMilestone(chatId, t.id, { isActive: false, status: 'ended' });
            if (settings.debugLogging) log(`压缩里程碑: ${(t.event || t.id).slice(0, 30)}`);
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

    const [npc, items, milestones, memories, threads] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getMilestones(chatId), getMemories(chatId), getTimeline(chatId),
    ]);

    let issues = [];
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

    // 2. 积灰物品：连续未命中达到阈值后提示用户裁决
    const dustyThreshold = Number(settings.itemDustyMissRounds) || 30;
    for (const item of items) {
        if (item.archived || item.keepPermanent || item.memoryTier === 'eternal') continue;
        const missStreak = Math.max(0, Number(item.missStreak) || 0);
        if (item.memoryTier !== 'transient' && missStreak < dustyThreshold) continue;
        issues.push({
            type: 'dusty_item', collection: 'item', item,
            reason: `${item.name} — ${item.memoryTier === 'transient' ? '已积灰' : `连续 ${missStreak} 轮未命中`}，可归档或升级注入层级`,
            severity: 'warning',
        });
    }

    // 3. 状态变更物品（排除永久保留）
    for (const item of items) {
        if (item.archived || item.status === 'held' || item.keepPermanent) continue;
        issues.push({
            type: 'status_changed_item', collection: 'item', item,
            reason: `${item.name} — 状态：${item.status}${item.keepPermanent ? '（永久保留）' : ''}`,
            severity: 'warning',
        });
    }

    // 4. 可压缩里程碑
    for (const t of milestones) {
        if (t.isActive || t.status === 'ongoing') continue;
        if (t.memoryTier === 'eternal') continue;
        issues.push({
            type: 'compressible_timeline', collection: 'milestone', item: t,
            reason: `${t.event} — 已结束，可压缩归档`,
            severity: 'info',
        });
    }

    // 5. 低 tier NPC
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

    // 6. 伏笔
    for (const t of milestones) {
        if (t.status !== 'foreshadow') continue;
        issues.push({
            type: 'foreshadow', collection: 'milestone', item: t,
            reason: `${t.event} — 待确认伏笔`,
            severity: 'info',
        });
    }

    for (const thread of threads) {
        const chars = timelineTextSize(thread);
        if (thread.entries?.length && ((thread.entries.length >= (settings.timelineCompressionEntryThreshold || 12)) || chars >= (settings.timelineCompressionCharThreshold || 1800))) {
            issues.push({ type: 'long_timeline', collection: 'timeline', item: thread, severity: 'warning',
                reason: `${thread.name} — ${thread.entries.length} 个事件 / ${chars} 字符，可生成精简故事骨架并确认修改` });
        }
    }
    issues = issues.filter(issue => !issue.item.archived && !['archived', 'deleted'].includes(issue.item.status) && issue.item.memoryTier !== 'eternal' && !issue.item.keepPermanent);
    issues = await filterIgnoredIssues(chatId, issues);
    cache.pending = issues;
    cache.lastCheck = now;

    const thresholdNpc = settings.maintenanceNpcThreshold || 5;
    const thresholdItem = settings.maintenanceItemThreshold || 20;
    const thresholdMem = settings.maintenanceMemThreshold || 20;
    const totalCount = npc.length + items.length + milestones.length + memories.length;

    const needsReminder = issues.length > 0 && (
        npc.length >= thresholdNpc || items.length >= thresholdItem ||
        memories.length >= thresholdMem || issues.some(i => i.severity === 'warning')
    );

    return {
        needed: needsReminder,
        totalItems: totalCount,
        issueCount: issues.length,
        issues,
        stats: { npc: npc.length, items: items.length, milestones: milestones.length, timeline: milestones.length, memories: memories.length },
    };
}

// ═══════════════════════════════════════════════════════════
//  维护操作
// ═══════════════════════════════════════════════════════════

const loadFns = { npc: getNpcProfiles, item: getItems, milestone: getMilestones, timeline: getMilestones, mem: getMemories };
const updateFns = { npc: updateNpcProfile, item: updateItem, milestone: updateMilestone, timeline: updateMilestone, mem: updateMemory };
const removeFns = { npc: removeNpcProfile, item: removeItem, milestone: removeMilestone, timeline: removeMilestone, mem: removeMemory };

export async function performMaintenance(chatId, actions) {
    const cache = getCache(chatId);
    const results = { kept: 0, deleted: 0, promoted: 0, demoted: 0, compressed: 0, archived: 0 };

    for (const action of actions) {
        const { collection, id, op } = action;
        const updateFn = updateFns[collection];
        const removeFn = removeFns[collection];
        const loadFn = loadFns[collection];
        if (!loadFn || !updateFn || !removeFn) throw new Error('未知维护集合');
        const current = (await loadFn(chatId)).find(entry => entry.id === id);
        if (!current) throw new Error('条目已不存在，请重新检查');
        if (current.memoryTier === 'eternal' || current.keepPermanent) throw new Error('永恒或永久保留条目不参与维护');

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
                await updateMilestone(chatId, id, {
                    isActive: false, status: 'ended',
                    summary: `[归档] ${(await getMilestones(chatId)).find(t => t.id === id)?.event || ''}: ${(await getMilestones(chatId)).find(t => t.id === id)?.summary || ''}`,
                });
                results.compressed++;
                break;
            case 'archive_item':
                await updateItem(chatId, id, { archived: true });
                results.archived++;
                break;
            case 'item_to_vector':
                await updateItem(chatId, id, { memoryTier: 'stable', keepPermanent: false, missStreak: 0, hitScore: 0, archived: false });
                results.promoted++;
                break;
            case 'item_to_core':
                await updateItem(chatId, id, { memoryTier: 'core', keepPermanent: false, missStreak: 0, hitScore: 0, archived: false });
                results.promoted++;
                break;
            case 'item_to_eternal':
                await updateItem(chatId, id, { memoryTier: 'eternal', keepPermanent: true, missStreak: 0, hitScore: 0, archived: false });
                results.promoted++;
                break;
            default:
                throw new Error('未知维护操作: ' + op);
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
//  v9.2.0 时间线系统 — 时间线总结生成
// ═══════════════════════════════════════════════════════════

/**
 * 从里程碑重新生成时间线总结
 * 读取所有里程碑 + 现有时间线，让 LLM 输出更新后的时间线列表
 */
export async function regenerateThreadSummary(chatId, options = {}) {
    const { reviewJointSummary } = await import('./story-summary.js');
    return reviewJointSummary(chatId, options);
}

export const regenerateTimelineSummary = regenerateThreadSummary;

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
