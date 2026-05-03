/**
 * auto-generator.js —— BB-Memory 的"自动速记员"
 *
 * ═══════════════════════════════════════════════════════════
 *  代码小课堂
 * ═══════════════════════════════════════════════════════════
 *
 * 这个文件是什么？
 *   想象有一个助手坐在你旁边，每当你和角色对话完，
 *   它就自动帮你把重要的内容记到笔记本上。
 *   这就是"AI 自动生成记忆"的功能。
 *
 * 用了哪些编程概念？
 *   - 事件监听(Event Listener)：当AI回复消息时触发
 *   - fetch/API调用：向AI服务发送请求
 *   - JSON解析：把AI返回的文字解析成结构化数据
 *   - try/catch：处理可能出错的情况（网络问题等）
 *   - 防抖(debounce)：避免太频繁地调用API
 *
 * 工作流程：
 *   1. 监听 AI 回复事件（MESSAGE_RECEIVED）
 *   2. 收集当前楼层的用户消息 + AI回复
 *   3. 调用 AI（主API的quiet模式 或 自定义API）
 *   4. AI 返回结构化的记忆条目（JSON格式）
 *   5. 解析并存入记忆库
 *
 * ═══════════════════════════════════════════════════════════
 */

import { getSettings, addMemory } from './memory-store.js';
import { getExtractableExchanges, markExchangeExtracted } from './message-state.js';
import {
    normalizeNpcTier,
    normalizeItemTier,
    applyStandaloneArchivePolicy,
    inferStandaloneArchive,
} from './entity-tiers.js';

// ═══ 默认提示词模板 ═══

const DEFAULT_EXTRACTION_PROMPT = `你是一个记忆提取助手。请根据以下对话内容，提取值得长期记忆的关键信息。

规则：
1. 只提取重要的、值得记住的信息，不要记录日常寒暄
2. 每条记忆应有简短标题和清晰内容
3. 如果对话中有重要原话（承诺、告白、威胁等），保留在 verbatim 字段
4. 正确选择认知类型和分类路径
5. **一次性出场的路人**不要建 npc.profile 独立档案：设 standaloneArchive=false，分类用 episode.event，npcTier=background
6. **核心/长线 NPC** 才用 npc.profile / npc.relationship 等，并标注 npcTier
7. **消耗品、随手道具** 用 itemTier=consumable 或 background；任务关键物用 key / clue
8. 如果没有值得记忆的内容，返回空数组 []

认知类型：
- fact: 确定的事实（NPC档案、物品、地点、世界设定）
- episode: 发生的事件或经历（事件、承诺、秘密、战斗）
- emotion: 情感状态（好感变化、情绪波动、羁绊）
- habit: 行为模式（习惯、偏好、口头禅）

分类路径（NPC 子类可归在对应路径下）：
world.politics | world.lore | npc.profile | npc.relationship | npc.emotion | npc.secret | npc.goal | npc.attitude |
item.ownership | item.key | item.clue | item.quest | location.state | episode.event | episode.promise |
episode.secret | episode.dialogue | episode.combat | emotion.bond | emotion.trauma | emotion.desire |
habit.routine | habit.preference | habit.speech

NPC 分级 npcTier（事实类/档案类条目填写，路人片段填 background）：
- core: 核心角色（长跑剧情）
- important: 重要配角
- minor: 普通配角
- background: 路人（尽量不单独建档）

物品分级 itemTier（物品相关条目填写）：
- key: 关键剧情物品
- equipped: 当前持有/装备
- clue: 线索物
- consumable: 消耗品
- background: 背景道具

以纯JSON数组格式返回（不要包含markdown代码块标记），每条包含：
- cognitiveType: "fact"|"episode"|"emotion"|"habit"
- categoryPath: 分类路径（从上方列表选择）
- title: 简短标题（3-8字）
- content: 完整记忆内容
- summary: 一句话摘要（10-20字）
- verbatim: 重要原话（无则 ""）
- tags: 标签数组（2-5个关键词）
- subject: 主要实体名（NPC或物品名，无则 ""）
- target: 关联对象名（无则 ""）
- importance: 重要性(0-1)
- emotionalWeight: 情感强度(0-1)
- npcTier: "core"|"important"|"minor"|"background"|"" （非 NPC 可 ""）
- itemTier: "key"|"equipped"|"clue"|"consumable"|"background"|"" （非物品可 ""）
- standaloneArchive: true/false —— false 表示「不要单独 NPC 档案」（路人），插件会改为情景记忆
- indexCard: 可选，一行常驻索引卡（短摘要+状态，不要写完整生平；无则 ""）
- relatedMemoryIds: 可选，关联的其它记忆 id 数组（通常留 []）

[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

// ═══ 常量 ═══

const MAX_EXTRACT_PER_CYCLE = 3;

// ═══ 状态管理 ═══

let isProcessing = false;
let pendingMessages = [];
let processingTimer = null;

// ═══ 核心函数 ═══

/**
 * 获取当前使用的提示词模板
 */
function getExtractionPrompt() {
    const settings = getSettings();
    return settings.autoGenPrompt || DEFAULT_EXTRACTION_PROMPT;
}

/**
 * 构建完整的提取提示词
 */
function buildPrompt(userMessage, aiMessage) {
    const template = getExtractionPrompt();
    return template
        .replace('{{userMessage}}', userMessage || '(无)')
        .replace('{{aiMessage}}', aiMessage || '(无)');
}

/**
 * 通过主 API 的 generateRaw 调用（推荐方式）
 * 使用 SillyTavern 当前配置的 API，以 raw 模式生成
 */
async function callMainApi(prompt) {
    const { generateRaw } = SillyTavern.getContext();

    const result = await generateRaw({
        systemPrompt: '你是一个JSON格式的记忆提取助手。只输出纯JSON数组，不要包含其他文字。',
        prompt: prompt,
    });

    return result;
}

/**
 * 通过自定义 API 端点调用（备用方式）
 * 支持 OpenAI 兼容格式
 */
async function callCustomApi(prompt) {
    const settings = getSettings();
    const { autoGenEndpoint, autoGenApiKey, autoGenModel } = settings;

    if (!autoGenEndpoint) {
        throw new Error('未配置自定义API端点');
    }

    const response = await fetch(autoGenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${autoGenApiKey}`,
        },
        body: JSON.stringify({
            model: autoGenModel || 'gpt-3.5-turbo',
            messages: [
                {
                    role: 'system',
                    content: '你是一个JSON格式的记忆提取助手。只输出纯JSON数组，不要包含其他文字。',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.3,
            max_tokens: 1000,
        }),
    });

    if (!response.ok) {
        throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // 兼容 OpenAI 格式
    if (data.choices && data.choices[0]) {
        return data.choices[0].message?.content || data.choices[0].text || '';
    }

    return data.content || data.text || JSON.stringify(data);
}

/**
 * 解析 AI 返回的 JSON 文本为记忆条目数组
 */
function parseAiResponse(responseText) {
    if (!responseText || !responseText.trim()) return [];

    let text = responseText.trim();

    // 移除可能的 markdown 代码块标记
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    // 尝试提取 JSON 数组
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        text = arrayMatch[0];
    }

    try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) return [];

        const VALID_COG_TYPES = ['fact', 'episode', 'emotion', 'habit'];

        return parsed
            .filter(item => item && item.content && typeof item.content === 'string')
            .map(item => ({
                cognitiveType: VALID_COG_TYPES.includes(item.cognitiveType)
                    ? item.cognitiveType
                    : 'episode',
                categoryPath: item.categoryPath || '',
                title: typeof item.title === 'string' ? item.title.trim() : '',
                content: item.content.trim(),
                summary: typeof item.summary === 'string' ? item.summary.trim() : '',
                verbatim: typeof item.verbatim === 'string' ? item.verbatim.trim() : '',
                tags: Array.isArray(item.tags)
                    ? item.tags.map(t => ({ name: String(t), weight: 0.6 }))
                    : [],
                importance: typeof item.importance === 'number'
                    ? Math.max(0, Math.min(1, item.importance))
                    : 0.5,
                emotionalWeight: typeof item.emotionalWeight === 'number'
                    ? Math.max(0, Math.min(1, item.emotionalWeight))
                    : 0.0,
                subject: typeof item.subject === 'string' ? item.subject.trim() : '',
                target: typeof item.target === 'string' ? item.target.trim() : '',
                npcTier: normalizeNpcTier(item.npcTier),
                itemTier: normalizeItemTier(item.itemTier),
                standaloneArchive: typeof item.standaloneArchive === 'boolean'
                    ? item.standaloneArchive
                    : undefined,
                indexCard: typeof item.indexCard === 'string' ? item.indexCard.trim() : '',
                relatedMemoryIds: Array.isArray(item.relatedMemoryIds)
                    ? item.relatedMemoryIds.map(String).filter(Boolean)
                    : [],
            }));
    } catch (e) {
        console.warn('[BB-Memory] AI 返回内容解析失败:', e.message, text.slice(0, 200));
        return [];
    }
}

/**
 * 从一个 exchange 中提取记忆（不带队列控制，直接调用 AI）
 * @returns {number} 成功添加的记忆条数
 */
async function extractFromExchange(chatId, userMessage, aiMessage) {
    const settings = getSettings();
    const prompt = buildPrompt(userMessage, aiMessage);

    let responseText;
    if (settings.autoGenMode === 'custom' && settings.autoGenEndpoint) {
        responseText = await callCustomApi(prompt);
    } else {
        responseText = await callMainApi(prompt);
    }

    const memories = parseAiResponse(responseText);
    let addedCount = 0;

    for (const mem of memories) {
        if (mem.standaloneArchive === undefined) {
            mem.standaloneArchive = inferStandaloneArchive(mem);
        }
        applyStandaloneArchivePolicy(mem);

        await addMemory(chatId, mem.content, mem.cognitiveType || 'episode', 'auto', {
            categoryPath: mem.categoryPath,
            title: mem.title,
            summary: mem.summary,
            verbatim: mem.verbatim,
            tags: mem.tags,
            importance: mem.importance,
            emotionalWeight: mem.emotionalWeight,
            subject: mem.subject,
            target: mem.target,
            npcTier: mem.npcTier || undefined,
            itemTier: mem.itemTier || undefined,
            standaloneArchive: mem.standaloneArchive,
            indexCard: mem.indexCard || undefined,
            relatedMemoryIds: mem.relatedMemoryIds?.length ? mem.relatedMemoryIds : undefined,
        });
        addedCount++;
    }

    if (addedCount > 0) {
        console.log(`[BB-Memory] 从 exchange 提取了 ${addedCount} 条记忆`);
    }

    return addedCount;
}

/**
 * 处理一轮对话，提取记忆（保留用于手动提取的兼容接口）
 */
async function processConversation(chatId, userMessage, aiMessage) {
    if (isProcessing) {
        pendingMessages.push({ chatId, userMessage, aiMessage });
        return;
    }

    isProcessing = true;

    try {
        const count = await extractFromExchange(chatId, userMessage, aiMessage);

        if (count > 0 && typeof toastr !== 'undefined') {
            toastr.info(`自动记录了 ${count} 条新记忆`, 'BB-Memory', {
                timeOut: 3000,
                preventDuplicates: true,
            });
        }
    } catch (error) {
        console.error('[BB-Memory] AI 自动生成记忆失败:', error);
    } finally {
        isProcessing = false;

        if (pendingMessages.length > 0) {
            const next = pendingMessages.shift();
            setTimeout(() => processConversation(next.chatId, next.userMessage, next.aiMessage), 1000);
        }
    }
}

// ═══ 事件处理 ═══

/**
 * MESSAGE_RECEIVED 事件处理函数
 * 当 AI 生成新回复时触发
 *
 * v2.1 变更：不再直接提取当前消息，而是：
 *   1. 等待 index.js 完成消息可见性同步（自动隐藏旧消息）
 *   2. 查找所有"插件自动隐藏 + 未提取"的 exchange
 *   3. 逐个提取记忆，并用指纹防止重复
 */
function onMessageReceived(_messageIndex) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoGenEnabled) return;

    const chatId = getChatId();
    if (!chatId) return;

    if (processingTimer) clearTimeout(processingTimer);
    processingTimer = setTimeout(async () => {
        try {
            const exchanges = await getExtractableExchanges();
            if (!exchanges.length) return;

            const toProcess = exchanges.slice(0, MAX_EXTRACT_PER_CYCLE);
            let totalAdded = 0;

            for (const ex of toProcess) {
                try {
                    const count = await extractFromExchange(chatId, ex.userMessage, ex.aiMessage);
                    await markExchangeExtracted(ex.aiIndex, ex.hash);
                    totalAdded += count;
                } catch (err) {
                    console.error('[BB-Memory] Exchange 提取失败:', err);
                }
            }

            if (totalAdded > 0 && typeof toastr !== 'undefined') {
                toastr.info(
                    `自动记录了 ${totalAdded} 条新记忆（来自 ${toProcess.length} 个 exchange）`,
                    'BB-Memory',
                    { timeOut: 3000, preventDuplicates: true },
                );
            }
        } catch (error) {
            console.error('[BB-Memory] Exchange 处理流程出错:', error);
        }
    }, 2500);
}

/**
 * 获取当前聊天 ID（与 index.js 共用逻辑）
 */
function getChatId() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.chatId) return String(ctx.chatId);
        if (ctx.characters && ctx.characterId !== undefined) {
            const char = ctx.characters[ctx.characterId];
            if (char?.chat) return String(char.chat);
        }
    } catch { /* 忽略 */ }
    return null;
}

// ═══ 初始化与清理 ═══

let eventBound = false;

/**
 * 初始化自动生成模块
 * 注册 MESSAGE_RECEIVED 事件监听
 */
export function initAutoGenerator() {
    if (eventBound) return;

    const ctx = SillyTavern.getContext();
    ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventBound = true;

    console.log('[BB-Memory] AI 自动生成模块已初始化');
}

/**
 * 停止自动生成（用于禁用时）
 */
export function stopAutoGenerator() {
    if (!eventBound) return;

    try {
        const ctx = SillyTavern.getContext();
        ctx.eventSource.removeListener(ctx.event_types.MESSAGE_RECEIVED, onMessageReceived);
    } catch { /* 忽略 */ }

    eventBound = false;
    pendingMessages = [];
    if (processingTimer) {
        clearTimeout(processingTimer);
        processingTimer = null;
    }
}

/**
 * 手动触发一次记忆提取（用于管理面板的"一键分析"）
 */
export async function manualExtract(chatId, userMessage, aiMessage) {
    return processConversation(chatId, userMessage, aiMessage);
}

/**
 * 获取默认提示词（用于设置面板显示）
 */
export function getDefaultPrompt() {
    return DEFAULT_EXTRACTION_PROMPT;
}
