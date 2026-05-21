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
    NPC_TIERS,
    ITEM_TIERS,
} from './entity-tiers.js';
import {
    getNpcProfiles, getItems, getTimeline, getMemories,
    getTimelineThreads, isArchived, getSettings,
} from './memory-store.js';

// ═══════════════════════════════════════════════════════════
//  评分权重（简化为 5 维）
// ═══════════════════════════════════════════════════════════

const SCORE_WEIGHTS = {
    keyword:    0.25,
    embedding:  0.25,
    importance: 0.20,
    recency:    0.18,
    tier:       0.12,
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
    const queryTokens = extractTokens(query);
    const now = Date.now();

    // 关键词
    let keywordScore = 0;
    if (queryTokens.length) {
        const searchTarget = [
            memory.content, memory.title || '', memory.summary || '',
            memory.subject || '', memory.target || '',
        ].join(' ').toLowerCase();
        let matchCount = 0;
        for (const t of queryTokens) {
            if (searchTarget.includes(t)) matchCount++;
        }
        keywordScore = matchCount / queryTokens.length;
    }

    // 语义
    const embeddingScore = (queryEmbedding && memory.embedding)
        ? cosineSimilarity(queryEmbedding, memory.embedding) : 0;

    // 重要性
    const importanceScore = memory.importance ?? 0.5;

    // 时效性
    const age = now - (memory.lastHitAt || memory.createdAt || now);
    let recencyScore;
    if (age <= 0) recencyScore = 1.0;
    else if (age >= RECENCY_WINDOW_MS) recencyScore = Math.max(0.1, 1 - Math.log10(age / RECENCY_WINDOW_MS + 1) * 0.5);
    else recencyScore = 1 - (age / RECENCY_WINDOW_MS) * 0.5;

    // 层级
    const tierScore = TIER_SCORE[memory.memoryTier] || 0.3;

    let weightedSum = 0, weightTotal = 0;
    const dims = { keyword: keywordScore, embedding: embeddingScore, importance: importanceScore, recency: recencyScore, tier: tierScore };
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

    let candidates = memories.filter(m => !isArchived(m) && m.status !== 'deleted');

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
    return merged.slice(0, ceiling);
}

// ═══════════════════════════════════════════════════════════
//  各支柱检索
// ═══════════════════════════════════════════════════════════

/**
 * NPC 档案：core+important 全注入，minor 按命中
 */
export function getNpcForInjection(npcProfiles, queryText) {
    const result = [];
    for (const npc of npcProfiles) {
        if (isArchived(npc)) continue;
        if (npc.npcTier === 'core' || npc.npcTier === 'important' || npc.memoryTier === 'eternal') {
            result.push(npc);
        } else if (npc.npcTier === 'minor' && memoryMatchesQueryEntities(npc, queryText)) {
            result.push(npc);
        }
    }
    // 排序：tier 优先
    const tierOrder = { core: 0, important: 1, minor: 2, background: 3 };
    result.sort((a, b) => (tierOrder[a.npcTier] || 2) - (tierOrder[b.npcTier] || 2));
    return result.slice(0, getSettings().npcInjectionMax ?? 8);
}

/**
 * 物品栏：key+equipped+kp 全注入，其余按命中
 */
export function getItemsForInjection(items, queryText) {
    const result = [];
    for (const item of items) {
        if (isArchived(item)) continue;
        if (item.itemTier === 'key' || item.itemTier === 'equipped' || item.keepPermanent || item.memoryTier === 'eternal') {
            result.push(item);
        } else if (memoryMatchesQueryEntities(item, queryText)) {
            result.push(item);
        }
    }
    const tierOrder = { key: 0, equipped: 1, clue: 2, consumable: 3, background: 4 };
    result.sort((a, b) => (tierOrder[a.itemTier] || 3) - (tierOrder[b.itemTier] || 3));
    return result.slice(0, getSettings().itemInjectionMax ?? 5);
}

/**
 * 时间线：ongoing 全注入，最近 ended 3 条
 */
export function getTimelineForInjection(timeline) {
    const active = timeline.filter(t => !isArchived(t));
    const ongoing = active.filter(t => t.isActive && t.status === 'ongoing');
    const ended = active
        .filter(t => !t.isActive || t.status === 'ended')
        .sort((a, b) => (b.storyTimeSort ?? b.updatedAt ?? 0) - (a.storyTimeSort ?? a.updatedAt ?? 0))
        .slice(0, getSettings().timelineEndedMax ?? 3);
    const foreshadow = active.filter(t => t.status === 'foreshadow');
    return { ongoing, ended, foreshadow };
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

    // 优先级排序：resident > high > medium > low
    const priorityOrder = { resident: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...threads].sort((a, b) => {
        const pa = priorityOrder[a.priority || 'medium'] ?? 2;
        const pb = priorityOrder[b.priority || 'medium'] ?? 2;
        if (pa !== pb) return pa - pb;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    // Resident 线程不计入 maxActive 限制
    const residents = sorted.filter(t => t.status === 'resident');
    const nonResidents = sorted.filter(t => t.status !== 'resident');

    // Active 线程（ongoing + paused），受 maxActive 限制
    const active = nonResidents.filter(t => t.status === 'ongoing' || t.status === 'paused');
    const limited = active.slice(0, maxActive);

    // 合并：resident 线程 + 限制后的活跃线程
    const forInjection = [...residents, ...limited];

    if (!forInjection.length) return { text: '', threads: [] };

    const lines = ['【故事线程地图】'];
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
            lines.push(`  ${entryStatus} ${entry.period || ''} ${entry.event || ''}`);
        }
    }

    return { text: lines.join('\n'), threads: forInjection };
}

// ═══════════════════════════════════════════════════════════
//  格式化
// ═══════════════════════════════════════════════════════════

function formatNpcLine(npc) {
    const parts = [npc.name, npc.role, npc.personality, npc.appearance, npc.status].filter(Boolean);
    const line = '◆ ' + parts.join(' | ');
    const relLines = (npc.relationships || []).map(r =>
        `  关系：${r.name ? '与' + r.name : ''}${r.type || ''}${r.attitude ? '（' + r.attitude + '）' : ''}`
    );
    return line + (relLines.length ? '\n' + relLines.join('\n') : '');
}

function formatItemLine(item) {
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

function formatMemoryLine(m, chatLength = 0) {
    const parts = [];
    if (m.title) parts.push(`[${m.title}]`);
    const typeLabel = MEMORY_TYPES[m.type]?.label || '';
    if (typeLabel) parts.push(`(${typeLabel})`);
    if (m.truthStatus && m.truthStatus !== 'true') {
        const ts = TRUTH_STATUS[m.truthStatus];
        if (ts) parts.push(`{${ts.label}}`);
    }
    // 基于楼层距离决定使用摘要还是完整内容
    const floorWindow = getSettings().floorRecentWindow ?? 6;
    const floorDist = chatLength > 0 && typeof m.sourceFloor === 'number' && m.sourceFloor >= 0
        ? chatLength - m.sourceFloor
        : Infinity;
    const isRecent = floorDist <= floorWindow;
    const isStable = (m.memoryTier === 'stable' || m.memoryTier === 'core' || m.memoryTier === 'eternal');

    if ((isRecent || isStable) && m.content) {
        parts.push(m.content);
    } else if (m.summary) {
        parts.push(m.summary);
    } else {
        parts.push(m.content || m.summary);
    }
    if (m.verbatim) parts.push(`「${m.verbatim}」`);
    if (m.subject && m.target) parts.push(`(${m.subject} → ${m.target})`);
    else if (m.subject) parts.push(`(${m.subject})`);
    return parts.join(' ');
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
export function buildMemoryInjectionPrompt({ npcProfiles, items, timeline, threadSummary, relevantResults, settings, chatLength = 0, clueBoard = null }) {
    const tokenBudget = settings.tokenBudget || 800;
    let tokenUsed = 0;
    const stats = { npcCount: 0, itemCount: 0, timelineCount: 0, memoryCount: 0, threadCount: 0 };
    const truncated = [];

    const sections = [];

    // ── 区块 0：故事线程地图（v6.7.0 — 最前，给 LLM 全局叙事视野）──
    if (threadSummary && threadSummary.text) {
        const threadText = threadSummary.text;
        const threadTokens = estimateTokens(threadText);
        if (threadTokens <= tokenBudget * 0.2) {
            sections.push(threadText);
            tokenUsed += threadTokens;
            stats.threadCount = threadSummary.threads?.length || 0;
        } else {
            truncated.push('线程地图(超出token预算)');
        }
    }

    // ── 区块 1：角色档案 ──
    if (npcProfiles?.length) {
        const lines = ['【角色档案】'];
        let sectionTokens = 0;
        for (const npc of npcProfiles) {
            const line = formatNpcLine(npc);
            const lt = estimateTokens(line);
            if (sectionTokens + lt > tokenBudget * 0.3) break;
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
        const lines = ['【重要物品】'];
        let sectionTokens = 0;
        for (const item of items) {
            const line = formatItemLine(item);
            const lt = estimateTokens(line);
            if (sectionTokens + lt > tokenBudget * 0.2) break;
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
        const all = [...foreshadow, ...ongoing, ...ended];
        if (all.length) {
            const lines = ['【故事时间线】'];
            let sectionTokens = 0;
            for (const t of all) {
                const line = formatTimelineLine(t);
                const lt = estimateTokens(line);
                if (sectionTokens + lt > tokenBudget * 0.25) break;
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
        const lines = ['【相关记忆】'];
        const MAX_MEM = (settings.maxResults || 10) + 4;
        let count = 0;
        let sectionTokens = 0;
        for (const { memory, level } of relevantResults) {
            if (count >= MAX_MEM) break;
            const line = (count + 1) + '. ' + formatMemoryLine(memory, chatLength);
            const lt = estimateTokens(line);
            if (sectionTokens + lt > tokenBudget * 0.7) break;
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
                truncated.push('线索板(超出token预算)');
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
        !isArchived(m) && m.status !== 'deleted'
    );
}
