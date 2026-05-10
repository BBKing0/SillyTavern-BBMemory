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

import { getSettings, getMemories, addMemory, updateMemory } from './memory-store.js';
import { getExtractableExchanges, markExchangeExtracted, isExchangeProcessed, computeExchangeHash, hideExchange } from './message-state.js';
import {
    normalizeNpcTier,
    normalizeItemTier,
    applyStandaloneArchivePolicy,
    inferStandaloneArchive,
} from './entity-tiers.js';

// ═══ v4.1.0: 语义去重 ═══

function getDedupConfig() {
    const s = getSettings();
    return {
        mergeThreshold: s.mergeSimilarityThreshold ?? 0.85,
        reduceThreshold: s.reduceSimilarityThreshold ?? 0.60,
        minSimilarity: 0.50,
    };
}

/**
 * v4.1.0: 余弦相似度（本地副本，纯数学运算）
 */
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

/**
 * v4.1.0: 在现有记忆中寻找与新记忆语义最相似的记忆
 * @returns {{ memory, similarity } | null}
 */
function findMostSimilarMemory(newEmbedding, existingMemories) {
    if (!newEmbedding) return null;
    let best = null;
    for (const mem of existingMemories) {
        if (!mem.embedding) continue;
        if (mem.status === 'archived' || mem.status === 'deleted') continue;
        const sim = cosineSimilarity(newEmbedding, mem.embedding);
        if (sim >= getDedupConfig().minSimilarity && (!best || sim > best.similarity)) {
            best = { memory: mem, similarity: sim };
        }
    }
    return best;
}

/**
 * v4.1.0: 合并新旧记忆字段。新信息追加到旧记忆，不改变创建时间。
 */
function mergeMemoryFields(existing, incoming) {
    const updates = {
        content: existing.content + '\n[更新] ' + incoming.content,
        summary: incoming.summary || existing.summary,
        verbatim: incoming.verbatim || existing.verbatim,
        importance: Math.min(1.0, Math.max(existing.importance || 0.5, incoming.importance || 0.5) + 0.05),
        emotionalWeight: Math.max(existing.emotionalWeight || 0, incoming.emotionalWeight || 0),
        updatedAt: Date.now(),
    };
    // 追加关联 ID
    if (incoming.id) {
        const existingRelated = Array.isArray(existing.relatedMemoryIds) ? existing.relatedMemoryIds : [];
        if (!existingRelated.includes(incoming.id)) {
            updates.relatedMemoryIds = [...existingRelated, incoming.id];
        }
    }
    return updates;
}

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

NPC 分级 npcTier（**每条记忆必须填写**，有角色时必须标注对应分级；无角色时留空 ""）：
- core: 核心角色（长跑剧情）
- important: 重要配角
- minor: 普通配角
- background: 路人（尽量不单独建档）

物品分级 itemTier（**涉及重要物品时必须填写**，无物品时留空 ""）：
- key: 关键剧情物品
- equipped: 当前持有/装备
- clue: 线索物
- consumable: 消耗品
- background: 背景道具

以纯JSON数组格式返回（不要包含markdown代码块标记），使用以下短码字段名以减少 token：

短码对照（必用短码，不要用全名）：
t=cognitiveType | p=categoryPath | n=title | c=content | m=summary | v=verbatim
g=tags | s=subject | a=target | i=importance | e=emotionalWeight
nt=npcTier | it=itemTier | sa=standaloneArchive | ic=indexCard | ri=relatedMemoryIds
st=storyTime | ss=storyTimeSort

字段说明：
- t: "fact"|"episode"|"emotion"|"habit"
- p: 分类路径（从上方列表选择）
- n: 简短标题（3-8字）
- c: 完整记忆内容
- m: 一句话摘要（10-20字）
- v: 重要原话（无则 ""）
- g: 标签数组（前3个为结构标签用于聚类如"北境战争"，后7个为自由标签用于交叉索引如"背叛"；上限10个）
- s: 主要实体名（NPC或物品名，无则 ""）
- a: 关联对象名（无则 ""）
- i: 重要性(0-1)
- e: 情感强度(0-1)
- nt: "core"|"important"|"minor"|"background"|"" （非NPC可""）
- it: "key"|"equipped"|"clue"|"consumable"|"background"|"" （非物品可""）
- sa: true/false —— false表示「不要单独NPC档案」（路人），插件会改为情景记忆
- ic: 可选，一行常驻索引卡（短摘要+状态，无则 ""）
- ri: 可选，关联的其它记忆id数组（通常留 []）
- st: 可选，故事发生时间（人类可读格式，无则 ""）
- ss: 可选，排序用数字时间戳（按用户日历规则折算，无则 null）

示例1（含NPC分级）：[{"t":"episode","p":"episode.event","n":"北境宣战","c":"雅赫摩斯在北境会议上正式宣战","m":"雅赫摩斯向北境诸邦宣战","v":"从今日起，北境诸邦即为吾敌","g":["北境战争","雅赫摩斯"],"s":"雅赫摩斯","a":"北境诸邦","i":0.8,"e":0.6,"nt":"core","it":"","sa":false,"ic":"","ri":[]}]
示例2（NPC记忆-必填nt）：[{"t":"fact","p":"npc.profile","n":"旅行商人科尔","c":"科尔是一个来自南方的旅行商人，专营稀有魔法材料","m":"旅行商人科尔专营稀有魔法材料","v":"","g":["科尔","商人","南方"],"s":"科尔","a":"","i":0.7,"e":0.1,"nt":"important","it":"","sa":true,"ic":"南方的稀有材料商人，性格精明","ri":[]}]
示例3（物品记忆-必填it）：[{"t":"fact","p":"item.key","n":"辉月之剑","c":"辉月之剑是一把传说中的圣剑，曾属于古代英雄阿尔托","m":"辉月之剑是传说中的圣剑","v":"","g":["辉月之剑","圣剑","古代遗物"],"s":"辉月之剑","a":"","i":0.9,"e":0.3,"nt":"","it":"key","sa":true,"ic":"传说中的圣剑","ri":[]}]
[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

// ═══ 状态管理 ═══

let isProcessing = false;
let pendingMessages = [];
let processingTimer = null;

// v2.9.8: 主动模式下等待审核的候选记忆
let pendingAutoCandidates = [];

/**
 * 获取待审核的自动提取候选记忆
 */
export function getPendingAutoCandidates() {
    return pendingAutoCandidates;
}

/**
 * 清空待审核的自动提取候选记忆
 */
export function clearPendingAutoCandidates() {
    pendingAutoCandidates = [];
}

// ═══ 核心函数 ═══

/**
 * 获取当前使用的提示词模板
 */
function getExtractionPrompt() {
    const settings = getSettings();
    return settings.autoGenPrompt || DEFAULT_EXTRACTION_PROMPT;
}

/**
 * v2.9.9: 构建总结模式 + 排除NPC 的附加指令
 */
function buildSummaryInstructions() {
    const settings = getSettings();
    const parts = [];

    // 获取角色名和用户名
    let charName = '';
    let userName = '';
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.characters && ctx.characterId !== undefined) {
            charName = ctx.characters[ctx.characterId]?.name || '';
        }
        if (ctx.name1) userName = ctx.name1;
    } catch { /* ignore */ }

    // 总结模式
    if (settings.summaryMode === 'self') {
        parts.push(`【重要：代入式总结模式】用户 "${userName || '用户'}" 是扮演者本人。关于 "${userName || '用户'}" 的信息**只能从用户消息中提取**，严禁从AI回复中推断或总结用户的信息。AI角色 "${charName || '角色'}" 的信息正常从AI回复中提取。`);
    } else {
        parts.push(`【扮演式总结模式】用户 "${userName || '用户'}" 和 AI角色 "${charName || '角色'}" 的信息均可从对话中综合提取。`);
    }

    // 排除 NPC
    if (settings.excludedNpcs && settings.excludedNpcs.trim()) {
        const npcs = settings.excludedNpcs.split(',').map(n => n.trim()).filter(Boolean);
        if (npcs.length > 0) {
            parts.push(`【排除NPC】以下 NPC 的信息**不需要**提取为独立记忆：${npcs.join('、')}。在对话中出现这些NPC时，不要为其创建 npc.profile 或以他们为 subject 的记忆条目。`);
        }
    }

    // v4.1.0: 故事日历规则
    if (settings.calendarDescription && settings.calendarDescription.trim()) {
        parts.push(`【故事日历】${settings.calendarDescription.trim()}\n请在每条记忆的 st 字段中填写故事发生时间（人类可读格式），在 ss 字段中填写对应的排序用数字时间戳。无法确定时间时，st 和 ss 可留空。`);
    } else {
        // v4.3.0: 无自定义日历时，给 AI 默认时间推断规则
        parts.push(`【时间推断规则】对话未配置故事日历。请基于对话内容推断故事时间：根据事件顺序推测大致时间（如"第1天上午"、"次日傍晚"、"三天后"），填入 st 字段。ss 填写递增排序数字：每个对话 exchange 推进约 +20，跨天 +100（如 100, 120, 200, 220...）。无法确定时间时留空。`);
    }

    // v4.3.0: 强化实体标注规则
    parts.push(`【实体标注规则-严格执行】每条记忆的 s（subject）必须填写涉及的主要实体名。有实体名时必须填写 nt（npcTier）或 it（itemTier），不可留空。
具体要求：
- NPC记忆（categoryPath 以 npc. 开头）：s填角色名，nt必填(core/important/minor/background)
- 物品记忆（categoryPath 以 item. 开头）：s填物品名，it必填(key/equipped/clue/consumable/background)
- 其他记忆（地点/事件/情感/习惯）：有实体则标注，无实体可留空
分级速查：core=核心角色 | important=重要配角 | minor=普通配角 | background=路人
         key=关键剧情物 | equipped=持有装备 | clue=线索物 | consumable=消耗品 | background=背景物`);

    return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
}

/**
 * v4.1.0: 清洗 AI 消息，只保留正文内容
 * - 如果有 &lt;content&gt; 标签 → 只提取其内容
 * - 否则移除 &lt;think&gt; 块和状态栏，保留剩余文本
 */
function cleanAiMessage(text) {
    if (!text) return '';
    let cleaned = text;

    // 优先提取 <content>...</content>
    const contentMatch = cleaned.match(/<content>([\s\S]*?)<\/content>/i);
    if (contentMatch) {
        return contentMatch[1].trim();
    }

    // 移除 <think>...</think> 块
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // 移除常见状态栏格式（如 [HP:100/100] 等）
    cleaned = cleaned.replace(/\[[\w\s:/.-]+\]/g, '');
    return cleaned.trim();
}

/**
 * 构建完整的提取提示词
 */
function buildPrompt(userMessage, aiMessage) {
    const template = getExtractionPrompt();
    const instructions = buildSummaryInstructions();
    return (template + instructions)
        .replace('{{userMessage}}', userMessage || '(无)')
        .replace('{{aiMessage}}', cleanAiMessage(aiMessage) || '(无)');
}

/**
 * 规范化 API 端点 URL，自动补全 OpenAI 兼容路径
 *   https://api.example.com           -> .../v1/chat/completions
 *   https://api.example.com/v1        -> .../v1/chat/completions
 *   https://api.example.com/v1/chat/completions -> 保持不变
 */
export function normalizeEndpoint(url) {
    let cleaned = url.trim().replace(/\/+$/, '');
    if (cleaned.endsWith('/chat/completions')) return cleaned;
    if (cleaned.endsWith('/v1')) return cleaned + '/chat/completions';
    return cleaned + '/v1/chat/completions';
}

/**
 * 通过主 API 的 generateRaw 调用（推荐方式）
 * 使用 SillyTavern 当前配置的 API，以 raw 模式生成
 */
export async function callMainApi(prompt) {
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
export async function callCustomApi(prompt) {
    const settings = getSettings();
    const { autoGenEndpoint, autoGenApiKey, autoGenModel } = settings;

    if (!autoGenEndpoint) {
        throw new Error('未配置自定义API端点');
    }

    const endpoint = normalizeEndpoint(autoGenEndpoint);

    if (settings.debugLogging) {
        console.log('[BB-Memory] 副API请求端点:', endpoint);
    }

    const response = await fetchWithTimeout(endpoint, {
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
    }, 30000);

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
 * v4.4.1: 带超时的 fetch 包装。浏览器 fetch 无默认超时，可能永久挂起。
 */
function fetchWithTimeout(url, options, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * v4.0.0: 规范化 Embedding API 端点 URL
 */
function normalizeEmbeddingEndpoint(url) {
    let cleaned = url.trim().replace(/\/+$/, '');
    if (cleaned.endsWith('/embeddings')) return cleaned;
    if (cleaned.endsWith('/v1')) return cleaned + '/embeddings';
    return cleaned + '/v1/embeddings';
}

/**
 * v4.0.0: 调用 Embedding API 生成向量
 * v4.4.1: 添加 10 秒超时保护
 */
export async function callEmbeddingApi(text, timeoutMs = 10000) {
    const settings = getSettings();
    const { embeddingEndpoint, embeddingApiKey, embeddingModel } = settings;

    if (!embeddingEndpoint) {
        throw new Error('未配置 Embedding API 端点');
    }

    const endpoint = normalizeEmbeddingEndpoint(embeddingEndpoint);

    if (settings.debugLogging) {
        console.log('[BB-Memory] Embedding API 请求端点:', endpoint, '模型:', embeddingModel);
    }

    const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${embeddingApiKey}`,
        },
        body: JSON.stringify({
            model: embeddingModel,
            input: text,
        }),
    }, timeoutMs);

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Embedding API 请求失败: ${response.status} ${response.statusText}${errText ? ' - ' + errText : ''}`);
    }

    const data = await response.json();

    if (data.data && data.data[0] && Array.isArray(data.data[0].embedding)) {
        return data.data[0].embedding;
    }

    throw new Error('Embedding API 返回格式异常');
}

/**
 * v4.0.0: 为一条记忆生成 embedding 向量
 * @param {object} mem - 含 summary/content 的记忆条目
 * @returns {number[]|null} 向量数组或 null
 */
async function embedMemoryEntry(mem) {
    const text = mem.summary || mem.content?.slice(0, 100) || '';
    if (!text) return null;
    try {
        return await callEmbeddingApi(text, 8000);
    } catch (e) {
        console.warn('[BB-Memory] 向量化失败，将跳过此条:', e.message);
        return null;
    }
}

// ═══ v4.1.0: 短码 JSON 映射 ═══

const SHORT_CODE_MAP = {
    t: 'cognitiveType',     p: 'categoryPath',
    n: 'title',             c: 'content',
    m: 'summary',           v: 'verbatim',
    g: 'tags',              s: 'subject',
    a: 'target',            i: 'importance',
    e: 'emotionalWeight',   nt: 'npcTier',
    it: 'itemTier',         sa: 'standaloneArchive',
    ic: 'indexCard',        ri: 'relatedMemoryIds',
    st: 'storyTime',        ss: 'storyTimeSort',
};

const REVERSE_SHORT_CODE_MAP = Object.fromEntries(
    Object.entries(SHORT_CODE_MAP).map(([k, v]) => [v, k])
);

/**
 * v4.1.0: 将短码 JSON 还原为完整字段名，兼容混合格式
 */
function expandShortCodes(item) {
    if (!item || typeof item !== 'object') return item;
    // 如果已经是全名格式（有 cognitiveType 或 title），直接返回
    if ('cognitiveType' in item || 'title' in item) return item;
    const expanded = {};
    for (const [key, value] of Object.entries(item)) {
        const fullKey = SHORT_CODE_MAP[key] || key;
        expanded[fullKey] = value;
    }
    return expanded;
}

/**
 * 解析 AI 返回的 JSON 文本为记忆条目数组
 */
export function parseAiResponse(responseText) {
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
            .filter(item => item && (item.content || item.c) && typeof (item.content || item.c) === 'string')
            .map(item => {
                // v4.1.0: 短码 → 全名映射
                const m = expandShortCodes(item);
                return {
                    cognitiveType: VALID_COG_TYPES.includes(m.cognitiveType)
                        ? m.cognitiveType
                        : 'episode',
                    categoryPath: m.categoryPath || '',
                    title: typeof m.title === 'string' ? m.title.trim() : '',
                    content: (typeof m.content === 'string' ? m.content : '').trim(),
                    summary: typeof m.summary === 'string' ? m.summary.trim() : '',
                    verbatim: typeof m.verbatim === 'string' ? m.verbatim.trim() : '',
                    tags: Array.isArray(m.tags)
                        ? m.tags.map(t => ({ name: String(t), weight: 0.6 }))
                        : [],
                    importance: typeof m.importance === 'number'
                        ? Math.max(0, Math.min(1, m.importance))
                        : 0.5,
                    emotionalWeight: typeof m.emotionalWeight === 'number'
                        ? Math.max(0, Math.min(1, m.emotionalWeight))
                        : 0.0,
                    subject: typeof m.subject === 'string' ? m.subject.trim() : '',
                    target: typeof m.target === 'string' ? m.target.trim() : '',
                    npcTier: normalizeNpcTier(m.npcTier),
                    itemTier: normalizeItemTier(m.itemTier),
                    standaloneArchive: typeof m.standaloneArchive === 'boolean'
                        ? m.standaloneArchive
                        : undefined,
                    indexCard: typeof m.indexCard === 'string' ? m.indexCard.trim() : '',
                    relatedMemoryIds: Array.isArray(m.relatedMemoryIds)
                        ? m.relatedMemoryIds.map(String).filter(Boolean)
                        : [],
                    storyTime: typeof m.storyTime === 'string' ? m.storyTime.trim() : '',
                    storyTimeSort: typeof m.storyTimeSort === 'number' ? m.storyTimeSort : null,
                    // v4.2.0: 启发式回退占位
                    _fallbackNpc: null,
                    _fallbackItem: null,
                };
            })
            // v4.2.0: 应用启发式回退
            .map(entry => {
                if (!entry.npcTier && entry.subject && !(entry.categoryPath || '').startsWith('item.')) {
                    entry.npcTier = 'minor';
                    if (getSettings().debugLogging) console.log('[BB-Memory] 启发式回退 NPC:', entry.subject, '→ minor');
                }
                if (!entry.itemTier && entry.subject && (entry.categoryPath || '').startsWith('item.')) {
                    entry.itemTier = 'consumable';
                    if (getSettings().debugLogging) console.log('[BB-Memory] 启发式回退 Item:', entry.subject, '→ consumable');
                }
                return {
                    cognitiveType: entry.cognitiveType,
                    categoryPath: entry.categoryPath,
                    title: entry.title,
                    content: entry.content,
                    summary: entry.summary,
                    verbatim: entry.verbatim,
                    tags: entry.tags,
                    importance: entry.importance,
                    emotionalWeight: entry.emotionalWeight,
                    subject: entry.subject,
                    target: entry.target,
                    npcTier: entry.npcTier,
                    itemTier: entry.itemTier,
                    standaloneArchive: entry.standaloneArchive,
                    indexCard: entry.indexCard,
                    relatedMemoryIds: entry.relatedMemoryIds,
                    storyTime: entry.storyTime,
                    storyTimeSort: entry.storyTimeSort,
                };
            });
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

    // v4.2.0: 每轮提取上限
    const maxPerExchange = settings.maxMemoriesPerExchange ?? 3;
    const memories = parseAiResponse(responseText).slice(0, maxPerExchange);
    let addedCount = 0;
    let mergedCount = 0;

    // v4.1.0: 加载现有活跃记忆用于语义去重
    const existingMemories = (await getMemories(chatId)).filter(
        m => m.status === 'active' && m.embedding
    );

    for (const mem of memories) {
        if (mem.standaloneArchive === undefined) {
            mem.standaloneArchive = inferStandaloneArchive(mem);
        }
        applyStandaloneArchivePolicy(mem);

        const embedding = await embedMemoryEntry(mem);

        // v4.1.0: 语义去重检查
        const match = findMostSimilarMemory(embedding, existingMemories);
        if (match && match.similarity >= getDedupConfig().mergeThreshold) {
            // 合并：更新旧记忆，不新建
            const updates = mergeMemoryFields(match.memory, mem);
            await updateMemory(chatId, match.memory.id, updates);
            mergedCount++;
            if (settings.debugLogging) {
                console.log(`[BB-Memory] 语义合并: "${mem.title}" → "${match.memory.title}" (sim=${match.similarity.toFixed(2)})`);
            }
            continue;
        }

        // 中等相似度：降低重要性
        let adjustedImportance = mem.importance;
        if (match && match.similarity >= getDedupConfig().reduceThreshold) {
            adjustedImportance = Math.max(0.3, mem.importance - 0.15);
        }

        await addMemory(chatId, mem.content, mem.cognitiveType || 'episode', 'auto', {
            categoryPath: mem.categoryPath,
            title: mem.title,
            summary: mem.summary,
            verbatim: mem.verbatim,
            tags: mem.tags,
            importance: adjustedImportance,
            emotionalWeight: mem.emotionalWeight,
            subject: mem.subject,
            target: mem.target,
            npcTier: mem.npcTier || undefined,
            itemTier: mem.itemTier || undefined,
            standaloneArchive: mem.standaloneArchive,
            indexCard: mem.indexCard || undefined,
            relatedMemoryIds: mem.relatedMemoryIds?.length ? mem.relatedMemoryIds : undefined,
            embedding,
            storyTime: mem.storyTime || '',
            storyTimeSort: mem.storyTimeSort ?? null,
        });
        addedCount++;
        // 新记忆的 embedding 加入比较池（防止同一轮内重复提取）
        existingMemories.push({ embedding, status: 'active' });
    }

    if (addedCount > 0 || mergedCount > 0) {
        const parts = [];
        if (addedCount > 0) parts.push(`新增 ${addedCount} 条`);
        if (mergedCount > 0) parts.push(`合并 ${mergedCount} 条`);
        console.log(`[BB-Memory] 从 exchange 提取: ${parts.join('，')}`);
    }

    return addedCount;
}

/**
 * v2.9.8: 从一个 exchange 中提取记忆（仅调用 AI 并解析，不保存到数据库）
 * 用于 active 确认模式——提取结果先作为候选，等待用户审核
 * @returns {Promise<Array>} 解析后的候选记忆数组
 */
async function extractFromExchangeRaw(chatId, userMessage, aiMessage) {
    const settings = getSettings();
    const prompt = buildPrompt(userMessage, aiMessage);

    let responseText;
    if (settings.autoGenMode === 'custom' && settings.autoGenEndpoint) {
        responseText = await callCustomApi(prompt);
    } else {
        responseText = await callMainApi(prompt);
    }

    const memories = parseAiResponse(responseText);
    // 为候选记忆补充默认字段并生成 embedding
    for (const mem of memories) {
        if (mem.standaloneArchive === undefined) {
            mem.standaloneArchive = inferStandaloneArchive(mem);
        }
        mem._embedding = await embedMemoryEntry(mem);
    }
    return memories;
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
 * 从聊天中获取最近的 exchange（用户消息 + AI 回复）
 * PRIMARY 路径 —— 不依赖消息是否被隐藏，直接抓取最新对话
 */
function getLatestExchange() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    if (!chat || chat.length < 2) return null;

    let aiIndex = -1;
    let userIndex = -1;

    for (let i = chat.length - 1; i >= 0; i--) {
        if (aiIndex === -1 && !chat[i].is_user && !chat[i].is_system) {
            aiIndex = i;
        } else if (aiIndex !== -1 && chat[i].is_user) {
            userIndex = i;
            break;
        }
    }

    if (aiIndex === -1 || userIndex === -1) return null;

    const userMessage = chat[userIndex].mes || '';
    const aiMessage = chat[aiIndex].mes || '';
    const hash = computeExchangeHash(userMessage, aiMessage);

    return { userMessage, aiMessage, hash, userIndex, aiIndex };
}

/**
 * MESSAGE_RECEIVED 事件处理函数
 * 当 AI 生成新回复时触发
 *
 * 双路径设计：
 *   PRIMARY：直接提取最新的 exchange（不等待消息被隐藏）
 *   SECONDARY：提取已被插件隐藏的旧 exchange（兜底，确保不漏）
 */
// ═══ 进度回调 ═══

let onAutoExtractProgress = null;

/**
 * 设置自动提取的进度回调（由 index.js 调用）
 * @param {function|null} cb - (phase: string, current: number, total: number) => void
 */
export function setAutoExtractProgressCallback(cb) {
    onAutoExtractProgress = cb;
}

function reportProgress(phase, current, total) {
    if (typeof onAutoExtractProgress === 'function') {
        onAutoExtractProgress(phase, current, total);
    }
}

/**
 * v2.9.8: MESSAGE_RECEIVED 事件处理函数（滑动窗口策略）
 *
 * 当 AI 生成新回复时触发。新逻辑：
 *   1. 收集所有可见 exchange（非隐藏、非元标记、非系统消息）
 *   2. 若可见 exchange 数 > contextWindowExchanges，取最旧的提取
 *   3. 提取后隐藏该 exchange，保留最近 N 个可见
 *   4. 根据 extractionConfirmMode 决定是否弹审核窗
 */
function onMessageReceived(_messageIndex) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoGenEnabled) return;

    const chatId = getChatId();
    if (!chatId) return;

    // 首次加载时的积压检查使用较短防抖
    const debounceMs = (_messageIndex === -1) ? 500 : 2500;

    if (processingTimer) clearTimeout(processingTimer);
    processingTimer = setTimeout(async () => {
        try {
            const debug = settings.debugLogging;
            const windowSize = settings.contextWindowExchanges ?? 5;
            const confirmMode = settings.extractionConfirmMode || 'semi';

            const ctx = SillyTavern.getContext();
            const chat = ctx.chat;
            if (!chat || chat.length < 2) return;

            // ═══ 收集所有可见 exchange ═══
            const visibleExchanges = [];
            for (let i = 1; i < chat.length; i++) {
                const aiMsg = chat[i];
                if (aiMsg.is_user || aiMsg.is_system) continue;
                if (aiMsg.is_hidden) continue;
                if (aiMsg._bbmem_extracted) continue;
                if (aiMsg._bbmem_meta_marker) continue;

                // 向前找最近的可见用户消息
                let userIdx = -1;
                for (let j = i - 1; j >= 0; j--) {
                    if (chat[j].is_user && !chat[j].is_hidden && !chat[j]._bbmem_meta_marker) {
                        userIdx = j;
                        break;
                    }
                }
                if (userIdx === -1) continue;

                const userMsg = chat[userIdx];
                const hash = computeExchangeHash(
                    (userMsg.mes || '').trim(),
                    (aiMsg.mes || '').trim(),
                );

                visibleExchanges.push({
                    userMessage: userMsg.mes || '',
                    aiMessage: aiMsg.mes || '',
                    userIndex: userIdx,
                    aiIndex: i,
                    hash,
                });
            }

            console.log(`[BB-Memory] 滑动窗口检查: ${visibleExchanges.length} 可见 / 窗口${windowSize}`);
            if (debug) {
                console.log(`[BB-Memory] 自动提取状态:`, {
                    chatId,
                    visibleExchanges: visibleExchanges.length,
                    windowSize,
                    confirmMode,
                    willExtract: visibleExchanges.length >= windowSize,
                });
            }

            // ═══ 若可见 exchange 达到窗口大小，提取最旧的 ═══
            if (visibleExchanges.length >= windowSize) {
                const oldest = visibleExchanges[0];
                const alreadyDone = await isExchangeProcessed(chatId, oldest.hash);

                if (!alreadyDone) {
                    // v4.3.0: semi/auto 模式先隐藏再提取，避免竞态条件导致 AI 上下文泄漏
                    if (confirmMode !== 'active') {
                        hideExchange(oldest.userIndex, oldest.aiIndex);
                        if (debug) console.log('[BB-Memory] 滑动窗口：已预先隐藏最旧 exchange（提取前）');
                    }

                    reportProgress('正在提取记忆', 0, 1);

                    if (confirmMode === 'active') {
                        // 主动模式：提取但不保存，排队等待审核
                        if (debug) console.log('[BB-Memory] 主动模式：提取最旧 exchange 并排队等待审核');
                        const candidates = await extractFromExchangeRaw(
                            chatId, oldest.userMessage, oldest.aiMessage,
                        );
                        if (candidates.length > 0) {
                            pendingAutoCandidates.push(...candidates);
                        }
                        reportProgress('正在提取记忆', 1, 1);
                    } else {
                        // semi 或 auto 模式：直接保存
                        if (debug) console.log(`[BB-Memory] ${confirmMode} 模式：提取并直接保存最旧 exchange`);
                        const count = await extractFromExchange(
                            chatId, oldest.userMessage, oldest.aiMessage,
                        );
                        reportProgress('正在提取记忆', 1, 1);
                        if (count > 0 && typeof toastr !== 'undefined') {
                            toastr.info(
                                `自动记录了 ${count} 条新记忆`,
                                'BB-Memory',
                                { timeOut: 3000, preventDuplicates: true },
                            );
                        }
                    }

                    await markExchangeExtracted(oldest.aiIndex, oldest.hash);

                    // active 模式：提取并审核后才隐藏
                    if (confirmMode === 'active') {
                        hideExchange(oldest.userIndex, oldest.aiIndex);
                    }
                }

                if (debug) console.log('[BB-Memory] 滑动窗口：已隐藏最旧 exchange');
            }

            // ═══ active 模式通知 ═══
            if (confirmMode === 'active' && pendingAutoCandidates.length > 0) {
                const confirmStyle = settings.activeConfirmStyle || 'popup';
                if (confirmStyle === 'toast') {
                    if (typeof toastr !== 'undefined') {
                        toastr.info(
                            `自动提取到 ${pendingAutoCandidates.length} 条候选记忆，请打开管理面板审核`,
                            'BB-Memory',
                            { timeOut: 5000 },
                        );
                    }
                }
                // popup 模式由 index.js 的进度回调触发
            }

            if (visibleExchanges.length >= windowSize) {
                reportProgress('done', 1, 1);
            } else {
                reportProgress('idle', 0, 0);
            }
        } catch (error) {
            console.error('[BB-Memory] 滑动窗口处理出错:', error);
            const dbgSettings = getSettings();
            if (dbgSettings.debugLogging) {
                console.error('[BB-Memory] 错误详情:', {
                    message: error.message,
                    stack: error.stack,
                    chatId: getChatId(),
                });
            }
            if (typeof toastr !== 'undefined') {
                toastr.warning(
                    `自动提取记忆失败: ${error.message || '请检查 API 配置'}`,
                    'BB-Memory',
                    { timeOut: 5000 },
                );
            }
        }
    }, debounceMs);
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

// ═══ 上下文提取（手动触发的批量提取）═══

const CONTEXT_EXTRACTION_PROMPT = `你是一个记忆提取助手。请阅读以下对话片段，提取所有值得长期记忆的关键信息。

规则：
1. 提取所有重要的信息——不要只挑一条，尽可能全面
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
world.politics | world.lore | world.rules | npc.profile | npc.relationship | npc.emotion | npc.secret | npc.goal | npc.attitude |
item.ownership | item.quest | item.key | item.clue | location.state | location.map |
episode.event | episode.promise | episode.secret | episode.dialogue | episode.combat |
emotion.bond | emotion.trauma | emotion.desire |
habit.routine | habit.preference | habit.speech

NPC 分级 npcTier（**每条记忆必须填写**，有角色时必须标注；无角色留空 ""）：core / important / minor / background
物品分级 itemTier（**涉及重要物品时必须填写**，无物品留空 ""）：key / equipped / clue / consumable / background

以纯JSON数组格式返回（不要包含markdown代码块标记），使用短码字段名减少 token。
短码：t=cognitiveType p=categoryPath n=title c=content m=summary v=verbatim g=tags s=subject a=target i=importance e=emotionalWeight nt=npcTier it=itemTier sa=standaloneArchive ic=indexCard ri=relatedMemoryIds st=storyTime ss=storyTimeSort
以下是要分析的对话：
{{conversation}}`;

/**
 * 从上下文中提取记忆
 *
 * v3.0.0: 支持逐层提取（single）和批量提取（batch）双模式
 * - single: 每个 exchange 独立调 AI、直接保存、标记隐藏
 * - batch:  所有 exchange 打包一次提取（原有逻辑），返回候选供审核
 *
 * @param {string} chatId
 * @param {number} messageCount - 获取最近多少条消息
 * @param {number} [startFloor] - 起始楼层
 * @returns {Promise<{ memories: Array, skippedCount: number, processedExchanges?: Array, _directSaved?: number }>}
 */
export async function extractFromContext(chatId, messageCount = 12, startFloor = undefined) {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    if (!chat || chat.length < 2) return { memories: [], skippedCount: 0 };

    const settings = getSettings();
    const batchMode = settings.extractionBatchMode || 'single';
    const recentMessages = startFloor !== undefined
        ? chat.slice(startFloor, Math.min(startFloor + messageCount, chat.length))
        : chat.slice(-Math.min(messageCount, chat.length));

    // 按 exchange 配对并去重
    const pairs = [];
    let skippedCount = 0;
    for (let i = 0; i < recentMessages.length; i++) {
        const msg = recentMessages[i];
        if (msg.is_system || msg.is_user) continue;
        const aiIndex = chat.indexOf(msg);
        if (aiIndex < 1) continue;
        let userIndex = aiIndex - 1;
        while (userIndex >= 0 && (chat[userIndex].is_system || !chat[userIndex].is_user)) {
            userIndex--;
        }
        if (userIndex < 0) continue;
        const userMsg = chat[userIndex];
        const aiMsg = msg;

        if (aiMsg._bbmem_extracted) { skippedCount++; continue; }
        if (aiMsg._bbmem_meta_marker) { skippedCount++; continue; }
        const hash = computeExchangeHash(
            (userMsg.mes || '').trim(),
            (aiMsg.mes || '').trim(),
        );
        if (await isExchangeProcessed(chatId, hash)) {
            aiMsg._bbmem_extracted = true;
            skippedCount++;
            continue;
        }

        pairs.push({ userMsg, aiMsg, userIndex, aiIndex, hash });
    }

    if (pairs.length === 0) {
        return { memories: [], skippedCount };
    }

    // v3.0.0: 逐层提取模式 — 每层独立调用 AI、直接保存、标记隐藏
    if (batchMode === 'single') {
        let totalAdded = 0;
        for (let p = 0; p < pairs.length; p++) {
            const pair = pairs[p];
            reportProgress('逐层提取', p, pairs.length);
            try {
                const added = await extractFromExchange(
                    chatId,
                    pair.userMsg.mes || '',
                    pair.aiMsg.mes || '',
                );
                totalAdded += added;
                await markExchangeExtracted(pair.aiIndex, pair.hash);
                hideExchange(pair.userIndex, pair.aiIndex);
            } catch (err) {
                console.warn('[BB-Memory] 逐层提取失败，楼层:', pair.aiIndex, err);
            }
        }
        reportProgress('done', pairs.length, pairs.length);
        if (settings.debugLogging) {
            console.log(`[BB-Memory] 逐层提取完成：${pairs.length} 层，新增 ${totalAdded} 条记忆，跳过 ${skippedCount} 个`);
        }
        return { memories: [], skippedCount, _directSaved: totalAdded, processedExchanges: [] };
    }

    // ── 批量提取模式（原有逻辑）──
    const processedExchanges = pairs.map(p => ({
        userIndex: p.userIndex, aiIndex: p.aiIndex, hash: p.hash,
    }));

    // 构建对话文本（仅未提取的 exchange）
    const lines = [];
    for (const { userMsg, aiMsg } of pairs) {
        const userText = (userMsg.mes || '').trim();
        const aiText = (aiMsg.mes || '').trim();
        if (!userText && !aiText) continue;
        if (userText) lines.push(`用户: ${userText}`);
        if (aiText) lines.push(`角色: ${aiText}`);
    }

    if (lines.length < 2) {
        return { memories: [], skippedCount };
    }

    const conversationText = lines.join('\n');
    const contextTemplate = settings.autoGenContextPrompt || CONTEXT_EXTRACTION_PROMPT;
    const instructions = buildSummaryInstructions();
    const prompt = (contextTemplate + instructions).replace('{{conversation}}', conversationText);

    if (settings.debugLogging) {
        console.log(`[BB-Memory] 批量提取：分析 ${pairs.length} 个交换（${lines.length} 条消息），跳过 ${skippedCount} 个已提取`);
    }

    let responseText;
    if (settings.autoGenMode === 'custom' && settings.autoGenEndpoint) {
        responseText = await callCustomApi(prompt);
    } else {
        responseText = await callMainApi(prompt);
    }

    const memories = parseAiResponse(responseText);
    return { memories, skippedCount, processedExchanges };
}

/**
 * 保存用户审核通过的候选记忆
 * @param {string} chatId
 * @param {Array} candidateMemories - 包含用户编辑字段的候选记忆
 * @returns {Promise<number>} 实际保存的记忆条数
 */
export async function saveExtractedMemories(chatId, candidateMemories, onProgress) {
    let count = 0;
    let mergedCount = 0;
    const selected = candidateMemories.filter(m => m._selected);
    const total = selected.length;

    // v4.1.0: 加载现有活跃记忆用于语义去重
    const existingMemories = (await getMemories(chatId)).filter(
        m => m.status === 'active' && m.embedding
    );

    for (const mem of candidateMemories) {
        if (!mem._selected) continue;

        if (mem.standaloneArchive === undefined) {
            mem.standaloneArchive = inferStandaloneArchive(mem);
        }
        applyStandaloneArchivePolicy(mem);

        const embedding = mem._embedding ?? null;

        // v4.1.0: 语义去重检查
        const match = findMostSimilarMemory(embedding, existingMemories);
        if (match && match.similarity >= getDedupConfig().mergeThreshold) {
            const updates = mergeMemoryFields(match.memory, mem);
            await updateMemory(chatId, match.memory.id, updates);
            mergedCount++;
            count++;
            if (typeof onProgress === 'function') onProgress(count, total);
            continue;
        }

        let adjustedImportance = mem.importance;
        if (match && match.similarity >= getDedupConfig().reduceThreshold) {
            adjustedImportance = Math.max(0.3, mem.importance - 0.15);
        }

        await addMemory(chatId, mem.content, mem.cognitiveType || 'episode', 'auto', {
            categoryPath: mem.categoryPath,
            title: mem.title,
            summary: mem.summary,
            verbatim: mem.verbatim,
            tags: mem.tags,
            importance: adjustedImportance,
            emotionalWeight: mem.emotionalWeight,
            subject: mem.subject,
            target: mem.target,
            npcTier: mem.npcTier || undefined,
            itemTier: mem.itemTier || undefined,
            standaloneArchive: mem.standaloneArchive,
            indexCard: mem.indexCard || undefined,
            relatedMemoryIds: mem.relatedMemoryIds?.length ? mem.relatedMemoryIds : undefined,
            embedding,
            storyTime: mem.storyTime || '',
            storyTimeSort: mem.storyTimeSort ?? null,
        });
        count++;
        existingMemories.push({ embedding, status: 'active' });

        if (typeof onProgress === 'function') {
            onProgress(count, total);
        }
    }
    if (mergedCount > 0) {
        console.log(`[BB-Memory] 审核保存: 新增 ${count - mergedCount} 条，合并 ${mergedCount} 条`);
    }
    return count;
}

/**
 * v4.0.0: 批量为已有记忆生成 embedding（用于重新索引）
 * @param {Array} memories - 需要处理的记忆数组（会原地修改）
 * @param {Function} onProgress - (current, total) => void
 * @returns {Promise<number>} 成功向量化的条数
 */
export async function embedExistingMemories(memories, onProgress) {
    let count = 0;
    const total = memories.length;
    for (let i = 0; i < memories.length; i++) {
        const mem = memories[i];
        if (mem.embedding && mem.embedding !== null) continue;
        if (mem.status === 'archived' || mem.status === 'deleted') continue;

        const embedding = await embedMemoryEntry(mem);
        if (embedding) {
            mem.embedding = embedding;
            count++;
        }

        if (typeof onProgress === 'function') {
            onProgress(i + 1, total);
        }
    }
    return count;
}

// ═══ 初始化与清理 ═══

let eventBound = false;

/**
 * 初始化自动生成模块
 * 注册 MESSAGE_RECEIVED 事件监听
 */
export function initAutoGenerator() {
    if (eventBound) return;

    try {
        const ctx = SillyTavern.getContext();
        if (!ctx || !ctx.eventSource) {
            console.error('[BB-Memory] 无法获取 SillyTavern 上下文，自动生成模块初始化失败');
            if (typeof toastr !== 'undefined') {
                toastr.warning('BB-Memory 自动提取初始化失败：无法获取上下文', 'BB-Memory');
            }
            return;
        }
        const ev = ctx.event_types ?? ctx.eventTypes;
        if (!ev || !ev.MESSAGE_RECEIVED) {
            console.error('[BB-Memory] 无法获取事件类型，自动生成模块初始化失败');
            return;
        }
        ctx.eventSource.on(ev.MESSAGE_RECEIVED, onMessageReceived);
        eventBound = true;

        console.log('[BB-Memory] AI 自动生成模块已初始化');

        const settings = getSettings();
        if (settings.debugLogging) {
            console.log('[BB-Memory] 自动提取配置:', {
                contextWindowExchanges: settings.contextWindowExchanges ?? 5,
                extractionConfirmMode: settings.extractionConfirmMode || 'semi',
                autoGenEnabled: settings.autoGenEnabled,
            });
        }

        // 首次启用时触发积压检查
        onMessageReceived(-1);
    } catch (err) {
        console.error('[BB-Memory] 自动生成模块初始化失败:', err);
        if (typeof toastr !== 'undefined') {
            toastr.warning('BB-Memory 自动提取初始化失败，请检查设置', 'BB-Memory');
        }
    }
}

/**
 * 停止自动生成（用于禁用时）
 */
export function stopAutoGenerator() {
    if (!eventBound) return;

    try {
        const ctx = SillyTavern.getContext();
        const ev = ctx.event_types ?? ctx.eventTypes;
        ctx.eventSource.removeListener(ev.MESSAGE_RECEIVED, onMessageReceived);
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
