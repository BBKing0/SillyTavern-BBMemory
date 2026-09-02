/**
 * retriever.js —— BB-Memory v9.4.3 检索与注入系统
 *
 * 长期记忆注入格式：角色档案 / 重要物品 / 故事里程碑 / 故事时间线 / 相关记忆。
 * 简化为 5 维评分 + 实体展开。
 */

import {
    MEMORY_TYPES,
    TRUTH_STATUS,
    REALTIME_KINDS,
    getRealtimeKindSlotLimits,
} from './memory-types.js';
import {
    NPC_TIERS,
    ITEM_TIERS,
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
import { entityNameSimilarity, normalizeIdentityText } from './dedup-engine.js';

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
    thread: '以下是持续故事线与事件顺序。',
    timeline: '以下是持续故事线与事件顺序。',
    npc: '格式：-姓名|级别|身份|关系|性格|外貌|位置\n只有检索命中的人物才会追加“【详细介绍】”。',
    item: '格式：-物品名|持有者或地点|状态\n条目按持有者、地点连续排列；只有检索命中的物品才会追加“【详细说明】”。',
    milestone: '格式：日期：内容',
    memory: '格式：序号.[日期]内容\n（说话者→对话对象）人物对话',
    map: '以下是地点与空间关系{{worldRefSuffix}}。\n格式：-地点名 | 区域:区域名 | 父地点:地点名 | 说明:地点说明 | 现实参考:参考地点\n下方缩进行表示“可前往 / 入口来源 / 子地点 / 同区域地点 / 局部空间链”。',
    // v9.3.3 第五柱：不参与检索、无条件注入
    realtime: '以下是当前场景仍然有效的临时细节，用于保持连续性，不是长期设定。',
});

const MAP_INJECTION_FORMAT_GUIDE = '格式：-地点名 | 区域:区域名 | 父地点:地点名 | 说明:地点说明 | 现实参考:参考地点\n'
    + '下方缩进行表示“可前往 / 入口来源 / 子地点 / 同区域地点 / 局部空间链”。';

const SECTION_XML_TAGS = Object.freeze({
    timeline: 'Story_Timeline',
    thread: 'Story_Timeline',
    npc: 'Characters',
    item: 'Items',
    milestone: 'Milestones',
    memory: 'Relevant_Memories',
    map: 'Map',
    clue: 'Clue_Board',
    realtime: 'Current_Scene_Details',
});

const TOKEN_BUDGET_MODES = Object.freeze({
    RESIDENT_UNLIMITED: 'resident_unlimited',
    STRICT_TOTAL: 'strict_total',
});

const SECTION_BUDGET_RATIOS = Object.freeze({
    thread: 0.25,
    timeline: 0.25,
    npc: 0.30,
    item: 0.20,
    milestone: 0.25,
    memory: 0.70,
    map: 0.18,
    clue: 0.15,
    // v9.3.3 实时记忆的实际约束是它自己的双硬上限（条数 + token），
    // 这个比例只在 strict_total 模式下才会被用到。
    realtime: 0.20,
});

const SECTION_LABELS = Object.freeze({
    thread: '时间线',
    timeline: '时间线',
    npc: 'NPC',
    item: '物品',
    milestone: '里程碑',
    memory: '记忆',
    map: '地图',
    clue: '线索板',
    realtime: '实时',
});

function getInjectionHeader(settings, key, replacements = {}) {
    const activeSettings = settings || getSettings();
    const defaultValue = DEFAULT_INJECTION_SECTION_HEADERS[key] || '';
    const fallback = key === 'timeline'
        ? getPromptTemplate(activeSettings, 'injection.threadHeader', defaultValue)
        : defaultValue;
    const template = getPromptTemplate(activeSettings, `injection.${key}Header`, fallback);
    return fillPromptTemplate(template, replacements).trim();
}

function getStructuredInjectionHeader(settings, key, replacements = {}) {
    let header = getInjectionHeader(settings, key, replacements);
    // 只迁移旧版内置格式文案，不覆盖用户真正自定义的说明。
    if (key === 'npc') {
        header = header.replace(
            '-姓名|身份|关系|性格|外貌|位置|级别',
            '-姓名|级别|身份|关系|性格|外貌|位置',
        );
    } else if (key === 'memory') {
        header = header.replace(
            '格式：序号.[日期]内容|人物对话',
            '格式：序号.[日期]内容\n（说话者→对话对象）人物对话',
        );
    } else if (key === 'map' && !header.includes('格式：-地点名')) {
        header = [header, MAP_INJECTION_FORMAT_GUIDE].filter(Boolean).join('\n');
    }
    return header;
}

export function getRetrieverPromptTemplates() {
    return [
        {
            key: 'injection.timelineHeader',
            title: '时间线注入标题',
            category: '五柱注入',
            description: '长期记忆注入中“故事时间线”区块的标题。',
            defaultValue: DEFAULT_INJECTION_SECTION_HEADERS.timeline,
        },
        {
            key: 'injection.threadHeader',
            title: '旧版时间线注入标题（threadHeader）',
            category: '五柱注入',
            description: '兼容旧模板键；新版本优先使用 injection.timelineHeader。',
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
            key: 'injection.milestoneHeader',
            title: '里程碑注入标题',
            category: '五柱注入',
            description: '长期记忆注入中故事里程碑区块的标题。',
            defaultValue: DEFAULT_INJECTION_SECTION_HEADERS.milestone,
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
            description: '长期记忆注入中世界地图/空间关系区块的标题，{{worldRefSuffix}} 会带入当前角色的现实参考。',
            defaultValue: DEFAULT_INJECTION_SECTION_HEADERS.map,
        },
        {
            key: 'injection.realtimeHeader',
            title: '实时记忆注入标题',
            category: '实时记忆',
            description: '第五柱「当前场景细节」区块的标题。这一柱不参与检索、无条件注入，'
                + '标题里最好写明它是临时细节而非长期设定，避免模型把它当作永久设定。',
            defaultValue: DEFAULT_INJECTION_SECTION_HEADERS.realtime,
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

function isResidentMilestone(entry) {
    if (!entry) return false;
    if (isResidentEntry(entry)) return true;
    if (entry.memoryTier === 'stable' || entry.injectionMode === 'vector') return false;
    if (entry.memoryTier === 'transient' || entry.status === 'dusty') return false;
    return entry.injectionMode !== 'vector';
}

function isDustyItem(item) {
    return item?.memoryTier === 'transient' || item?.status === 'dusty';
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
    const createTime = memory.lastHitAt || memory.createdAt || Date.now();
    const age = Math.max(0, now - createTime);
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
        const ctx = SillyTavern.getContext();
        const Fuse = ctx?.libs?.Fuse || globalThis.SillyTavern?.libs?.Fuse;
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
    const candidates = [];
    for (const npc of npcProfiles) {
        if (isArchived(npc) || !matchesActiveCategory(npc)) continue;
        const resident = isResidentEntry(npc);
        const alwaysIndex = npc.npcTier === 'core' || npc.npcTier === 'important';
        const hit = entryTextMatches(npc, queryText, ['name', 'role', 'personality', 'appearance', 'status', 'location'], queryEmbedding);
        // 详细介绍严格按命中展开；核心/重要/常驻人物在未命中时也只给固定的一行索引。
        if (hit) candidates.push(cloneForInjection(npc, 'full', 'hit'));
        else if (resident || alwaysIndex) candidates.push(cloneForInjection(npc, 'index', resident ? 'resident_index' : 'always_index'));
    }
    const tierOrder = { core: 0, important: 1, minor: 2, background: 3 };
    candidates.sort((a, b) => {
        const hitDelta = (b._bbInjectReason === 'hit' ? 1 : 0) - (a._bbInjectReason === 'hit' ? 1 : 0);
        if (hitDelta) return hitDelta;
        return (tierOrder[a.npcTier] ?? 2) - (tierOrder[b.npcTier] ?? 2);
    });
    const max = clampIntSetting(getSettings().npcInjectionMax, 0, 100, 8);
    return uniqueById(candidates).slice(0, max);
}

/**
 * 物品栏：命中时展开；达到命中次数阈值时常态注入一行索引；其余按稳定概率少量抽样。
 */
export function getItemsForInjection(items, queryText, queryEmbedding = null) {
    const settings = getSettings();
    const max = clampIntSetting(settings.itemInjectionMax, 0, 100, 5);
    if (max <= 0) return [];
    const hitThreshold = clampIntSetting(settings.itemResidentHitCountThreshold, 0, 100000, 5);
    const fallbackProbability = clampIntSetting(settings.itemFallbackInjectionProbability, 0, 100, 5);
    const fallbackMax = clampIntSetting(settings.itemFallbackInjectionMax, 0, 50, 2);
    const hits = [];
    const frequent = [];
    const fallback = [];

    const stableRoll = (item) => {
        const seed = `${item.id || item.name}|${normalizeIdentityText(queryText)}`;
        let hash = 2166136261;
        for (let i = 0; i < seed.length; i++) {
            hash ^= seed.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0) % 100;
    };

    for (const item of items) {
        if (isArchived(item) || !matchesActiveCategory(item)) continue;
        const hit = !isDustyItem(item) && entryTextMatches(item, queryText, ['name', 'owner', 'status', 'significance', 'location'], queryEmbedding);
        if (hit) {
            hits.push(cloneForInjection(item, 'full', 'hit'));
            continue;
        }
        if ((Number(item.hitCount) || 0) >= hitThreshold) {
            frequent.push(cloneForInjection(item, 'index', 'frequent_index'));
            continue;
        }
        if (!isDustyItem(item) && fallbackProbability > 0 && stableRoll(item) < fallbackProbability) {
            fallback.push(cloneForInjection(item, 'index', 'fallback_sample'));
        }
    }

    const tierOrder = { key: 0, equipped: 1, clue: 2, consumable: 3, background: 4 };
    const qualitySort = (a, b) => {
        const tierDelta = (tierOrder[a.itemTier] ?? 3) - (tierOrder[b.itemTier] ?? 3);
        if (tierDelta) return tierDelta;
        const hitDelta = (Number(b.hitCount) || 0) - (Number(a.hitCount) || 0);
        if (hitDelta) return hitDelta;
        return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
    };
    hits.sort(qualitySort);
    frequent.sort(qualitySort);
    fallback.sort(qualitySort);
    const distinct = [];
    for (const candidate of uniqueById([...hits, ...frequent, ...fallback.slice(0, fallbackMax)])) {
        if (distinct.some(existing => entityNameSimilarity('item', candidate, existing) >= 0.94)) continue;
        distinct.push(candidate);
    }
    const selected = distinct.slice(0, max);

    // 最终展示以“持有人 > 地点 > 未归属”为主键，同一人的物品保持连续，避免 121212 交错。
    const groupKey = item => normalizeIdentityText(item.owner)
        ? `0|${normalizeIdentityText(item.owner)}`
        : (normalizeIdentityText(item.location) ? `1|${normalizeIdentityText(item.location)}` : '2|');
    selected.sort((a, b) => groupKey(a).localeCompare(groupKey(b), 'zh-CN') || qualitySort(a, b));
    return selected;
}

/**
 * 里程碑：默认常驻全注入；设置为 vector 的里程碑只在关键词/向量命中时注入。
 */
export function getMilestonesForInjection(milestones, queryText = '', queryEmbedding = null) {
    const active = milestones.filter(t => !isArchived(t) && matchesActiveCategory(t));
    const resident = active.filter(isResidentMilestone);
    const vectorLimit = Number(getSettings().milestoneVectorMax ?? getSettings().timelineEndedMax ?? 3);
    const vectorHits = active
        .filter(t => !isResidentMilestone(t))
        .filter(t => entryTextMatches(t, queryText, ['title', 'event', 'summary', 'impact', 'location', 'storyTime'], queryEmbedding))
        .sort((a, b) => (b.storyTimeSort ?? b.updatedAt ?? 0) - (a.storyTimeSort ?? a.updatedAt ?? 0))
        .slice(0, Math.max(0, Number.isFinite(vectorLimit) ? vectorLimit : 3));
    const selected = uniqueById([...resident, ...vectorHits]);
    return {
        ongoing: selected.filter(t => !isForeshadowTimeline(t) && (t.status === 'ongoing' || t.isActive)),
        ended: selected.filter(t => !isForeshadowTimeline(t) && !(t.status === 'ongoing' || t.isActive)),
        foreshadow: selected.filter(isForeshadowTimeline),
    };
}

// ═══════════════════════════════════════════════════════════
//  v9.2.0 时间线系统 — 时间线总结注入
// ═══════════════════════════════════════════════════════════

/**
 * 从时间线数据构建注入文本
 * @param {Array} timeline - getTimeline 的结果
 * @param {number} maxActive - 最大活跃时间线数
 * @returns {object} { text: string, timeline: Array, threads: Array }
 */
export function getTimelineForInjection(timeline, maxActive = 5) {
    if (!timeline || !timeline.length) return { text: '', timeline: [], threads: [] };

    // 常驻时间线全部注入；其他时间线按上限注入，避免叙事地图过长。
    const priorityOrder = { resident: 0, high: 1, medium: 2, low: 3 };
    const sorted = timeline.filter(t => !isArchived(t) && t.status !== 'archived').sort((a, b) => {
        const pa = priorityOrder[a.priority || 'medium'] ?? 2;
        const pb = priorityOrder[b.priority || 'medium'] ?? 2;
        if (pa !== pb) return pa - pb;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    const resident = sorted.filter(t => isResidentEntry(t) || t.status === 'resident');
    const nonResidentLimit = Math.max(0, Number.isFinite(Number(maxActive)) ? Number(maxActive) : 5);
    const forInjection = uniqueById([
        ...resident,
        ...sorted.filter(t => !(isResidentEntry(t) || t.status === 'resident')).slice(0, nonResidentLimit),
    ]);

    if (!forInjection.length) return { text: '', timeline: [], threads: [] };

    const header = getInjectionHeader(getSettings(), 'timeline') || getInjectionHeader(getSettings(), 'thread') || DEFAULT_INJECTION_SECTION_HEADERS.timeline;
    const lines = [header];
    const blocks = [];
    for (const line of forInjection) {
        const summarySuffix = line.summary ? `：${line.summary}` : '';
        const blockLines = [`-${line.name}${summarySuffix}`];
        for (const entry of (line.entries || [])) {
            const period = entry.period || entry.storyTime || entry.time || '';
            const event = entry.event || entry.title || entry.summary || entry.note || '';
            blockLines.push(`  ${period || '时间未明'}：${event}`);
        }
        lines.push(...blockLines);
        blocks.push({ text: blockLines.join('\n'), timeline: line, thread: line });
    }

    return { text: lines.join('\n'), timeline: forInjection, threads: forInjection, header, blocks };
}

export const getThreadSummaryForInjection = getTimelineForInjection;

// ═══════════════════════════════════════════════════════════
//  格式化
// ═══════════════════════════════════════════════════════════

function cleanMergedField(value, maxChars = 80, preferLatest = false) {
    const segments = String(value || '')
        .split(/\n?\s*(?:\[\s*(?:补充|初始化合并|追加|新增)\s*\]|【\s*(?:补充|追加|新增)\s*】)\s*/g)
        .map(text => text.trim().replace(/[\r\n]+/g, ' '))
        .filter(Boolean);
    const seen = new Set();
    const unique = [];
    for (const segment of segments) {
        const key = normalizeIdentityText(segment);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unique.push(segment);
    }
    const source = preferLatest ? unique.slice().reverse() : unique;
    const text = source.join('；');
    const limit = Math.max(0, Number(maxChars) || 0);
    if (!limit || text.length <= limit) return text;
    return text.slice(0, Math.max(1, limit - 1)).trimEnd() + '…';
}

function formatNpcRelationship(npc, maxChars = 54) {
    const text = (npc.relationships || []).map(r => {
        const name = String(r?.name || '').trim();
        const relation = String(r?.type || r?.relation || '').trim();
        const attitude = String(r?.attitude || '').trim();
        return [name, relation, attitude].filter(Boolean).join(':');
    }).filter(Boolean).join('；');
    return cleanMergedField(text, maxChars);
}

function formatNpcLine(npc) {
    const tierLabel = NPC_TIERS[npc.npcTier]?.label || npc.npcTier || '配角';
    const row = [
        npc.name || '未命名',
        tierLabel,
        cleanMergedField(npc.role, 36, true),
        formatNpcRelationship(npc),
        cleanMergedField(npc.personality, 54, true),
        cleanMergedField(npc.appearance, 54, true),
        cleanMergedField(npc.location, 32, true),
    ].join('|');
    if (npc._bbInjectMode !== 'full') return `-${row}`;

    const maxChars = clampIntSetting(getSettings().entityDetailInjectionMaxChars, 40, 2000, 320);
    const notes = (npc.notes || []).map(note => typeof note === 'string' ? note : note?.content).filter(Boolean).join('；');
    const detail = cleanMergedField([
        npc.indexCard,
        npc.status ? `当前状态：${npc.status}` : '',
        npc.personality ? `性格：${npc.personality}` : '',
        npc.appearance ? `外貌：${npc.appearance}` : '',
        notes,
    ].filter(Boolean).join('；'), maxChars);
    return `-${row}${detail ? `\n【详细介绍】${detail}` : ''}`;
}

function formatItemLine(item) {
    const statusLabel = { held: '持有中', used: '已使用', lost: '已失去', destroyed: '已销毁' }[item.status] || item.status;
    const holderOrLocation = cleanMergedField(item.owner || item.location || '未归属', 36, true);
    const row = `-${item.name || '未命名'}|${holderOrLocation}|${statusLabel || '状态未明'}`;
    if (item._bbInjectMode !== 'full') return row;
    const maxChars = clampIntSetting(getSettings().entityDetailInjectionMaxChars, 40, 2000, 320);
    const detail = cleanMergedField(item.significance, maxChars);
    return `${row}${detail ? `\n【详细说明】${detail}` : ''}`;
}

function formatTimelineLine(t) {
    return `${t.storyTime || '时间未明'}：${t.event || t.summary || ''}`;
}

function formatHiddenNotesForInjection(m) {
    if (!Array.isArray(m.hiddenNotes) || !m.hiddenNotes.length) return '';
    const lines = m.hiddenNotes
        .filter(note => note && note.allowInjection !== false && String(note.content || '').trim())
        .slice(0, 4)
        .map(note => {
            const type = note.type ? `[${note.type}]` : '';
            const content = String(note.content).trim().slice(0, 180).replace(/[\r\n]+/g, ' ');
            return `  [AI隐藏备注${type}] ${content}`;
        });
    return lines.length ? '\n' + lines.join('\n') : '';
}

function isRecentSourceMemory(m, chatLength = 0, settings = getSettings()) {
    const windowSize = Number(settings?.floorRecentWindow ?? 6);
    const sourceFloor = Number(m?.sourceFloor);
    const totalFloors = Number(chatLength);
    if (!Number.isFinite(windowSize) || windowSize <= 0) return false;
    if (!Number.isFinite(sourceFloor) || sourceFloor < 0) return false;
    if (!Number.isFinite(totalFloors) || totalFloors <= 0) return false;
    return sourceFloor >= Math.max(0, totalFloors - windowSize);
}

function formatMemoryLine(m, chatLength = 0, level = 'L2', settings = getSettings()) {
    const isResident = isResidentEntry(m);
    const isFuzzy = m.memoryTier === 'transient' && !isResident;
    const recentFull = isRecentSourceMemory(m, chatLength, settings);
    const shouldUseFull = !isFuzzy && (isResident || recentFull || level === 'L3' || level === 'L4');
    let content = '';

    if (isFuzzy) {
        content = m.summary || buildDefaultIndexCard(m) || (m.content || '').slice(0, 120);
    } else if (level === 'L1' && !shouldUseFull) {
        content = buildDefaultIndexCard(m);
    } else if (shouldUseFull && m.content) {
        content = m.content;
    } else if (m.summary) {
        content = m.summary;
    } else {
        content = m.content || m.summary;
    }
    const date = String(m.storyTime || m.date || m.time || '时间未明').trim();
    const dialogue = String(m.verbatim || '').trim();
    if (!dialogue) return `[${date}]${String(content || '').trim()}`;

    const participants = Array.isArray(m.participants)
        ? m.participants.map(name => String(name || '').trim()).filter(Boolean)
        : [];
    const speaker = String(m.subject || m.speaker || m.from || participants[0] || '说话者未明').trim();
    const listener = String(
        m.target
        || m.listener
        || m.to
        || participants.find(name => name !== speaker)
        || '对象未明'
    ).trim();
    return `[${date}]${String(content || '').trim()}\n（${speaker}→${listener}）${dialogue}`;
}

function formatMapEdgeMeta(edge) {
    const meta = [edge.distance, edge.pathType, edge.difficulty && edge.difficulty !== 'normal' ? edge.difficulty : ''].filter(Boolean);
    return meta.length ? `(${meta.join('/')})` : '';
}

function buildMapContextLines(mapData, settings, queryText = '', tokenBudget = 800, queryEmbedding = null) {
    if (!mapData || typeof mapData !== 'object' || Object.keys(mapData.locations || {}).length === 0) {
        return { lines: [], blocks: [], tokens: 0, truncated: false, ids: [] };
    }

    const locs = Object.values(mapData.locations || {}).filter(loc => loc && !loc.archived);
    if (!locs.length) return { lines: [], blocks: [], tokens: 0, truncated: false, ids: [] };

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

    const maxLocations = clampIntSetting(settings.mapInjectionMax, 0, 100, 8);
    if (maxLocations <= 0) return { lines: [], blocks: [], tokens: 0, truncated: false, ids: [] };
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

    let baseMatches = locs
        .filter(loc => isResidentEntry(loc) || locMatchesQuery(loc))
        .sort((a, b) => scoreLoc(b) - scoreLoc(a))
        .slice(0, maxLocations);

    // 普通地点既不是 resident、用户本轮也没说地名时，旧逻辑会让整张地图永远为空。
    // 兜底选最近更新且连接度高的少量地点，让 AI 至少保有当前世界的空间骨架。
    if (!baseMatches.length) {
        const fallbackMax = Math.min(maxLocations, clampIntSetting(settings.mapFallbackInjectionMax, 0, 50, 3));
        baseMatches = locs.slice().sort((a, b) => scoreLoc(b) - scoreLoc(a)).slice(0, fallbackMax);
    }
    if (!baseMatches.length) return { lines: [], blocks: [], tokens: 0, truncated: false, ids: [] };

    const selectedMap = new Map();
    const addSelected = (loc, reason) => {
        if (!loc || selectedMap.has(loc.id)) return;
        selectedMap.set(loc.id, { ...loc, _bbMapInjectReason: reason });
    };

    for (const loc of baseMatches) {
        if (selectedMap.size >= maxLocations) break;
        addSelected(loc, isResidentEntry(loc) ? 'resident' : (locMatchesQuery(loc) ? 'hit' : 'fallback'));
    }
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
    const header = getStructuredInjectionHeader(settings, 'map', {
        worldRef,
        worldRefSuffix: worldRef ? `｜现实参考：${worldRef}` : '',
    }) || (worldRef ? `地点与空间关系（现实参考：${worldRef}）` : '地点与空间关系');
    const lines = [header];
    const blocks = [];
    let tokens = 0;

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
        const parts = [`-${loc.name || loc.id}`];
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
        lines.push(line);
        blocks.push({
            text: line,
            id: loc.id,
            resident: isResidentEntry(loc),
            reason: loc._bbMapInjectReason || '',
        });
        tokens += lt;
    }

    return { lines, blocks, tokens, truncated: selected.length < locs.length, ids: blocks.map(l => l.id) };
}

// ═══════════════════════════════════════════════════════════
//  统一注入构建
// ═══════════════════════════════════════════════════════════

function normalizeTokenBudget(settings) {
    const n = Number(settings?.tokenBudget);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 800;
}

function normalizeBudgetMode(settings) {
    return settings?.tokenBudgetMode === TOKEN_BUDGET_MODES.STRICT_TOTAL
        ? TOKEN_BUDGET_MODES.STRICT_TOTAL
        : TOKEN_BUDGET_MODES.RESIDENT_UNLIMITED;
}

function tagText(entry) {
    return (entry?.tags || [])
        .map(t => typeof t === 'string' ? t : t?.name)
        .filter(Boolean)
        .join(' ');
}

function hasClueOrForeshadowSignal(entry) {
    const text = [
        entry?.type,
        entry?.cognitiveType,
        entry?.status,
        entry?.itemTier,
        entry?.title,
        entry?.summary,
        tagText(entry),
    ].filter(Boolean).join(' ').toLowerCase();
    return /clue|hint|foreshadow|线索|伏笔|疑点|谜/.test(text);
}

function priorityForThread(thread) {
    if (isResidentEntry(thread) || thread?.status === 'resident') return 0;
    if (thread?.status === 'ongoing' || thread?.priority === 'high') return 1;
    return 2;
}

function priorityForNpc(npc) {
    if (isResidentEntry(npc) || npc?.npcTier === 'core') return 0;
    if (npc?.npcTier === 'important') return 1;
    return 2;
}

function priorityForItem(item) {
    if (isResidentEntry(item) || item?.keepPermanent) return 0;
    if (item?.itemTier === 'key' || item?.itemTier === 'equipped' || item?.itemTier === 'clue' || hasClueOrForeshadowSignal(item)) return 1;
    return 2;
}

function priorityForTimelineEntry(entry) {
    if (isResidentMilestone(entry)) return 0;
    if (entry?.status === 'ongoing' || entry?.isActive || isForeshadowTimeline(entry)) return 1;
    return 2;
}

function priorityForMemory(memory) {
    if (isResidentEntry(memory)) return 0;
    if (hasClueOrForeshadowSignal(memory)) return 1;
    return 2;
}

function makeBudgetItem(text, options = {}) {
    const cleanText = String(text || '').trimEnd();
    return {
        text: cleanText,
        tokens: estimateTokens(cleanText),
        resident: !!options.resident,
        priority: Number.isFinite(options.priority) ? options.priority : 2,
        collection: options.collection || '',
        id: options.id || '',
        flagKey: options.flagKey || '',
    };
}

function makeBudgetSection(key, header, items, options = {}) {
    const normalizedItems = (items || []).filter(item => item && String(item.text || '').trim());
    const xmlTag = options.xmlTag || SECTION_XML_TAGS[key] || '';
    const openTag = xmlTag ? `<${xmlTag}>` : '';
    const closeTag = xmlTag ? `</${xmlTag}>` : '';
    return {
        key,
        label: options.label || SECTION_LABELS[key] || key,
        header: String(header || '').trim(),
        openTag,
        closeTag,
        headerTokens: estimateTokens([openTag, header, closeTag].filter(Boolean).join('\n')),
        items: normalizedItems,
        extraTruncated: options.extraTruncated || '',
        allowFirstOverSectionCap: options.allowFirstOverSectionCap === true,
    };
}

function getThreadBudgetBlocks(threadSummary) {
    if (!threadSummary?.text) return [];
    if (Array.isArray(threadSummary.blocks) && threadSummary.blocks.length) return threadSummary.blocks;

    const lines = String(threadSummary.text || '').split('\n');
    const body = lines.slice(1).join('\n').trim();
    return body ? [{ text: body, thread: null }] : [];
}

function allocateBudgetSections(sections, settings, tokenBudget) {
    const mode = normalizeBudgetMode(settings);
    const flat = [];
    let order = 0;

    sections.forEach((section, sectionIndex) => {
        section.items.forEach((item, itemIndex) => {
            flat.push({ section, sectionIndex, item, itemIndex, order: order++ });
        });
    });

    flat.sort((a, b) => {
        if (a.item.priority !== b.item.priority) return a.item.priority - b.item.priority;
        return a.order - b.order;
    });

    const selectedKeys = new Set();
    const selectedSections = new Set();
    const sectionBudgetUsed = new Map();
    let budgetUsed = 0;
    let tokenEstimate = 0;

    for (const entry of flat) {
        const { section, sectionIndex, item, itemIndex } = entry;
        const hasHeader = selectedSections.has(sectionIndex);
        const headerCost = hasHeader ? 0 : section.headerTokens;
        const actualCost = item.tokens + headerCost;
        const unlimited = mode === TOKEN_BUDGET_MODES.RESIDENT_UNLIMITED && item.resident;

        let fits = true;
        if (!unlimited) {
            if (mode === TOKEN_BUDGET_MODES.RESIDENT_UNLIMITED) {
                const ratio = SECTION_BUDGET_RATIOS[section.key] ?? 1;
                const sectionCap = Math.max(1, Math.floor(tokenBudget * ratio));
                const nextSectionUsed = (sectionBudgetUsed.get(section.key) || 0) + actualCost;
                fits = budgetUsed + actualCost <= tokenBudget && nextSectionUsed <= sectionCap;
                if (!fits && section.allowFirstOverSectionCap && !selectedSections.has(sectionIndex)) {
                    fits = budgetUsed + actualCost <= tokenBudget;
                }
            } else {
                fits = budgetUsed + actualCost <= tokenBudget;
            }
        }

        if (!fits) continue;

        selectedKeys.add(`${sectionIndex}:${itemIndex}`);
        if (!selectedSections.has(sectionIndex)) {
            selectedSections.add(sectionIndex);
            tokenEstimate += section.headerTokens;
        }
        tokenEstimate += item.tokens;
        if (!unlimited) {
            budgetUsed += actualCost;
            if (mode === TOKEN_BUDGET_MODES.RESIDENT_UNLIMITED) {
                sectionBudgetUsed.set(section.key, (sectionBudgetUsed.get(section.key) || 0) + actualCost);
            }
        }
    }

    const renderedSections = [];
    const selectedItems = [];
    const truncated = [];

    sections.forEach((section, sectionIndex) => {
        const selected = section.items.filter((_, itemIndex) => selectedKeys.has(`${sectionIndex}:${itemIndex}`));
        if (selected.length) {
            renderedSections.push([
                section.openTag,
                section.header,
                ...selected.map(item => item.text),
                section.closeTag,
            ].filter(Boolean).join('\n'));
            selectedItems.push(...selected);
        }
        if (selected.length < section.items.length) {
            truncated.push(`${section.label}(${selected.length}/${section.items.length})`);
        }
        if (selected.length && section.extraTruncated) {
            truncated.push(section.extraTruncated);
        }
    });

    return { renderedSections, selectedItems, tokenEstimate, truncated, budgetMode: mode };
}

// ═══════════════════════════════════════════════════════════
//  v9.3.3 实时记忆注入（第五柱）
// ═══════════════════════════════════════════════════════════

function clampIntSetting(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 按 REALTIME_KINDS 的声明顺序分组，每类一行；组内按楼层从旧到新，读起来符合时间顺序。
 *
 * 楼层标注按「楼层段」合并而不是逐条附加：一条「（第42层）」按 estimateTokens 要 4 token，
 * 逐条标注 15 条就吃掉 60 token（默认 300 上限的 20%）。同层的条目共用一个标注后，
 * 标注开销降到每个楼层段一次。
 */
function formatRealtimeGroups(entries) {
    const byKind = new Map();
    for (const entry of entries) {
        const kind = REALTIME_KINDS[entry.kind] ? entry.kind : 'detail';
        if (!byKind.has(kind)) byKind.set(kind, []);
        byKind.get(kind).push(entry);
    }
    const lines = [];
    for (const kind of Object.keys(REALTIME_KINDS)) {
        const group = byKind.get(kind);
        if (!group?.length) continue;
        const ordered = group.slice().sort((a, b) =>
            (Number(a.lastSeenFloor ?? -1) - Number(b.lastSeenFloor ?? -1))
            || (Number(a.createdAt || 0) - Number(b.createdAt || 0)));

        const texts = ordered.map(entry => String(entry.text || '').trim()).filter(Boolean);
        if (!texts.length) continue;
        const body = texts.join('，');
        lines.push({
            kind,
            text: `· ${REALTIME_KINDS[kind].label}：${body}`,
            ids: ordered.map(entry => entry.id),
        });
    }
    return lines;
}

/**
 * 挑出要注入的实时记忆并渲染成按类分组的行。
 *
 * 关键约束：**自带条数 + token 双硬上限，不依赖全局 token 预算**。
 * 因为注入项会标 resident=true，在默认的 resident_unlimited 模式下会完全绕过预算
 * （retriever 的 unlimited 判定），漏掉这层上限会让长会话的注入无声膨胀。
 *
 * 过滤规则：已结算（settled）或已晋升（promotedTo）的不注入——前者已退场，
 * 后者内容已进长期库，再注入就是重复。待结算（pending_settle）仍注入，
 * 这样结算失败时细节不会凭空消失。
 */
export function getRealtimeForInjection(entries, settings) {
    const activeSettings = settings || getSettings();
    const empty = { lines: [], totalCount: 0, injectedCount: 0, tokenEstimate: 0, truncated: false, enabled: false };
    if (!activeSettings.realtimeEnabled) return empty;

    const rawPool = (Array.isArray(entries) ? entries : []).filter(entry =>
        entry && String(entry.text || '').trim()
        && entry.settleState !== 'settled'
        && !entry.promotedTo);
    if (!rawPool.length) return { ...empty, enabled: true };

    // 新到旧：分类槽位与全局截断都优先保留最新状态。0 槽分类立即停止注入，
    // 不必等下一轮提取把旧数据推进 settled。
    const newestFirst = rawPool.slice().sort((a, b) =>
        (Number(b.lastSeenFloor ?? -1) - Number(a.lastSeenFloor ?? -1))
        || (Number(b.createdAt || 0) - Number(a.createdAt || 0)));
    const kindLimits = getRealtimeKindSlotLimits(activeSettings);
    const kindCounts = {};
    const seenExact = new Set();
    const seenSlots = new Set();
    const sorted = newestFirst.filter(entry => {
        const kind = REALTIME_KINDS[entry.kind] ? entry.kind : 'detail';
        const exactKey = `${kind}|${normalizeIdentityText(entry.text)}`;
        const normalizedSlot = normalizeIdentityText(entry.slotKey);
        const slotKey = normalizedSlot ? `${kind}|${normalizedSlot}` : '';
        if (seenExact.has(exactKey) || (slotKey && seenSlots.has(slotKey))) return false;
        const used = kindCounts[kind] || 0;
        if (used >= kindLimits[kind]) return false;
        kindCounts[kind] = used + 1;
        seenExact.add(exactKey);
        if (slotKey) seenSlots.add(slotKey);
        return true;
    });
    if (!sorted.length) return { ...empty, enabled: true };

    const maxCount = clampIntSetting(activeSettings.realtimeInjectionMax, 0, 200, 15);
    const tokenCap = clampIntSetting(activeSettings.realtimeInjectionTokenCap, 0, 8000, 300);

    const chosen = [];
    let lines = [];
    let tokenEstimate = 0;
    for (const entry of sorted) {
        if (maxCount > 0 && chosen.length >= maxCount) break;
        const nextLines = formatRealtimeGroups([...chosen, entry]);
        const nextTokens = nextLines.reduce((sum, line) => sum + estimateTokens(line.text), 0);
        // 首条即超上限时仍然放行：宁可略微超一条的量，也不要让整个分区变空
        if (tokenCap > 0 && nextTokens > tokenCap && chosen.length) break;
        chosen.push(entry);
        lines = nextLines;
        tokenEstimate = nextTokens;
    }

    return {
        lines,
        totalCount: sorted.length,
        injectedCount: chosen.length,
        tokenEstimate,
        truncated: chosen.length < sorted.length,
        enabled: true,
    };
}

function buildInjectionStats(selectedItems) {
    const stats = {
        npcCount: 0,
        itemCount: 0,
        milestoneCount: 0,
        timelineCount: 0,
        memoryCount: 0,
        threadCount: 0,
        mapCount: 0,
        realtimeCount: 0,
        realtimeKinds: [],
        npcIds: [],
        itemIds: [],
        milestoneIds: [],
        timelineIds: [],
        memoryIds: [],
        threadIds: [],
        mapLocationIds: [],
    };
    const seen = {
        npc: new Set(),
        item: new Set(),
        milestone: new Set(),
        mem: new Set(),
        timeline: new Set(),
        thread: new Set(),
        map: new Set(),
        realtime: new Set(),
    };

    const addUnique = (collection, id, listKey, countKey) => {
        const safeId = String(id || '');
        if (!safeId || seen[collection].has(safeId)) return;
        seen[collection].add(safeId);
        stats[listKey].push(safeId);
        stats[countKey] = stats[listKey].length;
    };

    for (const item of selectedItems) {
        if (item.flagKey) stats[item.flagKey] = true;
        if (item.collection === 'npc') addUnique('npc', item.id, 'npcIds', 'npcCount');
        else if (item.collection === 'item') addUnique('item', item.id, 'itemIds', 'itemCount');
        else if (item.collection === 'milestone') addUnique('milestone', item.id, 'milestoneIds', 'milestoneCount');
        else if (item.collection === 'timeline') addUnique('timeline', item.id, 'timelineIds', 'timelineCount');
        else if (item.collection === 'mem') addUnique('mem', item.id, 'memoryIds', 'memoryCount');
        else if (item.collection === 'thread') addUnique('thread', item.id, 'threadIds', 'threadCount');
        else if (item.collection === 'map') addUnique('map', item.id, 'mapLocationIds', 'mapCount');
        // v9.3.3 实时记忆按分类计数（一个注入项 = 一个 kind 分组）
        else if (item.collection === 'realtime') addUnique('realtime', item.id, 'realtimeKinds', 'realtimeCount');
    }
    stats.threadIds = stats.timelineIds.length ? [...stats.timelineIds] : stats.threadIds;
    stats.threadCount = stats.timelineCount || stats.threadCount;
    stats.mapInjected = stats.mapCount > 0;
    return stats;
}

/**
 * 构建四柱注入文本
 * @param {object} params
 * @param {Array} params.npcProfiles - getNpcForInjection 结果
 * @param {Array} params.items - getItemsForInjection 结果
 * @param {object} params.milestones - getMilestonesForInjection 结果
 * @param {object} params.timeline - getTimelineForInjection 结果
 * @param {Array} params.relevantResults - getRelevantMemories 结果
 * @param {object} params.settings
 * @returns {{ text: string, tokenEstimate: number, stats: object }}
 */
export async function buildMemoryInjectionPrompt({ npcProfiles, items, milestones, timeline, threadSummary, relevantResults, settings, chatLength = 0, clueBoard = null, mapData = null, queryText = '', queryEmbedding = null, realtimeEntries = null }) {
    const activeSettings = settings || getSettings();
    const tokenBudget = normalizeTokenBudget(activeSettings);
    const budgetSections = [];

    const timelineSummary = timeline || threadSummary;
    const timelineBlocks = getThreadBudgetBlocks(timelineSummary);
    if (timelineBlocks.length) {
        const header = timelineSummary?.header || getInjectionHeader(activeSettings, 'timeline') || DEFAULT_INJECTION_SECTION_HEADERS.timeline;
        budgetSections.push(makeBudgetSection('timeline', header, timelineBlocks.map((block, index) => {
            const line = block.timeline || block.thread || timelineSummary?.timeline?.[index] || timelineSummary?.threads?.[index] || null;
            return makeBudgetItem(block.text, {
                resident: isResidentEntry(line),
                priority: priorityForThread(line),
                collection: 'timeline',
                id: line?.id || line?.name || `timeline_${index}`,
            });
        })));
    }

    if (npcProfiles?.length) {
        budgetSections.push(makeBudgetSection(
            'npc',
            getStructuredInjectionHeader(activeSettings, 'npc') || DEFAULT_INJECTION_SECTION_HEADERS.npc,
            npcProfiles.map(npc => makeBudgetItem(formatNpcLine(npc), {
                resident: isResidentEntry(npc) || npc.npcTier === 'core',
                priority: priorityForNpc(npc),
                collection: 'npc',
                id: npc.id,
            }))
        ));
    }

    if (items?.length) {
        budgetSections.push(makeBudgetSection(
            'item',
            getInjectionHeader(activeSettings, 'item') || DEFAULT_INJECTION_SECTION_HEADERS.item,
            items.map(item => makeBudgetItem(formatItemLine(item), {
                resident: isResidentEntry(item) || item.keepPermanent,
                priority: priorityForItem(item),
                collection: 'item',
                id: item.id,
            }))
        ));
    }

    const milestoneGroup = milestones || (!timelineBlocks.length && timeline && (timeline.ongoing || timeline.ended || timeline.foreshadow) ? timeline : null);
    if (milestoneGroup) {
        const { ongoing = [], ended = [], foreshadow = [] } = milestoneGroup;
        const threadIndex = buildThreadTimelineIndex(timelineSummary?.timeline || timelineSummary?.threads || []);
        const allTimeline = [...foreshadow, ...ongoing, ...ended].filter(t =>
            isResidentMilestone(t) || isForeshadowTimeline(t) || !isTimelineCoveredByThread(t, threadIndex)
        );
        if (allTimeline.length) {
            budgetSections.push(makeBudgetSection(
                'milestone',
                getInjectionHeader(activeSettings, 'milestone') || DEFAULT_INJECTION_SECTION_HEADERS.milestone,
                allTimeline.map(t => makeBudgetItem(formatTimelineLine(t), {
                    resident: isResidentMilestone(t),
                    priority: priorityForTimelineEntry(t),
                    collection: 'milestone',
                    id: t.id,
                }))
            ));
        }
    }

    if (relevantResults?.length) {
        const maxMemories = (activeSettings.maxResults || 10) + 4;
        const memoryItems = [];
        let nonResidentCount = 0;
        let displayIndex = 0;
        for (const result of relevantResults) {
            const memory = result?.memory;
            if (!memory) continue;
            const resident = isResidentEntry(memory);
            if (!resident) {
                if (nonResidentCount >= maxMemories) continue;
                nonResidentCount++;
            }
            displayIndex++;
            const line = `${displayIndex}.${formatMemoryLine(memory, chatLength, result.level, activeSettings)}`;
            memoryItems.push(makeBudgetItem(line, {
                resident,
                priority: priorityForMemory(memory),
                collection: 'mem',
                id: memory.id,
            }));
        }
        budgetSections.push(makeBudgetSection(
            'memory',
            getStructuredInjectionHeader(activeSettings, 'memory') || DEFAULT_INJECTION_SECTION_HEADERS.memory,
            memoryItems
        ));
    }

    const mapContext = buildMapContextLines(mapData, activeSettings, queryText, tokenBudget, queryEmbedding);
    if (mapContext.blocks?.length) {
        budgetSections.push(makeBudgetSection(
            'map',
            mapContext.lines[0] || getInjectionHeader(activeSettings, 'map') || DEFAULT_INJECTION_SECTION_HEADERS.map,
            mapContext.blocks.map(block => makeBudgetItem(block.text, {
                resident: block.resident,
                priority: block.resident ? 0 : (block.reason === 'hit' ? 1 : 2),
                collection: 'map',
                id: block.id,
            })),
            {
                extraTruncated: mapContext.truncated ? '地图(按空间关系截断)' : '',
                allowFirstOverSectionCap: true,
            }
        ));
    }

    if (clueBoard && typeof clueBoard === 'object') {
        const { hasActiveClues, buildClueBoardInjection } = await import('./clue-board.js');
        if (hasActiveClues(clueBoard)) {
            const clueLines = buildClueBoardInjection(clueBoard)
                .split('\n')
                .map(line => line.trimEnd())
                .filter(line => line.trim());
            if (clueLines.length) {
                const clueHeader = clueLines.length > 1 ? clueLines[0] : '';
                const clueBody = clueLines.length > 1 ? clueLines.slice(1) : clueLines;
                budgetSections.push(makeBudgetSection(
                    'clue',
                    clueHeader,
                    clueBody.map(line => makeBudgetItem(line, {
                        priority: 4,
                        flagKey: 'clueBoard',
                    }))
                ));
            }
        }
    }

    // 实时记忆必须以独立 extension prompt 注入到聊天末端，不能与前置长期记忆共用位置。
    // 因此这里单独渲染并返回 realtimeText，不加入长期记忆的 budgetSections。
    const realtime = getRealtimeForInjection(realtimeEntries, activeSettings);
    let realtimeText = '';
    if (realtime.lines.length) {
        const realtimeSection = makeBudgetSection(
            'realtime',
            getInjectionHeader(activeSettings, 'realtime') || DEFAULT_INJECTION_SECTION_HEADERS.realtime,
            realtime.lines.map(line => makeBudgetItem(line.text, {
                resident: true,
                priority: 0,
                collection: 'realtime',
                id: line.kind,
            })),
            { extraTruncated: realtime.truncated ? `实时(${realtime.injectedCount}/${realtime.totalCount})` : '' }
        );
        realtimeText = [
            realtimeSection.openTag,
            realtimeSection.header,
            ...realtimeSection.items.map(item => item.text),
            realtimeSection.closeTag,
        ].filter(Boolean).join('\n');
    }

    const allocation = allocateBudgetSections(budgetSections, activeSettings, tokenBudget);
    const text = allocation.renderedSections.join('\n\n');
    const stats = buildInjectionStats(allocation.selectedItems);
    stats.realtimeKinds = realtime.lines.map(line => line.kind);
    stats.realtimeCount = stats.realtimeKinds.length;
    stats.realtimeEntryCount = realtime.injectedCount;
    stats.realtimeTotalCount = realtime.totalCount;
    stats.realtimeTokens = realtime.tokenEstimate;

    return {
        text,
        realtimeText,
        longTermTokenEstimate: allocation.tokenEstimate,
        realtimeTokenEstimate: realtime.tokenEstimate,
        tokenEstimate: allocation.tokenEstimate + realtime.tokenEstimate,
        stats,
        truncated: realtime.truncated
            ? [...allocation.truncated, `实时(${realtime.injectedCount}/${realtime.totalCount})`]
            : allocation.truncated,
        tokenBudget,
        budgetMode: allocation.budgetMode,
    };
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
