/**
 * world-book-importer.js —— BB-Memory 的"翻译官"
 *
 * ═══════════════════════════════════════════════════════════
 *  代码小课堂
 * ═══════════════════════════════════════════════════════════
 *
 * 这个文件是什么？
 *   SillyTavern 有一个叫"世界书"(World Book/Lorebook)的功能，
 *   用来存储角色设定、世界观等信息。
 *   这个文件就像一个"翻译官"，把世界书的格式翻译成 BB-Memory 能理解的格式。
 *
 * 用了哪些编程概念？
 *   - JSON.parse()：把文本转换成 JavaScript 对象
 *   - 循环(for...of)：遍历世界书中的每一个条目
 *   - 条件判断(if)：根据内容判断这条记忆属于什么类型
 *   - 正则表达式(RegExp)：用模式匹配来分析文本内容
 *
 * 世界书格式：
 *   世界书的 JSON 文件里有 entries 对象，每个条目有：
 *   - key: 触发关键词数组
 *   - content: 词条正文
 *   - comment: 注释/标题
 *   - enabled: 是否启用
 *   - position: 注入位置
 *
 * 转换逻辑：
 *   关键词 → tags + keywords
 *   内容 → content
 *   自动判断 → type (npc/item/location/event等)
 *
 * ═══════════════════════════════════════════════════════════
 */

import { addMemory, extractKeywords, getSettings } from './memory-store.js';
import { guessTypeFromContent } from './memory-types.js';

/**
 * 解析世界书 JSON 并导入为 BB-Memory 记忆条目
 *
 * @param {string} chatId - 要导入到哪个聊天
 * @param {string} jsonString - 世界书 JSON 文件内容
 * @returns {number} 成功导入的条目数
 */
export async function importWorldBook(chatId, jsonString) {
    const data = JSON.parse(jsonString);
    const entries = extractEntries(data);

    if (!entries.length) {
        throw new Error('未找到有效的世界书条目。请确保文件是 SillyTavern 世界书格式。');
    }

    let importedCount = 0;

    for (const entry of entries) {
        if (!entry.content || !entry.content.trim()) continue;

        const content = entry.content.trim();
        const keywords = entry.key || [];
        const comment = entry.comment || '';

        // 自动判断记忆类型
        const type = guessTypeFromContent(content, keywords);

        // 构建标签（从关键词转换）
        const tags = keywords
            .filter(k => k && k.trim())
            .map(k => ({ name: k.trim(), weight: 0.6 }));

        // 构建元数据（根据类型填充）
        const metadata = buildMetadata(type, content, comment, keywords);

        await addMemory(chatId, content, type, 'worldbook', {
            tags,
            importance: estimateImportance(entry),
            emotionalValence: 0.0,
            metadata,
        });

        importedCount++;
    }

    return importedCount;
}

/**
 * 从世界书 JSON 中提取条目数组
 * 兼容多种世界书格式
 */
function extractEntries(data) {
    // 格式1：标准 SillyTavern 世界书 { entries: { "0": {...}, "1": {...} } }
    if (data.entries && typeof data.entries === 'object') {
        const entries = Object.values(data.entries);
        return entries.filter(e => e && typeof e === 'object');
    }

    // 格式2：直接是数组 [{ key, content }, ...]
    if (Array.isArray(data)) {
        return data.filter(e => e && typeof e === 'object' && e.content);
    }

    // 格式3：CharacterBook 格式（角色卡内嵌的世界书）
    if (data.data?.character_book?.entries) {
        return Object.values(data.data.character_book.entries);
    }
    if (data.character_book?.entries) {
        return Object.values(data.character_book.entries);
    }

    // 格式4：带 entries 数组
    if (data.entries && Array.isArray(data.entries)) {
        return data.entries;
    }

    return [];
}

/**
 * 根据类型和内容构建专用元数据
 */
function buildMetadata(type, content, comment, keywords) {
    const metadata = {};

    switch (type) {
        case 'npc': {
            // 尝试从注释或关键词中提取 NPC 名字
            metadata.npcName = comment || keywords[0] || '';
            metadata.role = '';
            metadata.relationship = '';
            metadata.attitude = 'unknown';
            break;
        }
        case 'item': {
            metadata.owner = '';
            metadata.quantity = 1;
            metadata.status = 'active';
            break;
        }
        case 'location': {
            metadata.locationName = comment || keywords[0] || '';
            metadata.description = content.slice(0, 100);
            metadata.visited = true;
            break;
        }
        case 'timeline': {
            metadata.storyDay = 0;
            metadata.chapter = comment || '';
            metadata.sequenceOrder = 0;
            break;
        }
        case 'relationship': {
            metadata.person1 = keywords[0] || '';
            metadata.person2 = keywords[1] || '';
            metadata.relationType = '';
            break;
        }
        default: {
            metadata.participants = [];
            metadata.location = '';
            break;
        }
    }

    return metadata;
}

/**
 * 根据世界书条目的属性估算重要性
 */
function estimateImportance(entry) {
    let importance = 0.5;

    // 有注释/标题的通常更重要
    if (entry.comment && entry.comment.trim()) {
        importance += 0.1;
    }

    // 内容越长通常越重要（但有上限）
    const contentLength = (entry.content || '').length;
    if (contentLength > 200) importance += 0.1;
    if (contentLength > 500) importance += 0.1;

    // 关键词越多越重要
    const keyCount = Array.isArray(entry.key) ? entry.key.length : 0;
    if (keyCount > 3) importance += 0.1;

    // constant (永久激活) 的条目更重要
    if (entry.constant) importance += 0.15;

    return Math.min(1.0, importance);
}

/**
 * 预览世界书文件内容（不实际导入，返回解析结果供用户确认）
 */
export function previewWorldBook(jsonString) {
    const data = JSON.parse(jsonString);
    const entries = extractEntries(data);

    return entries.map(entry => ({
        key: entry.key || [],
        content: (entry.content || '').slice(0, 100) + (entry.content?.length > 100 ? '...' : ''),
        comment: entry.comment || '',
        guessedType: guessTypeFromContent(entry.content || '', entry.key || []),
        enabled: entry.enabled !== false,
    }));
}

/**
 * 使用AI总结世界书内容后导入
 * 将所有条目内容发送给AI，由AI整理为结构化的记忆条目
 */
export async function importWorldBookWithAI(chatId, jsonString) {
    const data = JSON.parse(jsonString);
    const entries = extractEntries(data);

    if (!entries.length) {
        throw new Error('未找到有效的世界书条目。请确保文件是 SillyTavern 世界书格式。');
    }

    const settings = getSettings();

    // Check API configuration
    if (settings.autoGenMode === 'custom') {
        if (!settings.autoGenEndpoint) {
            throw new Error('请先在设置中配置自定义 API 端点（端点地址、API Key、模型名称）');
        }
    }

    // Build context text from all entries
    const contextText = entries.map((entry, i) => {
        const keys = (entry.key || []).join(', ');
        const comment = entry.comment ? ` (${entry.comment})` : '';
        return `[条目${i + 1}${comment}]\n关键词: ${keys}\n内容: ${entry.content}`;
    }).join('\n\n');

    // Build summarization prompt
    const prompt = `你是一个世界书记忆整理助手。以下是世界书的所有条目，请将它们整理为结构化的长期记忆条目。

规则：
1. 合并相似的条目，避免重复信息
2. 每条记忆应有简短标题和清晰内容
3. 正确选择认知类型和分类路径
4. 对于角色信息，建立 npc.profile；对于世界设定，使用 world.lore
5. 保留重要的关键词作为 tags
6. 如果没有值得保留的内容，返回空数组 []

认知类型：fact | episode | emotion | habit
分类路径：world.politics | world.lore | world.rules | npc.profile | npc.relationship | npc.emotion | npc.secret | npc.goal | npc.attitude | item.ownership | item.quest | item.key | item.clue | location.state | location.map | episode.event | episode.promise | episode.secret | episode.dialogue | episode.combat | emotion.bond | emotion.trauma | emotion.desire | habit.routine | habit.preference | habit.speech

以纯JSON数组格式返回，每条包含字段：cognitiveType, categoryPath, title, content, summary, tags, subject, target, importance（0-1之间的小数）

以下是世界书内容：

${contextText}`;

    // Call API
    let responseText;
    if (settings.autoGenMode === 'custom' && settings.autoGenEndpoint) {
        const { callCustomApi } = await import('./auto-generator.js');
        responseText = await callCustomApi(prompt);
    } else {
        const { callMainApi } = await import('./auto-generator.js');
        responseText = await callMainApi(prompt);
    }

    // Parse and create memories
    const { parseAiResponse } = await import('./auto-generator.js');
    const memories = parseAiResponse(responseText);

    if (!memories.length) {
        throw new Error('AI 未能从世界书中提取到有效记忆条目');
    }

    let importedCount = 0;
    for (const mem of memories) {
        await addMemory(chatId, mem.content, mem.cognitiveType || 'fact', 'worldbook', {
            categoryPath: mem.categoryPath,
            title: mem.title,
            summary: mem.summary,
            tags: mem.tags,
            subject: mem.subject,
            target: mem.target,
            importance: mem.importance,
            emotionalWeight: mem.emotionalWeight || 0.0,
        });
        importedCount++;
    }

    return importedCount;
}
