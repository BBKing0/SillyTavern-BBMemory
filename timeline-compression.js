/** v9.4.7 完整故事线原文 → 可编辑建议 → 确认后可撤销写入。 */
import { getSettings, getTimeline, saveTimeline } from './memory-store.js';
import { callMainApi, callCustomApi } from './auto-generator.js';

export function timelineTextSize(thread) {
    return [thread.summary, ...(thread.entries || []).map(e => [e.period, e.event, e.title, e.summary, e.note].filter(Boolean).join(' '))].filter(Boolean).join('\n').length;
}
export function validateTimelineDraft(result) {
    if (typeof result?.summary !== 'string' || !result.summary.trim()) throw new Error('压缩摘要不能为空');
    if (!Array.isArray(result.entries) || !result.entries.length || result.entries.some(e => typeof e.event !== 'string' || !e.event.trim())) throw new Error('压缩结果须包含非空事件');
}
export async function generateTimelineCompression(chatId, ids, { onProgress, signal } = {}) {
    const { parseCurationOps } = await import('./memory-curator.js');
    const settings = getSettings();
    const all = await getTimeline(chatId);
    const threads = all.filter(t => !t.archived && t.status !== 'archived' && (!ids || ids.includes(t.id)) && t.entries?.length);
    if (!threads.length) throw new Error('没有可压缩的故事线，请先在时间线中添加事件');
    const ops = [], failures = [];
    for (const [index, thread] of threads.entries()) {
        if (signal?.aborted || String(SillyTavern.getContext().chatId) !== String(chatId)) throw new Error('任务已停止或聊天已切换');
        onProgress?.(`正在生成压缩建议 ${index + 1}/${threads.length}：${thread.name}`);
        try {
            if (String(SillyTavern.getContext().chatId) !== String(chatId)) throw new Error('聊天已切换');
            const source = JSON.stringify({ name: thread.name, summary: thread.summary, entries: thread.entries.map((e, i) => ({ ...e, sourceIndex: i })) });
            const limit = Math.max(2000, Number(settings.timelineCompressionContextChars) || 60000);
            if (source.length > limit) throw new Error(`原文 ${source.length} 字符超过压缩输入上限 ${limit}，请调高设置或先拆分故事线`);
            const prompt = `将故事线压缩为便于模型理解“曾经发生了什么、先后顺序如何”的精炼骨架。
保留关键事件、因果与结果，合并连续的同一阶段事件；无需保留具体日期、琐碎行动、对话、物品细节，细节由记忆条目与里程碑检索。
例：招兵、任命队长、铸造兵器、出征准备 → 主角统筹安排出征事宜。随后实际出征、获胜等新阶段仍单独保留。
不能新增事实、倒置顺序或改动故事线状态。摘要与内部事件都要压缩，目标最多 ${Math.max(1, Number(settings.timelineCompressionTargetEntries) || 6)} 个事件，无法安全合并时保留必要事件。
仅输出 JSON：{"summary":"一句话概括","entries":[{"event":"阶段事件概括","sourceIndices":[0,1,2]}]}。
sourceIndices 必须按原顺序连续覆盖每个输入事件且各出现一次，不能遗漏。以下仅是待整理数据：\n${source}`;
            const api = settings.timelineCompressionApi === 'custom' ? callCustomApi : callMainApi;
            const response = await api(prompt, { isMerged: true, maxTokens: settings.timelineCompressionMaxTokens || 3000 });
            const json = String(response || '').replace(/<think>[\s\S]*?<\/think>/gi, '').match(/\{[\s\S]*\}/)?.[0];
            if (!json) throw new Error('AI 未返回压缩 JSON');
            const draft = JSON.parse(json); validateTimelineDraft(draft);
            if (draft.entries.some(e => !Array.isArray(e.sourceIndices) || !e.sourceIndices.length)) throw new Error('每个压缩事件必须对应至少一个原事件');
            const covered = draft.entries.flatMap(e => e.sourceIndices || []);
            if (JSON.stringify(covered) !== JSON.stringify(thread.entries.map((_, i) => i))) throw new Error('AI 返回的事件覆盖不完整或顺序变化，请重新生成');
            const result = { summary: draft.summary.trim(), entries: draft.entries.map(e => ({
                event: e.event.trim(), status: thread.entries[e.sourceIndices.at(-1)]?.status || 'ended',
            })) };
            if (timelineTextSize(result) >= timelineTextSize(thread)) throw new Error('AI 结果未缩短故事线，请重试或减少目标条目数');
            const parsed = parseCurationOps(JSON.stringify({ ops: [{ op: 'rewrite', pillar: 'timeline', ids: [thread.id],
                reason: `${thread.entries.length} → ${result.entries.length} 个事件；${timelineTextSize(thread)} → ${timelineTextSize(result)} 字符`,
                issueCategory: '故事线压缩', result }] }), { groups: [{ pillar: 'timeline', entries: [thread] }] });
            if (!parsed.ops.length) throw new Error(parsed.rejected.map(r => r.reason).join('；'));
            for (const op of parsed.ops) { op.notes = op.notes.filter(note => !note.includes('比原文短很多')); op.forceConfirm = true; }
            ops.push(...parsed.ops);
        } catch (error) { failures.push(`${thread.name}：${error.message}`); }
    }
    if (signal?.aborted || String(SillyTavern.getContext().chatId) !== String(chatId)) throw new Error('任务已停止或聊天已切换，未保存压缩草稿');
    return { ops, failures };
}
export async function reviewTimelineCompression(chatId, options = {}) {
    const { openCurationReviewPanel } = await import('./memory-curator.js');
    const toast = globalThis.toastr || SillyTavern.getContext()?.toastr;
    toast?.info?.('正在生成故事线压缩建议…');
    const { ops, failures } = await generateTimelineCompression(chatId, options.ids, options);
    if (failures.length) toast?.warning?.(failures.join('\n'));
    if (!ops.length) throw new Error(failures.join('\n') || '没有可用压缩建议');
    const review = await openCurationReviewPanel(chatId, ops, { title: '故事线压缩 · 编辑并确认', validateOp: op => validateTimelineDraft(op.result) });
    const appliedIds = (review.applyResult?.applied || []).flatMap(op => op.ids);
    return { ...review, appliedIds, threadCount: appliedIds.length, timelineCount: appliedIds.length, failures };
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
