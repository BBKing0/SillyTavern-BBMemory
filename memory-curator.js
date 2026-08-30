/**
 * memory-curator.js — BB-Memory v9.3.3 AI 记忆整理师
 *
 * 解决增量两两去重的结构性盲区：`findBestDuplicate` 只让每条新条目与已有条目
 * 逐一比较并取最高分，因此「渐进细化」型重复（5 条同一件事逐层补细节，相邻
 * 两条相似度都在 0.8 上下但谁也过不了 0.85 合并线）永远无法合并。
 *
 * 本模块加一层**跨条目聚类**：用松阈值建边 + 并查集把整条细化链聚成一组，
 * 一次性交给 AI 重写为最终态。
 *
 * 阶段一 Task 1 只包含纯函数聚类引擎，零 API 调用，可在浏览器控制台自检。
 */

import {
    charBigrams,
    cosineSimilarity,
    diceFromBigrams,
    entityNameSimilarity,
} from './dedup-engine.js';
import { hydrateCollectionEmbeddings } from './vector-store.js';
import {
    getSettings, updateSettings, getCalendarDescription, restoreEntriesVerbatim,
    getMemories, addMemory, updateMemory, removeMemory,
    getNpcProfiles, addNpcProfile, updateNpcProfile, removeNpcProfile,
    getItems, addItem, updateItem, removeItem,
    getMilestones, addMilestone, updateMilestone, removeMilestone,
    getTimeline, upsertTimeline, removeTimeline,
} from './memory-store.js';
import { mergeEntityAliases } from './dedup-engine.js';
import { callCustomApi, callMainApi } from './auto-generator.js';
import {
    DEFAULT_CONCRETE_TIME_RULE,
    DEFAULT_CURATE_REVIEW_PROMPT,
    fillPromptTemplate,
    getPromptTemplate,
} from './prompt-templates.js';

// ═══════════════════════════════════════════════════════════
//  柱定义与默认参数
// ═══════════════════════════════════════════════════════════

/** 整理师支持的柱。键名与 memory-agent.js / 设置项保持一致。 */
export const CURATION_PILLARS = Object.freeze(['mem', 'npc', 'item', 'milestone', 'timeline']);

/** 各柱参与相似度计算的字段，顺序即拼接顺序（名称类字段放前面）。 */
const PILLAR_TEXT_FIELDS = Object.freeze({
    // 与 dedup-engine.js 的 memoryText 对齐，保证聚类分数与去重分数可比。
    mem: ['title', 'summary', 'content', 'verbatim'],
    npc: ['name', 'role', 'personality', 'appearance', 'status', 'location', 'indexCard'],
    item: ['name', 'owner', 'status', 'location', 'significance', 'indexCard'],
    milestone: ['storyTime', 'event', 'summary', 'location', 'impact'],
    timeline: ['name', 'type', 'summary'],
});

/** 实体柱额外启用名称/别名相似度（「睡裙」vs「白色刺猬睡裙」）。 */
const NAME_AWARE_PILLARS = Object.freeze(new Set(['npc', 'item']));

export const CURATION_DEFAULTS = Object.freeze({
    recallPerEntry: 5,      // aiCurateRecallPerEntry：每条新条目召回多少条同柱相关旧条目
    clusterThreshold: 0.65, // aiCurateClusterThreshold：建边用的松阈值，远低于 0.85 合并线
    maxGroups: 8,           // aiCurateMaxGroupsPerRun：单次最多整理多少组
    maxGroupSize: 10,       // 单组上限，防止松阈值下整库连成一个巨型连通块撑爆提示词
});

// ═══════════════════════════════════════════════════════════
//  小工具
// ═══════════════════════════════════════════════════════════

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampFloat(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

export function normalizeCurationPillar(value) {
    const raw = String(value || '').trim();
    if (CURATION_PILLARS.includes(raw)) return raw;
    // 容错：接受 memory-store / retriever 里出现过的别名。
    const aliases = {
        memory: 'mem',
        memories: 'mem',
        items: 'item',
        milestones: 'milestone',
        timeline_entry: 'milestone',
        thread: 'timeline',
        threads: 'timeline',
    };
    return aliases[raw] || 'mem';
}

function isEntryArchived(entry) {
    return entry?.archived === true || entry?.memoryTier === 'archived';
}

/** 按柱拼出参与相似度计算的文本。缺字段自动跳过，不留空行。 */
export function curationEntryText(entry, pillar) {
    const fields = PILLAR_TEXT_FIELDS[normalizeCurationPillar(pillar)] || PILLAR_TEXT_FIELDS.mem;
    const parts = [];
    for (const field of fields) {
        const value = entry?.[field];
        if (typeof value === 'string' && value.trim()) parts.push(value.trim());
    }
    // 时间线的 entries 子表也参与比较，否则两条时间线只靠名称区分。
    if (normalizeCurationPillar(pillar) === 'timeline' && Array.isArray(entry?.entries)) {
        for (const sub of entry.entries.slice(0, 12)) {
            const line = [sub?.period, sub?.event].filter(v => typeof v === 'string' && v.trim()).join(' ');
            if (line) parts.push(line);
        }
    }
    return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════
//  相似度
// ═══════════════════════════════════════════════════════════

function makeNode(entry, index, pillar) {
    const text = curationEntryText(entry, pillar);
    return {
        index,
        id: String(entry.id),
        entry,
        text,
        bigrams: charBigrams(text),
        vector: Array.isArray(entry.embedding) && entry.embedding.length ? entry.embedding : null,
    };
}

/**
 * 两节点相似度 = max(向量余弦, 文本 Dice, 实体名称相似度)。
 * 没有向量时 cosineSimilarity 返回 0，自动降级为文本比较。
 */
export function curationPairSimilarity(left, right, pillar) {
    const normalizedPillar = normalizeCurationPillar(pillar);
    const vector = cosineSimilarity(left.vector, right.vector);
    const text = diceFromBigrams(left.bigrams, right.bigrams);
    const name = NAME_AWARE_PILLARS.has(normalizedPillar)
        ? entityNameSimilarity(normalizedPillar, left.entry, right.entry)
        : 0;
    const score = Math.max(vector, text, name);
    let basis = 'text';
    if (score > 0) {
        if (score === vector) basis = 'vector';
        else if (score === name) basis = 'name';
    }
    return { score, vector, text, name, basis };
}

// ═══════════════════════════════════════════════════════════
//  并查集
// ═══════════════════════════════════════════════════════════

function makeUnionFind(size) {
    const parent = new Int32Array(size);
    for (let i = 0; i < size; i++) parent[i] = i;
    function find(x) {
        let root = x;
        while (parent[root] !== root) {
            parent[root] = parent[parent[root]];
            root = parent[root];
        }
        return root;
    }
    function union(a, b) {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) return false;
        parent[rb] = ra;
        return true;
    }
    return { find, union };
}

/**
 * 组内超过 maxGroupSize 时贪心裁剪：从最强边出发，每次并入与已选集合相似度最高的成员。
 * 结果确定（同输入同输出），保留的是这个连通块里最紧密的核心。
 */
function trimGroup(memberIndices, localEdges, maxGroupSize) {
    if (memberIndices.length <= maxGroupSize) return memberIndices;
    if (!localEdges.length) return memberIndices.slice(0, maxGroupSize);
    const kept = [localEdges[0].a, localEdges[0].b];
    const keptSet = new Set(kept);
    while (kept.length < maxGroupSize) {
        let picked = -1;
        for (const edge of localEdges) {
            const hasA = keptSet.has(edge.a);
            const hasB = keptSet.has(edge.b);
            if (hasA === hasB) continue; // 两端都在或都不在，跳过
            picked = hasA ? edge.b : edge.a;
            break; // localEdges 已按分数降序，第一条合格边就是最优
        }
        if (picked < 0) break;
        kept.push(picked);
        keptSet.add(picked);
    }
    return kept;
}

// ═══════════════════════════════════════════════════════════
//  聚类主函数
// ═══════════════════════════════════════════════════════════

function normalizeSeedIds(newIds, idToIndex) {
    const source = newIds instanceof Set ? [...newIds] : (Array.isArray(newIds) ? newIds : []);
    const out = new Set();
    for (const raw of source) {
        const id = String(raw?.id ?? raw ?? '').trim();
        if (!id) continue;
        const index = idToIndex.get(id);
        if (index !== undefined) out.add(index);
    }
    return out;
}

/**
 * 纯函数：把条目聚成待整理的候选组。
 *
 * @param {Array<object>} entries 同一柱的全部条目（可预先 hydrate embedding）
 * @param {Array<string>|Set<string>} newIds 本批新条目 id；为空时把全部条目当种子（全库整理）
 * @param {object} config { pillar, recallPerEntry, clusterThreshold, maxGroups, maxGroupSize, includeArchived }
 * @returns {{ pillar, groups, stats }}
 */
export function buildCurationGroups(entries, newIds, config = {}) {
    const pillar = normalizeCurationPillar(config.pillar);
    const recallPerEntry = clampInt(config.recallPerEntry, 1, 50, CURATION_DEFAULTS.recallPerEntry);
    const clusterThreshold = clampFloat(config.clusterThreshold, 0.2, 0.99, CURATION_DEFAULTS.clusterThreshold);
    const maxGroups = clampInt(config.maxGroups, 1, 50, CURATION_DEFAULTS.maxGroups);
    const maxGroupSize = clampInt(config.maxGroupSize, 2, 40, CURATION_DEFAULTS.maxGroupSize);
    const includeArchived = config.includeArchived === true;

    const pool = (Array.isArray(entries) ? entries : []).filter(entry =>
        entry && typeof entry === 'object' && entry.id && (includeArchived || !isEntryArchived(entry)));

    const stats = {
        pillar,
        clusterThreshold,
        recallPerEntry,
        maxGroups,
        maxGroupSize,
        poolSize: pool.length,
        seedCount: 0,
        comparisons: 0,
        edgeCount: 0,
        vectorEdges: 0,
        textEdges: 0,
        nameEdges: 0,
        componentCount: 0,
        singletonCount: 0,
        groupCount: 0,
        trimmedGroups: 0,
        vectorCoverage: 0,
    };

    if (pool.length < 2) return { pillar, groups: [], stats };

    const nodes = pool.map((entry, index) => makeNode(entry, index, pillar));
    stats.vectorCoverage = nodes.filter(node => node.vector).length / nodes.length;

    const idToIndex = new Map(nodes.map(node => [node.id, node.index]));
    const seedSet = normalizeSeedIds(newIds, idToIndex);
    const seeds = seedSet.size ? [...seedSet].sort((a, b) => a - b) : nodes.map(node => node.index);
    stats.seedCount = seeds.length;

    // ── 每条种子召回 top-K，松阈值建边 ──
    const edges = [];
    const edgeSeen = new Set();
    for (const seedIndex of seeds) {
        const seed = nodes[seedIndex];
        const candidates = [];
        for (const node of nodes) {
            if (node.index === seedIndex) continue;
            stats.comparisons++;
            const detail = curationPairSimilarity(seed, node, pillar);
            if (detail.score <= 0) continue;
            candidates.push({ index: node.index, ...detail });
        }
        candidates.sort((a, b) => (b.score - a.score) || (a.index - b.index));
        for (const candidate of candidates.slice(0, recallPerEntry)) {
            if (candidate.score < clusterThreshold) break; // 已降序排列
            const a = Math.min(seedIndex, candidate.index);
            const b = Math.max(seedIndex, candidate.index);
            const key = `${a}|${b}`;
            if (edgeSeen.has(key)) continue;
            edgeSeen.add(key);
            edges.push({ a, b, score: candidate.score, basis: candidate.basis });
            if (candidate.basis === 'vector') stats.vectorEdges++;
            else if (candidate.basis === 'name') stats.nameEdges++;
            else stats.textEdges++;
        }
    }
    stats.edgeCount = edges.length;
    if (!edges.length) return { pillar, groups: [], stats };

    // ── 并查集聚组 ──
    const uf = makeUnionFind(nodes.length);
    for (const edge of edges) uf.union(edge.a, edge.b);

    const buckets = new Map();
    for (const node of nodes) {
        const root = uf.find(node.index);
        if (!buckets.has(root)) buckets.set(root, []);
        buckets.get(root).push(node.index);
    }
    stats.componentCount = buckets.size;

    const edgesByRoot = new Map();
    for (const edge of edges) {
        const root = uf.find(edge.a);
        if (!edgesByRoot.has(root)) edgesByRoot.set(root, []);
        edgesByRoot.get(root).push(edge);
    }

    // ── 丢单例，裁剪超大组，组装结果 ──
    const groups = [];
    for (const [root, members] of buckets) {
        if (members.length < 2) {
            stats.singletonCount++;
            continue;
        }
        const localEdges = (edgesByRoot.get(root) || []).slice().sort((x, y) => (y.score - x.score) || (x.a - y.a) || (x.b - y.b));
        const keptIndices = trimGroup(members.slice().sort((a, b) => a - b), localEdges, maxGroupSize);
        if (keptIndices.length < 2) continue;
        if (keptIndices.length < members.length) stats.trimmedGroups++;

        const keptSet = new Set(keptIndices);
        const keptEdges = localEdges.filter(edge => keptSet.has(edge.a) && keptSet.has(edge.b));
        if (!keptEdges.length) continue;

        const sortedIndices = keptIndices.slice().sort((a, b) => a - b);
        const groupNodes = sortedIndices.map(index => nodes[index]);
        const scores = keptEdges.map(edge => edge.score);
        const maxSimilarity = Math.max(...scores);
        const avgSimilarity = scores.reduce((sum, value) => sum + value, 0) / scores.length;
        const ids = groupNodes.map(node => node.id);

        groups.push({
            key: `${pillar}:${ids.slice().sort().join(',')}`,
            pillar,
            ids,
            entries: groupNodes.map(node => node.entry),
            seedIds: ids.filter(id => seedSet.has(idToIndex.get(id))),
            maxSimilarity,
            avgSimilarity,
            pairs: keptEdges.map(edge => ({
                a: nodes[edge.a].id,
                b: nodes[edge.b].id,
                score: edge.score,
                basis: edge.basis,
            })),
        });
    }

    groups.sort((a, b) =>
        (b.maxSimilarity - a.maxSimilarity)
        || (b.ids.length - a.ids.length)
        || a.key.localeCompare(b.key));

    const limited = groups.slice(0, maxGroups);
    stats.groupCount = limited.length;
    return { pillar, groups: limited, stats };
}

/**
 * 异步包装：先把压缩向量 hydrate 回条目，再聚类。
 * hydrate 失败不阻断，直接降级到纯文本相似度。
 */
export async function prepareCurationGroups(chatId, pillar, entries, newIds, config = {}) {
    const pool = Array.isArray(entries) ? entries : [];
    try {
        await hydrateCollectionEmbeddings(chatId, pool);
    } catch (e) {
        console.warn('[BB-Memory] 整理师向量 hydrate 失败，降级为文本相似度:', e);
    }
    return buildCurationGroups(pool, newIds, { ...config, pillar });
}

// ═══════════════════════════════════════════════════════════
//  Task 2：提示词构建 / API 调用 / 操作解析
// ═══════════════════════════════════════════════════════════

/** 整理师允许的操作类型。 */
export const CURATION_OPS = Object.freeze(['merge', 'rewrite', 'split', 'delete', 'keep']);

/** 会改变数据的操作（keep 不算），用于授权矩阵与撤销快照。 */
export const CURATION_WRITE_OPS = Object.freeze(['merge', 'rewrite', 'split', 'delete']);

export const PILLAR_LABELS = Object.freeze({
    mem: '记忆条目',
    npc: 'NPC 档案',
    item: '物品',
    milestone: '里程碑',
    timeline: '时间线',
});

/**
 * AI 可以写入的字段白名单。
 * 刻意排除 id / createdAt / hitScore / hitCount / memoryTier / embeddingRef / source*
 * 等系统字段——整理师只负责内容，不许改统计、等级和来源归属。
 */
const PILLAR_WRITABLE_FIELDS = Object.freeze({
    mem: Object.freeze(['title', 'type', 'summary', 'content', 'verbatim', 'subject', 'target',
        'storyTime', 'importance', 'emotionalWeight', 'tags', 'truthStatus']),
    npc: Object.freeze(['name', 'aliases', 'role', 'personality', 'appearance', 'status',
        'location', 'indexCard', 'relationships', 'tags']),
    item: Object.freeze(['name', 'aliases', 'owner', 'status', 'location', 'significance', 'tags']),
    milestone: Object.freeze(['storyTime', 'event', 'summary', 'participants', 'location',
        'status', 'impact', 'tags']),
    timeline: Object.freeze(['name', 'type', 'status', 'priority', 'summary', 'entries']),
});

/** 提示词里给 AI 看的字段说明。 */
const PILLAR_FIELD_HINTS = Object.freeze({
    mem: '- 记忆条目 mem：title 标题 / type(event|emotion|habit|fact) / summary 一句话摘要 / content 事实摘要 / verbatim 关键原话 / subject 主体 / target 对象 / storyTime 具体故事时间 / importance 0~1 / emotionalWeight 0~1 / tags 标签数组 / truthStatus(true|false|unknown|rumor|misleading|secret_true)',
    npc: '- NPC npc：name 姓名 / aliases 别名数组 / role 身份 / personality 性格 / appearance 外貌 / status 状态 / location 所在地 / indexCard 一句话索引卡 / relationships 关系数组 / tags',
    item: '- 物品 item：name 物品名 / aliases 别名数组 / owner 持有者 / status(held|used|lost|destroyed) / location 所在地点 / significance 意义与用途 / tags',
    milestone: '- 里程碑 milestone：storyTime 具体时间 / event 事件摘要 / summary 补充说明 / participants 参与者数组 / location 地点 / status(ongoing|ended|foreshadow) / impact 影响 / tags',
    timeline: '- 时间线 timeline：name 时间线名 / type(plot|emotional|side|world) / status(ongoing|paused|ended|resident) / priority(high|medium|low) / summary 一句话总结 / entries 条目数组',
});

const MAX_ENTRY_CHARS_IN_PROMPT = 420;
/** 缝合痕迹：出现即判定违反「必须重写成最终态」，转人工确认。 */
const SPLICE_MARKER_PATTERN = /\[\s*(?:补充|补记|追加|附|新增|更新)\s*\]|【\s*(?:补充|补记|追加|新增)\s*】/;

function isEternal(entry) {
    return entry?.memoryTier === 'eternal';
}

function truncate(value, max) {
    const text = String(value ?? '').trim();
    return text.length > max ? text.slice(0, max) + '…' : text;
}

// ── 提示词构建 ──

function formatEntryForPrompt(entry, pillar) {
    const fields = PILLAR_WRITABLE_FIELDS[pillar] || PILLAR_WRITABLE_FIELDS.mem;
    const parts = [];
    for (const field of fields) {
        const value = entry?.[field];
        if (value == null) continue;
        if (Array.isArray(value)) {
            const flat = value
                .map(v => (typeof v === 'string' ? v : (v?.name || v?.event || v?.period || '')))
                .filter(Boolean)
                .join('、');
            if (flat) parts.push(`${field}=${truncate(flat, 120)}`);
        } else if (typeof value === 'number') {
            parts.push(`${field}=${value}`);
        } else if (typeof value === 'string' && value.trim()) {
            parts.push(`${field}=${truncate(value, MAX_ENTRY_CHARS_IN_PROMPT)}`);
        }
    }
    const flags = [];
    if (isEternal(entry)) flags.push('永恒·禁止删除/拆分/被吸收');
    else if (entry?.memoryTier) flags.push(`层级=${entry.memoryTier}`);
    if (entry?.truthStatus && entry.truthStatus !== 'true') flags.push(`真值=${entry.truthStatus}`);
    return `  · id=${entry.id}${flags.length ? ` [${flags.join('；')}]` : ''}\n    ${parts.join(' | ') || '(无内容)'}`;
}

export function formatGroupsForPrompt(groups) {
    return (Array.isArray(groups) ? groups : []).map((group, index) => {
        const pillar = normalizeCurationPillar(group.pillar);
        const header = `【第 ${index + 1} 组】柱=${pillar}（${PILLAR_LABELS[pillar] || pillar}）`
            + ` 共 ${group.entries?.length || 0} 条，组内最高相似度 ${Number(group.maxSimilarity || 0).toFixed(2)}`;
        const body = (group.entries || []).map(entry => formatEntryForPrompt(entry, pillar)).join('\n');
        return `${header}\n${body}`;
    }).join('\n\n');
}

function buildFieldSpec(groups) {
    const pillars = [...new Set((Array.isArray(groups) ? groups : []).map(g => normalizeCurationPillar(g.pillar)))];
    const used = pillars.length ? pillars : ['mem'];
    return used.map(pillar => PILLAR_FIELD_HINTS[pillar]).filter(Boolean).join('\n');
}

export function buildCurationPrompt(groups, options = {}) {
    const settings = options.settings || {};
    const template = getPromptTemplate(settings, 'curate.review', DEFAULT_CURATE_REVIEW_PROMPT);
    const calendar = String(options.calendarDescription || '').trim();
    return fillPromptTemplate(template, {
        fieldSpec: buildFieldSpec(groups),
        groupsText: formatGroupsForPrompt(groups),
        CONCRETE_TIME_RULE: getPromptTemplate(settings, 'extract.concreteTimeRule', DEFAULT_CONCRETE_TIME_RULE),
        calRef: calendar ? `\n## 世界日历参考\n${calendar}` : '',
    });
}

// ── 操作解析与校验（纯函数） ──

/** 从可能夹带说明文字/代码块的响应里抠出 JSON 对象。与 parseMergedResponse 同策略。 */
function extractJsonObject(rawText) {
    let text = String(rawText || '').trim();
    if (!text) return null;
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
        try { return JSON.parse(objectMatch[0]); } catch { /* 继续尝试数组 */ }
    }
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        try {
            const parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed)) return { ops: parsed };
        } catch { /* 放弃 */ }
    }
    return null;
}

function buildEntryIndex(groups, extraEntries) {
    const index = new Map();
    const put = (pillar, entry) => {
        if (!entry?.id) return;
        const key = normalizeCurationPillar(pillar);
        if (!index.has(key)) index.set(key, new Map());
        index.get(key).set(String(entry.id), entry);
    };
    for (const group of (Array.isArray(groups) ? groups : [])) {
        for (const entry of (group?.entries || [])) put(group.pillar, entry);
    }
    for (const [pillar, entries] of Object.entries(extraEntries || {})) {
        for (const entry of (Array.isArray(entries) ? entries : [])) put(pillar, entry);
    }
    return index;
}

function normalizeIds(value) {
    const source = Array.isArray(value) ? value : (value == null ? [] : [value]);
    const out = [];
    const seen = new Set();
    for (const raw of source) {
        const id = String(raw?.id ?? raw ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/** 只保留白名单字段，并做基本类型收敛。 */
function sanitizeResult(raw, pillar) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const allowed = PILLAR_WRITABLE_FIELDS[pillar] || PILLAR_WRITABLE_FIELDS.mem;
    const out = {};
    for (const field of allowed) {
        if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
        const value = raw[field];
        if (value == null) continue;
        if (field === 'importance' || field === 'emotionalWeight') {
            const n = Number(value);
            if (Number.isFinite(n)) out[field] = Math.max(0, Math.min(1, n));
        } else if (field === 'tags') {
            const tags = (Array.isArray(value) ? value : String(value).split(/[,，、]/))
                .map(t => (typeof t === 'string' ? t.trim() : (t?.name ? String(t.name).trim() : '')))
                .filter(Boolean)
                .map(name => ({ name, weight: 0.6 }));
            if (tags.length) out.tags = tags;
        } else if (field === 'aliases' || field === 'participants') {
            const list = (Array.isArray(value) ? value : String(value).split(/[,，、]/))
                .map(v => (typeof v === 'string' ? v.trim() : String(v?.name || '').trim()))
                .filter(Boolean);
            if (list.length) out[field] = list;
        } else if (field === 'relationships' || field === 'entries') {
            if (Array.isArray(value) && value.length) out[field] = value.filter(v => v && typeof v === 'object');
        } else if (typeof value === 'string') {
            const text = value.trim();
            if (text) out[field] = text;
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            out[field] = value;
        }
    }
    return Object.keys(out).length ? out : null;
}

/** 主要内容字段，用于判断 result 是否为空、以及是否发生信息量退化。 */
function primaryContentOf(value, pillar) {
    if (!value) return '';
    if (pillar === 'npc' || pillar === 'item') {
        return String(value.significance || value.indexCard || value.personality || value.role || value.name || '');
    }
    if (pillar === 'milestone') return String(value.event || value.summary || value.impact || '');
    if (pillar === 'timeline') return String(value.summary || value.name || '');
    return String(value.content || value.summary || value.title || '');
}

/**
 * 解析并校验整理操作。纯函数，不读库不发请求。
 *
 * @param {string} rawText AI 原始响应
 * @param {object} options { groups, entries, allowedPillars }
 * @returns {{ ops, rejected, parsed, totalReturned }}
 */
export function parseCurationOps(rawText, options = {}) {
    const groups = Array.isArray(options.groups) ? options.groups : [];
    const index = buildEntryIndex(groups, options.entries);
    const groupPillarById = new Map();
    for (const group of groups) {
        for (const entry of (group?.entries || [])) {
            if (entry?.id) groupPillarById.set(String(entry.id), normalizeCurationPillar(group.pillar));
        }
    }

    const ops = [];
    const rejected = [];
    const consumed = new Set(); // `${pillar}:${id}`，防止同一条目被两个写操作同时改

    const parsed = extractJsonObject(rawText);
    if (!parsed) {
        return {
            ops: [],
            rejected: [{ reason: '响应里找不到可解析的 JSON', snippet: truncate(rawText, 200) }],
            parsed: null,
            totalReturned: 0,
        };
    }

    const rawOps = Array.isArray(parsed.ops) ? parsed.ops
        : (Array.isArray(parsed.operations) ? parsed.operations
            : (Array.isArray(parsed) ? parsed : []));
    if (!rawOps.length) {
        return {
            ops: [],
            rejected: [{ reason: '响应里没有 ops 数组' }],
            parsed,
            totalReturned: 0,
        };
    }

    for (const raw of rawOps) {
        const reject = (reason) => rejected.push({
            op: raw?.op, pillar: raw?.pillar, ids: normalizeIds(raw?.ids ?? raw?.id), reason,
        });
        if (!raw || typeof raw !== 'object') { reject('操作不是对象'); continue; }

        const op = String(raw.op || raw.action || '').trim().toLowerCase();
        if (!CURATION_OPS.includes(op)) { reject(`未知操作类型「${raw.op ?? ''}」`); continue; }

        const ids = normalizeIds(raw.ids ?? raw.id);
        if (!ids.length) { reject('缺少 ids'); continue; }

        // pillar 缺失时按 ids 反推
        const declaredPillar = raw.pillar ? normalizeCurationPillar(raw.pillar) : '';
        const inferredPillar = groupPillarById.get(ids[0]) || '';
        const pillar = declaredPillar || inferredPillar || 'mem';
        if (!CURATION_PILLARS.includes(pillar)) { reject(`非法柱「${raw.pillar}」`); continue; }
        if (Array.isArray(options.allowedPillars) && options.allowedPillars.length
            && !options.allowedPillars.includes(pillar)) {
            reject(`本次整理不包含柱「${pillar}」`); continue;
        }

        // ids 必须都真实存在
        const pillarIndex = index.get(pillar);
        const targets = [];
        let missing = '';
        for (const id of ids) {
            const entry = pillarIndex?.get(id);
            if (!entry) { missing = id; break; }
            targets.push(entry);
        }
        if (missing) { reject(`id 不存在或不属于该柱：${missing}`); continue; }

        // 同一批次内不允许重复处理同一条目
        const clash = ids.find(id => consumed.has(`${pillar}:${id}`));
        if (clash) { reject(`条目 ${clash} 已被本批次前一个操作占用`); continue; }

        const notes = [];
        let forceConfirm = false;
        const normalized = {
            op,
            pillar,
            ids,
            reason: truncate(raw.reason || raw.why || '', 300),
            notes,
        };

        if (op === 'keep') {
            normalized.entryLabels = buildEntryLabels(targets, pillar);
            ops.push(normalized);
            continue; // keep 不消耗条目
        }

        // ── 永恒保护 ──
        const eternals = targets.filter(isEternal);
        if (eternals.length && (op === 'delete' || op === 'split')) {
            reject(`永恒条目禁止 ${op}：${eternals.map(e => e.id).join('、')}`); continue;
        }

        if (op === 'merge') {
            if (ids.length < 2) { reject('merge 至少需要 2 条 ids'); continue; }
            let keepId = String(raw.keepId || raw.keep || '').trim();
            if (!keepId || !ids.includes(keepId)) {
                keepId = eternals.length === 1 ? eternals[0].id : ids[0];
                notes.push(`keepId 缺失或不在 ids 内，已改为 ${keepId}`);
            }
            // 永恒条目只能当保留方，不能被吸收
            const absorbedEternals = eternals.filter(e => e.id !== keepId);
            if (absorbedEternals.length) {
                if (eternals.length === 1) {
                    notes.push(`永恒条目 ${eternals[0].id} 不能被吸收，keepId 已改为它`);
                    keepId = eternals[0].id;
                    forceConfirm = true;
                } else {
                    reject(`merge 里有多条永恒条目，无法确定保留哪条：${eternals.map(e => e.id).join('、')}`);
                    continue;
                }
            }
            const result = sanitizeResult(raw.result || raw.merged, pillar);
            if (!result) { reject('merge 缺少可用的 result（重写后的字段）'); continue; }
            const mergedContent = primaryContentOf(result, pillar);
            if (!mergedContent.trim()) { reject('merge 的 result 主内容为空'); continue; }

            // 规则 1：禁止缝合式合并
            if (SPLICE_MARKER_PATTERN.test(mergedContent)) {
                notes.push('result 含拼接痕迹，未按要求重写成最终态');
                forceConfirm = true;
            }
            // 规则 2：信息量退化检测
            const longestSource = Math.max(...targets.map(e => primaryContentOf(e, pillar).length), 0);
            if (longestSource > 0 && mergedContent.length < longestSource * 0.6) {
                notes.push(`result 比最长原文短很多（${mergedContent.length} vs ${longestSource} 字），可能丢信息`);
                forceConfirm = true;
            }
            normalized.keepId = keepId;
            normalized.removeIds = ids.filter(id => id !== keepId);
            normalized.result = result;
        } else if (op === 'rewrite') {
            if (ids.length !== 1) { reject('rewrite 只能作用于 1 条 ids'); continue; }
            const result = sanitizeResult(raw.result || raw.rewritten, pillar);
            if (!result) { reject('rewrite 缺少可用的 result'); continue; }
            const rewritten = primaryContentOf(result, pillar);
            const original = primaryContentOf(targets[0], pillar);
            if (original.length > 0 && rewritten.length && rewritten.length < original.length * 0.5) {
                notes.push(`重写后比原文短很多（${rewritten.length} vs ${original.length} 字），可能丢信息`);
                forceConfirm = true;
            }
            normalized.result = result;
        } else if (op === 'split') {
            if (ids.length !== 1) { reject('split 只能作用于 1 条 ids'); continue; }
            const rawResults = Array.isArray(raw.results) ? raw.results
                : (Array.isArray(raw.result) ? raw.result : []);
            const results = rawResults.map(item => sanitizeResult(item, pillar)).filter(Boolean);
            if (results.length < 2) { reject('split 需要 results 数组且至少 2 条'); continue; }
            normalized.results = results;
        } else if (op === 'delete') {
            // 删除不可逆，一律带上原文摘要，便于审核面板和撤销记录展示
            normalized.deletePreview = targets.map(e => truncate(primaryContentOf(e, pillar), 120));
        }

        normalized.forceConfirm = forceConfirm;
        normalized.entryLabels = buildEntryLabels(targets, pillar);
        for (const id of ids) consumed.add(`${pillar}:${id}`);
        ops.push(normalized);
    }

    return { ops, rejected, parsed, totalReturned: rawOps.length };
}

function buildEntryLabels(entries, pillar) {
    const labels = {};
    for (const entry of entries || []) {
        if (!entry?.id) continue;
        labels[entry.id] = truncate(
            entry.title || entry.name || entry.event || primaryContentOf(entry, pillar) || entry.id,
            60,
        );
    }
    return labels;
}

/** 测试别名：方案里约定的纯函数导出名。 */
export const __parseCurationOps = parseCurationOps;

// ── API 调用 ──

function pickCurationApi(settings, override) {
    const mode = override || (settings.autoGenMode === 'custom' && settings.autoGenEndpoint ? 'custom' : 'main');
    if (mode === 'custom') {
        if (!settings.autoGenEndpoint) throw new Error('未配置副 API 端点（autoGenEndpoint），无法运行 AI 整理');
        return { mode, call: callCustomApi };
    }
    return { mode, call: callMainApi };
}

/**
 * 对已聚好的候选组跑一次 AI 整理。只调用与解析，**不写库**。
 * 写库由 Task 3 的 applyCurationOps 负责，方便先在控制台观察判断质量。
 *
 * @returns {{ ok, ops, rejected, prompt, rawText, groupCount, entryCount, apiMode, durationMs, error }}
 */
export async function runCuration(chatId, groups, options = {}) {
    const settings = options.settings || getSettings();
    const list = (Array.isArray(groups) ? groups : []).filter(g => g?.entries?.length >= 2);
    const base = {
        ok: false,
        ops: [],
        rejected: [],
        prompt: '',
        rawText: '',
        groupCount: list.length,
        entryCount: list.reduce((sum, g) => sum + g.entries.length, 0),
        apiMode: '',
        durationMs: 0,
        error: '',
    };
    if (!list.length) return { ...base, ok: true, error: '' };

    let calendarDescription = '';
    try { calendarDescription = (await getCalendarDescription(chatId)) || ''; } catch { /* 可选信息 */ }

    const prompt = buildCurationPrompt(list, { settings, calendarDescription });
    base.prompt = prompt;

    let api;
    try {
        api = pickCurationApi(settings, options.apiMode);
    } catch (e) {
        return { ...base, error: e.message };
    }
    base.apiMode = api.mode;

    const startedAt = Date.now();
    let rawText = '';
    try {
        rawText = await api.call(prompt, { isMerged: true });
    } catch (e) {
        return { ...base, durationMs: Date.now() - startedAt, error: `整理 API 调用失败：${e.message}` };
    }
    base.rawText = rawText || '';
    base.durationMs = Date.now() - startedAt;

    const allowedPillars = [...new Set(list.map(g => normalizeCurationPillar(g.pillar)))];
    const { ops, rejected } = parseCurationOps(rawText, { groups: list, allowedPillars });

    if (settings.debugLogging) {
        console.log(`[BB-Memory] AI 整理：${list.length} 组 / ${base.entryCount} 条 → ${ops.length} 个有效操作，`
            + `${rejected.length} 个被拦截，耗时 ${base.durationMs}ms（${api.mode} API）`);
        if (rejected.length) console.warn('[BB-Memory] 被拦截的整理操作:', rejected);
    }

    return { ...base, ok: true, ops, rejected };
}

// ═══════════════════════════════════════════════════════════
//  Task 3：授权矩阵 / 应用 / 撤销快照
// ═══════════════════════════════════════════════════════════

/** auto=静默执行，notify=执行并提醒，confirm=必须人工确认。 */
export const CURATION_AUTH_LEVELS = Object.freeze(['auto', 'notify', 'confirm']);

const AUTH_SETTING_KEYS = Object.freeze({
    merge: 'aiCurateAuthMerge',
    rewrite: 'aiCurateAuthRewrite',
    split: 'aiCurateAuthSplit',
    delete: 'aiCurateAuthDelete',
});

/** 设置缺失时的兜底：改内容的偏提醒，不可逆的偏确认。 */
const AUTH_FALLBACK = Object.freeze({
    merge: 'notify', rewrite: 'notify', split: 'confirm', delete: 'confirm',
});

const UNDO_KEY_PREFIX = 'bb_curate_undo_';
const UNDO_SCHEMA = 'bb-memory-curate-undo-v1';

/** 五柱 CRUD 分发表。刻意走各柱现有函数，保留排序、等级归一化、自动备份等副作用。 */
const PILLAR_CRUD = Object.freeze({
    mem: { get: getMemories, add: addMemory, update: updateMemory, remove: removeMemory },
    npc: { get: getNpcProfiles, add: addNpcProfile, update: updateNpcProfile, remove: removeNpcProfile },
    item: { get: getItems, add: addItem, update: updateItem, remove: removeItem },
    milestone: { get: getMilestones, add: addMilestone, update: updateMilestone, remove: removeMilestone },
    timeline: {
        get: getTimeline,
        add: (chatId, data) => upsertTimeline(chatId, data),
        update: (chatId, id, patch) => upsertTimeline(chatId, { ...patch, id }),
        remove: removeTimeline,
    },
});

/** 合并时从被吸收条目继承的字段（各柱通用 + 柱特有）。 */
const MERGE_UNION_TAG_FIELDS = Object.freeze(['tags']);

function getLocalForage() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx?.libs?.localforage || globalThis.localforage || globalThis.SillyTavern?.libs?.localforage;
    } catch {
        return globalThis.localforage || null;
    }
}

function deepClone(value) {
    if (!value || typeof value !== 'object') return value;
    try { return JSON.parse(JSON.stringify(value)); } catch { return Array.isArray(value) ? [...value] : { ...value }; }
}

/** 快照里不需要运行时向量（体积大且可从向量库重建）。 */
function cloneForSnapshot(entry) {
    const copy = deepClone(entry);
    if (copy && typeof copy === 'object') delete copy.embedding;
    return copy;
}

/**
 * 单个操作的授权级别。
 * keep 不写库，恒为 auto；解析阶段标了 forceConfirm 的（缝合痕迹、信息量退化、
 * 永恒条目被改 keepId）无论设置如何都必须人工确认。
 */
export function resolveOpAuthorization(op, settings = {}) {
    if (!op || op.op === 'keep') return 'auto';
    if (op.forceConfirm) return 'confirm';
    const raw = String(settings[AUTH_SETTING_KEYS[op.op]] || '').trim();
    if (CURATION_AUTH_LEVELS.includes(raw)) return raw;
    return AUTH_FALLBACK[op.op] || 'confirm';
}

/** 按授权级别分流。 */
export function partitionOpsByAuthorization(ops, settings = {}, forceAuth = '') {
    const buckets = { auto: [], notify: [], confirm: [], keep: [] };
    for (const op of (Array.isArray(ops) ? ops : [])) {
        if (!op) continue;
        if (op.op === 'keep') { buckets.keep.push(op); continue; }
        const level = CURATION_AUTH_LEVELS.includes(forceAuth) ? forceAuth : resolveOpAuthorization(op, settings);
        buckets[level].push({ ...op, auth: level });
    }
    return buckets;
}

// ── 撤销快照 ──

function undoKey(chatId) {
    return UNDO_KEY_PREFIX + chatId;
}

async function readUndoStack(chatId) {
    const lf = getLocalForage();
    if (!lf || !chatId) return { schema: UNDO_SCHEMA, chatId, entries: [] };
    const stored = await lf.getItem(undoKey(chatId));
    if (stored && typeof stored === 'object' && Array.isArray(stored.entries)) return stored;
    return { schema: UNDO_SCHEMA, chatId, entries: [] };
}

async function writeUndoStack(chatId, stack) {
    const lf = getLocalForage();
    if (!lf || !chatId) return false;
    await lf.setItem(undoKey(chatId), stack);
    return true;
}

function undoDepth(settings) {
    return clampInt(settings.aiCurateUndoDepth, 1, 20, 3);
}

/** 各柱的同柱交叉引用字段。merge/delete 会重映射这些引用，快照必须一并覆盖。 */
const CROSS_REF_FIELDS = Object.freeze({ mem: 'relatedMemoryIds', milestone: 'relatedEventIds' });

/**
 * 应用前记录受影响条目的完整原状。
 *
 * 刻意只快照被命中的条目而非整柱：整柱覆写会把用户在整理之后做的其他修改一起回退。
 * 但范围必须包含 repairCrossReferences 会改到的条目——它们不在 op.ids 里，
 * 漏掉会导致撤销后交叉引用仍指向合并后的条目。
 */
async function beginCurationSnapshot(chatId, ops, meta = {}) {
    const settings = meta.settings || getSettings();
    const idsByPillar = new Map();
    for (const op of ops) {
        const pillar = normalizeCurationPillar(op.pillar);
        if (!idsByPillar.has(pillar)) idsByPillar.set(pillar, new Set());
        for (const id of op.ids) idsByPillar.get(pillar).add(String(id));
    }

    const before = {};
    for (const [pillar, ids] of idsByPillar) {
        const crud = PILLAR_CRUD[pillar];
        if (!crud) continue;
        const entries = await crud.get(chatId);
        const list = Array.isArray(entries) ? entries : [];
        const capture = new Set(ids);
        const refField = CROSS_REF_FIELDS[pillar];
        if (refField) {
            for (const entry of list) {
                const refs = Array.isArray(entry?.[refField]) ? entry[refField] : [];
                if (refs.some(ref => ids.has(String(ref)))) capture.add(String(entry.id));
            }
        }
        before[pillar] = list
            .filter(entry => capture.has(String(entry?.id)))
            .map(cloneForSnapshot);
    }

    const record = {
        id: 'undo_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
        timestamp: Date.now(),
        source: meta.source || 'auto',
        opCount: ops.length,
        pillars: [...idsByPillar.keys()],
        ops: ops.map(op => ({ op: op.op, pillar: op.pillar, ids: op.ids, keepId: op.keepId || '', reason: op.reason || '' })),
        before,
        createdIds: {},
        summary: '',
        applied: 0,
    };

    const stack = await readUndoStack(chatId);
    stack.entries = [record, ...stack.entries].slice(0, undoDepth(settings));
    await writeUndoStack(chatId, stack);
    return record.id;
}

/** 应用结束后补写新建条目 id 与摘要（撤销时要把这些新条目删掉）。 */
async function finalizeCurationSnapshot(chatId, snapshotId, patch = {}) {
    if (!snapshotId) return;
    const stack = await readUndoStack(chatId);
    const record = stack.entries.find(entry => entry.id === snapshotId);
    if (!record) return;
    Object.assign(record, patch);
    await writeUndoStack(chatId, stack);
}

export async function listCurationSnapshots(chatId) {
    const stack = await readUndoStack(chatId);
    return stack.entries.map(entry => ({
        id: entry.id,
        timestamp: entry.timestamp,
        source: entry.source,
        opCount: entry.opCount,
        applied: entry.applied || 0,
        summary: entry.summary || '',
        pillars: entry.pillars || [],
    }));
}

/**
 * 撤销最近一次整理。逐柱按原 id 原样写回，并删除整理过程中新建的条目。
 * @returns {{ ok, error, summary, restored, reinserted, removed, timestamp }}
 */
export async function undoLastCuration(chatId, options = {}) {
    if (!chatId) return { ok: false, error: '没有当前聊天' };
    const stack = await readUndoStack(chatId);
    const targetId = options.snapshotId || stack.entries[0]?.id;
    const index = stack.entries.findIndex(entry => entry.id === targetId);
    if (index < 0) return { ok: false, error: '没有可撤销的整理记录' };

    const record = stack.entries[index];
    const totals = { restored: 0, reinserted: 0, removed: 0 };
    const failures = [];

    for (const [pillar, entries] of Object.entries(record.before || {})) {
        const normalizedPillar = normalizeCurationPillar(pillar);
        if (!PILLAR_CRUD[normalizedPillar]) continue;
        try {
            const result = await restoreEntriesVerbatim(chatId, normalizedPillar, entries, {
                removeIds: record.createdIds?.[pillar] || [],
            });
            totals.restored += result.restored;
            totals.reinserted += result.reinserted;
            totals.removed += result.removed;
        } catch (e) {
            failures.push(`${PILLAR_LABELS[normalizedPillar] || normalizedPillar}：${e.message}`);
        }
    }

    if (failures.length && !totals.restored && !totals.reinserted && !totals.removed) {
        return { ok: false, error: `撤销失败：${failures.join('；')}` };
    }

    stack.entries.splice(index, 1);
    await writeUndoStack(chatId, stack);

    const summary = `已还原 ${totals.restored + totals.reinserted} 条`
        + (totals.removed ? `，删除整理新建的 ${totals.removed} 条` : '');
    return {
        ok: true,
        error: failures.length ? `部分柱撤销失败：${failures.join('；')}` : '',
        summary,
        ...totals,
        timestamp: record.timestamp,
        opSummary: record.summary || '',
    };
}

// ── 字段合并辅助 ──

function tagName(tag) {
    return typeof tag === 'string' ? tag.trim() : String(tag?.name || '').trim();
}

function mergeTagLists(...lists) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
        for (const tag of (Array.isArray(list) ? list : [])) {
            const name = tagName(tag);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            out.push(typeof tag === 'object' && tag ? { ...tag, name } : { name, weight: 0.6 });
        }
    }
    return out;
}

function uniqueStrings(...lists) {
    const seen = new Set();
    for (const list of lists) {
        for (const value of (Array.isArray(list) ? list : [])) {
            const text = String(value || '').trim();
            if (text) seen.add(text);
        }
    }
    return [...seen];
}

/**
 * 构造 merge 的补丁：AI 重写的字段为主，再把被吸收条目里不该丢的东西并进来。
 * 命中统计取 max(hitScore) + sum(hitCount)——取 max 而非求和，避免合并本身把条目推过升格线。
 */
function buildMergePatch(op, keepEntry, absorbedEntries, pillar) {
    const patch = { ...op.result };

    patch.tags = mergeTagLists(
        op.result.tags,
        keepEntry.tags,
        ...absorbedEntries.map(entry => entry.tags),
    );
    if (!patch.tags.length) delete patch.tags;

    if (pillar === 'npc' || pillar === 'item') {
        let aliases = normalizeAliasInput(op.result.aliases, keepEntry.aliases);
        for (const absorbed of absorbedEntries) {
            aliases = mergeEntityAliases(
                { name: patch.name || keepEntry.name, aliases },
                { name: absorbed.name, aliases: absorbed.aliases },
            );
        }
        if (aliases.length) patch.aliases = aliases;
    }

    if (pillar === 'mem') {
        // 隐藏备注是用户手写的，任何情况下都不能因为合并而丢失
        const hiddenNotes = [
            ...(Array.isArray(keepEntry.hiddenNotes) ? keepEntry.hiddenNotes : []),
            ...absorbedEntries.flatMap(entry => Array.isArray(entry.hiddenNotes) ? entry.hiddenNotes : []),
        ];
        if (hiddenNotes.length) patch.hiddenNotes = hiddenNotes;
        const related = uniqueStrings(keepEntry.relatedMemoryIds, ...absorbedEntries.map(e => e.relatedMemoryIds))
            .filter(id => id !== keepEntry.id && !op.removeIds.includes(id));
        if (related.length) patch.relatedMemoryIds = related;
    }

    if (pillar === 'milestone') {
        const related = uniqueStrings(keepEntry.relatedEventIds, ...absorbedEntries.map(e => e.relatedEventIds))
            .filter(id => id !== keepEntry.id && !op.removeIds.includes(id));
        if (related.length) patch.relatedEventIds = related;
        const participants = uniqueStrings(op.result.participants, keepEntry.participants,
            ...absorbedEntries.map(e => e.participants));
        if (participants.length) patch.participants = participants;
    }

    const allEntries = [keepEntry, ...absorbedEntries];
    patch.hitCount = allEntries.reduce((sum, entry) => sum + (Number(entry.hitCount) || 0), 0);
    patch.hitScore = Math.max(...allEntries.map(entry => Number(entry.hitScore) || 0));
    patch.curatedAt = Date.now();
    patch.curatedFrom = op.removeIds.slice();
    return patch;
}

function normalizeAliasInput(primary, fallback) {
    const source = Array.isArray(primary) && primary.length ? primary : fallback;
    return uniqueStrings(source);
}

/** split 出来的新条目要继承原条目的归属信息，否则楼层回滚和来源追溯会断。 */
function carryOverFields(original, pillar) {
    const carried = {
        category: original.category ?? null,
        source: original.source || 'manual',
        sourceExchange: original.sourceExchange || '',
        sourceFloor: typeof original.sourceFloor === 'number' ? original.sourceFloor : -1,
        creationFloor: typeof original.creationFloor === 'number' ? original.creationFloor : -1,
        sourceMessageHash: original.sourceMessageHash || '',
        sourceChatId: original.sourceChatId || '',
        curatedAt: Date.now(),
        curatedFrom: [original.id],
    };
    if (pillar === 'mem') {
        carried.type = original.type || 'event';
        carried.storyTime = original.storyTime || '';
        carried.truthStatus = original.truthStatus || 'true';
        carried.importance = typeof original.importance === 'number' ? original.importance : 0.5;
    }
    if (pillar === 'milestone') {
        carried.storyTime = original.storyTime || '';
        carried.isActive = original.isActive !== false;
    }
    return carried;
}

/**
 * merge / delete 后，同柱其他条目里指向已删除 id 的交叉引用会变悬空
 * （entity-tiers.js 的 expandEntityMemories 会读 relatedMemoryIds）。这里重映射或摘掉。
 */
async function repairCrossReferences(chatId, pillar, removedIds, replacementId) {
    const field = CROSS_REF_FIELDS[pillar];
    if (!field || !removedIds.length) return 0;
    const crud = PILLAR_CRUD[pillar];
    const entries = await crud.get(chatId);
    const removedSet = new Set(removedIds.map(String));
    let repaired = 0;
    for (const entry of (Array.isArray(entries) ? entries : [])) {
        const refs = Array.isArray(entry?.[field]) ? entry[field] : [];
        if (!refs.some(id => removedSet.has(String(id)))) continue;
        const next = uniqueStrings(refs.map(id => (removedSet.has(String(id)) ? (replacementId || '') : id)))
            .filter(id => id && id !== entry.id);
        await crud.update(chatId, entry.id, { [field]: next });
        repaired++;
    }
    return repaired;
}

// ── 应用单个操作 ──

async function applySingleOp(chatId, op) {
    const pillar = normalizeCurationPillar(op.pillar);
    const crud = PILLAR_CRUD[pillar];
    if (!crud) throw new Error(`未知的数据柱：${op.pillar}`);
    const createdIds = [];

    if (op.op === 'merge') {
        const entries = await crud.get(chatId);
        const byId = new Map((Array.isArray(entries) ? entries : []).map(e => [String(e.id), e]));
        const keepEntry = byId.get(String(op.keepId));
        if (!keepEntry) throw new Error(`保留条目 ${op.keepId} 已不存在`);
        const absorbed = op.removeIds.map(id => byId.get(String(id))).filter(Boolean);
        if (!absorbed.length) throw new Error('被合并的条目都已不存在');

        await crud.update(chatId, keepEntry.id, buildMergePatch(op, keepEntry, absorbed, pillar));
        for (const entry of absorbed) await crud.remove(chatId, entry.id);
        const repaired = await repairCrossReferences(chatId, pillar, absorbed.map(e => e.id), keepEntry.id);
        return { createdIds, removedCount: absorbed.length, updatedCount: 1, repaired };
    }

    if (op.op === 'rewrite') {
        const updated = await crud.update(chatId, op.ids[0], { ...op.result, curatedAt: Date.now() });
        if (!updated) throw new Error(`条目 ${op.ids[0]} 已不存在`);
        return { createdIds, removedCount: 0, updatedCount: 1, repaired: 0 };
    }

    if (op.op === 'split') {
        const entries = await crud.get(chatId);
        const original = (Array.isArray(entries) ? entries : []).find(e => String(e.id) === String(op.ids[0]));
        if (!original) throw new Error(`条目 ${op.ids[0]} 已不存在`);
        const snapshot = cloneForSnapshot(original);
        // 第一条原地改，其余新建，保证原 id 不失效（线索板等可能引用它）
        await crud.update(chatId, original.id, { ...op.results[0], curatedAt: Date.now() });
        for (const result of op.results.slice(1)) {
            const created = await crud.add(chatId, { ...carryOverFields(snapshot, pillar), ...result });
            if (created?.id) createdIds.push(created.id);
        }
        return { createdIds, removedCount: 0, updatedCount: 1, repaired: 0 };
    }

    if (op.op === 'delete') {
        let removedCount = 0;
        for (const id of op.ids) {
            if (await crud.remove(chatId, id)) removedCount++;
        }
        if (!removedCount) throw new Error('目标条目都已不存在');
        const repaired = await repairCrossReferences(chatId, pillar, op.ids, '');
        return { createdIds, removedCount, updatedCount: 0, repaired };
    }

    throw new Error(`不支持的操作：${op.op}`);
}

function summarizeCounts(counts) {
    const parts = [];
    if (counts.merge) parts.push(`合并 ${counts.merge} 组`);
    if (counts.rewrite) parts.push(`重写 ${counts.rewrite} 条`);
    if (counts.split) parts.push(`拆分 ${counts.split} 条`);
    if (counts.delete) parts.push(`删除 ${counts.delete} 条`);
    if (counts.keep) parts.push(`保留 ${counts.keep} 条`);
    return parts.join(' / ') || '无改动';
}

/**
 * 按授权矩阵应用整理操作。
 *
 * confirm 档的操作不写库，原样放进 pending 交给审核面板；
 * auto / notify 档在写库前先落撤销快照，再逐个应用。单个操作失败不影响其余操作。
 *
 * @param {string} chatId
 * @param {Array<object>} ops parseCurationOps 输出的操作
 * @param {object} options { settings, forceAuth, source, onProgress, skipSnapshot }
 */
export async function applyCurationOps(chatId, ops, options = {}) {
    const settings = options.settings || getSettings();
    const buckets = partitionOpsByAuthorization(ops, settings, options.forceAuth);
    const toApply = [...buckets.auto, ...buckets.notify];
    const counts = { merge: 0, rewrite: 0, split: 0, delete: 0, keep: buckets.keep.length };
    const result = {
        ok: true,
        snapshotId: '',
        applied: [],
        failed: [],
        pending: buckets.confirm,
        notified: [],
        counts,
        removedCount: 0,
        createdCount: 0,
        repairedCount: 0,
        summary: '',
    };

    if (!toApply.length) {
        result.summary = buckets.confirm.length
            ? `${buckets.confirm.length} 项待确认`
            : summarizeCounts(counts);
        return result;
    }

    if (!options.skipSnapshot) {
        try {
            result.snapshotId = await beginCurationSnapshot(chatId, toApply, { settings, source: options.source || 'auto' });
        } catch (e) {
            // 快照写不进去就不动数据——删除类操作不可逆，没有回退网不能开工
            result.ok = false;
            result.summary = `撤销快照写入失败，已中止整理：${e.message}`;
            result.failed = toApply.map(op => ({ op: op.op, pillar: op.pillar, ids: op.ids, error: '撤销快照不可用' }));
            return result;
        }
    }

    const createdIdsByPillar = {};
    let index = 0;
    for (const op of toApply) {
        index++;
        options.onProgress?.({
            phase: 'apply',
            current: index,
            total: toApply.length,
            message: `正在应用 ${op.op}（${index}/${toApply.length}）`,
        });
        try {
            const outcome = await applySingleOp(chatId, op);
            counts[op.op] = (counts[op.op] || 0) + 1;
            result.removedCount += outcome.removedCount;
            result.createdCount += outcome.createdIds.length;
            result.repairedCount += outcome.repaired;
            if (outcome.createdIds.length) {
                const pillar = normalizeCurationPillar(op.pillar);
                createdIdsByPillar[pillar] = [...(createdIdsByPillar[pillar] || []), ...outcome.createdIds];
            }
            result.applied.push({ op: op.op, pillar: op.pillar, ids: op.ids, auth: op.auth, reason: op.reason });
            if (op.auth === 'notify') result.notified.push(op);
        } catch (e) {
            result.failed.push({ op: op.op, pillar: op.pillar, ids: op.ids, error: e.message });
            console.warn(`[BB-Memory] 整理操作失败（${op.op} ${op.ids.join(',')}）:`, e);
        }
    }

    result.summary = summarizeCounts(counts);
    if (result.snapshotId) {
        await finalizeCurationSnapshot(chatId, result.snapshotId, {
            createdIds: createdIdsByPillar,
            summary: result.summary,
            applied: result.applied.length,
        }).catch(() => { /* 快照补写失败不影响已完成的数据修改 */ });
    }
    return result;
}

/**
 * 一次完整整理：聚类 → AI 判断 → 按授权矩阵应用 → confirm 档进审核面板。
 *
 * 这是 Task 4 的计数器触发与手动整理入口共用的编排函数。
 *
 * @param {string} chatId
 * @param {object} options
 *   pillars        要整理的柱，默认全部五柱
 *   newIdsByPillar { mem: ['id'...] } 本批新条目；某柱为空数组=该柱全库扫描
 *   source         'auto' | 'manual'，记进撤销快照
 *   onProgress     ({ phase, message, current, total }) => void
 *   review         是否弹审核面板处理 confirm 档，默认 true
 *   settings
 */
export async function runCurationFlow(chatId, options = {}) {
    const settings = options.settings || getSettings();
    const pillars = (Array.isArray(options.pillars) && options.pillars.length
        ? options.pillars
        : CURATION_PILLARS).map(normalizeCurationPillar);
    const report = {
        ok: false,
        error: '',
        groupCount: 0,
        entryCount: 0,
        ops: [],
        rejected: [],
        applyResult: null,
        reviewResult: null,
        summary: '',
        stats: [],
    };
    if (!chatId) { report.error = '没有当前聊天'; return report; }

    // ── 1. 逐柱聚类 ──
    const allGroups = [];
    let step = 0;
    for (const pillar of pillars) {
        step++;
        options.onProgress?.({
            phase: 'cluster', current: step, total: pillars.length,
            message: `正在分析${PILLAR_LABELS[pillar] || pillar}（${step}/${pillars.length}）`,
        });
        const crud = PILLAR_CRUD[pillar];
        if (!crud) continue;
        let entries = [];
        try {
            entries = await crud.get(chatId);
        } catch (e) {
            console.warn(`[BB-Memory] 整理读取${pillar}失败:`, e);
            continue;
        }
        if (!Array.isArray(entries) || entries.length < 2) continue;
        const result = await prepareCurationGroups(chatId, pillar, entries, options.newIdsByPillar?.[pillar] || [], {
            recallPerEntry: settings.aiCurateRecallPerEntry,
            clusterThreshold: settings.aiCurateClusterThreshold,
            maxGroups: settings.aiCurateMaxGroupsPerRun,
        });
        report.stats.push(result.stats);
        allGroups.push(...result.groups);
    }

    // 跨柱汇总后再按相似度截断，避免某一柱把额度吃光
    allGroups.sort((a, b) => (b.maxSimilarity - a.maxSimilarity) || a.key.localeCompare(b.key));
    const groups = allGroups.slice(0, clampInt(settings.aiCurateMaxGroupsPerRun, 1, 50, CURATION_DEFAULTS.maxGroups));
    report.groupCount = groups.length;
    report.entryCount = groups.reduce((sum, g) => sum + g.entries.length, 0);

    if (!groups.length) {
        report.ok = true;
        report.summary = '没有发现需要整理的重复条目';
        return report;
    }

    // ── 2. AI 判断 ──
    options.onProgress?.({
        phase: 'ai', message: `正在请 AI 整理 ${groups.length} 组 / ${report.entryCount} 条...`,
    });
    const curation = await runCuration(chatId, groups, { settings, apiMode: options.apiMode });
    report.ops = curation.ops;
    report.rejected = curation.rejected;
    if (!curation.ok) {
        report.error = curation.error;
        report.summary = curation.error;
        return report;
    }
    if (!curation.ops.length) {
        report.ok = true;
        report.summary = curation.rejected.length
            ? `AI 返回的 ${curation.rejected.length} 个操作全部被拦截`
            : 'AI 判断无需改动';
        return report;
    }

    // ── 3. 按授权矩阵应用 ──
    const applyResult = await applyCurationOps(chatId, curation.ops, {
        settings,
        source: options.source || 'auto',
        onProgress: options.onProgress,
    });
    report.applyResult = applyResult;
    report.ok = applyResult.ok;

    // ── 4. confirm 档交人工 ──
    if (options.review !== false && applyResult.pending.length) {
        options.onProgress?.({ phase: 'review', message: `${applyResult.pending.length} 项待确认` });
        report.reviewResult = await openCurationReviewPanel(chatId, applyResult.pending, { settings });
    }

    const parts = [];
    if (applyResult.applied.length) parts.push(applyResult.summary);
    if (applyResult.pending.length) parts.push(`${applyResult.pending.length} 项待确认`);
    if (applyResult.failed.length) parts.push(`${applyResult.failed.length} 项失败`);
    if (curation.rejected.length) parts.push(`${curation.rejected.length} 项被拦截`);
    report.summary = parts.join('，') || '无改动';
    return report;
}

// ═══════════════════════════════════════════════════════════
//  Task 4：计数器触发 / 手动全库整理
// ═══════════════════════════════════════════════════════════

const COUNTER_KEY = '_curateCounters';
const SEED_KEY = '_curateSeedIds';
const COUNTER_CHAT_KEY = '_curateCounterChatId';
const MAX_SEEDS_PER_PILLAR = 300;

const THRESHOLD_SETTING_KEYS = Object.freeze({
    mem: 'aiCurateMemThreshold',
    npc: 'aiCurateNpcThreshold',
    item: 'aiCurateItemThreshold',
    milestone: 'aiCurateMilestoneThreshold',
    timeline: 'aiCurateTimelineThreshold',
});

/** 同一时刻只允许一次整理，防止自动触发与手动整理并发写同一柱。 */
let curationInFlight = false;

export function isCurationRunning() {
    return curationInFlight;
}

function emptySeedMap() {
    return { mem: [], npc: [], item: [], milestone: [], timeline: [] };
}

export function normalizeSeedMap(value) {
    const out = emptySeedMap();
    if (!value || typeof value !== 'object') return out;
    for (const pillar of CURATION_PILLARS) {
        const list = value[pillar];
        if (!Array.isArray(list)) continue;
        const seen = new Set();
        for (const raw of list) {
            const id = String(raw?.id ?? raw ?? '').trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out[pillar].push(id);
            if (out[pillar].length >= MAX_SEEDS_PER_PILLAR) break;
        }
    }
    return out;
}

function normalizeCounters(value) {
    const out = { mem: 0, npc: 0, item: 0, milestone: 0, timeline: 0 };
    if (!value || typeof value !== 'object') return out;
    for (const pillar of CURATION_PILLARS) {
        const n = Number(value[pillar]);
        if (Number.isFinite(n) && n > 0) out[pillar] = Math.floor(n);
    }
    return out;
}

/**
 * 是否达到触发条件。纯函数。
 * 阈值 <= 0 表示该柱不参与触发判定。
 */
export function shouldTriggerCuration(counters, settings = {}) {
    const mode = String(settings.aiCurateTriggerMode || 'any');
    if (mode === 'manual') return false;
    const normalized = normalizeCounters(counters);
    const active = CURATION_PILLARS
        .map(pillar => [pillar, Number(settings[THRESHOLD_SETTING_KEYS[pillar]])])
        .filter(([, threshold]) => Number.isFinite(threshold) && threshold > 0);
    if (!active.length) return false;
    return mode === 'all'
        ? active.every(([pillar, threshold]) => normalized[pillar] >= threshold)
        : active.some(([pillar, threshold]) => normalized[pillar] >= threshold);
}

/**
 * 读取当前聊天的整理计数器与待整理种子。
 * 计数器存在 extensionSettings 里，用 chatId 做门闩：切换聊天时自动归零，
 * 避免 A 聊天攒的计数把 B 聊天的整理提前触发。
 */
export function getCurationState(chatId, settings = getSettings()) {
    if (settings[COUNTER_CHAT_KEY] !== chatId) {
        return { counters: normalizeCounters(null), seeds: emptySeedMap(), stale: true };
    }
    return {
        counters: normalizeCounters(settings[COUNTER_KEY]),
        seeds: normalizeSeedMap(settings[SEED_KEY]),
        stale: false,
    };
}

export function clearCurationCounters(chatId) {
    updateSettings({
        [COUNTER_CHAT_KEY]: chatId || '',
        [COUNTER_KEY]: normalizeCounters(null),
        [SEED_KEY]: emptySeedMap(),
    });
}

/**
 * 记录本批新增/更新的条目，累加计数器。
 * @param {string} chatId
 * @param {object} seeds { mem: ['id'...], npc: [...] }
 * @returns {{ counters, seeds, triggered }}
 */
export function recordCurationSeeds(chatId, seeds) {
    const settings = getSettings();
    if (!chatId || !settings.aiCurateEnabled) {
        return { counters: normalizeCounters(null), seeds: emptySeedMap(), triggered: false };
    }
    const incoming = normalizeSeedMap(seeds);
    const state = getCurationState(chatId, settings);
    const nextCounters = { ...state.counters };
    const nextSeeds = state.stale ? emptySeedMap() : state.seeds;

    let changed = false;
    for (const pillar of CURATION_PILLARS) {
        if (!incoming[pillar].length) continue;
        changed = true;
        nextCounters[pillar] += incoming[pillar].length;
        const merged = new Set([...nextSeeds[pillar], ...incoming[pillar]]);
        nextSeeds[pillar] = [...merged].slice(-MAX_SEEDS_PER_PILLAR);
    }
    if (!changed && !state.stale) {
        return { counters: state.counters, seeds: state.seeds, triggered: shouldTriggerCuration(state.counters, settings) };
    }

    updateSettings({
        [COUNTER_CHAT_KEY]: chatId,
        [COUNTER_KEY]: nextCounters,
        [SEED_KEY]: nextSeeds,
    });
    return { counters: nextCounters, seeds: nextSeeds, triggered: shouldTriggerCuration(nextCounters, settings) };
}

/**
 * 计数器达标时跑一次整理。由 auto-generator 在提取完成后调用。
 * 计数器先清零再跑：整理途中失败也不该让计数器无限累积、每条消息都重试。
 */
export async function maybeRunScheduledCuration(chatId, options = {}) {
    const settings = getSettings();
    if (!chatId || !settings.enabled || !settings.aiCurateEnabled) return { triggered: false, reason: 'disabled' };
    if (curationInFlight) return { triggered: false, reason: 'busy' };

    const state = getCurationState(chatId, settings);
    if (!shouldTriggerCuration(state.counters, settings)) {
        return { triggered: false, reason: 'below-threshold', counters: state.counters };
    }

    const seeds = state.seeds;
    clearCurationCounters(chatId);

    curationInFlight = true;
    try {
        const report = await runCurationFlow(chatId, {
            settings,
            newIdsByPillar: seeds,
            source: 'auto',
            review: options.review !== false,
            onProgress: options.onProgress,
        });
        const hadEffect = (report.applyResult?.applied.length || 0) > 0 || (report.applyResult?.pending.length || 0) > 0;
        if (report.error) {
            showToast(`AI 整理失败：${report.error}`, 'error');
        } else if (hadEffect) {
            // notify 档的提醒在这里统一给出；auto 档只写 activityLog 不弹 toast
            const notified = report.applyResult?.notified.length || 0;
            const pending = report.applyResult?.pending.length || 0;
            if (notified || pending) showToast(`AI 整理：${report.summary}`, 'info');
            else globalThis.bbMemoryRecordActivity?.('info', 'AI 整理完成', report.summary);
        } else if (settings.debugLogging) {
            console.log('[BB-Memory] AI 整理：', report.summary);
        }
        return { triggered: true, report };
    } catch (e) {
        console.warn('[BB-Memory] 自动整理异常:', e);
        globalThis.bbMemoryRecordActivity?.('error', 'AI 整理失败', e.message || '未知错误');
        return { triggered: true, error: e.message };
    } finally {
        curationInFlight = false;
    }
}

/**
 * 手动全库整理：忽略计数器与种子，扫描全部条目，按 aiCurateMaxGroupsPerRun 分块送 AI。
 *
 * 与自动整理的两点区别：
 *  1. 不受种子限制，会做全库两两比较（O(n²)），所以先返回预估再确认
 *  2. 结果一律进审核面板，不走授权矩阵直接写库
 *
 * @param {object} options { confirmed, onProgress, pillars, settings }
 * @returns {{ needsConfirm?, totalGroups, estimatedChunks, ops, reviewResult, summary, error }}
 */
export async function runFullLibraryCuration(chatId, options = {}) {
    const settings = options.settings || getSettings();
    const report = {
        ok: false, error: '', needsConfirm: false,
        totalGroups: 0, estimatedChunks: 0, chunkSize: 0, groups: [],
        entryCount: 0, ops: [], rejected: [], reviewResult: null, summary: '', stats: [],
    };
    if (!chatId) { report.error = '没有当前聊天'; return report; }
    if (curationInFlight) { report.error = '已有整理任务在运行，请稍后再试'; return report; }

    const pillars = (Array.isArray(options.pillars) && options.pillars.length ? options.pillars : CURATION_PILLARS)
        .map(normalizeCurationPillar);
    const chunkSize = clampInt(settings.aiCurateMaxGroupsPerRun, 1, 50, CURATION_DEFAULTS.maxGroups);
    report.chunkSize = chunkSize;

    // ── 1. 全库聚类（不设 maxGroups 上限，先看清总量） ──
    // 用户确认后会带着 options.groups 回来，避免把 O(n²) 的全库比较跑第二遍。
    let allGroups = Array.isArray(options.groups) ? options.groups : null;
    if (!allGroups) {
        allGroups = [];
        let step = 0;
        for (const pillar of pillars) {
            step++;
            options.onProgress?.({
                phase: 'cluster', current: step, total: pillars.length,
                message: `正在扫描${PILLAR_LABELS[pillar] || pillar}（${step}/${pillars.length}）`,
            });
            const crud = PILLAR_CRUD[pillar];
            if (!crud) continue;
            let entries = [];
            try { entries = await crud.get(chatId); } catch { continue; }
            if (!Array.isArray(entries) || entries.length < 2) continue;
            const result = await prepareCurationGroups(chatId, pillar, entries, [], {
                recallPerEntry: settings.aiCurateRecallPerEntry,
                clusterThreshold: settings.aiCurateClusterThreshold,
                maxGroups: 9999,
            });
            report.stats.push(result.stats);
            allGroups.push(...result.groups);
        }
        allGroups.sort((a, b) => (b.maxSimilarity - a.maxSimilarity) || a.key.localeCompare(b.key));
    }
    report.groups = allGroups;
    report.totalGroups = allGroups.length;
    report.entryCount = allGroups.reduce((sum, g) => sum + g.entries.length, 0);
    report.estimatedChunks = Math.ceil(allGroups.length / chunkSize);

    if (!allGroups.length) {
        report.ok = true;
        report.summary = '全库扫描完成，没有发现疑似重复';
        return report;
    }
    // 全库扫描可能是几十次 API 调用，先把账单摆出来让用户确认
    if (options.confirmed !== true) {
        report.needsConfirm = true;
        report.summary = `发现 ${report.totalGroups} 组疑似重复（共 ${report.entryCount} 条），`
            + `需要约 ${report.estimatedChunks} 次 API 调用`;
        return report;
    }

    // ── 2. 分块送 AI ──
    curationInFlight = true;
    try {
        for (let i = 0; i < allGroups.length; i += chunkSize) {
            const chunk = allGroups.slice(i, i + chunkSize);
            const chunkIndex = Math.floor(i / chunkSize) + 1;
            options.onProgress?.({
                phase: 'ai', current: chunkIndex, total: report.estimatedChunks,
                message: `正在请 AI 整理第 ${chunkIndex}/${report.estimatedChunks} 批（${chunk.length} 组）`,
            });
            const curation = await runCuration(chatId, chunk, { settings, apiMode: options.apiMode });
            if (!curation.ok) {
                report.error = curation.error;
                break; // 已收集的操作仍然交给用户审核，不整批丢弃
            }
            report.ops.push(...curation.ops);
            report.rejected.push(...curation.rejected);
        }
    } finally {
        curationInFlight = false;
    }

    if (!report.ops.length) {
        report.ok = !report.error;
        report.summary = report.error
            ? `整理中断：${report.error}`
            : (report.rejected.length ? `AI 返回的 ${report.rejected.length} 个操作全部被拦截` : 'AI 判断无需改动');
        return report;
    }

    // ── 3. 全库整理一律过审核面板 ──
    options.onProgress?.({ phase: 'review', message: `${report.ops.length} 项待确认` });
    report.reviewResult = await openCurationReviewPanel(chatId, report.ops, { settings });
    report.ok = true;
    const applied = report.reviewResult?.applyResult?.summary || '未应用任何改动';
    report.summary = `全库整理：AI 提出 ${report.ops.length} 项，${applied}`
        + (report.rejected.length ? `，${report.rejected.length} 项被拦截` : '')
        + (report.error ? `（中途出错：${report.error}）` : '');
    return report;
}

// ═══════════════════════════════════════════════════════════
//  Task 3：确认档审核面板（复用 bb-active-review-* 样式）
// ═══════════════════════════════════════════════════════════

const OP_LABELS = Object.freeze({
    merge: '合并', rewrite: '重写', split: '拆分', delete: '删除', keep: '保留',
});

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
}

function showToast(msg, type = 'info') {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.[type] === 'function') {
            ctx.toastr[type](msg, '', { timeOut: type === 'error' ? 5000 : 3000 });
        }
    } catch { /* toastr 不可用时静默，调用方另有 activityLog */ }
    try { globalThis.bbMemoryRecordActivity?.(type, 'AI 整理', String(msg)); } catch { /* ignore */ }
}

function renderOpDetail(op) {
    const pillar = normalizeCurationPillar(op.pillar);
    const labelOf = (id) => op.entryLabels?.[id] || id;

    if (op.op === 'merge') {
        const absorbed = (op.removeIds || []).map(id => `<li>${escapeHtml(labelOf(id))}</li>`).join('');
        return `
            <div class="bb-curate-diff">
                <div class="bb-curate-diff-row"><span class="bb-curate-diff-tag">保留</span>${escapeHtml(labelOf(op.keepId))}</div>
                <div class="bb-curate-diff-row"><span class="bb-curate-diff-tag danger">吸收并删除</span><ul>${absorbed}</ul></div>
                <div class="bb-curate-diff-row"><span class="bb-curate-diff-tag ok">重写为</span>
                    <div class="bb-curate-diff-body">${escapeHtml(primaryContentOf(op.result, pillar))}</div>
                </div>
            </div>`;
    }
    if (op.op === 'rewrite') {
        return `
            <div class="bb-curate-diff">
                <div class="bb-curate-diff-row"><span class="bb-curate-diff-tag ok">重写为</span>
                    <div class="bb-curate-diff-body">${escapeHtml(primaryContentOf(op.result, pillar))}</div>
                </div>
            </div>`;
    }
    if (op.op === 'split') {
        const pieces = (op.results || []).map((result, i) =>
            `<div class="bb-curate-diff-body">${i + 1}. ${escapeHtml(primaryContentOf(result, pillar))}</div>`).join('');
        return `<div class="bb-curate-diff"><div class="bb-curate-diff-row">
            <span class="bb-curate-diff-tag ok">拆为 ${op.results?.length || 0} 条</span><div>${pieces}</div>
        </div></div>`;
    }
    if (op.op === 'delete') {
        const previews = (op.deletePreview || []).map(text =>
            `<div class="bb-curate-diff-body">${escapeHtml(text)}</div>`).join('');
        return `<div class="bb-curate-diff"><div class="bb-curate-diff-row">
            <span class="bb-curate-diff-tag danger">将删除</span><div>${previews}</div>
        </div></div>`;
    }
    return '';
}

/**
 * confirm 档审核面板。用户勾选后才写库。
 * @returns {Promise<{ confirmed: number, rejected: number, applyResult: object|null }>}
 */
export function openCurationReviewPanel(chatId, ops, options = {}) {
    return new Promise((resolve) => {
        const list = (Array.isArray(ops) ? ops : []).filter(op => op && op.op !== 'keep');
        if (!list.length) {
            resolve({ confirmed: 0, rejected: 0, applyResult: null });
            return;
        }

        document.getElementById('bb_curate_review_overlay')?.remove();
        const state = list.map((op, index) => ({
            ...op,
            _idx: index,
            // 高风险项默认不勾选：删除、以及系统标了风险的（缝合痕迹/信息量退化）
            selected: op.op !== 'delete' && !op.forceConfirm,
        }));
        const tabs = [
            { key: 'all', label: '全部' },
            ...CURATION_WRITE_OPS.map(op => ({ key: op, label: OP_LABELS[op] })),
        ];
        let activeTab = 'all';
        let busy = false;

        const overlay = document.createElement('div');
        overlay.id = 'bb_curate_review_overlay';
        overlay.className = 'bb-active-review-overlay';
        overlay.innerHTML = `
            <div class="bb-active-review-panel">
                <div class="bb-active-review-header">
                    <div>
                        <div class="bb-active-review-title"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 整理待确认</div>
                        <div class="bb-active-review-subtitle">未勾选的操作不会执行。删除和有风险提示的项默认不勾选。</div>
                    </div>
                    <button class="menu_button bb-active-review-close" type="button" title="关闭">×</button>
                </div>
                <div class="bb-active-review-tabs"></div>
                <div class="bb-active-review-toolbar">
                    <button class="menu_button" type="button" data-action="select_visible">全选当前</button>
                    <button class="menu_button" type="button" data-action="invert_visible">反选当前</button>
                    <span class="bb-active-review-status"></span>
                </div>
                <div class="bb-active-review-list"></div>
                <div class="bb-active-review-footer">
                    <button class="menu_button danger" type="button" data-action="reject">全部拒绝</button>
                    <button class="menu_button" type="button" data-action="apply">应用选中</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const tabEl = overlay.querySelector('.bb-active-review-tabs');
        const listEl = overlay.querySelector('.bb-active-review-list');
        const statusEl = overlay.querySelector('.bb-active-review-status');
        const applyBtn = overlay.querySelector('[data-action="apply"]');

        const visible = () => state.filter(op => activeTab === 'all' || op.op === activeTab);
        const selectedCount = () => state.filter(op => op.selected).length;

        function render() {
            const counts = tabs.reduce((acc, tab) => {
                acc[tab.key] = tab.key === 'all' ? state.length : state.filter(op => op.op === tab.key).length;
                return acc;
            }, {});
            tabEl.innerHTML = tabs.map(tab => `
                <button class="bb-active-review-tab ${activeTab === tab.key ? 'active' : ''}" type="button"
                        data-tab="${tab.key}" ${counts[tab.key] ? '' : 'disabled'}>
                    ${escapeHtml(tab.label)} <span>${counts[tab.key]}</span>
                </button>`).join('');

            const rows = visible();
            listEl.innerHTML = rows.length ? rows.map(op => {
                const warn = (op.notes || []).length
                    ? `<div class="bb-curate-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(op.notes.join('；'))}</div>`
                    : '';
                return `
                    <label class="bb-active-review-item" data-idx="${op._idx}">
                        <input type="checkbox" ${op.selected ? 'checked' : ''} />
                        <div class="bb-active-review-item-body">
                            <div class="bb-active-review-item-head">
                                <span class="bb-active-review-type">${escapeHtml(OP_LABELS[op.op] || op.op)} · ${escapeHtml(PILLAR_LABELS[normalizeCurationPillar(op.pillar)] || op.pillar)}</span>
                                <span class="bb-active-review-source">${op.ids.length} 条</span>
                            </div>
                            <div class="bb-active-review-item-title">${escapeHtml(op.reason || '(AI 未给出理由)')}</div>
                            ${warn}
                            ${renderOpDetail(op)}
                        </div>
                    </label>`;
            }).join('') : '<div class="bb-active-review-empty">这一类没有待确认操作。</div>';
            statusEl.textContent = `已选 ${selectedCount()} / ${state.length}`;
        }

        function finish(payload) {
            overlay.remove();
            resolve(payload);
        }

        tabEl.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-tab]');
            if (!btn || btn.disabled || busy) return;
            activeTab = btn.dataset.tab;
            render();
        });

        listEl.addEventListener('change', (event) => {
            const item = event.target.closest('[data-idx]');
            if (!item || busy) return;
            const op = state[Number(item.dataset.idx)];
            if (op) op.selected = event.target.checked;
            statusEl.textContent = `已选 ${selectedCount()} / ${state.length}`;
        });

        overlay.querySelector('.bb-active-review-toolbar').addEventListener('click', (event) => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (!action || busy) return;
            if (action === 'select_visible') visible().forEach(op => { op.selected = true; });
            if (action === 'invert_visible') visible().forEach(op => { op.selected = !op.selected; });
            render();
        });

        overlay.querySelector('.bb-active-review-close').addEventListener('click', () => {
            if (busy) return;
            finish({ confirmed: 0, rejected: state.length, applyResult: null, closed: true });
        });

        overlay.querySelector('.bb-active-review-footer').addEventListener('click', async (event) => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (!action || busy) return;
            if (action === 'reject') {
                showToast(`已拒绝 ${state.length} 项整理操作`, 'info');
                finish({ confirmed: 0, rejected: state.length, applyResult: null });
                return;
            }
            if (action !== 'apply') return;

            const chosen = state.filter(op => op.selected);
            if (!chosen.length) {
                showToast('没有勾选任何操作', 'warning');
                return;
            }
            busy = true;
            overlay.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
            applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在应用...';
            try {
                // 用户已在此确认，写库时按 auto 走，避免再次进入确认循环
                const applyResult = await applyCurationOps(chatId, chosen, {
                    settings: options.settings,
                    forceAuth: 'auto',
                    source: 'confirm',
                    onProgress: ({ current, total }) => {
                        applyBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 应用中 ${current}/${total}`;
                    },
                });
                const failedNote = applyResult.failed.length ? `，${applyResult.failed.length} 项失败` : '';
                showToast(`整理已应用：${applyResult.summary}${failedNote}`,
                    applyResult.failed.length ? 'warning' : 'success');
                finish({ confirmed: chosen.length, rejected: state.length - chosen.length, applyResult });
            } catch (e) {
                busy = false;
                overlay.querySelectorAll('button, input').forEach(el => { el.disabled = false; });
                applyBtn.textContent = '应用选中';
                showToast(`应用失败：${e.message}`, 'error');
            }
        });

        render();
    });
}

// ═══════════════════════════════════════════════════════════
//  自检用例（浏览器控制台执行，零 API）
// ═══════════════════════════════════════════════════════════

function fixtureProgressiveRefinement() {
    // 用户实测场景：同一个约定被逐层补细节，相邻两条都在 0.8 上下，
    // 增量两两比较下谁也过不了 0.85 合并线 → 必须聚成 1 组。
    return [
        { id: 'p1', type: 'event', title: '约定吃饭', summary: 'A和B约定去吃饭', content: 'A和B约定一起去吃饭。', storyTime: '12:01' },
        { id: 'p2', type: 'event', title: '约定一起吃饭', summary: 'A和B约定一起去吃饭', content: 'A和B约定一起去吃饭，两人已经和好。', storyTime: '12:03' },
        { id: 'p3', type: 'event', title: '约定去楼下吃饭', summary: 'A和B约定去楼下吃饭', content: 'A和B约定一起去家楼下吃饭，两人已经和好。', storyTime: '12:05' },
        { id: 'p4', type: 'event', title: '约定去楼下肯德基', summary: 'A和B约定去楼下的肯德基吃饭', content: 'A和B约定一起去家楼下的肯德基吃饭，两人已经和好。', storyTime: '12:08' },
        { id: 'p5', type: 'event', title: '约定去楼下肯德基吃汉堡', summary: 'A和B约定去楼下的肯德基吃汉堡和炸鸡', content: 'A和B约定一起去家楼下的肯德基吃汉堡和炸鸡，两人已经和好。', storyTime: '12:10' },
    ];
}

function fixtureSimilarWordingDifferentDay() {
    // s1/s2 措辞高度相似但是两天的独立约定 → 聚类层应当召回（交给 AI 判 keep），
    // s3 完全无关 → 不应被拉进同一组。
    return [
        { id: 's1', type: 'event', title: '周一约定看电影', summary: 'A和B约定周一去看电影', content: 'A和B约定周一晚上去看电影。', storyTime: '2026年4月6日' },
        { id: 's2', type: 'event', title: '周三约定看电影', summary: 'A和B约定周三去看电影', content: 'A和B约定周三晚上去看电影。', storyTime: '2026年4月8日' },
        { id: 's3', type: 'fact', title: '旧档案室位置', summary: '旧档案室藏在站务室后方', content: '东港旧车站的旧档案室入口藏在站务室后方的暗门里。', storyTime: '2026年4月3日' },
    ];
}

/**
 * 三组固定用例自检。返回 { pass, cases }，每个 case 带 detail 便于控制台排查。
 * 用法：bbMemoryDebug.curator.selfTest()
 */
export function __selfTestCurationGroups() {
    const cases = [];

    // 用例 1：渐进细化必须聚成 1 组，且 5 条全在组内。
    {
        const entries = fixtureProgressiveRefinement();
        const result = buildCurationGroups(entries, entries.map(e => e.id), { pillar: 'mem' });
        const group = result.groups[0];
        const ids = group ? group.ids.slice().sort() : [];
        const pass = result.groups.length === 1
            && ids.join(',') === 'p1,p2,p3,p4,p5';
        cases.push({
            name: '渐进细化聚成 1 组',
            pass,
            expected: '1 组 / p1,p2,p3,p4,p5',
            actual: `${result.groups.length} 组 / ${ids.join(',') || '(空)'}`,
            detail: { groups: result.groups, stats: result.stats },
        });
    }

    // 用例 2：措辞相似的独立事件被召回，无关条目不被拉进来。
    {
        const entries = fixtureSimilarWordingDifferentDay();
        const result = buildCurationGroups(entries, entries.map(e => e.id), { pillar: 'mem' });
        const group = result.groups[0];
        const ids = group ? group.ids.slice().sort() : [];
        const pass = result.groups.length === 1 && ids.join(',') === 's1,s2';
        cases.push({
            name: '措辞相似的独立事件被召回、无关条目被排除',
            pass,
            expected: '1 组 / s1,s2',
            actual: `${result.groups.length} 组 / ${ids.join(',') || '(空)'}`,
            detail: { groups: result.groups, stats: result.stats },
        });
    }

    // 用例 3：空输入 / 单条输入不报错且不产出组。
    {
        let pass = true;
        let actual = '';
        try {
            const empty = buildCurationGroups([], [], { pillar: 'mem' });
            const single = buildCurationGroups([{ id: 'x', content: '只有一条' }], ['x'], { pillar: 'mem' });
            const nullish = buildCurationGroups(null, null, {});
            const garbage = buildCurationGroups([null, {}, { content: '无 id' }], undefined, { pillar: 'npc' });
            pass = empty.groups.length === 0
                && single.groups.length === 0
                && nullish.groups.length === 0
                && garbage.groups.length === 0;
            actual = `empty=${empty.groups.length} single=${single.groups.length} null=${nullish.groups.length} garbage=${garbage.groups.length}`;
        } catch (e) {
            pass = false;
            actual = `抛错: ${e.message}`;
        }
        cases.push({ name: '空/单条/脏输入不产出组且不抛错', pass, expected: '全部 0 组', actual });
    }

    const pass = cases.every(c => c.pass);
    return { pass, cases };
}

function fixtureOpsGroup() {
    const entries = [
        { id: 'a', type: 'event', title: '约定吃饭', content: 'A和B约定一起去吃饭。', storyTime: '12:01', memoryTier: 'stable' },
        { id: 'b', type: 'event', title: '约定去楼下吃饭', content: 'A和B约定一起去家楼下吃饭，两人已经和好。', storyTime: '12:05', memoryTier: 'stable' },
        { id: 'c', type: 'event', title: '约定去楼下肯德基', content: 'A和B约定一起去家楼下的肯德基吃汉堡和炸鸡，两人已经和好。', storyTime: '12:10', memoryTier: 'stable' },
        { id: 'e', type: 'fact', title: '永恒设定', content: '这是一条永远不能删的核心设定，涉及世界观根基与主角身份来源。', memoryTier: 'eternal' },
    ];
    return [{
        key: 'mem:a,b,c,e',
        pillar: 'mem',
        ids: entries.map(e => e.id),
        entries,
        maxSimilarity: 0.79,
        avgSimilarity: 0.7,
        pairs: [],
        seedIds: ['c'],
    }];
}

/**
 * 操作解析与拦截自检。用法：bbMemoryDebug.curator.selfTestOps()
 */
export function __selfTestCurationOps() {
    const groups = fixtureOpsGroup();
    const cases = [];
    const check = (name, rawText, assert) => {
        let pass = false;
        let actual = '';
        try {
            const result = parseCurationOps(rawText, { groups });
            const verdict = assert(result);
            pass = verdict === true || verdict?.pass === true;
            actual = (typeof verdict === 'object' ? verdict.actual : '')
                || `ops=${result.ops.length} rejected=${result.rejected.length}`
                + (result.rejected.length ? ` [${result.rejected.map(r => r.reason).join(' / ')}]` : '');
        } catch (e) {
            pass = false;
            actual = `抛错: ${e.message}`;
        }
        cases.push({ name, pass, actual });
    };

    check('合法 merge 正常通过', JSON.stringify({
        ops: [{
            op: 'merge', pillar: 'mem', ids: ['a', 'b', 'c'], keepId: 'c',
            result: { title: '约定去楼下肯德基', content: 'A和B约定一起去家楼下的肯德基吃汉堡和炸鸡，两人已经和好。', storyTime: '12:01–12:10' },
            reason: '同一约定的渐进细化',
        }],
    }), r => {
        const op = r.ops[0];
        const pass = r.ops.length === 1 && op.op === 'merge' && op.keepId === 'c'
            && op.removeIds.join(',') === 'a,b' && op.forceConfirm === false && !r.rejected.length;
        return { pass, actual: `ops=${r.ops.length} keepId=${op?.keepId} removeIds=${op?.removeIds?.join(',')} forceConfirm=${op?.forceConfirm}` };
    });

    check('外包说明文字与代码块仍可解析',
        '好的，我分析完了：\n```json\n{"ops":[{"op":"keep","pillar":"mem","ids":["a"],"reason":"独立事件"}]}\n```\n以上。',
        r => r.ops.length === 1 && r.ops[0].op === 'keep');

    check('非 JSON 响应被拒且不抛错', '我觉得这些记忆都挺好的，不需要整理。',
        r => r.ops.length === 0 && r.rejected.length === 1);

    check('空 ops 数组被记录', JSON.stringify({ ops: [] }),
        r => r.ops.length === 0 && r.rejected.length === 1);

    check('未知操作类型被拦截', JSON.stringify({ ops: [{ op: 'nuke', pillar: 'mem', ids: ['a'] }] }),
        r => r.ops.length === 0 && r.rejected.length === 1);

    check('永恒条目禁止 delete', JSON.stringify({ ops: [{ op: 'delete', pillar: 'mem', ids: ['e'] }] }),
        r => r.ops.length === 0 && /永恒条目禁止 delete/.test(r.rejected[0]?.reason || ''));

    check('永恒条目禁止 split', JSON.stringify({
        ops: [{ op: 'split', pillar: 'mem', ids: ['e'], results: [{ content: '拆一' }, { content: '拆二' }] }],
    }), r => r.ops.length === 0 && /永恒条目禁止 split/.test(r.rejected[0]?.reason || ''));

    check('永恒条目在 merge 中被吸收 → 自动改为 keepId 并转人工确认', JSON.stringify({
        ops: [{
            op: 'merge', pillar: 'mem', ids: ['a', 'e'], keepId: 'a',
            result: { content: '这是一条永远不能删的核心设定，涉及世界观根基与主角身份来源，且与吃饭约定相关。' },
        }],
    }), r => {
        const op = r.ops[0];
        const pass = op?.keepId === 'e' && op?.forceConfirm === true && op?.notes?.length > 0;
        return { pass, actual: `keepId=${op?.keepId} forceConfirm=${op?.forceConfirm} notes=${JSON.stringify(op?.notes)}` };
    });

    check('merge 缺少 result 被拦截', JSON.stringify({ ops: [{ op: 'merge', pillar: 'mem', ids: ['a', 'b'], keepId: 'a' }] }),
        r => r.ops.length === 0 && /缺少可用的 result/.test(r.rejected[0]?.reason || ''));

    check('merge 只有 1 条 ids 被拦截', JSON.stringify({
        ops: [{ op: 'merge', pillar: 'mem', ids: ['a'], result: { content: '内容内容内容内容内容' } }],
    }), r => r.ops.length === 0 && /至少需要 2 条/.test(r.rejected[0]?.reason || ''));

    check('不存在的 id 被拦截', JSON.stringify({
        ops: [{ op: 'merge', pillar: 'mem', ids: ['a', 'zzz'], keepId: 'a', result: { content: '随便' } }],
    }), r => r.ops.length === 0 && /id 不存在/.test(r.rejected[0]?.reason || ''));

    check('缝合痕迹 [补充] 触发人工确认', JSON.stringify({
        ops: [{
            op: 'merge', pillar: 'mem', ids: ['a', 'c'], keepId: 'c',
            result: { content: 'A和B约定一起去家楼下的肯德基吃汉堡和炸鸡，两人已经和好。[补充] A和B约定一起去吃饭。' },
        }],
    }), r => {
        const op = r.ops[0];
        return { pass: op?.forceConfirm === true && op.notes.some(n => n.includes('拼接痕迹')), actual: `forceConfirm=${op?.forceConfirm} notes=${JSON.stringify(op?.notes)}` };
    });

    check('合并结果退化变短触发人工确认', JSON.stringify({
        ops: [{ op: 'merge', pillar: 'mem', ids: ['a', 'c'], keepId: 'c', result: { content: '两人约好吃饭。' } }],
    }), r => {
        const op = r.ops[0];
        return { pass: op?.forceConfirm === true && op.notes.some(n => n.includes('丢信息')), actual: `forceConfirm=${op?.forceConfirm} notes=${JSON.stringify(op?.notes)}` };
    });

    check('result 系统字段被剥离', JSON.stringify({
        ops: [{
            op: 'rewrite', pillar: 'mem', ids: ['c'],
            result: {
                id: 'hacked', hitScore: 999, memoryTier: 'eternal', createdAt: 1, embeddingRef: { id: 'x' },
                content: 'A和B约定一起去家楼下的肯德基吃汉堡和炸鸡，两人已经和好，约定时间是中午。',
            },
        }],
    }), r => {
        const keys = Object.keys(r.ops[0]?.result || {});
        return { pass: keys.length === 1 && keys[0] === 'content', actual: `result 字段=${keys.join(',')}` };
    });

    check('同一条目被两个写操作占用 → 第二个被拦截', JSON.stringify({
        ops: [
            { op: 'merge', pillar: 'mem', ids: ['a', 'b'], keepId: 'b', result: { content: 'A和B约定一起去家楼下吃饭，两人已经和好。' } },
            { op: 'delete', pillar: 'mem', ids: ['a'] },
        ],
    }), r => r.ops.length === 1 && /已被本批次前一个操作占用/.test(r.rejected[0]?.reason || ''));

    check('split 只给 1 条 results 被拦截', JSON.stringify({
        ops: [{ op: 'split', pillar: 'mem', ids: ['c'], results: [{ content: '只有一条' }] }],
    }), r => r.ops.length === 0 && /至少 2 条/.test(r.rejected[0]?.reason || ''));

    check('合法 split 通过', JSON.stringify({
        ops: [{
            op: 'split', pillar: 'mem', ids: ['c'],
            results: [{ content: 'A和B约定去楼下的肯德基。' }, { content: 'A和B点了汉堡和炸鸡。' }],
        }],
    }), r => r.ops.length === 1 && r.ops[0].results.length === 2);

    check('pillar 缺失时按 ids 反推', JSON.stringify({ ops: [{ op: 'keep', ids: ['a'] }] }),
        r => r.ops.length === 1 && r.ops[0].pillar === 'mem');

    check('本次未整理的柱被拒绝', JSON.stringify({ ops: [{ op: 'delete', pillar: 'npc', ids: ['a'] }] }),
        r => r.ops.length === 0 && r.rejected.length === 1);

    check('一个非法操作不影响同批其他操作', JSON.stringify({
        ops: [
            { op: 'nuke', pillar: 'mem', ids: ['a'] },
            { op: 'keep', pillar: 'mem', ids: ['b'], reason: '独立' },
        ],
    }), r => r.ops.length === 1 && r.ops[0].ids[0] === 'b' && r.rejected.length === 1);

    check('delete 附带原文预览', JSON.stringify({ ops: [{ op: 'delete', pillar: 'mem', ids: ['a'] }] }),
        r => {
            const op = r.ops[0];
            return { pass: op?.deletePreview?.length === 1 && op.deletePreview[0].length > 0, actual: `preview=${JSON.stringify(op?.deletePreview)}` };
        });

    const pass = cases.every(c => c.pass);
    return { pass, cases };
}

/**
 * 授权矩阵与合并补丁自检。用法：bbMemoryDebug.curator.selfTestAuth()
 * 只覆盖纯逻辑；写库与撤销依赖 localforage，在浏览器里用 bbMemoryDebug.curator.undo() 验证。
 */
export function __selfTestCurationAuth() {
    const cases = [];
    const add = (name, pass, actual) => cases.push({ name, pass, actual });

    const defaults = {
        aiCurateAuthMerge: 'notify', aiCurateAuthRewrite: 'notify',
        aiCurateAuthSplit: 'confirm', aiCurateAuthDelete: 'confirm',
    };
    const levels = CURATION_WRITE_OPS.map(op => resolveOpAuthorization({ op, forceConfirm: false }, defaults));
    add('默认矩阵 merge/rewrite→notify，split/delete→confirm',
        levels.join(',') === 'notify,notify,confirm,confirm', levels.join(','));

    add('keep 恒为 auto（不写库）',
        resolveOpAuthorization({ op: 'keep' }, { aiCurateAuthMerge: 'confirm' }) === 'auto',
        resolveOpAuthorization({ op: 'keep' }, {}));

    add('forceConfirm 压过 auto 设置',
        resolveOpAuthorization({ op: 'merge', forceConfirm: true }, { aiCurateAuthMerge: 'auto' }) === 'confirm',
        resolveOpAuthorization({ op: 'merge', forceConfirm: true }, { aiCurateAuthMerge: 'auto' }));

    add('全 auto 设置下无 forceConfirm 的 merge 走 auto',
        resolveOpAuthorization({ op: 'merge', forceConfirm: false }, { aiCurateAuthMerge: 'auto' }) === 'auto',
        resolveOpAuthorization({ op: 'merge', forceConfirm: false }, { aiCurateAuthMerge: 'auto' }));

    const bogus = ['delete', 'split'].map(op => resolveOpAuthorization({ op }, { aiCurateAuthDelete: 'yolo', aiCurateAuthSplit: '' }));
    add('非法/空设置值回退到 confirm（不可逆操作从严）',
        bogus.every(level => level === 'confirm'), bogus.join(','));

    const ops = [
        { op: 'merge', pillar: 'mem', ids: ['a', 'b'], forceConfirm: false },
        { op: 'delete', pillar: 'mem', ids: ['c'], forceConfirm: false },
        { op: 'rewrite', pillar: 'mem', ids: ['d'], forceConfirm: true },
        { op: 'keep', pillar: 'mem', ids: ['e'] },
    ];
    const buckets = partitionOpsByAuthorization(ops, defaults);
    add('分桶：merge→notify，delete+forceConfirm rewrite→confirm，keep 单列',
        buckets.auto.length === 0 && buckets.notify.length === 1
        && buckets.confirm.length === 2 && buckets.keep.length === 1,
        `auto=${buckets.auto.length} notify=${buckets.notify.length} confirm=${buckets.confirm.length} keep=${buckets.keep.length}`);

    const forced = partitionOpsByAuthorization(ops, defaults, 'auto');
    add('forceAuth=auto 时写操作全进 auto 桶（审核面板确认后用）',
        forced.auto.length === 3 && forced.confirm.length === 0,
        `auto=${forced.auto.length} confirm=${forced.confirm.length}`);

    // ── 合并补丁 ──
    const keepEntry = {
        id: 'k', title: '约定去楼下肯德基', content: 'A和B约定去家楼下的肯德基吃汉堡和炸鸡。',
        tags: [{ name: '约定', weight: 0.6 }], hitCount: 3, hitScore: 7,
        hiddenNotes: [{ id: 'n1', content: '用户手写备注' }], relatedMemoryIds: ['z1'],
    };
    const absorbed = [
        { id: 'r1', title: '约定吃饭', content: 'A和B约定去吃饭。', tags: [{ name: '和解' }], hitCount: 2, hitScore: 12, hiddenNotes: [{ id: 'n2', content: '第二条备注' }], relatedMemoryIds: ['z2', 'r1'] },
        { id: 'r2', title: '约定去楼下', content: 'A和B约定去楼下吃饭。', tags: [{ name: '约定' }], hitCount: 1, hitScore: 4, relatedMemoryIds: [] },
    ];
    const mergeOp = {
        op: 'merge', pillar: 'mem', ids: ['k', 'r1', 'r2'], keepId: 'k', removeIds: ['r1', 'r2'],
        result: { title: '约定去楼下肯德基', content: 'A和B约定一起去家楼下的肯德基吃汉堡和炸鸡，两人已经和好。' },
    };
    const patch = buildMergePatch(mergeOp, keepEntry, absorbed, 'mem');

    add('hitScore 取 max 而非求和（避免合并把条目推过升格线）',
        patch.hitScore === 12, `hitScore=${patch.hitScore}（期望 12，求和会是 23）`);
    add('hitCount 求和', patch.hitCount === 6, `hitCount=${patch.hitCount}`);
    add('用户手写的 hiddenNotes 全部保留',
        patch.hiddenNotes?.length === 2, `hiddenNotes=${patch.hiddenNotes?.length}`);
    add('tags 合并去重', patch.tags?.map(t => t.name).join(',') === '约定,和解',
        patch.tags?.map(t => t.name).join(','));
    add('relatedMemoryIds 剔除被删 id 与自身',
        patch.relatedMemoryIds?.join(',') === 'z1,z2', patch.relatedMemoryIds?.join(','));
    add('记录 curatedFrom 溯源', patch.curatedFrom?.join(',') === 'r1,r2', patch.curatedFrom?.join(','));

    const itemPatch = buildMergePatch(
        { op: 'merge', pillar: 'item', ids: ['i1', 'i2'], keepId: 'i2', removeIds: ['i1'], result: { name: '白色刺猬睡裙' } },
        { id: 'i2', name: '白色刺猬睡裙', aliases: [] },
        [{ id: 'i1', name: '睡裙', aliases: ['睡衣'] }],
        'item',
    );
    add('物品合并把被吸收条目的名称并入别名',
        (itemPatch.aliases || []).includes('睡裙') && (itemPatch.aliases || []).includes('睡衣'),
        `aliases=${JSON.stringify(itemPatch.aliases)}`);

    add('摘要文案', summarizeCounts({ merge: 2, delete: 1, keep: 3 }) === '合并 2 组 / 删除 1 条 / 保留 3 条',
        summarizeCounts({ merge: 2, delete: 1, keep: 3 }));
    add('空摘要', summarizeCounts({}) === '无改动', summarizeCounts({}));

    const pass = cases.every(c => c.pass);
    return { pass, cases };
}

/** 触发条件与种子归一化自检。用法：bbMemoryDebug.curator.selfTestTrigger() */
export function __selfTestCurationTrigger() {
    const cases = [];
    const add = (name, pass, actual = '') => cases.push({ name, pass, actual });

    const thresholds = {
        aiCurateMemThreshold: 10, aiCurateNpcThreshold: 5, aiCurateItemThreshold: 5,
        aiCurateMilestoneThreshold: 5, aiCurateTimelineThreshold: 3,
    };
    const any = { ...thresholds, aiCurateTriggerMode: 'any' };
    const all = { ...thresholds, aiCurateTriggerMode: 'all' };

    add('any 模式：记忆达标即触发', shouldTriggerCuration({ mem: 10 }, any) === true);
    add('any 模式：全部未达标不触发', shouldTriggerCuration({ mem: 9, npc: 4, item: 4, milestone: 4, timeline: 2 }, any) === false);
    add('any 模式：时间线单独达标也触发', shouldTriggerCuration({ timeline: 3 }, any) === true);
    add('all 模式：只有记忆达标不触发', shouldTriggerCuration({ mem: 99 }, all) === false);
    add('all 模式：全部达标才触发',
        shouldTriggerCuration({ mem: 10, npc: 5, item: 5, milestone: 5, timeline: 3 }, all) === true);
    add('manual 模式永不自动触发',
        shouldTriggerCuration({ mem: 999 }, { ...thresholds, aiCurateTriggerMode: 'manual' }) === false);
    add('阈值全为 0 时不触发（等于关掉自动整理）',
        shouldTriggerCuration({ mem: 999 }, {
            aiCurateTriggerMode: 'any', aiCurateMemThreshold: 0, aiCurateNpcThreshold: 0,
            aiCurateItemThreshold: 0, aiCurateMilestoneThreshold: 0, aiCurateTimelineThreshold: 0,
        }) === false);
    add('阈值为 0 的柱不参与判定，其他柱照常',
        shouldTriggerCuration({ mem: 999, npc: 1 }, { ...any, aiCurateMemThreshold: 0 }) === false
        && shouldTriggerCuration({ npc: 5 }, { ...any, aiCurateMemThreshold: 0 }) === true);
    add('计数器为空/脏数据不抛错',
        shouldTriggerCuration(null, any) === false && shouldTriggerCuration({ mem: 'x' }, any) === false);

    const seeds = normalizeSeedMap({
        mem: ['a', 'a', 'b', '', null, { id: 'c' }],
        npc: 'not-an-array',
        bogus: ['x'],
    });
    add('种子归一化：去重、去空、支持对象、忽略非法柱',
        seeds.mem.join(',') === 'a,b,c' && seeds.npc.length === 0 && !('bogus' in seeds),
        JSON.stringify(seeds));
    add('种子归一化：五柱键齐全',
        CURATION_PILLARS.every(p => Array.isArray(seeds[p])), Object.keys(seeds).join(','));

    const capped = normalizeSeedMap({ mem: Array.from({ length: MAX_SEEDS_PER_PILLAR + 50 }, (_, i) => 'id' + i) });
    add(`种子归一化：单柱上限 ${MAX_SEEDS_PER_PILLAR}`,
        capped.mem.length === MAX_SEEDS_PER_PILLAR, String(capped.mem.length));

    const pass = cases.every(c => c.pass);
    return { pass, cases };
}

/** 全部自检。用法：bbMemoryDebug.curator.selfTestAll() */
export function __selfTestCurator() {
    const groupsResult = __selfTestCurationGroups();
    const opsResult = __selfTestCurationOps();
    const authResult = __selfTestCurationAuth();
    const triggerResult = __selfTestCurationTrigger();
    return {
        pass: groupsResult.pass && opsResult.pass && authResult.pass && triggerResult.pass,
        cases: [
            ...groupsResult.cases.map(c => ({ ...c, group: '聚类' })),
            ...opsResult.cases.map(c => ({ ...c, group: '解析' })),
            ...authResult.cases.map(c => ({ ...c, group: '授权' })),
            ...triggerResult.cases.map(c => ({ ...c, group: '触发' })),
        ],
    };
}

/** 控制台辅助：打印一组条目的两两相似度矩阵，用于人工核对聚类判断。 */
export function buildSimilarityMatrix(entries, pillar = 'mem') {
    const pool = (Array.isArray(entries) ? entries : []).filter(e => e?.id);
    const nodes = pool.map((entry, index) => makeNode(entry, index, pillar));
    const matrix = {};
    for (const left of nodes) {
        matrix[left.id] = {};
        for (const right of nodes) {
            matrix[left.id][right.id] = left.index === right.index
                ? 1
                : Number(curationPairSimilarity(left, right, pillar).score.toFixed(3));
        }
    }
    return matrix;
}
