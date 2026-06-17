/**
 * retriever.js —— BB-Memory v5.0 检索与注入系统
 *
 * 四柱架构注入格式：角色档案 / 重要物品 / 故事时间线 / 相关记忆。
 * 简化为 5 维评分 + 实体展开。
 */

import { MEMORY_TYPES, TRUTH_STATUS } from './memory-types.js';
import {
    tierScoreMultiplier,
    buildNpcIndexCard,
    buildItemIndexCard,
    buildDefaultIndexCard,
    memoryMatchesQueryEntities,
    expandEntityMemories,
    extractEntityHints,
} from './entity-tiers.js';
import {
    isArchived, getSettings,
} from './memory-store.js';
import { fillPromptTemplate, getPromptTemplate } from './prompt-templates.js';

// ═══════════════════════════════════════════════════════════
//  评分权重（4 维）
// ═══════════════════════════════════════════════════════════

const SCORE_WEIGHTS = {
    keyword:    0.35,
    embedding:  0.25,
    recency:    0.10,
    tier:       0.30,
};

const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════
//  注入等级定义
// ═══════════════════════════════════════════════════════════

export const INJECTION_LEVELS = Object.freeze({
    L4: { id: 'L4', label: '常驻',   tokenCost: 'minimal' },
    L3: { id: 'L3', label: '完整',   tokenCost: 'high' },
    L2: { id: 'L2', label: '摘要',   tokenCost: 'medium' },
    L1: { id: 'L1', label: '标签',   tokenCost: 'low' },
});

const DEFAULT_INJECTION_SECTION_HEADERS = Object.freeze({
    thread: '【故事线程地图】',
    npc: '【角色档案】',
    item: '【重要物品】',
    timeline: '【故事时间线】',
    memory: '【相关记忆】',
    map: '【世界地图 —— 空间关系{{worldRefSuffix}}】',
});

function getInjectionHeader(settings, key, replacements = {}) {
    const template = getPromptTemplate(settings || getSettings(), `injection.${key}Header`, DEFAULT_INJECTION_SECTION_HEADERS[key] || '');
    return fillPromptTemplate(template, replacements).trim();
}

export function getRetrieverPromptTemplates() {
    return [
        {
            key: 'injection.threadHeader',
            title: '故事线程注入标题',
            category: '五柱注入',
            description: '长期记忆注入中“故事线程地图”区块的标题。',
            defaultValue: DEFAULT_INJECTION_SECTION_HEADERS.thread,
        },
        {
            key: 'injection.npcHeader',
            title: 'NPC 档案注入标题',
            category: '五柱注入',
            description: '长期记忆注入中 NPC/角色档案区块的标题。',
            defaultValue: DEFAULT_INJECTION_SECTION_HEADERS.npc,
        },
        {
            key: 'injection.itemHeader',
            title: '物品注入标题',
            category: '五柱注入',
            description: '长期记忆注入中重要物品区块的标题。',
            defaultValue: DEFAULT_INJECTION_SECTION_HEADERS.item,
        },
        {
            key: 'injection.timelineHeader',
            title: '时间线注入标题',
            category: '五柱注入',
            description: '长期记忆注入中故事时间线区块的标题。',
            defaultValue: DEFAULT_INJECTION_SECTION_HEADERS.timeline,
        },
        {
            key: 'injection.memoryHeader',
            title: '记忆条目注入标题',
            category: '五柱注入',
            description: '长期记忆注入中相关记忆区块的标题。',
            defaultValue: DEFAULT_INJECTION_SECTION_HEADERS.memory,
        },
        {
            key: 'injection.mapHeader',
            title: '地图注入标题',
            category: '地图注入',
            description: '长期记忆注入中世界地图/空间关系区块的标题，{{worldRefSuffix}} 会带入全局现实参考。',
            defaultValue: DEFAULT_INJECTION_SECTION_HEADERS.map,
        },
    ];
}

// ═══════════════════════════════════════════════════════════
//  文本分词
// ═══════════════════════════════════════════════════════════

function extractTokens(text) {
    if (!text) return [];
    return text
        .toLowerCase()
        .split(/[\s,，。！？!?、；;：:""''「」（）()\[\]{}·\n\r\t]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2);
}

function estimateTokens(text) {
    if (!text) return 0;
    const cjk = text.match(/[一-鿿぀-ヿ가-힯]/g);
    const cjkTokens = cjk ? cjk.length * 1.5 : 0;
    const rest = text.replace(/[一-鿿぀-ヿ가-힯]/g, '');
    const wordTokens = rest.split(/\s+/).filter(Boolean).length;
    return Math.ceil(cjkTokens + wordTokens);
}

function isResidentEntry(entry) {
    if (!entry) return false;
    return entry.memoryTier === 'core'
        || entry.memoryTier === 'eternal'
        || entry.resident === true
        || entry.status === 'resident';
}

function normalizeTimelineFingerprintText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[\s"'“”‘’.,，。:：;；!?！？、()[\]【】{}<>《》·\-—_/\\]+/g, '')
        .trim();
}

function timelineFingerprint(entry) {
    const period = normalizeTimelineFingerprintText(entry?.storyTime || entry?.period || entry?.time || '');
    const event = normalizeTimelineFingerprintText(entry?.event || entry?.title || entry?.summary || entry?.note || '');
    if (!event) return null;
    return { full: `${period}|${event}`, event, hasPeriod: Boolean(period) };
}

function buildThreadTimelineIndex(threads = []) {
    const full = new Set();
    const eventWithoutPeriod = new Set();
    for (const thread of threads || []) {
        for (const entry of (thread.entries || [])) {
            const fp = timelineFingerprint(entry);
            if (!fp) continue;
            full.add(fp.full);
            if (!fp.hasPeriod) eventWithoutPeriod.add(fp.event);
        }
    }
    return { full, eventWithoutPeriod };
}

function isForeshadowTimeline(entry) {
    const tagText = (entry?.tags || [])
        .map(tag => typeof tag === 'string' ? tag : tag?.name)
        .filter(Boolean)
        .join(' ');
    return entry?.status === 'foreshadow' || /伏笔|待兑现|待揭示/.test(tagText);
}

function isTimelineCoveredByThread(entry, threadIndex) {
    const fp = timelineFingerprint(entry);
    if (!fp) return false;
    if (threadIndex.full.has(fp.full)) return true;
    if (!fp.hasPeriod && [...threadIndex.full].some(key => key.endsWith(`|${fp.event}`))) return true;
    return threadIndex.eventWithoutPeriod.has(fp.event);
}

function cloneForInjection(entry, mode, reason = '') {
    return { ...entry, _bbInjectMode: mode, _bbInjectReason: reason };
}

function uniqueById(entries) {
    const seen = new Set();
    const out = [];
    for (const entry of entries) {
        if (!entry || !entry.id || seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
    }
    return out;
}

function embeddingSimilarity(entry, queryEmbedding) {
    if (!queryEmbedding || !entry?.embedding || !Array.isArray(entry.embedding)) return 0;
    if (queryEmbedding.length !== entry.embedding.length) return 0;
    return cosineSimilarity(queryEmbedding, entry.embedding);
}

function entryTextMatches(entry, queryText, fields = [], queryEmbedding = null, semanticThreshold = 0.62) {
    if (!entry || !queryText?.trim()) return false;
    if (embeddingSimilarity(entry, queryEmbedding) >= semanticThreshold) return true;
    if (memoryMatchesQueryEntities(entry, queryText)) return true;
    const tokens = extractTokens(queryText);
    if (!tokens.length) return false;
    const tagText = (entry.tags || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean).join(' ');
    const pool = [...fields.map(f => entry[f]), tagText]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return tokens.some(token => pool.includes(token));
}

// ═══════════════════════════════════════════════════════════
//  5 维评分
// ═══════════════════════════════════════════════════════════

function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : Math.max(0, dot / denom);
}

const TIER_SCORE = { eternal: 1.0, core: 0.8, stable: 0.5, transient: 0.3 };

export function calculateMemoryScore(memory, query, context = {}, queryEmbedding = null) {
    const now = Date.now();

    // 标签命中
    let keywordScore = 0;
    const hints = extractEntityHints(query);
    if (hints.length && memory.tags && memory.tags.length) {
        const tagNames = memory.tags.map(t => (typeof t === 'string' ? t : t.name).toLowerCase().trim()).filter(Boolean);
        let matchCount = 0;
        for (const hint of hints) {
            if (tagNames.some(tag => tag.includes(hint) || hint.includes(tag))) matchCount++;
        }
        keywordScore = matchCount / hints.length;
    } else if (hints.length) {
        // Fallback: 记忆无标签时用 title+subject+target
        const searchTarget = [
            memory.title || '', memory.subject || '', memory.target || '',
        ].join(' ').toLowerCase();
        let matchCount = 0;
        for (const hint of hints) {
            if (searchTarget.includes(hint)) matchCount++;
        }
        keywordScore = matchCount / hints.length;
    }

    // 语义
    const embeddingScore = (queryEmbedding && memory.embedding)
        ? cosineSimilarity(queryEmbedding, memory.embedding) : 0;

    // 时效性
    const age = now - (memory.lastHitAt || memory.createdAt || now);
    let recencyScore;
    if (age <= 0) recencyScore = 1.0;
    else if (age >= RECENCY_WINDOW_MS) recencyScore = Math.max(0.1, 1 - Math.log10(age / RECENCY_WINDOW_MS + 1) * 0.5);
    else recencyScore = 1 - (age / RECENCY_WINDOW_MS) * 0.5;

    // 层级
    const tierScore = TIER_SCORE[memory.memoryTier] || 0.3;

    let weightedSum = 0, weightTotal = 0;
    const dims = { keyword: keywordScore, embedding: embeddingScore, recency: recencyScore, tier: tierScore };
    for (const [dim, weight] of Object.entries(SCORE_WEIGHTS)) {
        weightedSum += (dims[dim] || 0) * weight;
        weightTotal += weight;
    }
    const normalized = weightTotal > 0 ? weightedSum / weightTotal : 0;
    const total = Math.min(1.0, normalized);

    return { total, breakdown: dims };
}

// ═══════════════════════════════════════════════════════════
//  注入等级选择
// ═══════════════════════════════════════════════════════════

export function chooseInjectionLevel(memory, score, queryMatched = false) {
    if (memory.memoryTier === 'transient') return 'L2';
    if (memory.memoryTier === 'eternal' || memory.memoryTier === 'core') return 'L4';
    if (score >= 0.55 || (memory.verbatim && queryMatched)) return 'L3';
    if (score >= 0.30) return 'L2';
    return 'L1';
}

// ═══════════════════════════════════════════════════════════
//  记忆检索
// ═══════════════════════════════════════════════════════════

export function getRelevantMemories(memories, queryText, options = {}) {
    const {
        maxResults = 10, minScore = 0.05, queryEmbedding = null,
    } = options;

    if (!memories.length || !queryText.trim()) return [];

    let candidates = memories.filter(m => !isArchived(m) && m.status !== 'deleted' && matchesActiveCategory(m));

    if (!candidates.length) return [];

    // Fuse 模糊匹配
    let fuseBoostMap = new Map();
    try {
        const Fuse = SillyTavern.libs.Fuse;
        if (Fuse) {
            const fuse = new Fuse(candidates, {
                keys: ['content', 'title', 'summary', 'subject', 'target'],
                threshold: 0.4,
                includeScore: true,
            });
            for (const result of fuse.search(queryText)) {
                fuseBoostMap.set(result.item.id, (1 - (result.score || 0)) * 0.15);
            }
        }
    } catch { /* Fuse 不可用 */ }

    const scored = [];
    for (const memory of candidates) {
        const queryMatched = memoryMatchesQueryEntities(memory, queryText);
        const { total, breakdown } = calculateMemoryScore(memory, queryText, {}, queryEmbedding);
        const fuseBoost = fuseBoostMap.get(memory.id) || 0;
        let finalScore = Math.min(1.0, total + fuseBoost);
        finalScore = Math.min(1.0, finalScore * tierScoreMultiplier(memory, queryMatched));

        if (finalScore >= minScore) {
            scored.push({
                memory,
                score: finalScore,
                breakdown,
                level: chooseInjectionLevel(memory, finalScore, queryMatched),
            });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
}

/**
 * 实体展开：合并关联记忆
 */
export function mergeExpandedRelevantResults(memories, queryText, relevantResults, excludeIds, expandLimit = 12, maxResults = 10, queryEmbedding = null) {
    const expanded = expandEntityMemories(memories, queryText, excludeIds, expandLimit);
    const merged = [...relevantResults];

    for (const m of expanded) {
        const queryMatched = true;
        const { total } = calculateMemoryScore(m, queryText, {}, queryEmbedding);
        let score = Math.min(1.0, Math.max(total, 0.55));
        score = Math.min(1.0, score * tierScoreMultiplier(m, queryMatched));
        merged.push({
            memory: m,
            score,
            level: chooseInjectionLevel(m, score, queryMatched),
        });
    }

    merged.sort((a, b) => b.score - a.score);
    const ceiling = Math.min(maxResults + Math.ceil(maxResults * 0.3), merged.length);
    const residents = merged.filter(r => isResidentEntry(r.memory));
    const rest = merged.filter(r => !isResidentEntry(r.memory));
    return [...residents, ...rest.slice(0, Math.max(0, ceiling - residents.length))];
}

// ═══════════════════════════════════════════════════════════
//  v8.6.0 分类过滤
// ═══════════════════════════════════════════════════════════

/**
 * 判断条目是否匹配当前激活的分类
 * activeCategory 为空时不过滤（显示全部）
 * activeCategory 有值时：只显示 category===null（通用）或 category===activeCategory（匹配分类）
 */
function matchesActiveCategory(entry) {
    const settings = getSettings();
    const enabled = settings.enabledCategories || {};
    const hasEnabled = Object.values(enabled).some(v => v === true);
    // 没有开启任何分类 → 显示全部
    if (!hasEnabled) return true;
    // 有开启的分类 → 只显示通用(null/undefined/空串) + 已开启的分类
    const category = entry?.category;
    return category === null || category === undefined || category === '' || enabled[category] === true;
}

// ═══════════════════════════════════════════════════════════
//  各支柱检索
// ═══════════════════════════════════════════════════════════

/**
 * NPC 档案：core+important 全注入，minor 按命中
 */
export function getNpcForInjection(npcProfiles, queryText, queryEmbedding = null) {
    const required = [];
    const optional = [];
    for (const npc of npcProfiles) {
        if (isArchived(npc) || !matchesActiveCategory(npc)) continue;
        const resident = isResidentEntry(npc);
        const alwaysIndex = npc.npcTier === 'core' || npc.npcTier === 'important';
        const hit = entryTextMatches(npc, queryText, ['name', 'role', 'personality', 'appearance', 'status', 'location'], queryEmbedding);
        if (resident || hit) {
            const target = resident || alwaysIndex ? required : optional;
            target.push(cloneForInjection(npc, 'full', resident ? 'resident' : 'hit'));
        } else if (alwaysIndex) {
            required.push(cloneForInjection(npc, 'index', 'always_index'));
        }
    }
    // 排序：tier 优先
    const tierOrder = { core: 0, important: 1, minor: 2, background: 3 };
    const sortNpc = (a, b) => {
        const residentDelta = (isResidentEntry(b) ? 1 : 0) - (isResidentEntry(a) ? 1 : 0);
        if (residentDelta) return residentDelta;
        return (tierOrder[a.npcTier] || 2) - (tierOrder[b.npcTier] || 2);
    };
    required.sort(sortNpc);
    optional.sort(sortNpc);
    return uniqueById([...required, ...optional.slice(0, getSettings().npcInjectionMax ?? 8)]);
}

/**
 * 物品栏：key+equipped+kp 全注入，其余按命中
 */
export function getItemsForInjection(items, queryText, queryEmbedding = null) {
    const required = [];
    const optional = [];
    for (const item of items) {
        if (isArchived(item) || !matchesActiveCategory(item)) continue;
        const resident = isResidentEntry(item);
        const alwaysIndex = item.itemTier === 'key' || item.itemTier === 'equipped' || item.keepPermanent;
        const hit = entryTextMatches(item, queryText, ['name', 'owner', 'status', 'significance', 'location'], queryEmbedding);
        if (resident || hit) {
            const target = resident || alwaysIndex ? required : optional;
            target.push(cloneForInjection(item, 'full', resident ? 'resident' : 'hit'));
        } else if (alwaysIndex) {
            required.push(cloneForInjection(item, 'index', 'always_index'));
        }
    }
    const tierOrder = { key: 0, equipped: 1, clue: 2, consumable: 3, background: 4 };
    const sortItem = (a, b) => {
        const residentDelta = (isResidentEntry(b) ? 1 : 0) - (isResidentEntry(a) ? 1 : 0);
        if (residentDelta) return residentDelta;
        return (tierOrder[a.itemTier] || 3) - (tierOrder[b.itemTier] || 3);
    };
    required.sort(sortItem);
    optional.sort(sortItem);
    return uniqueById([...required, ...optional.slice(0, getSettings().itemInjectionMax ?? 5)]);
}

/**
 * 时间线：ongoing 全注入，最近 ended 3 条
 */
export function getTimelineForInjection(timeline, queryText = '', queryEmbedding = null) {
    const active = timeline.filter(t => !isArchived(t) && matchesActiveCategory(t));
    const ongoing = active.filter(t => (t.isActive && t.status === 'ongoing') || (isResidentEntry(t) && t.status === 'ongoing'));
    const foreshadow = active.filter(t => t.status === 'foreshadow');
    const residentEnded = active.filter(t => isResidentEntry(t) && t.status !== 'ongoing' && t.status !== 'foreshadow');
    const endedHits = active
        .filter(t => (!t.isActive || t.status === 'ended') && !isResidentEntry(t))
        .filter(t => entryTextMatches(t, queryText, ['title', 'event', 'summary', 'impact', 'location', 'storyTime'], queryEmbedding))
        .sort((a, b) => (b.storyTimeSort ?? b.updatedAt ?? 0) - (a.storyTimeSort ?? a.updatedAt ?? 0))
        .slice(0, getSettings().timelineEndedMax ?? 3);
    return {
        ongoing: uniqueById(ongoing),
        ended: uniqueById([...residentEnded, ...endedHits]),
        foreshadow: uniqueById(foreshadow),
    };
}

// ═══════════════════════════════════════════════════════════
//  v6.7.0 命名线程系统 — 线程总结注入
// ═══════════════════════════════════════════════════════════

/**
 * 从线程数据构建注入文本
 * @param {Array} threads - getTimelineThreads 的结果
 * @param {number} maxActive - 最大活跃线程数
 * @returns {object} { text: string, threads: Array }
 */
export function getThreadSummaryForInjection(threads, maxActive = 5) {
    if (!threads || !threads.length) return { text: '', threads: [] };

    // 用户预期：时间线程作为全局叙事地图全部注入，仅跳过已归档线程。
    const priorityOrder = { resident: 0, high: 1, medium: 2, low: 3 };
    const sorted = threads.filter(t => !isArchived(t) && t.status !== 'archived').sort((a, b) => {
        const pa = priorityOrder[a.priority || 'medium'] ?? 2;
        const pb = priorityOrder[b.priority || 'medium'] ?? 2;
        if (pa !== pb) return pa - pb;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    const forInjection = sorted;

    if (!forInjection.length) return { text: '', threads: [] };

    const lines = [getInjectionHeader(getSettings(), 'thread') || DEFAULT_INJECTION_SECTION_HEADERS.thread];
    for (const thread of forInjection) {
        const statusMark = thread.status === 'resident' ? '★常驻' :
                          thread.status === 'ongoing' ? '●进行中' :
                          thread.status === 'paused' ? '⏸暂停' : '';
        const typeMark = thread.type === 'emotional' ? '[感情]' :
                         thread.type === 'side' ? '[支线]' :
                         thread.type === 'world' ? '[世界]' : '';
        const summarySuffix = thread.summary ? ` — ${thread.summary}` : '';
        lines.push(`${statusMark} ${typeMark} ${thread.name}${summarySuffix}`);
        for (const entry of (thread.entries || [])) {
            const entryStatus = entry.status === 'ongoing' ? '→' :
                               entry.status === 'ended' ? '✓' :
                               entry.status === 'milestone' ? '◆' : '·';
            const period = entry.period || entry.storyTime || entry.time || '';
            const event = entry.event || entry.title || entry.summary || entry.note || '';
            lines.push(`  ${entryStatus} ${period} ${event}`);
        }
    }

    return { text: lines.join('\n'), threads: forInjection };
}

// ═══════════════════════════════════════════════════════════
//  格式化
// ═══════════════════════════════════════════════════════════

function formatNpcLine(npc) {
    if (npc._bbInjectMode === 'index') {
        return '◆ ' + buildNpcIndexCard(npc);
    }
    const parts = [npc.name, npc.role, npc.personality, npc.appearance, npc.status].filter(Boolean);
    const line = '◆ ' + parts.join(' | ');
    const relLines = (npc.relationships || []).map(r =>
        `  关系：${r.name ? '与' + r.name : ''}${r.type || ''}${r.attitude ? '（' + r.attitude + '）' : ''}`
    );
    return line + (relLines.length ? '\n' + relLines.join('\n') : '');
}

function formatItemLine(item) {
    if (item._bbInjectMode === 'index') {
        return '◆ ' + buildItemIndexCard(item);
    }
    const statusLabel = { held: '持有中', used: '已使用', lost: '已失去', destroyed: '已销毁' }[item.status] || item.status;
    const parts = [
        '◆ ' + item.name,
        item.owner ? '持有者：' + item.owner : '',
        '状态：' + statusLabel,
        item.significance || '',
        item.keepPermanent ? '（永久保留）' : '',
    ].filter(Boolean);
    return parts.join(' | ');
}

function formatTimelineLine(t) {
    const timeStr = t.storyTime || '';
    const activeMark = t.status === 'ongoing' ? '（进行中）' :
                       t.status === 'foreshadow' ? '【伏笔】' : '（已结束）';
    return `▸ ${timeStr} ${t.event} ${activeMark}\n  ${t.summary}${t.impact ? ' — ' + t.impact : ''}`;
}

function formatHiddenNotesForInjection(m) {
    if (!Array.isArray(m.hiddenNotes) || !m.hiddenNotes.length) return '';
    const lines = m.hiddenNotes
        .filter(note => note && note.allowInjection !== false && String(note.content || '').trim())
        .slice(0, 4)
        .map(note => {
            const type = note.type ? `[${note.type}]` : '';
            return `  [AI隐藏备注${type}] ${String(note.content).trim().slice(0, 180)}`;
        });
    return lines.length ? '\n' + lines.join('\n') : '';
}

function formatMemoryLine(m, chatLength = 0, level = 'L2') {
    const parts = [];
    if (m.title) parts.push(`[${m.title}]`);
    const typeLabel = MEMORY_TYPES[m.type]?.label || '';
    if (typeLabel) parts.push(`(${typeLabel})`);
    if (m.truthStatus && m.truthStatus !== 'true') {
        const ts = TRUTH_STATUS[m.truthStatus];
        if (ts) parts.push(`{${ts.label}}`);
    }
    const isResident = isResidentEntry(m);
    const isFuzzy = m.memoryTier === 'transient' && !isResident;
    const shouldUseFull = !isFuzzy && (isResident || level === 'L3' || level === 'L4');

    if (isFuzzy) {
        parts.push(m.summary || buildDefaultIndexCard(m) || (m.content || '').slice(0, 120));
    } else if (level === 'L1' && !shouldUseFull) {
        parts.push(buildDefaultIndexCard(m));
    } else if (shouldUseFull && m.content) {
        parts.push(m.content);
    } else if (m.summary) {
        parts.push(m.summary);
    } else {
        parts.push(m.content || m.summary);
    }
    if (m.verbatim) parts.push(`「${m.verbatim}」`);
    if (m.subject && m.target) parts.push(`(${m.subject} → ${m.target})`);
    else if (m.subject) parts.push(`(${m.subject})`);
    return parts.join(' ') + formatHiddenNotesForInjection(m);
}

function formatMapEdgeMeta(edge) {
    const meta = [edge.distance, edge.pathType, edge.difficulty && edge.difficulty !== 'normal' ? edge.difficulty : ''].filter(Boolean);
    return meta.length ? `(${meta.join('/')})` : '';
}

function buildMapContextLines(mapData, settings, queryText = '', tokenBudget = 800, queryEmbedding = null) {
    if (!mapData || typeof mapData !== 'object' || Object.keys(mapData.locations || {}).length === 0) {
        return { lines: [], tokens: 0, truncated: false, ids: [] };
    }

    const locs = Object.values(mapData.locations || {}).filter(loc => loc && !loc.archived);
    if (!locs.length) return { lines: [], tokens: 0, truncated: false, ids: [] };

    const locById = new Map(locs.map(loc => [loc.id, loc]));
    const incoming = new Map(locs.map(loc => [loc.id, []]));
    const children = new Map(locs.map(loc => [loc.id, []]));
    const regionGroups = new Map();
    for (const loc of locs) {
        if (loc.parentId && children.has(loc.parentId)) children.get(loc.parentId).push(loc);
        const regionKey = String(loc.region || '').trim().toLowerCase();
        if (regionKey) {
            if (!regionGroups.has(regionKey)) regionGroups.set(regionKey, []);
            regionGroups.get(regionKey).push(loc);
        }
        for (const edge of (loc.edges || [])) {
            if (incoming.has(edge.toId)) incoming.get(edge.toId).push({ ...edge, fromId: loc.id });
        }
    }

    const maxLocations = Math.max(1, settings.mapInjectionMax || 8);
    const queryTokens = extractTokens(queryText || '');
    const locMatchesQuery = (loc) => {
        if (embeddingSimilarity(loc, queryEmbedding) >= 0.62) return true;
        if (!queryTokens.length) return false;
        const neighborNames = [
            ...(loc.edges || []).map(e => locById.get(e.toId)?.name || ''),
            ...(incoming.get(loc.id) || []).map(e => locById.get(e.fromId)?.name || ''),
            ...(children.get(loc.id) || []).map(child => child.name || ''),
        ];
        const text = [loc.name, loc.region, loc.description, loc.realWorldRef, ...neighborNames]
            .filter(Boolean).join(' ').toLowerCase();
        return queryTokens.some(token => text.includes(token));
    };
    const scoreLoc = (loc) => {
        const degree = (loc.edges?.length || 0) + (incoming.get(loc.id)?.length || 0) + (children.get(loc.id)?.length || 0);
        return (locMatchesQuery(loc) ? 100 : 0)
            + (isResidentEntry(loc) ? 90 : 0)
            + degree * 5
            + (loc.updatedAt || 0) / 10000000000000;
    };

    const baseMatches = locs
        .filter(loc => isResidentEntry(loc) || locMatchesQuery(loc))
        .sort((a, b) => scoreLoc(b) - scoreLoc(a));

    if (!baseMatches.length) return { lines: [], tokens: 0, truncated: false, ids: [] };

    const selectedMap = new Map();
    const addSelected = (loc, reason) => {
        if (!loc || selectedMap.has(loc.id)) return;
        selectedMap.set(loc.id, { ...loc, _bbMapInjectReason: reason });
    };

    for (const loc of baseMatches) addSelected(loc, isResidentEntry(loc) ? 'resident' : 'hit');
    for (const loc of baseMatches) {
        if (selectedMap.size >= maxLocations) break;
        const neighbors = [
            loc.parentId ? locById.get(loc.parentId) : null,
            ...(children.get(loc.id) || []),
            ...(loc.edges || []).map(e => locById.get(e.toId)),
            ...(incoming.get(loc.id) || []).map(e => locById.get(e.fromId)),
            ...(regionGroups.get(String(loc.region || '').trim().toLowerCase()) || []).filter(other => other.id !== loc.id),
        ].filter(Boolean);
        for (const neighbor of neighbors) {
            if (selectedMap.size >= maxLocations) break;
            const sameRegion = neighbor.region && loc.region && String(neighbor.region).trim().toLowerCase() === String(loc.region).trim().toLowerCase();
            addSelected(neighbor, sameRegion ? 'same_region' : 'nearby');
        }
    }

    const selected = [...selectedMap.values()];

    const worldRef = settings.worldRealWorldRef || '';
    const header = getInjectionHeader(settings, 'map', {
        worldRef,
        worldRefSuffix: worldRef ? `｜现实参考：${worldRef}` : '',
    }) || (worldRef ? `【世界地图 — 空间关系】(现实参考: ${worldRef})` : '【世界地图 — 空间关系】');
    const lines = [header];
    let tokens = 0;
    const maxTokens = tokenBudget * 0.18;

    const chainFor = (loc) => {
        const prev = (incoming.get(loc.id) || [])[0];
        const next = (loc.edges || []).find(e => locById.has(e.toId));
        const names = [];
        if (prev) names.push(locById.get(prev.fromId)?.name || prev.fromId);
        names.push(loc.name || loc.id);
        if (next) names.push(locById.get(next.toId)?.name || next.toId);
        return names.length > 1 ? names.join(' → ') : '';
    };

    for (const loc of selected) {
        const parent = loc.parentId ? locById.get(loc.parentId) : null;
        const outEdges = (loc.edges || []).filter(e => locById.has(e.toId)).slice(0, 3);
        const inEdges = (incoming.get(loc.id) || []).slice(0, 3);
        const childNames = (children.get(loc.id) || []).slice(0, 4).map(child => child.name || child.id);
        const sameRegionNames = (regionGroups.get(String(loc.region || '').trim().toLowerCase()) || [])
            .filter(other => other.id !== loc.id)
            .slice(0, 5)
            .map(other => other.name || other.id);
        const mark = loc._bbMapInjectReason === 'resident' ? '★常驻' :
                     loc._bbMapInjectReason === 'same_region' ? '同区域' :
                     loc._bbMapInjectReason === 'nearby' ? '周边' : '命中';
        const parts = [`◆ [${mark}] ${loc.name || loc.id}`];
        if (loc.region) parts.push(`区域:${loc.region}`);
        if (parent) parts.push(`父地点:${parent.name || parent.id}`);
        if (loc.description) parts.push(`说明:${loc.description.slice(0, 80)}`);
        if (loc.realWorldRef) parts.push(`现实参考:${loc.realWorldRef}`);

        const relationLines = [];
        if (outEdges.length) {
            relationLines.push('  可前往: ' + outEdges.map(e => `${locById.get(e.toId)?.name || e.toId}${formatMapEdgeMeta(e)}`).join('；'));
        }
        if (inEdges.length) {
            relationLines.push('  入口来源: ' + inEdges.map(e => `${locById.get(e.fromId)?.name || e.fromId}${formatMapEdgeMeta(e)}`).join('；'));
        }
        if (childNames.length) relationLines.push('  子地点: ' + childNames.join('、'));
        if (sameRegionNames.length) relationLines.push('  同区域地点: ' + sameRegionNames.join('、'));
        const chain = chainFor(loc);
        if (chain) relationLines.push('  局部空间链: ' + chain);

        const line = [parts.join(' | '), ...relationLines].join('\n');
        const lt = estimateTokens(line);
        if (tokens + lt > maxTokens && !isResidentEntry(loc)) {
            return { lines, tokens, truncated: true, ids: selected.slice(0, lines.length - 1).map(l => l.id) };
        }
        lines.push(line);
        tokens += lt;
    }

    return { lines, tokens, truncated: selected.length < baseMatches.length, ids: selected.map(l => l.id) };
}

// ═══════════════════════════════════════════════════════════
//  统一注入构建
// ═══════════════════════════════════════════════════════════

/**
 * 构建四柱注入文本
 * @param {object} params
 * @param {Array} params.npcProfiles - getNpcForInjection 结果
 * @param {Array} params.items - getItemsForInjection 结果
 * @param {object} params.timeline - getTimelineForInjection 结果
 * @param {Array} params.relevantResults - getRelevantMemories 结果
 * @param {object} params.settings
 * @returns {{ text: string, tokenEstimate: number, stats: object }}
 */
export async function buildMemoryInjectionPrompt({ npcProfiles, items, timeline, threadSummary, relevantResults, settings, chatLength = 0, clueBoard = null, mapData = null, queryText = '', queryEmbedding = null }) {
    const tokenBudget = settings.tokenBudget || 800;
    let tokenUsed = 0;
    const stats = { npcCount: 0, itemCount: 0, timelineCount: 0, memoryCount: 0, threadCount: 0, mapCount: 0, mapLocationIds: [] };
    const truncated = [];

    const sections = [];

    // ── 区块 0：故事线程地图（v6.7.0 — 最前，给 LLM 全局叙事视野）──
    if (threadSummary && threadSummary.text) {
        const threadText = threadSummary.text;
        const threadTokens = estimateTokens(threadText);
        sections.push(threadText);
        tokenUsed += threadTokens;
        stats.threadCount = threadSummary.threads?.length || 0;
        if (threadTokens > tokenBudget * 0.25) truncated.push('线程地图(超过建议预算但已保留)');
    }

    // ── 区块 1：角色档案 ──
    if (npcProfiles?.length) {
        const lines = [getInjectionHeader(settings, 'npc') || DEFAULT_INJECTION_SECTION_HEADERS.npc];
        let sectionTokens = 0;
        for (const npc of npcProfiles) {
            const line = formatNpcLine(npc);
            const lt = estimateTokens(line);
            if (sectionTokens + lt > tokenBudget * 0.3 && !isResidentEntry(npc)) break;
            lines.push(line);
            sectionTokens += lt;
            stats.npcCount++;
        }
        tokenUsed += sectionTokens;
        if (lines.length > 1) sections.push(lines.join('\n'));
        if (stats.npcCount < npcProfiles.length) {
            truncated.push(`角色(${stats.npcCount}/${npcProfiles.length})`);
        }
    }

    // ── 区块 2：重要物品 ──
    if (items?.length) {
        const lines = [getInjectionHeader(settings, 'item') || DEFAULT_INJECTION_SECTION_HEADERS.item];
        let sectionTokens = 0;
        for (const item of items) {
            const line = formatItemLine(item);
            const lt = estimateTokens(line);
            if (sectionTokens + lt > tokenBudget * 0.2 && !isResidentEntry(item)) break;
            lines.push(line);
            sectionTokens += lt;
            stats.itemCount++;
        }
        tokenUsed += sectionTokens;
        if (lines.length > 1) sections.push(lines.join('\n'));
        if (stats.itemCount < items.length) {
            truncated.push(`物品(${stats.itemCount}/${items.length})`);
        }
    }

    // ── 区块 3：故事时间线 ──
    if (timeline) {
        const { ongoing, ended, foreshadow } = timeline;
        const threadIndex = buildThreadTimelineIndex(threadSummary?.threads || []);
        const all = [...foreshadow, ...ongoing, ...ended].filter(t =>
            isResidentEntry(t) || isForeshadowTimeline(t) || !isTimelineCoveredByThread(t, threadIndex)
        );
        if (all.length) {
            const lines = [getInjectionHeader(settings, 'timeline') || DEFAULT_INJECTION_SECTION_HEADERS.timeline];
            let sectionTokens = 0;
            for (const t of all) {
                const line = formatTimelineLine(t);
                const lt = estimateTokens(line);
                if (sectionTokens + lt > tokenBudget * 0.25 && !isResidentEntry(t) && t.status !== 'ongoing' && t.status !== 'foreshadow') break;
                lines.push(line);
                sectionTokens += lt;
                stats.timelineCount++;
            }
            tokenUsed += sectionTokens;
            if (lines.length > 1) sections.push(lines.join('\n'));
            if (stats.timelineCount < all.length) {
                truncated.push(`时间线(${stats.timelineCount}/${all.length})`);
            }
        }
    }

    // ── 区块 4：相关记忆 ──
    if (relevantResults?.length) {
        const lines = [getInjectionHeader(settings, 'memory') || DEFAULT_INJECTION_SECTION_HEADERS.memory];
        const MAX_MEM = (settings.maxResults || 10) + 4;
        let count = 0;
        let sectionTokens = 0;
        for (const { memory, level } of relevantResults) {
            if (count >= MAX_MEM && !isResidentEntry(memory)) break;
            const line = (count + 1) + '. ' + formatMemoryLine(memory, chatLength, level);
            const lt = estimateTokens(line);
            if (sectionTokens + lt > tokenBudget * 0.7 && !isResidentEntry(memory)) break;
            lines.push(line);
            sectionTokens += lt;
            count++;
            stats.memoryCount++;
        }
        tokenUsed += sectionTokens;
        if (lines.length > 1) sections.push(lines.join('\n'));
        if (stats.memoryCount < relevantResults.length) {
            truncated.push(`记忆(${stats.memoryCount}/${relevantResults.length})`);
        }
    }

    // ── 区块 5：线索板（v8.4.0）──
    // ── 区块6：世界地图 v8.7.0 ──
    const mapContext = buildMapContextLines(mapData, settings, queryText, tokenBudget, queryEmbedding);
    if (mapContext.lines.length > 1) {
        sections.push(mapContext.lines.join('\n'));
        tokenUsed += mapContext.tokens;
        stats.mapInjected = true;
        stats.mapCount = mapContext.ids.length;
        stats.mapLocationIds = mapContext.ids;
        if (mapContext.truncated) truncated.push('地图(按空间关系截断)');
    }

    if (clueBoard && typeof clueBoard === 'object') {
        const { hasActiveClues, buildClueBoardInjection } = await import('./clue-board.js');
        if (hasActiveClues(clueBoard)) {
            const clueText = buildClueBoardInjection(clueBoard);
            const clueTokens = estimateTokens(clueText);
            if (clueTokens <= tokenBudget * 0.15) {
                sections.push(clueText);
                tokenUsed += clueTokens;
                stats.clueBoard = true;
            } else {
                sections.push(clueText);
                tokenUsed += clueTokens;
                stats.clueBoard = true;
                truncated.push('线索板(超过建议预算但已保留)');
            }
        }
    }

    const text = sections.join('\n\n');
    const tokenEstimate = tokenUsed;

    return { text, tokenEstimate, stats, truncated, tokenBudget };
}

// ═══════════════════════════════════════════════════════════
//  简单搜索
// ═══════════════════════════════════════════════════════════

/**
 * simpleSearch — 简单字符串匹配搜索
 */
export function simpleSearch(items, queryText, maxResults = 100) {
    if (!items?.length || !queryText?.trim()) return [];
    const q = queryText.toLowerCase();
    return items.filter(item => {
        if (isArchived(item)) return false;
        const pool = [
            item.content, item.title || '', item.summary || '',
            item.subject || '', item.target || '',
            item.name || '', item.event || '', item.significance || '',
            ...(item.tags || []).map(t => typeof t === 'string' ? t : t.name),
        ].join(' ').toLowerCase();
        return pool.includes(q) || extractTokens(q).some(t => pool.includes(t));
    }).slice(0, maxResults);
}

/**
 * getResidentMemories — v5 中 memoryTier=core/eternal 即为常驻
 */
export function getResidentMemories(memories) {
    return memories.filter(m =>
        (m.memoryTier === 'core' || m.memoryTier === 'eternal') &&
        !isArchived(m) && m.status !== 'deleted' && matchesActiveCategory(m)
    );
}
