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
    syncMessageVisibility,
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

const PROMPT_META_GUARD = `你是一个角色扮演(RP)剧情记忆提取助手。**只提取角色扮演的剧情内容。**
**绝对不要提取以下内容**：
- 用户与AI助手的对话（如"请帮我写...""你能给我建议吗"）
- 用户的元指令/OOC（如"(OOC: ...)"、系统设置请求）
- AI助手的自我介绍、工具说明、能力声明
如果对话中只有元指令没有RP内容，返回空数据。

`;

const NPC_EXTRACTION_PROMPT = PROMPT_META_GUARD + `你是一个角色档案提取助手。从对话中提取**本轮首次登场**或**属性发生明显变化**的 NPC。

规则：
1. 只提取有名字或明确身份的角色，不要从AI回复中推断用户信息
2. 一次性出场的路人用 nt=background；有剧情潜力的用 nt=minor；重要配角用 nt=important；核心角色用 nt=core
3. **职责边界：只记录角色本身的属性（身份、性格、外貌、关系），不记录事件过程**
4. 如果角色已存在且本轮没有新信息，不需要重复提取

返回纯JSON数组（不要markdown代码块）：
n=角色名 | r=身份/职业 | p=性格特征 | a=外貌描述 | s=当前状态 | l=当前位置
rt=关系数组 [{"n":"名称","r":"关系类型(朋友/敌人/恋人/师徒/交易伙伴等)","a":"态度(友好/敌对/中立/暧昧等)"}]
nt=分级(core/important/minor/background) | ic=一行索引卡 | g=标签数组

示例：[{"n":"雅赫摩斯","r":"北境领主","p":"冷酷果决，野心勃勃","a":"高瘦黑发中年男子，眼神锐利","s":"北境王座厅","l":"北境","rt":[{"n":"玩家","r":"敌人","a":"敌对"}],"nt":"core","ic":"北境领主，已向玩家宣战","g":["北境","领主"]}]

[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

const ITEM_EXTRACTION_PROMPT = PROMPT_META_GUARD + `你是一个物品追踪助手。从对话中提取**本轮首次出现**或**状态发生改变**的有意义物品。

规则：
1. 只提取有意义的物品（剧情相关、有特殊价值、有纪念意义）
2. 已使用的普通消耗品（药水、食物）kp=false；有情感/纪念价值的即使已使用也 kp=true
3. 消耗品用 it=consumable；关键剧情物用 it=key；线索物用 it=clue；装备用 it=equipped；背景道具用 it=background
4. **职责边界：只记录物品本身的信息（持有者、状态、意义），不记录使用场景或事件**
5. 如果物品已存在且状态未变，不需要重复提取

返回纯JSON数组（不要markdown代码块）：
n=物品名 | o=持有者 | s=状态(held=持有中/used=已使用/lost=已失去/destroyed=已销毁)
sig=意义描述 | kp=true(永久保留)/false(可清理) | it=分级(key/equipped/clue/consumable/background)
g=标签数组

示例：[{"n":"辉月之剑","o":"玩家","s":"held","sig":"传说中的圣剑，曾属古代英雄阿尔托","kp":true,"it":"key","g":["圣剑","古代遗物"]},{"n":"治疗药水","o":"玩家","s":"used","sig":"普通治疗药水","kp":false,"it":"consumable","g":["药水"]}]

[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

const TIMELINE_EXTRACTION_PROMPT = PROMPT_META_GUARD + `你是一个故事时间线记录员。只记录真正重要的**故事里程碑**，而非日记流水账。

**什么是里程碑（满足任一即记录）**：
- 时间跨越一天以上（如"三天后..."）
- 故事阶段转换（章节结束、新篇章开始）
- 重大战斗/冲突的起始或结束
- 核心角色关系的质变（敌人→朋友、朋友→恋人等）
- 核心剧情转折

**什么不是里程碑（不要记录）**：
- 同一场景内的日常对话和微小进展
- 重复行为、短暂冲突
- 没有明确时间信息的事件

**格式要求**：
- 时间粒度至少以"日"为单位
- 同一日内发生的事件合并为一条
- 描述极其简短（一句话）
- 如果没有达到里程碑级别，返回空数组 []

返回纯JSON数组（不要markdown代码块）：
t=故事时间(如"123年4月5日~5月6日"或"同日") | e=事件摘要(一句话) | p=参与者数组 | l=地点
active=true/false | imp=影响描述 | g=标签数组

示例：
[{"t":"123年4月5日~5月6日","e":"北境战争爆发。雅赫摩斯宣战，玩家应征入伍","p":["雅赫摩斯","玩家"],"l":"北境","active":false,"imp":"北境格局根本改变","g":["北境战争","宣战"]},
{"t":"123年7月8日","e":"玩家与艾琳在王都重逢，相拥和解","p":["玩家","艾琳"],"l":"王都","active":false,"imp":"核心关系修复","g":["重逢","和解"]}]

[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

const MEMORY_EXTRACTION_PROMPT = PROMPT_META_GUARD + `你是一个记忆提取助手。从对话中提取**所有值得长期记忆的关键信息**。

**提取标准（降低门槛，宁可多提取）**：
- 发生任何事件、行动、决策 → 提取
- 出现情感波动、态度变化、关系进展 → 提取
- 透露新信息（角色背景、世界观、计划、秘密） → 提取
- 做出承诺、威胁、告白、约定 → 提取
- 角色展现出习惯、偏好、性格特征 → 提取
- 场景或情境发生变化 → 提取

**记忆字段**：
n=标题(3-8字，精准概括) | tp=类型(event/emotion/habit/fact)
m=一句话摘要(10-20字) | c=完整内容(2-5句话，保留上下文)
v=重要原话(无则"") | s=主体名 | a=目标名
i=重要性(0-1，对剧情的影响程度) | e=情感强度(0-1，情感冲击力)
st=故事时间(无则"") | g=标签数组(前3个结构标签+自由标签)

示例：
[{"n":"北境宣战","tp":"event","m":"雅赫摩斯向北境诸邦正式宣战","c":"在会议上，雅赫摩斯宣布向北境诸邦宣战，玩家作为目击者在场。这将改变整个北境格局。","v":"从今日起，北境诸邦即为吾敌","s":"雅赫摩斯","a":"北境诸邦","i":0.85,"e":0.6,"st":"123年4月15日","g":["北境战争","宣战","雅赫摩斯","政治","冲突"]},
{"n":"疑惧之心","tp":"emotion","m":"玩家对即将到来的战争感到恐惧","c":"尽管表面镇定，玩家内心对战争前景充满不安，担心无法保护身边的人。","v":"","s":"玩家","a":"","i":0.5,"e":0.7,"st":"","g":["情感","恐惧","内心","战争前夕"]}]

如果没有值得记忆的内容（极罕见），返回空数组 []。

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
async function extractNpcStage(chatId, userMessage, aiMessage, sourceInfo) {
    const prompt = buildStagePrompt(NPC_EXTRACTION_PROMPT, userMessage, aiMessage);
    try {
        const responseText = await callApi(prompt);
        const npcs = parseNpcResponse(responseText);
        let count = 0;
        for (const npc of npcs) {
            await upsertNpcProfile(chatId, { ...npc, ...(sourceInfo || {}) });
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
async function extractItemStage(chatId, userMessage, aiMessage, sourceInfo) {
    const prompt = buildStagePrompt(ITEM_EXTRACTION_PROMPT, userMessage, aiMessage);
    try {
        const responseText = await callApi(prompt);
        const items = parseItemResponse(responseText);
        let count = 0;
        for (const item of items) {
            await upsertItem(chatId, { ...item, ...(sourceInfo || {}) });
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
async function extractTimelineStage(chatId, userMessage, aiMessage, sourceInfo) {
    const prompt = buildStagePrompt(TIMELINE_EXTRACTION_PROMPT, userMessage, aiMessage);
    try {
        const responseText = await callApi(prompt);
        const entries = parseTimelineResponse(responseText);
        let count = 0;
        for (const entry of entries) {
            await upsertTimelineEntry(chatId, { ...entry, ...(sourceInfo || {}) });
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
async function extractMemoryStage(chatId, userMessage, aiMessage, sourceInfo) {
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

            await addMemory(chatId, { ...mem, embedding, ...(sourceInfo || {}) });
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

// ═══ 合并提取（测试功能）═══

const MERGED_EXTRACTION_PROMPT = PROMPT_META_GUARD + `你是一个记忆提取助手。从对话中提取需要长期记住的信息。

**工作顺序：先提取记忆，再从记忆中反推需要更新的NPC/物品/时间线。**

═══════════════════════════════════════════════════════
## 核心：记忆提取（最重要，必须认真完成）
═══════════════════════════════════════════════════════

从对话中提取**所有值得长期记忆的关键信息**。宁可多提取，不可遗漏。

提取标准（**降低门槛**，满足任一条即提取）：
- 发生任何事件、行动、决策
- 出现情感波动、态度变化、关系进展（哪怕细微）
- 透露新信息（角色背景、世界观、计划、秘密）
- 做出承诺、威胁、告白、约定
- 角色展现出习惯、偏好、性格特征
- 场景或情境发生变化
- 任何可能对未来剧情有影响的内容

每条记忆字段（n和tp和m和c必填）：
- n=标题(3-8字，精准概括)
- tp=类型(event/emotion/habit/fact)
- m=一句话摘要(10-20字)
- c=完整内容(2-5句话，保留上下文)
- v=重要原话(无则"")
- s=主体名 | a=目标名
- i=重要性0-1(对剧情的影响程度)
- e=情感强度0-1(情感冲击力)
- st=故事时间(无则"")
- g=标签数组(前3个结构标签+自由标签)

示例：
[{"n":"北境宣战","tp":"event","m":"雅赫摩斯向北境诸邦正式宣战","c":"在会议上，雅赫摩斯宣布向北境诸邦宣战，玩家作为目击者在场。这一决定将改变整个北境格局。","v":"从今日起，北境诸邦即为吾敌","s":"雅赫摩斯","a":"北境诸邦","i":0.85,"e":0.6,"st":"123年4月15日","g":["北境战争","宣战","雅赫摩斯","政治","冲突"]},
{"n":"疑惧之心","tp":"emotion","m":"玩家对即将到来的战争感到恐惧","c":"尽管表面镇定，玩家内心对战争前景充满不安，担心无法保护身边的人。","v":"","s":"玩家","a":"","i":0.5,"e":0.7,"st":"","g":["情感","恐惧","内心","战争前夕"]}]

若无任何值得记忆的内容（极罕见），返回空数组。

═══════════════════════════════════════════════════════
## 辅助：NPC角色更新（仅更新本轮新出现或变化的角色）
═══════════════════════════════════════════════════════

只提取**本轮对话中首次登场**或**属性/关系发生明显变化**的角色。已存在的角色如果没有新信息则不需要重复提取。

字段：n(姓名), r(身份/职业), p(性格特征), a(外貌描述), s(当前状态), l(当前位置)
rt=关系数组 [{"n":"关联角色名","r":"关系类型(朋友/敌人/恋人/师徒等)","a":"态度(友好/敌对/中立/暧昧等)"}]
nt=分级(core=核心/important=重要配角/minor=有剧情的配角/background=路人)
ic=一行索引卡(角色核心信息摘要) | g=标签数组

若无新角色或变化，返回空数组。

═══════════════════════════════════════════════════════
## 辅助：物品更新（仅更新本轮新出现或状态变化的物品）
═══════════════════════════════════════════════════════

只提取**本轮首次出现**或**状态发生改变**的有意义物品。

字段：n(物品名), o(持有者), s(状态:held/used/lost/destroyed)
sig=意义描述, kp=true永久保留/false可清理
it=分级(key/equipped/clue/consumable/background) | g=标签数组

若无新物品或变化，返回空数组。

═══════════════════════════════════════════════════════
## 辅助：时间线里程碑（仅记录真正重要的故事节点）
═══════════════════════════════════════════════════════

时间线是**故事里程碑**，不是日记流水账。只记录级别达到以下标准的事件：

**什么是里程碑（满足任一）**：
- 时间跨越一天以上（如"三天后..."）
- 故事阶段转换（章节结束、新篇章开始）
- 重大战斗/冲突的起始或结束
- 核心角色关系的质变（敌人→朋友、朋友→恋人等）
- 核心剧情转折

**什么不是里程碑（不要记录）**：
- 同一场景内的日常对话和微小进展 → 放在记忆条目中
- 重复行为、短暂冲突
- 没有明确时间信息的事件

**格式要求**：
- 时间粒度至少以"日"为单位。没有具体日期可用"同年初夏""三天后"等
- 同一日内发生的事件合并为一条
- 描述极其简短（一句话）

字段：t(故事时间，如"123年4月5日~5月6日"或"同日"), e(事件摘要，一句话),
p(参与者数组), l(地点), active=true/false, imp(影响), g(标签数组)

示例：
[{"t":"123年4月5日~5月6日","e":"北境战争爆发。雅赫摩斯宣战，玩家应征入伍","p":["雅赫摩斯","玩家"],"l":"北境","active":false,"imp":"北境格局根本改变","g":["北境战争","宣战"]},
{"t":"123年7月8日","e":"玩家与艾琳在王都重逢，相拥和解","p":["玩家","艾琳"],"l":"王都","active":false,"imp":"核心关系修复","g":["重逢","和解"]}]

若本轮对话未达到里程碑级别，返回空数组。

═══════════════════════════════════════════════════════
## 输出格式
═══════════════════════════════════════════════════════

返回纯JSON对象（不要markdown代码块，不要```json```）：
{"memories":[...记忆数组，核心输出...], "npc":[...NPC数组...], "items":[...物品数组...], "timeline":[...时间线数组...]}

[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

function parseMergedResponse(responseText) {
    if (!responseText || !responseText.trim()) {
        console.warn('[BB-Memory] 合并提取响应为空');
        return { npc: [], items: [], timeline: [], memories: [] };
    }
    let text = responseText.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
        console.warn('[BB-Memory] 合并提取响应未找到JSON对象，前200字符:', text.slice(0, 200));
        return { npc: [], items: [], timeline: [], memories: [] };
    }
    try {
        const parsed = JSON.parse(match[0]);
        // v6.2.0: 兼容不同字段名
        const memArr = parsed.memories || parsed.memory || parsed.mem || [];
        const npcArr = parsed.npc || [];
        const itemsArr = parsed.items || [];
        const tlArr = parsed.timeline || [];
        const result = {
            npc: parseNpcResponse(JSON.stringify(npcArr)),
            items: parseItemResponse(JSON.stringify(itemsArr)),
            timeline: parseTimelineResponse(JSON.stringify(tlArr)),
            memories: parseMemoryResponse(JSON.stringify(memArr)),
        };
        if (memArr.length === 0 && npcArr.length === 0 && itemsArr.length === 0 && tlArr.length === 0) {
            console.log('[BB-Memory] 合并提取: 本轮无需提取');
        }
        return result;
    } catch (e) {
        console.warn('[BB-Memory] 合并响应JSON解析失败:', e.message, '前200字符:', text.slice(0, 200));
        return { npc: [], items: [], timeline: [], memories: [] };
    }
}

async function extractMergedStage(chatId, userMessage, aiMessage, sourceInfo) {
    const prompt = MERGED_EXTRACTION_PROMPT
        .replace('{{userMessage}}', userMessage || '(无)')
        .replace('{{aiMessage}}', cleanAiMessage(aiMessage) || '(无)');
    try {
        const responseText = await callApi(prompt);
        const results = parseMergedResponse(responseText);
        let total = 0;
        for (const npc of results.npc) { await upsertNpcProfile(chatId, { ...npc, ...(sourceInfo || {}) }); total++; }
        for (const item of results.items) { await upsertItem(chatId, { ...item, ...(sourceInfo || {}) }); total++; }
        for (const tl of results.timeline) { await upsertTimelineEntry(chatId, { ...tl, ...(sourceInfo || {}) }); total++; }
        const settings = getSettings();
        const maxPerExchange = settings.maxMemoriesPerExchange ?? 3;
        const limited = results.memories.slice(0, maxPerExchange);
        const existingMemories = await getMemories(chatId);
        const activeMemories = existingMemories.filter(m => m.embedding);
        for (const mem of limited) {
            const embedding = settings.embeddingEnabled && settings.embeddingEndpoint
                ? await embedMemoryEntry(mem)
                : null;
            if (settings.dedupEnabled && embedding) {
                const similar = findMostSimilarMemory(embedding, activeMemories);
                if (similar) {
                    if (similar.similarity >= getDedupConfig().mergeThreshold) {
                        await updateMemory(chatId, similar.memory.id, mergeMemoryFields(similar.memory, mem));
                        continue;
                    } else if (similar.similarity >= getDedupConfig().reduceThreshold) {
                        mem.importance = Math.max(0.3, (mem.importance || 0.5) - 0.15);
                    }
                }
            }
            await addMemory(chatId, { ...mem, embedding, ...(sourceInfo || {}) });
            if (embedding) activeMemories.push({ embedding });
            total++;
        }
        console.log(`[BB-Memory] 合并提取: NPC${results.npc.length}/物品${results.items.length}/时间线${results.timeline.length}/记忆${limited.length} (保存${total}条)`);
        return total;
    } catch (e) {
        console.warn('[BB-Memory] 合并提取失败:', e.message);
        return 0;
    }
}

// ═══ 分阶段提取 ═══

async function processLatestExchange(chatId) {
    // 先同步可见性，将超出窗口的旧消息标记为插件隐藏
    await syncMessageVisibility();

    const settings = getSettings();
    const confirmMode = settings.extractionConfirmMode || 'semi';

    const exchanges = await getExtractableExchanges();
    if (!exchanges.length) return;

    const oldest = exchanges[0];

    // 检查已处理
    if (await isExchangeProcessed(chatId, oldest.hash)) return;

    const sourceInfo = { sourceExchange: oldest.hash, sourceFloor: oldest.aiIndex, sourceChatId: chatId };

    try {
        if (confirmMode === 'active') {
            // Active 模式：解析但不保存
            const prompt = buildStagePrompt(MEMORY_EXTRACTION_PROMPT, oldest.userMessage, oldest.aiMessage);
            const responseText = await callApi(prompt);
            const candidates = parseMemoryResponse(responseText);
            if (candidates.length > 0) {
                pendingAutoCandidates.push(...candidates.map(c => ({ ...c, _chatId: chatId })));
            }
        } else if (settings.extractionMode === 'merged') {
            // 合并模式：1次API调用提取全部四类
            reportProgress('merged', 0, 1);
            await extractMergedStage(chatId, oldest.userMessage, oldest.aiMessage, sourceInfo);
            reportProgress('merged', 1, 1);
        } else {
            // Semi/Auto 模式：四阶段提取
            reportProgress('npc', 0, 4);
            await extractNpcStage(chatId, oldest.userMessage, oldest.aiMessage, sourceInfo);
            reportProgress('npc', 1, 4);

            reportProgress('item', 1, 4);
            await extractItemStage(chatId, oldest.userMessage, oldest.aiMessage, sourceInfo);
            reportProgress('item', 2, 4);

            reportProgress('timeline', 2, 4);
            await extractTimelineStage(chatId, oldest.userMessage, oldest.aiMessage, sourceInfo);
            reportProgress('timeline', 3, 4);

            reportProgress('mem', 3, 4);
            await extractMemoryStage(chatId, oldest.userMessage, oldest.aiMessage, sourceInfo);
            reportProgress('mem', 4, 4);
        }
    } catch (e) {
        console.warn('[BB-Memory] 提取处理异常:', e.message);
    }

    await markExchangeExtracted(oldest.aiIndex, oldest.hash);

    // 提取完成后隐藏消息（统一放在提取之后）
    hideExchange(oldest.userIndex, oldest.aiIndex);

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
