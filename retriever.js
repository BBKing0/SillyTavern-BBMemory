/**
 * retriever.js —— BB-Memory 的"搜索引擎"
 *
 * ═══════════════════════════════════════════════════════════
 *  代码小课堂
 * ═══════════════════════════════════════════════════════════
 *
 * 这个文件是什么？
 *   就像图书管理员帮你找书一样，这个文件负责在记忆库中
 *   找到与当前对话最相关的记忆。
 *
 * 用了哪些编程概念？
 *   - 算法：综合多个"打分维度"来判断一条记忆的相关性
 *   - 排序(sort)：按分数从高到低排列
 *   - 过滤(filter)：只保留满足条件的记忆
 *   - Fuse.js：SillyTavern 内置的模糊搜索库
 *     （能理解拼写错误或近似匹配）
 *
 * 搜索评分公式：
 *   总分 = 关键词匹配(30%) + 标签匹配(25%) + 记忆强度(25%) + 时效性(20%)
 *
 * 关键函数：
 *   - searchMemories()：主搜索函数，返回排序后的相关记忆
 *   - scoreMemory()：给单条记忆打综合分
 *   - computeKeywordMatch()：关键词维度打分
 *   - computeTagMatch()：标签维度打分
 *   - computeRecency()：时间维度打分（越新分越高）
 *
 * ═══════════════════════════════════════════════════════════
 */

// ═══ 评分权重配置 ═══
const WEIGHTS = {
    keyword: 0.30,
    tag: 0.25,
    strength: 0.25,
    recency: 0.20,
};

// 时效性计算的时间窗口（7天内的记忆获得满分时效性）
const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ═══ 文本分词 ═══

/**
 * 从文本中提取搜索用的词语（token）
 */
function extractTokens(text) {
    return text
        .toLowerCase()
        .split(/[\s,，。！？!?、；;：:""''（）()\[\]{}·\n\r\t]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2);
}

// ═══ 评分函数 ═══

/**
 * 关键词匹配度评分
 * 检查查询词语在记忆内容+关键词中出现了多少
 */
function computeKeywordMatch(memory, queryTokens) {
    if (!queryTokens.length) return 0;

    const memText = memory.content.toLowerCase();
    const memKeywords = (memory.keywords || []).join(' ').toLowerCase();
    const searchTarget = memText + ' ' + memKeywords;

    let matchCount = 0;
    for (const token of queryTokens) {
        if (searchTarget.includes(token)) {
            matchCount++;
        }
    }

    return matchCount / queryTokens.length;
}

/**
 * 标签匹配度评分
 * 如果查询词语命中了记忆的标签，按标签权重累加
 */
function computeTagMatch(memoryTags, queryTokens) {
    if (!memoryTags || !memoryTags.length || !queryTokens.length) return 0;

    let totalWeight = 0;
    let matchedWeight = 0;

    for (const tag of memoryTags) {
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
 * 时效性评分
 * 越新创建的记忆，分数越高（7天内为满分范围）
 */
function computeRecency(createdAt, now) {
    if (!createdAt) return 0.5;
    const age = now - createdAt;
    if (age <= 0) return 1.0;
    if (age >= RECENCY_WINDOW_MS) {
        // 超过7天的记忆，使用对数衰减，不会降到0
        return Math.max(0.1, 1 - Math.log10(age / RECENCY_WINDOW_MS + 1) * 0.5);
    }
    return 1 - (age / RECENCY_WINDOW_MS) * 0.5;
}

/**
 * 综合评分函数
 */
function scoreMemory(memory, queryTokens, now) {
    const keywordScore = computeKeywordMatch(memory, queryTokens);
    const tagScore = computeTagMatch(memory.tags, queryTokens);
    const strengthScore = memory.strength ?? 1.0;
    const recencyScore = computeRecency(memory.createdAt, now);

    const totalScore =
        keywordScore * WEIGHTS.keyword +
        tagScore * WEIGHTS.tag +
        strengthScore * WEIGHTS.strength +
        recencyScore * WEIGHTS.recency;

    // 重要性作为加成系数（0.5~1.5倍）
    const importanceBonus = 0.5 + (memory.importance || 0.5);

    return totalScore * importanceBonus;
}

// ═══ 主搜索函数 ═══

/**
 * 在记忆列表中搜索与查询文本相关的记忆
 *
 * @param {Array} memories - 记忆数组
 * @param {string} queryText - 搜索文本
 * @param {object} options - 搜索选项
 * @param {number} options.maxResults - 最多返回条数（默认5）
 * @param {string|null} options.typeFilter - 只搜索某种类型（null=全部）
 * @param {number} options.minStrength - 最低记忆强度过滤（默认0）
 * @param {boolean} options.useFuse - 是否使用Fuse模糊搜索增强（默认true）
 * @returns {Array} 匹配到的记忆数组（按相关度从高到低）
 */
export function searchMemories(memories, queryText, options = {}) {
    const {
        maxResults = 5,
        typeFilter = null,
        minStrength = 0,
        useFuse = true,
    } = typeof options === 'number' ? { maxResults: options } : options;

    if (!memories.length || !queryText.trim()) return [];

    const queryTokens = extractTokens(queryText);
    if (queryTokens.length === 0) return [];

    const now = Date.now();

    // 第一步：过滤
    let candidates = memories;

    if (typeFilter) {
        candidates = candidates.filter(m => m.type === typeFilter);
    }

    if (minStrength > 0) {
        candidates = candidates.filter(m => (m.strength ?? 1.0) >= minStrength);
    }

    if (!candidates.length) return [];

    // 第二步：Fuse 模糊搜索（如果可用）
    let fuseBoostMap = new Map();

    if (useFuse) {
        try {
            const Fuse = SillyTavern.libs.Fuse;
            if (Fuse) {
                const fuse = new Fuse(candidates, {
                    keys: ['content', 'keywords'],
                    threshold: 0.4,
                    includeScore: true,
                });
                const fuseResults = fuse.search(queryText);
                for (const result of fuseResults) {
                    // Fuse 的 score 越低越好(0=完美匹配)，转换为加成
                    const boost = 1 - (result.score || 0);
                    fuseBoostMap.set(result.item.id, boost * 0.3);
                }
            }
        } catch {
            // Fuse 不可用时忽略
        }
    }

    // 第三步：综合评分
    const scored = [];

    for (const memory of candidates) {
        let score = scoreMemory(memory, queryTokens, now);

        // 加上 Fuse 模糊匹配的加成
        const fuseBoost = fuseBoostMap.get(memory.id) || 0;
        score += fuseBoost;

        if (score > 0.01) {
            scored.push({ memory, score });
        }
    }

    // 第四步：排序并返回
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, maxResults).map(item => item.memory);
}

/**
 * 简单文本搜索（用于管理面板的搜索框，不需要复杂评分）
 */
export function simpleSearch(memories, queryText, maxResults = 100) {
    if (!memories.length || !queryText.trim()) return memories.slice(0, maxResults);

    const queryLower = queryText.toLowerCase();
    const tokens = extractTokens(queryText);

    const results = memories.filter(m => {
        const content = m.content.toLowerCase();
        const keywords = (m.keywords || []).join(' ').toLowerCase();
        const target = content + ' ' + keywords;

        // 整体包含或 token 命中
        if (target.includes(queryLower)) return true;
        return tokens.some(t => target.includes(t));
    });

    return results.slice(0, maxResults);
}
