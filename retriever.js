/**
 * retriever.js —— BB-Memory 的"搜索引擎 + 注入调度器"
 *
 * v2.4 重写：
 *   - 8 维综合评分 calculateMemoryScore()
 *   - 分等级注入 L1/L2/L3/L4
 *   - 常驻记忆 getResidentMemories()
 *   - token 预算控制
 *   - buildMemoryInjectionPrompt() 统一输出
 * v2.6：NPC/物品分级 + 按需展开 mergeExpandedRelevantResults()
 */

import {
    TRUTH_STATUS,
    HIDDEN_NOTE_TYPES,
    resolveMemoryType,
    getCategoryLabel,
} from './memory-types.js';

import {
    tierScoreMultiplier,
    memoryMatchesQueryEntities,
    expandEntityMemories,
    buildDefaultIndexCard,
    normalizeNpcTier,
    normalizeItemTier,
} from './entity-tiers.js';

const NPC_RESIDENT_ORDER = { core: 4, important: 3, minor: 2, background: 1 };

// ═══════════════════════════════════════════════════════════
//  评分权重（可调参，总和不强制为 1，最终会归一化）
// ═══════════════════════════════════════════════════════════

const SCORE_WEIGHTS = {
    keyword:        0.20,
    tag:            0.14,
    embedding:      0.18,   // v4.0.0: 语义向量相似度
    importance:     0.12,
    emotionalWeight:0.08,
    strength:       0.15,
    scene:          0.15,
    relation:       0.13,
};

const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════
//  注入等级定义
// ═══════════════════════════════════════════════════════════

export const INJECTION_LEVELS = Object.freeze({
    L4: { id: 'L4', label: '常驻',   tokenCost: 'minimal', description: '每轮注入的索引卡' },
    L3: { id: 'L3', label: '完整',   tokenCost: 'high',    description: '完整内容 + 原话' },
    L2: { id: 'L2', label: '摘要',   tokenCost: 'medium',  description: '摘要级别' },
    L1: { id: 'L1', label: '标签',   tokenCost: 'low',     description: '仅标题/标签' },
});

// 大致 token 估算：1 个汉字 ≈ 1.5 token，1 个英文单词 ≈ 1 token
function estimateTokens(text) {
    if (!text) return 0;
    const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
    const cjkTokens = cjk ? cjk.length * 1.5 : 0;
    const rest = text.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '');
    const wordTokens = rest.split(/\s+/).filter(Boolean).length;
    return Math.ceil(cjkTokens + wordTokens);
}

// ═══════════════════════════════════════════════════════════
//  文本分词
// ═══════════════════════════════════════════════════════════

function extractTokens(text) {
    return text
        .toLowerCase()
        .split(/[\s,，。！？!?、；;：:""''（）()\[\]{}·\n\r\t]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2);
}

// ═══════════════════════════════════════════════════════════
//  8 维综合评分
// ═══════════════════════════════════════════════════════════

/**
 * 对单条记忆进行 8 维综合评分。
 * 返回 { total, breakdown } — breakdown 包含每个维度的原始分。
 *
 * @param {object} memory - 记忆条目
 * @param {string} query - 用户当前消息
 * @param {object} context - 可选上下文 { recentActors, recentLocations, chatHistory }
 * @param {number[]|null} queryEmbedding - 查询向量
 */
export function calculateMemoryScore(memory, query, context = {}, queryEmbedding = null) {
    const queryTokens = extractTokens(query);
    const now = Date.now();

    const breakdown = {
        keyword:         computeKeywordScore(memory, queryTokens),
        tag:             computeTagScore(memory.tags, queryTokens),
        embedding:       computeEmbeddingScore(memory, queryEmbedding),
        importance:      memory.importance ?? 0.5,
        emotionalWeight: memory.emotionalWeight ?? 0.0,
        strength:        memory.strength ?? 1.0,
        scene:           computeSceneScore(memory, queryTokens, context),
        relation:        computeRelationScore(memory, queryTokens, context),
    };

    // 加权求和
    let weightedSum = 0;
    let weightTotal = 0;
    for (const [dim, weight] of Object.entries(SCORE_WEIGHTS)) {
        weightedSum += (breakdown[dim] || 0) * weight;
        weightTotal += weight;
    }
    const normalized = weightTotal > 0 ? weightedSum / weightTotal : 0;

    // 时效性作为小幅修正（不是主维度，避免过度惩罚旧记忆）
    const recencyBonus = computeRecency(memory.createdAt, now) * 0.1;

    // pinned 记忆获得固定底分加成
    const pinBonus = memory.pinned ? 0.15 : 0;

    // v4.1.0: 合集记忆获得小幅加分（浓缩多条记忆信息）
    const clusterBonus = memory.isClusterSummary ? 0.05 : 0;

    const total = Math.min(1.0, normalized + recencyBonus + pinBonus + clusterBonus);

    return { total, breakdown };
}

// ═══ 各维度计算 ═══

function computeKeywordScore(memory, queryTokens) {
    if (!queryTokens.length) return 0;

    const searchTarget = [
        memory.content,
        memory.title || '',
        memory.summary || '',
        memory.subject || '',
        memory.target || '',
        (memory.keywords || []).join(' '),
    ].join(' ').toLowerCase();

    let matchCount = 0;
    for (const token of queryTokens) {
        if (searchTarget.includes(token)) matchCount++;
    }
    return matchCount / queryTokens.length;
}

function computeTagScore(tags, queryTokens) {
    if (!tags?.length || !queryTokens.length) return 0;

    let totalWeight = 0;
    let matchedWeight = 0;

    for (const tag of tags) {
        const tagName = (tag.name || '').toLowerCase();
        const tagWeight = tag.weight || 0.5;
        totalWeight += tagWeight;

        for (const token of queryTokens) {
            if (tagName.includes(token) || token.includes(tagName)) {
                matchedWeight += tagWeight;
                break;
            }
        }
    }
    return totalWeight > 0 ? matchedWeight / totalWeight : 0;
}

/**
 * v4.0.0: 余弦相似度计算
 */
function cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : Math.max(0, dot / denom);
}

/**
 * v4.0.0: embedding 语义相似度评分。
 * 传入查询向量与记忆向量，计算余弦相似度。
 */
function computeEmbeddingScore(memory, queryEmbedding) {
    if (!queryEmbedding || !memory.embedding) return 0;
    return cosineSimilarity(memory.embedding, queryEmbedding);
}

/**
 * 场景相关度：检查当前消息是否提到了记忆中的地点或情景关键词。
 */
function computeSceneScore(memory, queryTokens, context) {
    if (!queryTokens.length) return 0;
    let score = 0;
    let checks = 0;

    // 地点匹配
    if (memory.location) {
        checks++;
        const loc = memory.location.toLowerCase();
        if (queryTokens.some(t => loc.includes(t) || t.includes(loc))) score += 1;
    }

    // context 中的近期地点匹配
    if (context.recentLocations?.length && memory.location) {
        checks++;
        const loc = memory.location.toLowerCase();
        if (context.recentLocations.some(l => l.toLowerCase().includes(loc) || loc.includes(l.toLowerCase()))) {
            score += 1;
        }
    }

    // categoryPath 中的场景类提升
    if (memory.categoryPath?.startsWith('episode.') || memory.categoryPath?.startsWith('location.')) {
        checks++;
        if (queryTokens.length > 0) score += 0.3;
    }

    return checks > 0 ? Math.min(1, score / checks) : 0;
}

/**
 * 关系相关度：检查当前消息是否提到了记忆中的人物。
 */
function computeRelationScore(memory, queryTokens, context) {
    if (!queryTokens.length) return 0;
    let score = 0;
    let checks = 0;

    const actorNames = [
        memory.subject,
        memory.target,
        ...(memory.actors || []),
    ].filter(Boolean).map(n => n.toLowerCase());

    if (actorNames.length) {
        checks++;
        for (const name of actorNames) {
            if (queryTokens.some(t => name.includes(t) || t.includes(name))) {
                score += 1;
                break;
            }
        }
    }

    // context 中的近期角色匹配
    if (context.recentActors?.length && actorNames.length) {
        checks++;
        for (const name of actorNames) {
            if (context.recentActors.some(a => a.toLowerCase().includes(name) || name.includes(a.toLowerCase()))) {
                score += 1;
                break;
            }
        }
    }

    // NPC / 关系类记忆基础加成
    if (memory.categoryPath?.startsWith('npc.')) {
        checks++;
        score += 0.3;
    }

    return checks > 0 ? Math.min(1, score / checks) : 0;
}

function computeRecency(createdAt, now) {
    if (!createdAt) return 0.5;
    const age = now - createdAt;
    if (age <= 0) return 1.0;
    if (age >= RECENCY_WINDOW_MS) {
        return Math.max(0.1, 1 - Math.log10(age / RECENCY_WINDOW_MS + 1) * 0.5);
    }
    return 1 - (age / RECENCY_WINDOW_MS) * 0.5;
}

// ═══════════════════════════════════════════════════════════
//  注入等级选择
// ═══════════════════════════════════════════════════════════

/**
 * 根据记忆属性、评分与「本轮是否命中实体」决定注入等级。
 *   L4 = 常驻（resident === true）
 *   L3 = 高分或（命中实体时的原话）
 *   路人/背景物在未命中时降级，避免占满 token
 */
export function chooseInjectionLevel(memory, score, queryMatched = false) {
    if (memory.resident) return 'L4';

    const nt = normalizeNpcTier(memory.npcTier);
    const it = normalizeItemTier(memory.itemTier);
    const verbatimStrong = memory.verbatim && (
        queryMatched || nt === 'core' || it === 'key'
    );

    let level;
    if (score >= 0.55 || verbatimStrong) level = 'L3';
    else if (score >= 0.30) level = 'L2';
    else level = 'L1';

    if (!queryMatched) {
        if (nt === 'background' || it === 'background') {
            if (level === 'L3') level = 'L2';
            if (score < 0.42) level = 'L1';
        }
        if ((nt === 'minor' || it === 'consumable') && level === 'L3' && score < 0.62) {
            level = 'L2';
        }
    }

    return level;
}

// ═══════════════════════════════════════════════════════════
//  常驻记忆
// ═══════════════════════════════════════════════════════════

/**
 * 从记忆列表中提取常驻记忆（resident === true）。
 * 常驻记忆按 importance 降序排列。
 */
export function getResidentMemories(memories) {
    return memories
        .filter(m => m.resident === true && m.status !== 'archived' && m.status !== 'deleted')
        .sort((a, b) => {
            const na = NPC_RESIDENT_ORDER[normalizeNpcTier(a.npcTier)] ?? 2;
            const nb = NPC_RESIDENT_ORDER[normalizeNpcTier(b.npcTier)] ?? 2;
            if (nb !== na) return nb - na;
            return (b.importance || 0) - (a.importance || 0);
        });
}

// ═══════════════════════════════════════════════════════════
//  智能检索
// ═══════════════════════════════════════════════════════════

/**
 * 在记忆中搜索与查询最相关的条目。
 * 返回带评分的数组 [{ memory, score, breakdown, level }]
 */
export function getRelevantMemories(memories, queryText, options = {}) {
    const {
        maxResults = 10,
        minScore = 0.05,
        typeFilter = null,
        minStrength = 0,
        enabledTypes = null,
        context = {},
        useFuse = true,
        queryEmbedding = null,
    } = options;

    if (!memories.length || !queryText.trim()) return [];

    // 过滤
    let candidates = memories.filter(m => {
        if (m.resident) return false;       // 常驻记忆单独处理
        if (m.status === 'archived' || m.status === 'deleted') return false;
        if (typeFilter && (m.cognitiveType || m.type) !== typeFilter) return false;
        if (minStrength > 0 && (m.strength ?? 1.0) < minStrength) return false;
        if (enabledTypes) {
            const ct = resolveMemoryType(m);
            if (!enabledTypes[ct]) return false;
        }
        return true;
    });

    if (!candidates.length) return [];

    // Fuse 模糊匹配加成
    let fuseBoostMap = new Map();
    if (useFuse) {
        try {
            const Fuse = SillyTavern.libs.Fuse;
            if (Fuse) {
                const fuse = new Fuse(candidates, {
                    keys: ['content', 'title', 'summary', 'keywords', 'subject', 'target'],
                    threshold: 0.4,
                    includeScore: true,
                });
                for (const result of fuse.search(queryText)) {
                    fuseBoostMap.set(result.item.id, (1 - (result.score || 0)) * 0.15);
                }
            }
        } catch { /* Fuse 不可用 */ }
    }

    // 评分
    const scored = [];
    for (const memory of candidates) {
        const queryMatched = memoryMatchesQueryEntities(memory, queryText);
        const { total, breakdown } = calculateMemoryScore(memory, queryText, context, queryEmbedding);
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
 * 在本轮检索结果基础上，合并「用户提到的实体」的关联记忆（按需展开），便于拉高注入档位。
 */
export function mergeExpandedRelevantResults(memories, queryText, relevantResults, residentMemories, context = {}, expandLimit = 12, maxResults = 10, queryEmbedding = null) {
    const excludeIds = new Set(residentMemories.map(m => m.id));
    for (const r of relevantResults) excludeIds.add(r.memory.id);

    const expanded = expandEntityMemories(memories, queryText, excludeIds, expandLimit);
    const merged = [...relevantResults];

    for (const m of expanded) {
        const queryMatched = true;
        const { total, breakdown } = calculateMemoryScore(m, queryText, context, queryEmbedding);
        let score = Math.min(1.0, Math.max(total, 0.55));
        score = Math.min(1.0, score * tierScoreMultiplier(m, queryMatched));
        merged.push({
            memory: m,
            score,
            breakdown,
            level: chooseInjectionLevel(m, score, queryMatched),
        });
    }

    merged.sort((a, b) => b.score - a.score);
    // v4.2.0: 截断为 maxResults + 30% 扩展上限，防止注入条目过多
    const ceiling = Math.min(maxResults + Math.ceil(maxResults * 0.3), merged.length);
    return merged.slice(0, ceiling);
}

// ═══════════════════════════════════════════════════════════
//  分等级格式化
// ═══════════════════════════════════════════════════════════

/**
 * 按注入等级格式化一条记忆为文本行。
 *   L1 → 标签/标题
 *   L2 → 摘要
 *   L3 → 完整内容 + 原话
 *   L4 → 常驻索引卡
 */
function formatByLevel(memory, level) {
    const titlePart = memory.title ? `[${memory.title}]` : '';
    const catPart = getCategoryLabel(memory.categoryPath);
    const catLabel = catPart ? `(${catPart})` : '';

    // truthStatus 标记
    let truthMark = '';
    if (memory.truthStatus && memory.truthStatus !== 'true') {
        const ts = TRUTH_STATUS[memory.truthStatus];
        if (ts) truthMark = `{${ts.label}} `;
    }

    switch (level) {
        case 'L4': {
            const card = buildDefaultIndexCard(memory);
            const tagStr = (memory.tags || []).slice(0, 3).map(t => t.name || t).join('/');
            return `◆ ${card}${tagStr ? ` [${tagStr}]` : ''}`;
        }
        case 'L1': {
            const tagStr = (memory.tags || []).slice(0, 4).map(t => t.name || t).join(', ');
            return `${titlePart}${catLabel} ${truthMark}${tagStr || memory.content.slice(0, 30)}`;
        }
        case 'L2': {
            const text = memory.summary || memory.content.slice(0, 80);
            return `${titlePart}${catLabel} ${truthMark}${text}`;
        }
        case 'L3':
        default: {
            const parts = [];
            if (titlePart) parts.push(titlePart);
            if (catLabel) parts.push(catLabel);
            if (truthMark) parts.push(truthMark);
            parts.push(memory.summary || memory.content);
            if (memory.verbatim) parts.push(`「${memory.verbatim}」`);
            if (memory.subject && memory.target) {
                parts.push(`(${memory.subject} → ${memory.target})`);
            } else if (memory.subject) {
                parts.push(`(${memory.subject})`);
            }
            return parts.join(' ');
        }
    }
}

/**
 * 格式化 hiddenNotes 行
 */
function formatNoteLines(memory) {
    if (!Array.isArray(memory.hiddenNotes)) return '';
    const notes = memory.hiddenNotes.filter(n => n.allowInjection !== false);
    if (!notes.length) return '';
    return notes.map(n => {
        const typeLabel = HIDDEN_NOTE_TYPES[n.type]?.label || '备注';
        return `   [隐·${typeLabel}] ${n.content}`;
    }).join('\n');
}

// ═══════════════════════════════════════════════════════════
//  统一注入 Prompt 构建
// ═══════════════════════════════════════════════════════════

/**
 * 构建完整的记忆注入文本，分三个区块：
 *   [常驻记忆]   — L4 常驻索引卡
 *   [本轮相关记忆] — L1~L3 分等级注入
 *   [隐藏备注]   — hiddenNotes（含常驻 + 相关）
 *
 * @param {object} params
 * @param {Array} params.residentMemories - getResidentMemories() 的结果
 * @param {Array} params.relevantResults  - getRelevantMemories() 的结果
 * @param {object} params.settings        - 用户设置
 * @returns {{ text: string, tokenEstimate: number, stats: object }}
 */
export function buildMemoryInjectionPrompt({ residentMemories, relevantResults, settings, persistentMemories = [] }) {
    const tokenBudget = settings.tokenBudget || 800;
    let tokenUsed = 0;
    const stats = { persistentCount: 0, residentCount: 0, l3: 0, l2: 0, l1: 0, totalMemories: 0, hiddenNoteCount: 0 };

    const sections = [];
    const allHiddenLines = [];

    // ── 区块 0：常驻档案（NPC/物品/时间线）──
    if (persistentMemories.length) {
        const byCategory = { npc: [], item: [], timeline: [] };
        for (const pm of persistentMemories) {
            if (byCategory[pm.category]) byCategory[pm.category].push(pm);
        }
        const catLabels = { npc: 'NPC档案', item: '物品', timeline: '时间线' };
        const archiveLines = [];
        for (const [cat, items] of Object.entries(byCategory)) {
            if (!items.length) continue;
            archiveLines.push(`[${catLabels[cat]}]`);
            for (const item of items) {
                const line = `- ${item.name}: ${item.content}`;
                const cost = estimateTokens(line);
                if (tokenUsed + cost > tokenBudget * 0.35) break;
                archiveLines.push(line);
                tokenUsed += cost;
                stats.persistentCount++;
            }
        }
        if (archiveLines.length) {
            sections.push(`[常驻档案]\n${archiveLines.join('\n')}`);
        }
    }

    // ── 区块 1：常驻记忆 ──
    if (residentMemories.length) {
        const residentLines = [];
        for (const m of residentMemories) {
            const line = formatByLevel(m, 'L4');
            const cost = estimateTokens(line);
            if (tokenUsed + cost > tokenBudget * 0.3) break; // 常驻最多占预算 30%
            residentLines.push(line);
            tokenUsed += cost;
            stats.residentCount++;

            const noteText = formatNoteLines(m);
            if (noteText) {
                allHiddenLines.push(noteText);
                stats.hiddenNoteCount++;
            }
        }
        if (residentLines.length) {
            sections.push(`[常驻记忆]\n${residentLines.join('\n')}`);
        }
    }

    // ── 区块 2：本轮相关记忆（按等级分组）──
    const enabledTypes = settings.typeEnabled || {};
    const relevantLines = [];
    // v4.2.0: 硬上限防注入条目过多
    const MAX_INJECT = (settings.maxResults || 10) + 4;
    let injectedCount = 0;

    for (const { memory, level } of relevantResults) {
        if (injectedCount >= MAX_INJECT) break;
        const cogType = resolveMemoryType(memory);
        if (enabledTypes[cogType] === false) continue;

        const line = formatByLevel(memory, level);
        const cost = estimateTokens(line);
        if (tokenUsed + cost > tokenBudget) break;

        relevantLines.push(line);
        tokenUsed += cost;
        injectedCount++;
        stats[level === 'L3' ? 'l3' : level === 'L2' ? 'l2' : 'l1']++;

        const noteText = formatNoteLines(memory);
        if (noteText) {
            allHiddenLines.push(noteText);
            stats.hiddenNoteCount++;
        }
    }

    if (relevantLines.length) {
        sections.push(`[本轮相关记忆]\n${relevantLines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`);
    }

    // ── 区块 3：隐藏备注 ──
    if (allHiddenLines.length) {
        sections.unshift('（标记为[隐]的信息仅供你塑造角色行为和推进剧情，绝不要在对话中直接透露。）');
        sections.push(`[隐藏备注]\n${allHiddenLines.join('\n')}`);
    }

    stats.totalMemories = stats.persistentCount + stats.residentCount + stats.l3 + stats.l2 + stats.l1;
    const text = sections.join('\n\n');
    const tokenEstimate = estimateTokens(text);

    return { text, tokenEstimate, stats };
}

// ═══════════════════════════════════════════════════════════
//  向后兼容：旧版 searchMemories / simpleSearch
// ═══════════════════════════════════════════════════════════

/**
 * 兼容旧版调用（返回记忆数组而非带评分的结果）
 */
export function searchMemories(memories, queryText, options = {}) {
    const {
        maxResults = 5,
        minStrength = 0,
    } = typeof options === 'number' ? { maxResults: options } : options;

    const results = getRelevantMemories(memories, queryText, {
        maxResults,
        minStrength,
    });

    return results.map(r => r.memory);
}

/**
 * 简单文本搜索（管理面板搜索框用）
 */
/** 按需展开 API（再导出，便于外部统一从 retriever 引用） */
export { expandEntityMemories, expandMemoriesForEntityKeyword } from './entity-tiers.js';

export function simpleSearch(memories, queryText, maxResults = 100) {
    if (!memories.length || !queryText.trim()) return memories.slice(0, maxResults);

    const queryLower = queryText.toLowerCase();
    const tokens = extractTokens(queryText);

    const results = memories.filter(m => {
        const target = [
            m.content, m.title || '', m.summary || '',
            m.subject || '', m.target || '',
            (m.keywords || []).join(' '),
        ].join(' ').toLowerCase();

        if (target.includes(queryLower)) return true;
        return tokens.some(t => target.includes(t));
    });

    return results.slice(0, maxResults);
}
