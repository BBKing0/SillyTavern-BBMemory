/** v9.4.5 纠错专用宽召回：全库原文、分词、近似片段、实体别名、关联引用取并集。 */
import * as store from './memory-store.js';
import { getLocations, updateLocation } from './map-store.js';
import { getClueBoard, updateClueNode, updateClueConnection } from './clue-board.js';
import { scheduleDayKey } from './realtime-schedule.js';

export const CORRECTION_LABELS = { npc: 'NPC', item: '物品', milestone: '里程碑', mem: '记忆', realtime: '实时/日程', timeline: '时间线', map: '地图', clue: '线索节点', connection: '线索连线' };
export const CORRECTION_FIELDS = {
    name: '名称', title: '标题', role: '身份/职业', description: '描述', content: '正文', summary: '摘要', indexCard: '索引卡',
    personality: '性格', appearance: '外貌', status: '状态', location: '地点', owner: '持有者', significance: '意义/用途',
    event: '事件', impact: '影响', storyTime: '故事时间', subject: '主体', target: '对象', participants: '参与者',
    tags: '标签', aliases: '别名', alias: '别名', relations: '人物关系', relationships: '人物关系', hiddenNotes: '隐藏备注',
    verbatim: '原文引用', realWorldRef: '现实参照', factContent: '事实原文', originalContent: '原文', truthStatus: '真实性', text: '内容', note: '备注', notes: '备注', label: '名称/说明',
    entries: '时间线事件', region: '区域', type: '类型', details: '细节', edges: '路线', distance: '距离', travelTime: '耗时',
    transport: '交通', requirements: '条件', reason: '原因', value: '内容', relation: '关系', relationType: '关系类型',
    dayLabel: '日程日期', quantity: '数量', confidence: '置信度', allowInjection: '允许注入',
};
const ROOT_FIELDS = Object.keys(CORRECTION_FIELDS);
const INTERNAL = /^(?:id|.*Id|.*Ids|_.*|embedding.*|source.*|creationFloor|createdFloor|lastSeenFloor|createdAt|updatedAt|dayKey|dayOrder|actionOrder|x|y)$/;
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const clone = value => JSON.parse(JSON.stringify(value));

// 同一份可读字段供搜索、结果原文和编辑器使用，防止“搜到了却看不到/改不了”。
export function correctionFields(entry, pillar, { includeEmpty = false } = {}) {
    const fields = [];
    const walk = (value, path, label) => {
        if (Array.isArray(value)) { value.forEach((item, i) => walk(item, [...path, i], `${label} ${i + 1}`)); return; }
        if (value && typeof value === 'object') {
            for (const [key, child] of Object.entries(value)) {
                if (!INTERNAL.test(key)) walk(child, [...path, key], `${label} · ${CORRECTION_FIELDS[key] || key}`);
            }
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            if (includeEmpty || String(value).trim()) fields.push({ path, label, value });
        }
    };
    const content = { ...entry };
    if (includeEmpty) {
        const defaults = { npc: ['name', 'role', 'personality', 'appearance', 'status', 'location', 'indexCard'], item: ['name', 'owner', 'significance'], mem: ['title', 'content', 'summary', 'indexCard'], realtime: ['text'], milestone: ['event', 'impact'], timeline: ['name', 'summary'], clue: ['label', 'note'], connection: ['label'], map: ['name', 'description'] };
        for (const key of defaults[pillar] || []) if (content[key] == null) content[key] = '';
    }
    for (const key of ROOT_FIELDS) if (Object.hasOwn(content, key)) walk(content[key], [key], CORRECTION_FIELDS[key]);
    return fields;
}

export function makeCorrectionRows(library) {
    return Object.entries(library).flatMap(([pillar, entries]) => (entries || []).filter(e => e?.id).map(entry => {
        const fields = correctionFields(entry, pillar);
        return { key: `${pillar}:${entry.id}`, pillar, entry, fields, text: normalize(fields.map(f => f.value).join(' ')),
            title: entry.name || entry.title || entry.label || entry.event || entry.text || `${CORRECTION_LABELS[pillar]} ${entry.id}` };
    }));
}

export async function loadCorrectionRows(chatId) {
    const [npc, item, milestone, mem, realtime, timeline, map, board] = await Promise.all([
        store.getNpcProfiles(chatId), store.getItems(chatId), store.getMilestones(chatId), store.getMemories(chatId),
        store.getRealtimeMemories(chatId), store.getTimeline(chatId), getLocations(chatId), getClueBoard(chatId),
    ]);
    // 不过滤 category、tier、归档状态、注入权限，不采用生成检索的 Top-K。
    return makeCorrectionRows({ npc, item, milestone, mem, realtime, timeline, map, clue: board.nodes, connection: board.connections });
}

const SYNONYMS = [
    ['职业', '工作', '身份', '职务', '任职', '就职', '岗位'], ['医生', '医师', '大夫', '医务'],
    ['老师', '教师', '教授', '讲师', '教员'], ['学生', '学员', '同学'], ['警察', '警官', '刑警', '民警'],
    ['姓名', '名字', '别名', '称呼'], ['关系', '亲属', '父亲', '母亲', '兄弟', '姐妹', '恋人'],
];
const STOP = new Set(['记忆', '错误', '纠错', '搞错', '搞混', '混了', '不是', '应该', '其实', '为什么', '怎么', '这个', '那个', '一个', '有误', '查找', '找到', '修改', '角色']);

export function correctionTerms(query, fuzzy = true) {
    const exact = new Set();
    const add = term => {
        const v = normalize(term);
        if (v && !STOP.has(v) && (v.length > 1 || /^[a-z0-9]$/i.test(v) || normalize(query) === v)) exact.add(v);
    };
    // 词边界由浏览器分词器提供；旧浏览器仍可用空格、引号和汉字片段搜索。
    if (typeof Intl.Segmenter === 'function') {
        for (const part of new Intl.Segmenter('zh', { granularity: 'word' }).segment(query)) if (part.isWordLike) add(part.segment);
    }
    for (const part of query.match(/[\p{L}\p{N}_]+/gu) || []) add(part);
    const fragments = new Set();
    if (fuzzy) for (const run of query.match(/[\p{Script=Han}]+/gu) || []) {
        for (let i = 0; i < run.length - 1; i++) { const term = run.slice(i, i + 2); if (!STOP.has(term)) fragments.add(term); }
    }
    for (const group of SYNONYMS) if (group.some(word => query.includes(word))) group.forEach(add);
    return { exact: [...exact], fragments: [...fragments] };
}

export function searchCorrectionRows(rows, query, settings = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const terms = correctionTerms(q, settings.correctionFuzzyEnabled !== false);
    const results = new Map();
    const add = (row, reason, score) => {
        if (!results.has(row.key)) results.set(row.key, { ...row, reasons: [], score: 0 });
        const hit = results.get(row.key);
        if (!hit.reasons.includes(reason)) { hit.reasons.push(reason); hit.score += score; }
    };
    const entities = rows.filter(row => ['npc', 'item', 'map'].includes(row.pillar)).map(row => ({ row,
        names: [row.entry.name, ...[row.entry.aliases, row.entry.alias].flatMap(value => Array.isArray(value) ? value : [value])].filter(v => typeof v === 'string' && v.trim()).map(normalize),
    }));
    const mentioned = entities.filter(e => e.names.some(name => normalize(q).includes(name)));
    for (const row of rows) {
        for (const term of terms.exact) if (row.text.includes(term)) add(row, `关键词：${term}`, 10);
        for (const term of terms.fragments) if (row.text.includes(term)) add(row, `近似片段：${term}`, 1);
        for (const entity of mentioned) if (row.key === entity.row.key || entity.names.some(name => row.text.includes(name))) {
            add(row, `人物/对象关联：${entity.row.entry.name}`, 30);
        }
        if (/职业|工作|身份|职务/.test(q) && row.pillar === 'npc' && row.entry.role) add(row, '职业/身份字段（宽范围候选）', 2);
    }
    if (settings.correctionRelatedEnabled !== false) {
        const aliases = { memory: 'mem', memories: 'mem', items: 'item', npcs: 'npc', rt: 'realtime', location: 'map' };
        const refs = row => {
            const e = row.entry, keys = [];
            if (e.refId) keys.push(`${e.refType === 'timeline' && row.pillar === 'clue' ? 'milestone' : aliases[e.refType] || e.refType}:${e.refId}`);
            if (e.promotedTo?.id) keys.push(`${aliases[e.promotedTo.pillar] || e.promotedTo.pillar}:${e.promotedTo.id}`);
            for (const id of e.relatedMemoryIds || []) keys.push(`mem:${id}`);
            if (row.pillar === 'map') for (const edge of e.edges || []) if (edge.toId) keys.push(`map:${edge.toId}`);
            if (row.pillar === 'map' && e.parentId) keys.push(`map:${e.parentId}`);
            if (row.pillar === 'timeline') for (const entry of e.entries || []) if (entry.refId) keys.push(`milestone:${entry.refId}`);
            if (e.parentThreadId) keys.push(`timeline:${e.parentThreadId}`);
            if (e.parentId && row.pillar === 'clue') keys.push(`clue:${e.parentId}`);
            for (const id of [e.fromNodeId, e.toNodeId].filter(Boolean)) keys.push(`clue:${id}`);
            return keys;
        };
        // 明确引用连通分量取闭包，不因限制两跳而漏掉间接线索。
        const byKey = new Map(rows.map(row => [row.key, row]));
        const adjacent = new Map(rows.map(row => [row.key, new Set()]));
        for (const row of rows) for (const key of refs(row)) {
            if (!byKey.has(key)) continue;
            adjacent.get(row.key).add(key); adjacent.get(key).add(row.key);
        }
        const queue = [...results.keys()];
        for (let i = 0; i < queue.length; i++) {
            const key = queue[i];
            for (const next of adjacent.get(key)) if (!results.has(next)) {
                add(byKey.get(next), `引用关联：${byKey.get(key).title}`, 1);
                queue.push(next);
            }
        }
    }
    return [...results.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

export function buildCorrectionPatch(row, values) {
    const patch = {};
    const fields = correctionFields(row.entry, row.pillar, { includeEmpty: true });
    for (const [index, field] of fields.entries()) {
        const value = values[index];
        if (value === undefined || String(value) === String(field.value)) continue;
        const [root, ...path] = field.path;
        if (!Object.hasOwn(patch, root)) patch[root] = row.entry[root] === undefined ? '' : clone(row.entry[root]);
        const typed = typeof field.value === 'boolean' ? value === true || value === 'true'
            : typeof field.value === 'number' ? Number(value) : String(value);
        if (typeof typed === 'number' && !Number.isFinite(typed)) throw new Error(`${field.label}必须是数字`);
        if (!path.length) patch[root] = typed;
        else { let target = patch[root]; for (const key of path.slice(0, -1)) target = target[key]; target[path.at(-1)] = typed; }
    }
    for (const required of ['name', 'title', 'event', 'text']) {
        if (Object.hasOwn(patch, required) && !String(patch[required]).trim()) throw new Error('名称/标题/事件/内容不能为空');
    }
    return patch;
}

export async function saveCorrection(chatId, row, patch) {
    const current = (await loadCorrectionRows(chatId)).find(r => r.key === row.key);
    if (!current) throw new Error('条目已不存在，请重新查找');
    for (const key of Object.keys(patch)) if (JSON.stringify(current.entry[key]) !== JSON.stringify(row.entry[key])) {
        throw new Error('该字段已被其它操作更新，请重新查找后修改');
    }
    if (!Object.keys(patch).length) return { changed: false };
    // 旧向量代表错误文本，不能继续命中；后续可使用现有补全向量功能重建。
    const safe = ['realtime', 'clue', 'connection'].includes(row.pillar) ? { ...patch }
        : { ...patch, embedding: null, embeddingRef: null, _bbmemSourceRollback: null };
    if (row.entry.kind === 'schedule' && Object.hasOwn(patch, 'dayLabel')) {
        if (!String(patch.dayLabel).trim()) throw new Error('日程日期不能为空');
        const sameDay = (await store.getRealtimeMemories(chatId)).find(e => e.kind === 'schedule' && e.dayLabel === patch.dayLabel);
        Object.assign(safe, { dayKey: sameDay?.dayKey || scheduleDayKey(patch.dayLabel), dayOrder: sameDay?.dayOrder || row.entry.dayOrder, storyTime: patch.dayLabel });
    }
    const writers = { npc: store.updateNpcProfile, item: store.updateItem, milestone: store.updateMilestone,
        mem: store.updateMemory, realtime: store.updateRealtimeMemory, map: updateLocation,
        timeline: (chat, id, data) => store.upsertTimeline(chat, { ...data, id }), clue: updateClueNode, connection: updateClueConnection };
    const result = await writers[row.pillar](chatId, row.entry.id, safe);
    if (!result) throw new Error('条目保存失败或已被删除');
    return { changed: true, entry: result };
}
