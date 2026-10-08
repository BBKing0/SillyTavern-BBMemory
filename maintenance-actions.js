/** v9.4.6：管家与维护面板共用的可核验批量执行器。 */
import * as store from './memory-store.js';
import { saveCorrection } from './memory-correction.js';
import { runHealthCheck, getActionButtonsForIssue, executeHealthMaintenanceAction } from './memory-health-check.js';
import { checkMaintenanceNeeded, performMaintenance, addMaintenanceResolved } from './memory-maintainer.js';
import { maintenanceIssueKey, maintenanceFingerprint, ignoreMaintenanceIssues } from './maintenance-state.js';
import { callEmbeddingApi } from './auto-generator.js';
import { buildEmbeddingText } from './vector-store.js';
import { getLocations, updateLocation } from './map-store.js';

export const MAINTENANCE_OP_LABELS = { ignore: '忽略', re_embed: '重新生成向量', keep: '保留', promote: '升级', demote: '降级',
    delete: '删除', item_to_core: '升为常驻', compress_thread: '生成压缩建议',
    archive: '归档', archive_item: '归档物品', item_to_vector: '升为稳定', item_to_eternal: '升为永恒',
    compress_timeline: '压缩里程碑', thread_fix_status: '修正时间线状态', thread_pause: '暂停时间线' };

export function pendingMaintenanceButtons(type) {
    const ops = type === 'dusty_item' ? ['archive_item', 'item_to_core', 'item_to_vector', 'item_to_eternal', 'ignore']
        : type === 'long_timeline' ? ['compress_thread', 'ignore']
        : ['keep', 'promote', 'demote', 'delete', ...(type === 'compressible_timeline' ? ['compress_timeline'] : []), 'ignore'];
    return ops.map(op => ({ op, label: op === 'archive_item' ? '归档' : MAINTENANCE_OP_LABELS[op] }));
}
export function availableMaintenanceOps(issue) {
    if (issue.source === 'pending') {
        return [...pendingMaintenanceButtons(issue.type).map(b => b.op), 'archive'];
    }
    return [...new Set([...getActionButtonsForIssue(issue).map(b => b.op), ...(['thread_empty', 'map_isolated_location', 'stale'].includes(issue.type) ? ['archive'] : [])])];
}

export async function getMaintenanceReport(chatId) {
    const [health, pending] = await Promise.all([runHealthCheck(chatId), checkMaintenanceNeeded(chatId)]);
    const issues = [
        ...Object.values(health.categories).flatMap(cat => cat.issues.map(issue => ({ ...issue, source: 'health', group: cat.label }))),
        ...pending.issues.map(issue => ({ ...issue, source: 'pending', id: issue.item.id, entry: issue.item, title: issue.item.name || issue.item.title || issue.item.event, detail: issue.reason, group: '待维护' })),
    ].map(issue => ({ ...issue, key: `${issue.source}:${maintenanceIssueKey(issue)}` }));
    return { issues, healthScore: health.summary.healthScore, totalEntries: health.summary.totalEntries };
}

function collectionOf(issue) {
    if (issue.type.startsWith('thread_')) return 'timeline';
    if (issue.type === 'map_isolated_location') return 'map';
    return issue.collection || 'mem';
}

async function loadRow(chatId, pillar, id) {
    const loaders = { mem: store.getMemories, npc: store.getNpcProfiles, item: store.getItems,
        milestone: store.getMilestones, timeline: store.getTimeline, map: getLocations };
    const entry = (await loaders[pillar]?.(chatId))?.find(e => e.id === id);
    return entry ? { key: `${pillar}:${id}`, pillar, entry } : null;
}

// 与各柱既有归档生命周期一致，不能仅写一个检索不读取的 archived 字段。
export function buildArchivePatch(row, archived) {
    if (['clue', 'connection'].includes(row.pillar)) throw new Error('线索节点和连线不支持归档，请在原面板管理');
    if (row.pillar === 'realtime') return { settleState: archived ? 'settled' : 'active', settleReason: archived ? '管家手动归档' : '' };
    const patch = { archived };
    if (row.pillar === 'mem') patch.status = archived ? 'archived' : 'active';
    if (row.pillar === 'milestone') { patch.isActive = !archived; if (!archived) patch.status = 'ongoing'; }
    if (row.pillar === 'timeline') patch.status = archived ? 'archived' : 'ongoing';
    if (!archived && row.entry.memoryTier === 'archived') patch.memoryTier = 'stable';
    return patch;
}

async function executeOne(chatId, issue, op, signal) {
    if (!availableMaintenanceOps(issue).includes(op)) throw new Error('此问题不支持该操作');
    if (op === 'ignore') { await ignoreMaintenanceIssues(chatId, [issue]); return; }
    if (issue.source !== 'pending' && op !== 're_embed' && op !== 'archive') {
        return executeHealthMaintenanceAction(op, issue, chatId);
    }
    const pillar = collectionOf(issue);
    const row = await loadRow(chatId, pillar, issue.id);
    if (issue.entry || issue.item) {
        if (!row) throw new Error('条目已不存在，请重新检查');
        if (maintenanceFingerprint({ entry: row.entry }) !== maintenanceFingerprint({ entry: issue.entry || issue.item })) {
            throw new Error('条目已变化，请重新检查');
        }
    }
    if (!row) throw new Error('此问题没有可操作条目');
    if (row.entry.memoryTier === 'eternal' || row.entry.keepPermanent) throw new Error('永恒或永久保留条目不参与维护，请手动编辑');
    if (op === 're_embed') {
        const text = buildEmbeddingText(row.entry).trim();
        if (!text) throw new Error('条目没有可生成向量的文本');
        const embedding = await callEmbeddingApi(text);
        if (signal?.aborted || String(globalThis.SillyTavern?.getContext?.()?.chatId) !== String(chatId)) throw new Error('任务已停止，未写入生成的向量');
        if (!Array.isArray(embedding) || !embedding.length || !embedding.every(Number.isFinite)) throw new Error('向量生成失败，请检查 Embedding API 设置');
        const fresh = await loadRow(chatId, pillar, issue.id);
        if (!fresh || maintenanceFingerprint({ entry: fresh.entry }) !== maintenanceFingerprint({ entry: row.entry })) throw new Error('生成期间条目已变化，请重试');
        const writers = { mem: store.updateMemory, npc: store.updateNpcProfile, item: store.updateItem, milestone: store.updateMilestone,
            timeline: (chat, id, patch) => store.upsertTimeline(chat, { ...patch, id }), map: updateLocation };
        if (!await writers[pillar](chatId, issue.id, { embedding, embeddingRef: null })) throw new Error('向量保存失败');
    } else if (issue.source === 'pending' && op !== 'archive') {
        await performMaintenance(chatId, [{ collection: pillar, id: issue.id, op }]);
    } else {
        const patch = op === 'archive' ? buildArchivePatch(row, true)
            : op === 'keep' ? { lastHitAt: Date.now(), hitCount: (row.entry.hitCount || 0) + 1 }
            : op === 'demote' ? { memoryTier: 'transient' }
            : op === 'thread_pause' ? { status: 'paused' }
            : op === 'thread_fix_status' ? { status: (row.entry.entries || []).some(e => e.status === 'ongoing') ? 'ongoing' : 'ended' } : null;
        if (!patch) throw new Error('未知维护操作');
        await saveCorrection(chatId, row, patch);
    }
}

const running = new Set();
export async function executeMaintenanceBatch(chatId, issues, op, { onProgress, signal } = {}) {
    if (running.has(chatId)) throw new Error('当前聊天已有维护任务正在执行');
    running.add(chatId);
    const unique = [...new Map(issues.map(i => [i.key || maintenanceIssueKey(i), i])).values()];
    const result = { succeeded: [], failed: [], cancelled: false, total: unique.length };
    try {
        onProgress?.(0, unique.length, result);
        if (op === 'compress_thread') {
            const { reviewTimelineCompression } = await import('./timeline-compression.js');
            const review = await reviewTimelineCompression(chatId, { ids: unique.map(i => i.id), scope:'all_threads', target:'timeline', signal, onProgress: message => onProgress?.(0, unique.length, { ...result, message }) });
            result.succeeded = unique.filter(i => review.appliedIds.includes(i.id));
            result.summary = review.summary;
            result.cancelled = !review.applyResult && review.confirmed === 0;
            result.failed = (review.applyResult?.failed || []).map(failure => ({
                issue: unique.find(i => failure.ids?.includes(i.id)) || { id:failure.ids?.[0] || '' }, error:failure.error,
            }));
            return result;
        }
        if (op === 'ignore' && !signal?.aborted && String(globalThis.SillyTavern?.getContext?.()?.chatId) === String(chatId)) {
            // 同类忽略一次持久化，避免大量条目重复写整份记录和聊天元数据。
            try { await ignoreMaintenanceIssues(chatId, unique); result.succeeded.push(...unique); }
            catch (error) { result.failed.push(...unique.map(issue => ({ issue, error: error.message }))); }
            onProgress?.(unique.length, unique.length, result);
            return result;
        }
        for (const issue of unique) {
            if (signal?.aborted || String(globalThis.SillyTavern?.getContext?.()?.chatId) !== String(chatId)) { result.cancelled = true; break; }
            try { await executeOne(chatId, issue, op, signal); result.succeeded.push(issue); }
            catch (error) { result.failed.push({ issue, error: error.message }); }
            onProgress?.(result.succeeded.length + result.failed.length, unique.length, result);
        }
        return result;
    } finally {
        addMaintenanceResolved(chatId, { details: [result.summary || `${MAINTENANCE_OP_LABELS[op] || op}：成功 ${result.succeeded.length}，失败 ${result.failed.length}${result.cancelled ? '，已停止' : ''}`] }, result.succeeded.length);
        running.delete(chatId);
    }
}
