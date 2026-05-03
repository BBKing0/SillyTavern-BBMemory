/**
 * retriever.js —— BB-Memory 的"搜索引擎"
 *
 * 职责：根据用户输入的文本，在记忆列表中查找相关的记忆。
 *
 * 搜索原理（关键词匹配）：
 *   1. 把用户输入拆分成"词语"（token）
 *   2. 对每条记忆，检查有多少词语出现在记忆内容中
 *   3. 计算匹配分数 = 命中词数 / 总词数
 *   4. 按分数从高到低排序，返回前 N 条
 *
 * 支持中文和英文混合文本。
 * 未来可以替换成向量化搜索（embedding）来提高精度。
 */

/**
 * 从文本中提取搜索用的词语。
 * 用各种标点符号和空白字符来拆分文本，过滤掉太短的片段。
 */
function extractTokens(text) {
    return text
        .toLowerCase()
        .split(/[\s,，。！？!?、；;：:""''（）()\[\]{}·\n\r\t]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2);
}

/**
 * 在记忆列表中搜索与查询文本相关的记忆。
 *
 * @param {Array} memories   - 记忆数组，每条有 { content, keywords } 字段
 * @param {string} queryText - 用户输入的文本
 * @param {number} maxResults - 最多返回几条结果
 * @returns {Array} 匹配到的记忆数组（按相关度从高到低）
 */
export function searchMemories(memories, queryText, maxResults = 5) {
    if (!memories.length || !queryText.trim()) return [];

    const tokens = extractTokens(queryText);
    if (tokens.length === 0) return [];

    const scored = [];

    for (const memory of memories) {
        const memText = memory.content.toLowerCase();
        const memKeywords = (memory.keywords || []).join(' ').toLowerCase();
        const searchTarget = memText + ' ' + memKeywords;

        let matchCount = 0;
        for (const token of tokens) {
            if (searchTarget.includes(token)) {
                matchCount++;
            }
        }

        if (matchCount > 0) {
            scored.push({
                memory,
                score: matchCount / tokens.length,
            });
        }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, maxResults).map(item => item.memory);
}
