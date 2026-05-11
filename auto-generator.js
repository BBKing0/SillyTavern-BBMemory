/**
 * auto-generator.js —— BB-Memory v5.0 自动提取系统
 *
 * 四柱架构：每轮对话分四个阶段独立提取 NPC/物品/时间线/记忆。
 * 每个阶段有聚焦的短 Prompt 和专用解析器。
 */

import {
    getSettings, getMemories, addMemory, updateMemory,
    upsertNpcProfile, upsertItem, upsertTimelineEntry,
    getNpcProfiles, getItems, getTimeline,
} from './memory-store.js';
import {
    getExtractableExchanges, markExchangeExtracted, isExchangeProcessed,
    computeExchangeHash, hideExchange, refreshExtractionMarkers,
} from './message-state.js';
import { normalizeNpcTier, normalizeItemTier } from './entity-tiers.js';

// ═══ 语义去重（保留 v4.1.0 逻辑） ═══

function getDedupConfig() {
    const s = getSettings();
    return {
        mergeThreshold: s.mergeSimilarityThreshold ?? 0.85,
        reduceThreshold: s.reduceSimilarityThreshold ?? 0.60,
        minSimilarity: 0.50,
    };
}

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

function findMostSimilarMemory(newEmbedding, existingMemories) {
    if (!newEmbedding) return null;
    let best = null;
    for (const mem of existingMemories) {
        if (!mem.embedding) continue;
        const sim = cosineSimilarity(newEmbedding, mem.embedding);
        if (sim >= getDedupConfig().minSimilarity && (!best || sim > best.similarity)) {
            best = { memory: mem, similarity: sim };
        }
    }
    return best;
}

function mergeMemoryFields(existing, incoming) {
    return {
        content: existing.content + '\n[更新] ' + incoming.content,
        summary: incoming.summary || existing.summary,
        verbatim: incoming.verbatim || existing.verbatim,
        importance: Math.min(1.0, Math.max(existing.importance || 0.5, incoming.importance || 0.5) + 0.05),
        emotionalWeight: Math.max(existing.emotionalWeight || 0, incoming.emotionalWeight || 0),
        updatedAt: Date.now(),
    };
}

// ═══ 四个提取提示词 ═══

const NPC_EXTRACTION_PROMPT = `你是一个角色档案提取助手。从对话中提取 NPC 信息。

规则：
1. 只提取有名字或明确身份的角色，不要从AI回复中推断用户信息
2. 一次性出场的路人用 nt=background；有剧情潜力的用 nt=minor；重要配角用 nt=important；核心角色用 nt=core
3. 如果没有值得记录的角色，返回空数组 []

返回纯JSON数组（不要markdown代码块）：
n=角色名 | r=身份/职业 | p=性格特征 | a=外貌描述 | s=当前状态 | l=当前位置
rt=关系数组 [{"n":"名称","r":"关系类型(朋友/敌人/恋人/师徒/交易伙伴等)","a":"态度(友好/敌对/中立/暧昧等)"}]
nt=分级(core/important/minor/background) | ic=一行索引卡 | g=标签数组

示例：[{"n":"雅赫摩斯","r":"北境领主","p":"冷酷果决，野心勃勃","a":"高瘦黑发中年男子，眼神锐利","s":"北境王座厅","l":"北境","rt":[{"n":"玩家","r":"敌人","a":"敌对"}],"nt":"core","ic":"北境领主，已向玩家宣战","g":["北境","领主"]}]

[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

const ITEM_EXTRACTION_PROMPT = `你是一个物品追踪助手。从对话中提取值得记住的物品信息。

规则：
1. 只提取有意义的物品（剧情相关、有特殊价值、有纪念意义）
2. 已使用的普通消耗品（药水、食物）kp=false；有情感/纪念价值的即使已使用也 kp=true
3. 消耗品用 it=consumable；关键剧情物用 it=key；线索物用 it=clue；装备用 it=equipped；背景道具用 it=background
4. 如果没有值得记录的物品，返回空数组 []

返回纯JSON数组（不要markdown代码块）：
n=物品名 | o=持有者 | s=状态(held=持有中/used=已使用/lost=已失去/destroyed=已销毁)
sig=意义描述 | kp=true(永久保留)/false(可清理) | it=分级(key/equipped/clue/consumable/background)
g=标签数组

示例：[{"n":"辉月之剑","o":"玩家","s":"held","sig":"传说中的圣剑，曾属古代英雄阿尔托","kp":true,"it":"key","g":["圣剑","古代遗物"]},{"n":"治疗药水","o":"玩家","s":"used","sig":"普通治疗药水","kp":false,"it":"consumable","g":["药水"]}]

[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

const TIMELINE_EXTRACTION_PROMPT = `你是一个故事时间线助手。从对话中检测值得记录的故事节点。

规则：
1. 只在以下情况新增/更新时间线：地点变化、关系质变、重大决策、战斗、新角色入场、章节转换
2. 日常寒暄、闲谈、重复行为不记录
3. 如果当前内容是一条已有事件的延续，设置 active=true（AI会更新而非新建）
4. 如果没有值得记录的故事节点，返回空数组 []
5. 对于回忆/过去的事，active=false

返回纯JSON数组（不要markdown代码块）：
t=故事时间(如"123年4月"或"第3天傍晚"或"") | e=事件摘要(简短) | p=参与者数组 | l=地点
active=true(进行中可后续更新)/false(已结束) | imp=影响描述 | g=标签数组

示例：[{"t":"123年4月15日","e":"北境会议宣战","p":["雅赫摩斯","玩家"],"l":"北境王座厅","active":true,"imp":"雅赫摩斯正式向北境诸邦宣战，玩家卷入战争","g":["北境战争","宣战"]}]

[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

const MEMORY_EXTRACTION_PROMPT = `你是一个记忆提取助手。从对话中提取值得长期记忆的关键信息。

规则：
1. 只提取重要的、值得记住的信息，不要记录日常寒暄
2. 每条记忆应有简短标题和清晰内容
3. 如果对话中有重要原话（承诺、告白、威胁等），保留在 v 字段
4. 类型选择：event(事件), emotion(情感), habit(习惯), fact(事实)
5. 如果没有值得记忆的内容，返回空数组 []

返回纯JSON数组（不要markdown代码块）：
n=标题(3-8字) | tp=类型(event/emotion/habit/fact) | m=一句话摘要(10-20字) | c=完整内容
v=重要原话(无则"") | s=主体名 | a=目标名 | i=重要性(0-1) | e=情感强度(0-1)
st=故事时间(无则"") | g=标签数组(前3个结构标签+后7个自由标签)

示例：[{"n":"北境宣战","tp":"event","m":"雅赫摩斯向北境诸邦正式宣战","c":"在今日的北境会议上，雅赫摩斯宣布向北境诸邦宣战，玩家作为目击者在场","v":"从今日起，北境诸邦即为吾敌","s":"雅赫摩斯","a":"北境诸邦","i":0.8,"e":0.6,"st":"123年4月15日","g":["北境战争","雅赫摩斯","宣战"]}]

[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

// ═══ 四个解析器 ═══

function cleanJsonText(text) {
    if (!text || !text.trim()) return '';
    let t = text.trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const arrayMatch = t.match(/\[[\s\S]*\]/);
    return arrayMatch ? arrayMatch[0] : t;
}

/**
 * 解析 NPC 提取响应
 */
function parseNpcResponse(responseText) {
    const text = cleanJsonText(responseText);
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : (parsed && parsed.n ? [parsed] : []);
        return arr
            .filter(item => item && item.n && typeof item.n === 'string')
            .map(item => ({
                name: (item.n || '').trim(),
                role: typeof item.r === 'string' ? item.r.trim() : '',
                personality: typeof item.p === 'string' ? item.p.trim() : '',
                appearance: typeof item.a === 'string' ? item.a.trim() : '',
                status: typeof item.s === 'string' ? item.s.trim() : '',
                location: typeof item.l === 'string' ? item.l.trim() : '',
                relationships: Array.isArray(item.rt) ? item.rt.map(r => ({
                    name: (r.n || '').trim(),
                    type: (r.r || '').trim(),
                    attitude: (r.a || '').trim(),
                })) : [],
                npcTier: normalizeNpcTier(item.nt) || 'minor',
                indexCard: typeof item.ic === 'string' ? item.ic.trim() : '',
                tags: Array.isArray(item.g)
                    ? item.g.map(t => ({ name: String(t), weight: 0.6 }))
                    : [],
                source: 'auto',
            }));
    } catch (e) {
        if (getSettings().debugLogging) console.warn('[BB-Memory] NPC响应解析失败:', e.message);
        return [];
    }
}

/**
 * 解析物品提取响应
 */
function parseItemResponse(responseText) {
    const text = cleanJsonText(responseText);
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : (parsed && parsed.n ? [parsed] : []);
        return arr
            .filter(item => item && item.n && typeof item.n === 'string')
            .map(item => ({
                name: (item.n || '').trim(),
                owner: typeof item.o === 'string' ? item.o.trim() : '',
                status: ['held', 'used', 'lost', 'destroyed'].includes(item.s) ? item.s : 'held',
                significance: typeof item.sig === 'string' ? item.sig.trim() : '',
                keepPermanent: item.kp === true,
                itemTier: normalizeItemTier(item.it) || 'consumable',
                tags: Array.isArray(item.g)
                    ? item.g.map(t => ({ name: String(t), weight: 0.6 }))
                    : [],
                source: 'auto',
            }));
    } catch (e) {
        if (getSettings().debugLogging) console.warn('[BB-Memory] 物品响应解析失败:', e.message);
        return [];
    }
}

/**
 * 解析时间线提取响应
 */
function parseTimelineResponse(responseText) {
    const text = cleanJsonText(responseText);
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : (parsed && parsed.e ? [parsed] : []);
        return arr
            .filter(item => item && item.e && typeof item.e === 'string')
            .map(item => ({
                storyTime: typeof item.t === 'string' ? item.t.trim() : '',
                event: (item.e || '').trim(),
                summary: typeof item.e === 'string' ? item.e.trim() : '',
                participants: Array.isArray(item.p) ? item.p.map(String) : [],
                location: typeof item.l === 'string' ? item.l.trim() : '',
                isActive: item.active === true || item.active === undefined,
                status: item.active === false ? 'ended' : 'ongoing',
                impact: typeof item.imp === 'string' ? item.imp.trim() : '',
                tags: Array.isArray(item.g)
                    ? item.g.map(t => ({ name: String(t), weight: 0.6 }))
                    : [],
                source: 'auto',
            }));
    } catch (e) {
        if (getSettings().debugLogging) console.warn('[BB-Memory] 时间线响应解析失败:', e.message);
        return [];
    }
}

/**
 * 解析记忆提取响应
 */
function parseMemoryResponse(responseText) {
    const text = cleanJsonText(responseText);
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : (parsed && parsed.n ? [parsed] : []);
        const VALID_TYPES = ['event', 'emotion', 'habit', 'fact'];
        return arr
            .filter(item => item && (item.c || item.m) && typeof (item.c || item.m) === 'string')
            .map(item => ({
                title: typeof item.n === 'string' ? item.n.trim() : '',
                type: VALID_TYPES.includes(item.tp) ? item.tp : 'event',
                summary: typeof item.m === 'string' ? item.m.trim() : '',
                content: (typeof item.c === 'string' ? item.c : (typeof item.m === 'string' ? item.m : '')).trim(),
                verbatim: typeof item.v === 'string' ? item.v.trim() : '',
                subject: typeof item.s === 'string' ? item.s.trim() : '',
                target: typeof item.a === 'string' ? item.a.trim() : '',
                importance: typeof item.i === 'number' ? Math.max(0, Math.min(1, item.i)) : 0.5,
                emotionalWeight: typeof item.e === 'number' ? Math.max(0, Math.min(1, item.e)) : 0.0,
                storyTime: typeof item.st === 'string' ? item.st.trim() : '',
                tags: Array.isArray(item.g)
                    ? item.g.map(t => ({ name: String(t), weight: 0.6 }))
                    : [],
                source: 'auto',
            }));
    } catch (e) {
        if (getSettings().debugLogging) console.warn('[BB-Memory] 记忆响应解析失败:', e.message);
        return [];
    }
}

// ═══ API 调用 ═══

function fetchWithTimeout(url, options, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export function normalizeEndpoint(url) {
    let cleaned = url.trim().replace(/\/+$/, '');
    if (cleaned.endsWith('/chat/completions')) return cleaned;
    if (cleaned.endsWith('/v1')) return cleaned + '/chat/completions';
    return cleaned + '/v1/chat/completions';
}

function normalizeEmbeddingEndpoint(url) {
    let cleaned = url.trim().replace(/\/+$/, '');
    if (cleaned.endsWith('/embeddings')) return cleaned;
    if (cleaned.endsWith('/v1')) return cleaned + '/embeddings';
    return cleaned + '/v1/embeddings';
}

export async function callMainApi(prompt) {
    const { generateRaw } = SillyTavern.getContext();
    const result = await generateRaw({
        systemPrompt: '你是一个JSON格式的记忆提取助手。只输出纯JSON数组，不要包含其他文字。',
        prompt,
    });
    return result;
}

export async function callCustomApi(prompt) {
    const settings = getSettings();
    const { autoGenEndpoint, autoGenApiKey, autoGenModel } = settings;
    if (!autoGenEndpoint) throw new Error('未配置自定义API端点');

    const endpoint = normalizeEndpoint(autoGenEndpoint);
    if (settings.debugLogging) console.log('[BB-Memory] 副API请求端点:', endpoint);

    const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${autoGenApiKey}`,
        },
        body: JSON.stringify({
            model: autoGenModel || 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: '你是一个JSON格式的记忆提取助手。只输出纯JSON数组，不要包含其他文字。' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.3,
            max_tokens: 1000,
        }),
    }, 30000);

    if (!response.ok) throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
    const data = await response.json();
    if (data.choices && data.choices[0]) {
        return data.choices[0].message?.content || data.choices[0].text || '';
    }
    return data.content || data.text || JSON.stringify(data);
}

export async function callEmbeddingApi(text, timeoutMs = 10000) {
    const settings = getSettings();
    const { embeddingEndpoint, embeddingApiKey, embeddingModel } = settings;
    if (!embeddingEndpoint) throw new Error('未配置 Embedding API 端点');

    const endpoint = normalizeEmbeddingEndpoint(embeddingEndpoint);
    if (settings.debugLogging) console.log('[BB-Memory] Embedding API 请求:', endpoint, embeddingModel);

    const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${embeddingApiKey}`,
        },
        body: JSON.stringify({ model: embeddingModel, input: text }),
    }, timeoutMs);

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Embedding API 请求失败: ${response.status} ${errText ? '- ' + errText : ''}`);
    }
    const data = await response.json();
    if (data.data && data.data[0] && Array.isArray(data.data[0].embedding)) {
        return data.data[0].embedding;
    }
    throw new Error('Embedding API 返回格式异常');
}

// ═══ Embedding 生成 ═══

async function embedMemoryEntry(mem) {
    const text = mem.summary || mem.content?.slice(0, 100) || '';
    if (!text) return null;
    try {
        return await callEmbeddingApi(text, 8000);
    } catch (e) {
        console.warn('[BB-Memory] 向量化失败:', e.message);
        return null;
    }
}

// ═══ 调用分发 ═══

async function callApi(prompt) {
    const settings = getSettings();
    if (settings.autoGenMode === 'custom' && settings.autoGenEndpoint) {
        return callCustomApi(prompt);
    }
    return callMainApi(prompt);
}

// ═══ AI消息清洗 ═══

function cleanAiMessage(text) {
    if (!text) return '';
    let cleaned = text;
    const contentMatch = cleaned.match(/<content>([\s\S]*?)<\/content>/i);
    if (contentMatch) return contentMatch[1].trim();
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    cleaned = cleaned.replace(/\[[\w\s:/.-]+\]/g, '');
    return cleaned.trim();
}

// ═══ 构建 Prompt（注入对话） ═══

function buildStagePrompt(template, userMessage, aiMessage) {
    return template
        .replace('{{userMessage}}', userMessage || '(无)')
        .replace('{{aiMessage}}', cleanAiMessage(aiMessage) || '(无)');
}

// ═══ 单阶段提取 ═══

/**
 * 阶段 1：NPC 提取
 */
async function extractNpcStage(chatId, userMessage, aiMessage) {
    const prompt = buildStagePrompt(NPC_EXTRACTION_PROMPT, userMessage, aiMessage);
    try {
        const responseText = await callApi(prompt);
        const npcs = parseNpcResponse(responseText);
        let count = 0;
        for (const npc of npcs) {
            await upsertNpcProfile(chatId, npc);
            count++;
        }
        if (count > 0 && getSettings().debugLogging) {
            console.log(`[BB-Memory] NPC 提取: ${count} 个角色`);
        }
        return count;
    } catch (e) {
        console.warn('[BB-Memory] NPC 提取失败:', e.message);
        return 0;
    }
}

/**
 * 阶段 2：物品提取
 */
async function extractItemStage(chatId, userMessage, aiMessage) {
    const prompt = buildStagePrompt(ITEM_EXTRACTION_PROMPT, userMessage, aiMessage);
    try {
        const responseText = await callApi(prompt);
        const items = parseItemResponse(responseText);
        let count = 0;
        for (const item of items) {
            await upsertItem(chatId, item);
            count++;
        }
        if (count > 0 && getSettings().debugLogging) {
            console.log(`[BB-Memory] 物品提取: ${count} 个`);
        }
        return count;
    } catch (e) {
        console.warn('[BB-Memory] 物品提取失败:', e.message);
        return 0;
    }
}

/**
 * 阶段 3：时间线提取
 */
async function extractTimelineStage(chatId, userMessage, aiMessage) {
    const prompt = buildStagePrompt(TIMELINE_EXTRACTION_PROMPT, userMessage, aiMessage);
    try {
        const responseText = await callApi(prompt);
        const entries = parseTimelineResponse(responseText);
        let count = 0;
        for (const entry of entries) {
            await upsertTimelineEntry(chatId, entry);
            count++;
        }
        if (count > 0 && getSettings().debugLogging) {
            console.log(`[BB-Memory] 时间线提取: ${count} 条`);
        }
        return count;
    } catch (e) {
        console.warn('[BB-Memory] 时间线提取失败:', e.message);
        return 0;
    }
}

/**
 * 阶段 4：记忆提取
 */
async function extractMemoryStage(chatId, userMessage, aiMessage) {
    const prompt = buildStagePrompt(MEMORY_EXTRACTION_PROMPT, userMessage, aiMessage);
    try {
        const responseText = await callApi(prompt);
        const memories = parseMemoryResponse(responseText);
        const settings = getSettings();
        const maxPerExchange = settings.maxMemoriesPerExchange ?? 3;
        const limited = memories.slice(0, maxPerExchange);
        const existingMemories = await getMemories(chatId);
        const activeMemories = existingMemories.filter(m => m.embedding);

        let count = 0;
        for (const mem of limited) {
            // 生成 embedding
            const embedding = settings.embeddingEnabled && settings.embeddingEndpoint
                ? await embedMemoryEntry(mem)
                : null;

            // 语义去重
            if (settings.dedupEnabled && embedding) {
                const similar = findMostSimilarMemory(embedding, activeMemories);
                if (similar) {
                    if (similar.similarity >= getDedupConfig().mergeThreshold) {
                        const updates = mergeMemoryFields(similar.memory, mem);
                        await updateMemory(chatId, similar.memory.id, updates);
                        continue;
                    } else if (similar.similarity >= getDedupConfig().reduceThreshold) {
                        mem.importance = Math.max(0.3, (mem.importance || 0.5) - 0.15);
                    }
                }
            }

            await addMemory(chatId, { ...mem, embedding });
            if (embedding) activeMemories.push({ embedding });
            count++;
        }
        if (count > 0 && getSettings().debugLogging) {
            console.log(`[BB-Memory] 记忆提取: ${count} 条`);
        }
        return count;
    } catch (e) {
        console.warn('[BB-Memory] 记忆提取失败:', e.message);
        return 0;
    }
}

// ═══ 状态管理 ═══

let isProcessing = false;
let pendingMessages = [];
let processingTimer = null;

// v5 兼容：待审核候选记忆（active 模式用）
let pendingAutoCandidates = [];

export function getPendingAutoCandidates() {
    return pendingAutoCandidates;
}

export function clearPendingAutoCandidates() {
    pendingAutoCandidates = [];
}

// ═══ 进度回调 ═══

let onAutoExtractProgress = null;

export function setAutoExtractProgressCallback(cb) {
    onAutoExtractProgress = cb;
}

function reportProgress(phase, current, total) {
    if (typeof onAutoExtractProgress === 'function') {
        onAutoExtractProgress({ phase, current, total });
    }
}

// ═══ 获取 chatId ═══

function getChatId() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx.chatId || (ctx.chat && ctx.chat.length ? ctx.chat[0]?.chatId : null) || null;
    } catch { return null; }
}

// ═══ 核心：消息接收处理 ═══

export async function onMessageReceived(_messageIndex) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoGenEnabled) return;

    const chatId = getChatId();
    if (!chatId) return;

    // 防抖
    const delay = _messageIndex === -1 ? 500 : 2500;
    if (processingTimer) clearTimeout(processingTimer);

    processingTimer = setTimeout(async () => {
        if (isProcessing) {
            pendingMessages.push({ chatId, messageIndex: _messageIndex });
            return;
        }

        isProcessing = true;
        try {
            await processLatestExchange(chatId);
        } finally {
            isProcessing = false;
            // 处理积压
            if (pendingMessages.length > 0) {
                const next = pendingMessages.shift();
                onMessageReceived(next.messageIndex);
            }
        }
    }, delay);
}

async function processLatestExchange(chatId) {
    const settings = getSettings();
    const confirmMode = settings.extractionConfirmMode || 'semi';

    const exchanges = await getExtractableExchanges();
    if (!exchanges.length) return;

    const oldest = exchanges[0];

    // 检查已处理
    if (await isExchangeProcessed(chatId, oldest.hash)) return;

    if (confirmMode !== 'active') {
        hideExchange(oldest.userIndex, oldest.aiIndex);
    }

    try {
        if (confirmMode === 'active') {
            // Active 模式：解析但不保存
            const prompt = buildStagePrompt(MEMORY_EXTRACTION_PROMPT, oldest.userMessage, oldest.aiMessage);
            const responseText = await callApi(prompt);
            const candidates = parseMemoryResponse(responseText);
            if (candidates.length > 0) {
                pendingAutoCandidates.push(...candidates.map(c => ({ ...c, _chatId: chatId })));
            }
        } else {
            // Semi/Auto 模式：四阶段提取
            reportProgress('npc', 0, 4);
            await extractNpcStage(chatId, oldest.userMessage, oldest.aiMessage);
            reportProgress('npc', 1, 4);

            reportProgress('item', 1, 4);
            await extractItemStage(chatId, oldest.userMessage, oldest.aiMessage);
            reportProgress('item', 2, 4);

            reportProgress('timeline', 2, 4);
            await extractTimelineStage(chatId, oldest.userMessage, oldest.aiMessage);
            reportProgress('timeline', 3, 4);

            reportProgress('mem', 3, 4);
            await extractMemoryStage(chatId, oldest.userMessage, oldest.aiMessage);
            reportProgress('mem', 4, 4);
        }
    } catch (e) {
        console.warn('[BB-Memory] 提取处理异常:', e.message);
    }

    await markExchangeExtracted(oldest.aiIndex, oldest.hash);

    if (confirmMode === 'active') {
        hideExchange(oldest.userIndex, oldest.aiIndex);
    }

    setTimeout(() => refreshExtractionMarkers(), 200);
}

// ═══ 批量提取（用于初始化） ═══

/**
 * 从上下文批量提取记忆（初始化功能用）
 * @param {string} chatId
 * @param {string} contextText - 拼接好的上下文文本（角色卡+世界书+对话）
 * @returns {object} { npc, items, timeline, memories }
 */
export async function extractFromContext(chatId, contextText, options = {}) {
    const { onProgress } = options;

    const buildContextPrompt = (template) => {
        return template
            .replace('{{userMessage}}', contextText)
            .replace('{{aiMessage}}', '(见上下文)');
    };

    const results = { npc: 0, items: 0, timeline: 0, memories: 0 };

    // Stage 1: NPC
    if (onProgress) onProgress({ stage: 'npc', progress: '正在提取 NPC 档案...' });
    const npcPrompt = buildContextPrompt(NPC_EXTRACTION_PROMPT);
    try {
        const resp = await callApi(npcPrompt);
        const npcs = parseNpcResponse(resp);
        for (const npc of npcs) {
            await upsertNpcProfile(chatId, npc);
            results.npc++;
        }
    } catch (e) { console.warn('[BB-Memory] 初始化NPC提取失败:', e.message); }

    // Stage 2: Items
    if (onProgress) onProgress({ stage: 'item', progress: '正在提取物品信息...' });
    const itemPrompt = buildContextPrompt(ITEM_EXTRACTION_PROMPT);
    try {
        const resp = await callApi(itemPrompt);
        const items = parseItemResponse(resp);
        for (const item of items) {
            await upsertItem(chatId, item);
            results.items++;
        }
    } catch (e) { console.warn('[BB-Memory] 初始化物品提取失败:', e.message); }

    // Stage 3: Timeline
    if (onProgress) onProgress({ stage: 'timeline', progress: '正在提取时间线...' });
    const tlPrompt = buildContextPrompt(TIMELINE_EXTRACTION_PROMPT);
    try {
        const resp = await callApi(tlPrompt);
        const entries = parseTimelineResponse(resp);
        for (const entry of entries) {
            await upsertTimelineEntry(chatId, entry);
            results.timeline++;
        }
    } catch (e) { console.warn('[BB-Memory] 初始化时间线提取失败:', e.message); }

    // Stage 4: Memories
    if (onProgress) onProgress({ stage: 'mem', progress: '正在提取记忆条目...' });
    const memPrompt = buildContextPrompt(MEMORY_EXTRACTION_PROMPT);
    try {
        const resp = await callApi(memPrompt);
        const memories = parseMemoryResponse(resp);
        for (const mem of memories) {
            const embedding = getSettings().embeddingEnabled && getSettings().embeddingEndpoint
                ? await embedMemoryEntry(mem)
                : null;
            await addMemory(chatId, { ...mem, embedding });
            results.memories++;
        }
    } catch (e) { console.warn('[BB-Memory] 初始化记忆提取失败:', e.message); }

    return results;
}

// ═══ 初始化/生命周期 ═══

let eventRegistered = false;

export function initAutoGenerator() {
    if (eventRegistered) return;
    try {
        const ctx = SillyTavern.getContext();
        const eventTypes = ctx.eventTypes || ctx.event_types || {};
        const msgReceived = eventTypes.MESSAGE_RECEIVED;
        if (msgReceived) {
            ctx.eventSource.on(msgReceived, onMessageReceived);
            eventRegistered = true;
            // 初始积压检查
            setTimeout(() => onMessageReceived(-1), 3000);
        }
    } catch (e) {
        console.warn('[BB-Memory] auto-generator 初始化失败:', e.message);
    }
}

export function stopAutoGenerator() {
    if (!eventRegistered) return;
    try {
        const ctx = SillyTavern.getContext();
        const eventTypes = ctx.eventTypes || ctx.event_types || {};
        const msgReceived = eventTypes.MESSAGE_RECEIVED;
        if (msgReceived) {
            ctx.eventSource.removeListener(msgReceived, onMessageReceived);
        }
    } catch { /* ignore */ }
    eventRegistered = false;
    if (processingTimer) { clearTimeout(processingTimer); processingTimer = null; }
    pendingMessages = [];
}

// ═══ Active 模式：保存候选人 ═══

export async function saveExtractedMemories(chatId, candidateMemories, onProgress) {
    let count = 0;
    const existingMemories = await getMemories(chatId);
    const activeMemories = existingMemories.filter(m => m.embedding);

    for (const mem of candidateMemories) {
        if (mem._selected === false) continue;

        const embedding = getSettings().embeddingEnabled && getSettings().embeddingEndpoint
            ? await embedMemoryEntry(mem)
            : null;

        if (getSettings().dedupEnabled && embedding) {
            const similar = findMostSimilarMemory(embedding, activeMemories);
            if (similar) {
                if (similar.similarity >= getDedupConfig().mergeThreshold) {
                    const updates = mergeMemoryFields(similar.memory, mem);
                    await updateMemory(chatId, similar.memory.id, updates);
                    count++;
                    continue;
                } else if (similar.similarity >= getDedupConfig().reduceThreshold) {
                    mem.importance = Math.max(0.3, (mem.importance || 0.5) - 0.15);
                }
            }
        }

        await addMemory(chatId, { ...mem, embedding, source: mem.source || 'auto' });
        if (embedding) activeMemories.push({ embedding });
        count++;
        if (onProgress) onProgress(count, candidateMemories.length);
    }
    return count;
}

// ═══ 兼容导出（供其他模块使用） ═══

export { parseMemoryResponse, parseNpcResponse, parseItemResponse, parseTimelineResponse };

/**
 * 兼容旧的 parseAiResponse 调用（world-book-importer 等）
 */
export function parseAiResponse(responseText) {
    return parseMemoryResponse(responseText);
}

/**
 * 兼容旧的 getDefaultPrompt
 */
export function getDefaultPrompt() {
    return MEMORY_EXTRACTION_PROMPT;
}

/**
 * 嵌入现有记忆（批量补 embedding）
 */
export async function embedExistingMemories(memories, onProgress) {
    let done = 0;
    for (const mem of memories) {
        if (!mem.embedding) {
            mem.embedding = await embedMemoryEntry(mem);
        }
        done++;
        if (onProgress) onProgress(done, memories.length);
    }
}
