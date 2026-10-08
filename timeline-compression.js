/** v9.4.7 完整故事线原文 → 可编辑建议 → 确认后可撤销写入。 */
import { getTimeline, saveTimeline } from './memory-store.js';

export function timelineTextSize(thread) {
    return [thread.summary, ...(thread.entries || []).map(e => [e.period, e.event, e.title, e.summary, e.note].filter(Boolean).join(' '))].filter(Boolean).join('\n').length;
}
export function validateTimelineDraft(result) {
    if (typeof result?.summary !== 'string' || !result.summary.trim()) throw new Error('压缩摘要不能为空');
    if (!Array.isArray(result.entries) || !result.entries.length || result.entries.some(e => typeof e.event !== 'string' || !e.event.trim())) throw new Error('压缩结果须包含非空事件');
}
export async function generateTimelineCompression(chatId, ids, options = {}) {
    const { generateJointSummary } = await import('./story-summary.js');
    try { return await generateJointSummary(chatId, { ...options, ids, scope:'all_threads', target:'timeline' }); }
    catch (error) { return { ops: [], failures: [error.message] }; }
}
export async function reviewTimelineCompression(chatId, options = {}) {
    const { reviewJointSummary } = await import('./story-summary.js');
    return reviewJointSummary(chatId, options);
}

/** 首次从里程碑生成故事线也先审核；未选中的既有故事线不会丢失。 */
export async function reviewTimelineRegeneration(chatId, drafts, original) {
    const curator = await import('./memory-curator.js');
    const bases = drafts.map((draft, i) => original.find(t => t.id === draft.id) || { id: `tl_${Date.now().toString(36)}_${i}`, name: '新故事线', entries: [] });
    const parsed = curator.parseCurationOps(JSON.stringify({ ops: drafts.map((draft, i) => ({ op: 'rewrite', pillar: 'timeline', ids: [bases[i].id], result: draft,
        issueCategory: '故事线生成', reason: `生成故事线：${draft.name || ''}` })) }), { groups: [{ pillar: 'timeline', entries: bases }] });
    if (!parsed.ops.length) throw new Error('AI 没有返回有效故事线');
    const review = await curator.openCurationReviewPanel(chatId, parsed.ops, { title: '故事线生成 · 编辑并确认',
        validateOp: op => {
            if (!op.result.name?.trim() || !op.result.entries?.length || op.result.entries.some(e => !String(e.event || '').trim())) throw new Error('故事线名称和事件不能为空');
        },
        apply: async (chat, chosen) => {
            const current = await getTimeline(chat);
            for (const op of chosen) {
                const before = original.find(t => t.id === op.ids[0]), now = current.find(t => t.id === op.ids[0]);
                if (JSON.stringify(before) !== JSON.stringify(now)) throw new Error('原故事线已变化，请重新生成');
            }
            const snapshotId = await curator.beginCurationSnapshot(chat, chosen, { source: 'timeline_generate' });
            const created = chosen.filter(op => !original.some(t => t.id === op.ids[0])).map(op => op.ids[0]);
            const summary = `保存 ${chosen.length} 条故事线`;
            await curator.finalizeCurationSnapshot(chat, snapshotId, { createdIds: { timeline: created }, applied: chosen.length, summary });
            if (String(SillyTavern.getContext().chatId) !== String(chat)) throw new Error('聊天已切换');
            const ids = new Set(chosen.flatMap(op => op.ids));
            await saveTimeline(chat, [...current.filter(t => !ids.has(t.id)), ...chosen.map(op => ({
                ...original.find(t => t.id === op.ids[0]), ...op.result, id: op.ids[0], embedding: null, embeddingRef: null,
                createdAt: original.find(t => t.id === op.ids[0])?.createdAt || Date.now(), updatedAt: Date.now(),
            }))]);
            return { applied: chosen, failed: [], summary, snapshotId };
        },
    });
    const count = review.applyResult?.applied?.length || 0;
    return { ...review, threadCount: count, timelineCount: count };
}
