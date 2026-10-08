/** v9.5.0 按明确的时间线关联逐线总结，线内按输入预算分片。 */
import { callMainApi, callCustomApi } from './auto-generator.js';

export function parseSummaryJson(response) {
    const text = String(response || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (/<\/?think\b/i.test(text)) throw new Error('AI 思考段未完整结束，可能已达到输出上限；未接收其中的 JSON');
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    try { if (json) return JSON.parse(json); } catch { /* 报告截断，不修补残缺 JSON */ }
    throw new Error('AI 输出不是完整 JSON（可能被思考内容占满或输出截断），请提高输出上限或减小分段输入');
}

const clean = (entry, fields) => Object.fromEntries(fields.filter(k => entry[k] !== undefined).map(k => [k, entry[k]]));
export function summarySources(timeline, milestones) {
    return {
        timeline: timeline.map(t => ({ ...clean(t, ['id','name','summary','type','status','priority']), entries: (t.entries || []).map((e, sourceIndex) => ({ ...clean(e, ['period','event','title','summary','note','status','refId']), sourceIndex })) })),
        milestones: milestones.map(m => clean(m, ['id','timelineId','storyTime','event','summary','impact','participants','location','status'])),
    };
}

function unitsOf(timeline, milestones) {
    return [
        ...timeline.flatMap(t => t.entries?.length ? t.entries.map(e => ({ timeline: { ...t, entries: [e] } })) : [{ timeline: t }]),
        ...milestones.map(milestone => ({ milestone })),
    ];
}
function materialize(units) {
    const timeline = [], milestones = [];
    for (const unit of units) {
        if (unit.milestone) milestones.push(unit.milestone);
        else {
            const previous = timeline.find(t => t.id === unit.timeline.id);
            if (previous) previous.entries.push(...unit.timeline.entries);
            else timeline.push({ ...unit.timeline, entries: [...(unit.timeline.entries || [])] });
        }
    }
    return { timeline, milestones };
}
function pack(units, limit, extraContext = () => ({})) {
    const chunks = []; let current = [];
    const size = source => JSON.stringify({ ...summarySources(source.timeline, source.milestones), readOnlyContext:extraContext(source) }).length;
    for (const unit of units) {
        const one = materialize([unit]);
        if (size(one) > limit) throw new Error('单条原文及关联上下文超过分段输入上限，请调高输入上限；未截断原文');
        const next = [...current, unit];
        const source = materialize(next);
        if (current.length && size(source) > limit) {
            chunks.push(current); current = [unit];
        } else current = next;
    }
    if (current.length) chunks.push(current);
    return chunks;
}

/** 明确标签优先；旧数据仅兼容唯一的 refId 关联，不猜测未标注的故事线。 */
export function milestoneTimelineId(milestone, timeline) {
    const explicit = String(milestone.timelineId || '').trim();
    if (explicit) return timeline.some(t => t.id === explicit) ? explicit : '';
    const linked = timeline.filter(t => (t.entries || []).some(e => e.refId === milestone.id));
    return linked.length === 1 ? linked[0].id : '';
}

export function buildSummaryGroups(timeline, milestones, scope = 'all_with_milestones') {
    const groups = timeline.map(t => ({ key:t.id, name:t.name || '未命名时间线', timelineIds:[t.id],
        milestoneIds:milestones.filter(m => scope === 'selected_all' || milestoneTimelineId(m, timeline) === t.id).map(m => m.id) }));
    const assigned = new Set(groups.flatMap(g => g.milestoneIds));
    const other = milestones.filter(m => !assigned.has(m.id));
    if (other.length) groups.push({ key:'__other_milestones__', name:'其他 / 无标签', timelineIds:[], milestoneIds:other.map(m => m.id) });
    return groups;
}

/** 分片保留同一条线的关联原文，只读资料不会生成重复修改。 */
function relatedContext(source, timeline, milestones) {
    const context = { timeline:[], milestones:[] };
    const refs = new Set(source.timeline.flatMap(t => t.entries.map(e => e.refId)).filter(Boolean));
    let nodes = milestones.filter(m => refs.has(m.id));
    if (source.timeline.length && !source.milestones.length && !nodes.length) {
        const linked = milestones.find(m => source.timeline.some(t => milestoneTimelineId(m, timeline) === t.id));
        if (linked) nodes = [linked];
    }
    context.milestones = nodes.filter(m => !source.milestones.some(s => s.id === m.id));
    if (source.milestones.length && !source.timeline.length) {
        const ids = new Set(source.milestones.map(m => m.id));
        context.timeline = timeline.map(t => {
            const related = (t.entries || []).filter(e => ids.has(e.refId));
            // 时间线全部事件另有工作片段；此处只传完整总述，避免一个里程碑
            // 关联数百事件时在每次调用中重新塞回整条故事。无总述时取一个原文节点作参考。
            return { ...t, entries:t.summary ? [] : (related.length ? related : (t.entries || [])).slice(0,1) };
        });
    }
    return summarySources(context.timeline, context.milestones);
}

export async function generateSummaryBatches(timeline, milestones, settings, options) {
    const api = settings.timelineCompressionApi === 'custom' ? callCustomApi : callMainApi;
    const request = async prompt => {
        options.alive();
        const response = await api(prompt, { isMerged: true, maxTokens: Number(settings.timelineCompressionMaxTokens) || 64000,
            rejectTruncated: true, timeoutMs: (Number(settings.timelineSummaryTimeoutSeconds) || 180) * 1000 });
        options.alive();
        return parseSummaryJson(response);
    };
    const groups = buildSummaryGroups(timeline, milestones, options.scope).filter(group =>
        group.timelineIds.some(id => options.writable('timeline', id)) || group.milestoneIds.some(id => options.writable('milestone', id))
        || (options.allowNewTimeline && group.milestoneIds.length));
    const limit = Math.max(2000, Number(settings.timelineSummarySegmentChars) || 16000);
    const jobs = groups.flatMap(group => {
        const ts = timeline.filter(t => group.timelineIds.includes(t.id));
        const ms = milestones.filter(m => group.milestoneIds.includes(m.id));
        const context = source => relatedContext(source, ts, ms);
        return pack(unitsOf(ts, ms), limit, context).map(units => ({ key:group.key, name:group.name, units, context }));
    });
    const results = [], failures = []; let done = 0;
    const run = async (job, depth = 0) => {
        const source = materialize(job.units);
        try {
            const draft = await request(options.prompt(source.timeline, source.milestones, job.name, job.context(source)));
            const ops = await options.parse(draft, source.timeline, source.milestones);
            // 每个获准条目都必须明确返回，防止某一片段被静默略过。
            for (const [pillar, entries] of [['timeline', source.timeline], ['milestone', source.milestones]]) {
                for (const entry of entries.filter(e => options.writable(pillar, e.id))) {
                    if (!ops.some(op => op.pillar === pillar && op.ids[0] === entry.id)) throw new Error('总结遗漏获准条目，未采纳此片段');
                }
            }
            results.push({ ...job, ...source, ops });
        } catch (error) {
            options.alive();
            if (job.units.length > 1 && depth < Math.max(0, Math.min(5, Number(settings.timelineSummarySplitRetries) || 0))) {
                options.onProgress?.(`“${job.name}”输出失败，拆小片段重试：${error.message}`);
                const mid = Math.ceil(job.units.length / 2);
                await run({ ...job, units:job.units.slice(0,mid) }, depth + 1);
                await run({ ...job, units:job.units.slice(mid) }, depth + 1);
            } else failures.push({ ...source, key:job.key, name:job.name, error:error.message });
        }
    };
    for (const [index, group] of groups.entries()) {
        const lineJobs = jobs.filter(job => job.key === group.key);
        let cursor = 0;
        options.onProgress?.(`第 ${index + 1}/${groups.length} 条线：“${group.name}”，${lineJobs.length} 个片段`);
        await Promise.all(Array.from({ length:Math.min(lineJobs.length, Math.max(1, Math.min(8, Number(settings.timelineSummaryParallel) || 2))) }, async () => {
            while (cursor < lineJobs.length) {
                const job = lineJobs[cursor++]; options.alive();
                options.onProgress?.(`总结“${job.name}”，共完成 ${done}/${jobs.length} 个片段`);
                await run(job); done++;
                options.onProgress?.(`已完成 ${done}/${jobs.length} 个片段${failures.length ? `，${failures.length} 个失败` : ''}`);
            }
        }));
    }
    return { results, failures, groups };
}
