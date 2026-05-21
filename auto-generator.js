/**
 * auto-generator.js —— BB-Memory v5.0 自动提取系统
 *
 * 四柱架构：每轮对话分四个阶段独立提取 NPC/物品/时间线/记忆。
 * 每个阶段有聚焦的短 Prompt 和专用解析器。
 */

import {
    getSettings, updateSettings, getMemories, addMemory, updateMemory,
    upsertNpcProfile, upsertItem, upsertTimelineEntry,
    getNpcProfiles, getItems, getTimeline,
    getCalendarDescription,
} from './memory-store.js';
import {
    getExtractableExchanges, markExchangeExtracted, isExchangeProcessed,
    computeExchangeHash, cyrb53Hash, hideExchange, refreshExtractionMarkers,
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

const PROMPT_META_GUARD = `你是一个角色扮演(RP)叙事记忆提取助手。

**职责**：从角色扮演对话中提取记忆条目（必做），以及可选的 NPC/物品/时间线更新。

**内容边界**：
❌ 不提取：用户给AI的元指令、OOC标注、系统设置、风格指导
❌ 不提取：AI的自我介绍、能力声明、工具说明
✅ 只提取：角色扮演中的剧情内容、角色互动、情感交流

**混合内容处理**：
- 如果消息中既有RP剧情又夹着元指令（如"(我们跳过三天)""角色应该知道..."），
  忽略元指令部分，只提取RP剧情内容。
- 如果整条消息都是元对话、不包含任何RP剧情，只输出一句话：META_DIALOGUE

**提取优先级（重要）**：
- 🅼 记忆条目：每条 exchange 必须至少提取 1 条。即使看似平淡，也必有情感流动。
- 🅽 NPC 更新：可选。仅当新角色出场或已知角色属性/关系发生明显变化时。
- 🅸 物品更新：可选。仅当新物品出现或已知物品状态/持有者改变时。
- 🆃 时间线：可选。仅当达到故事里程碑级别时记录。

`;



// ═══ 风格偏置指令 ═══

const STYLE_BIAS_DAILY = `
**当前为【日常陪伴】模式。调整提取侧重：**

优先提取：
- 角色特征（习惯/仪式/偏好锚点）——记住TA喜欢什么、怕什么、每天做什么
- 情感节拍中的温暖与脆弱面——被关心的瞬间、小小的喜悦、安全感
- 关系温度的微妙变化——默契的建立、内部梗的诞生、无声的理解
- 感官锚点——让回忆能有"气味"和"温度"

适度提取：
- 冲突种子和未兑现承诺（日常中的小承诺也算："明天我给你带早饭"）
- 角色弧线的微小进展

减少提取：
- 世界观线索（除非与角色日常生活直接相关）
- 情境反转铺垫（日常不需要强烈的叙事反转）

每轮提取 1-2 条高质量记忆即可，重在细腻而非数量。
如果这个对话片段看起来"什么都没有发生"——恰恰相反，
日常陪伴中最珍贵的正是那些看似"无事发生"的瞬间。`;

const STYLE_BIAS_DRAMA = `
**当前为【正剧叙事】模式。调整提取侧重：**

优先提取：
- 未兑现的承诺——每个约定、誓言、威胁都是未来剧情的发动机，务必标记"待兑现"
- 冲突种子——利益冲突、价值观对立、信息不对称，追踪它们的萌芽状态
- 角色弧线节点——立场转变、价值观挑战、隐藏动机的揭示、性格的成长/退步
- 契诃夫之枪的铺设与回收——记录每把"枪"，标记它的状态（待发射/已发射/哑火）

适度提取：
- 情境反转的铺垫——看似无关的闲笔、过度自信的断言、角色认知与现实的偏差
- 悬而未决的问题——异常细节、因果缺口中可能埋藏着未来的揭示
- 世界观线索——新规则、历史渊源、势力格局的变化

减少提取：
- 纯日常习惯和偏好（除非与伏笔或角色弧线相关）

每轮可提取 2-3 条记忆。叙事密度高于日常，因为正剧中每个场景都在推进故事。
关注"因果"——不是记录发生了什么，而是记录"这件事将导致什么"。`;

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

export async function callMainApi(prompt, options = {}) {
    const { generateRaw } = SillyTavern.getContext();
    const formatHint = options.isMerged ? '纯JSON对象' : '纯JSON';
    const result = await generateRaw({
        systemPrompt: `你是一个JSON格式的记忆提取助手。只输出${formatHint}，不要包含其他文字。`,
        prompt,
    });
    return result;
}

export async function callCustomApi(prompt, options = {}) {
    const settings = getSettings();
    const { autoGenEndpoint, autoGenApiKey, autoGenModel } = settings;
    if (!autoGenEndpoint) throw new Error('未配置自定义API端点');

    const endpoint = normalizeEndpoint(autoGenEndpoint);
    if (settings.debugLogging) console.log('[BB-Memory] 副API请求端点:', endpoint);

    const formatHint = options.isMerged ? '纯JSON对象' : '纯JSON';

    const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${autoGenApiKey}`,
        },
        body: JSON.stringify({
            model: autoGenModel || 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: `你是一个JSON格式的记忆提取助手。只输出${formatHint}，不要包含其他文字。` },
                { role: 'user', content: prompt },
            ],
            temperature: 0.3,
        }),
    }, 60000);

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

// ═══ v8.2.3 API 连接测试 ═══

export async function testApiConnection(endpoint, apiKey, model) {
    const start = Date.now();
    try {
        const url = normalizeEndpoint(endpoint);  // v8.2.7 规范化端点URL
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 1,
            }),
        }, 15000);
        const latency = Date.now() - start;
        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            let msg = `HTTP ${response.status}`;
            if (errText) {
                try {
                    const j = JSON.parse(errText);
                    msg = j.error?.message || j.message || msg;
                } catch { msg = errText.slice(0, 120); }
            }
            return { ok: false, error: msg, latency };
        }
        return { ok: true, latency };
    } catch (e) {
        return { ok: false, error: e.message || '网络错误', latency: Date.now() - start };
    }
}

// ═══ Embedding 生成 ═══

let _lastEmbeddingErrorTime = 0;
async function embedMemoryEntry(mem) {
    const text = mem.summary || mem.content?.slice(0, 100) || '';
    if (!text) return null;
    try {
        return await callEmbeddingApi(text, 8000);
    } catch (e) {
        console.warn('[BB-Memory] 向量化失败:', e.message);
        // 30s 内仅弹窗一次，避免批量向量化时刷屏
        const now = Date.now();
        if (typeof globalThis.bbShowErrorPopup === 'function' && (now - _lastEmbeddingErrorTime > 30000)) {
            _lastEmbeddingErrorTime = now;
            globalThis.bbShowErrorPopup('向量化失败', e.message || '未知错误', '端点: ' + (getSettings().embeddingEndpoint || '未配置'));
        }
        return null;
    }
}

// ═══ 调用分发 ═══

async function callApi(prompt, options = {}) {
    const settings = getSettings();
    if (settings.autoGenMode === 'custom' && settings.autoGenEndpoint) {
        return callCustomApi(prompt, options);
    }
    return callMainApi(prompt, options);
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


// ═══ 状态管理 ═══

let isProcessing = false;
let pendingMessages = [];
let processingTimer = null;

// v8.2.1 提取失败追踪（悬浮球重试按钮用）
export let lastExtractFailedFloor = null;
export function clearLastExtractFailedFloor() {
    lastExtractFailedFloor = null;
}

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

function reportProgress(phase, current, total, text) {
    if (typeof onAutoExtractProgress === 'function') {
        onAutoExtractProgress({ phase, current, total, text: text || '' });
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

// ═══ 合并提取（默认）═══

// v7.7.1 默认提示词片段（供自定义设置恢复默认时参考）
const DEFAULT_CORE_PRINCIPLES = `## 核心原则
═══════════════════════════════════════════════════════

**1. 契诃夫之枪**：如果第一幕挂着枪，第三幕它必须开火。
  → 记录每一把"枪"的存在（承诺、威胁、预言、可疑物品）。
  → 标记它的状态：待发射 / 已发射 / 哑火。

**2. 展示而非说教（Show, Don't Tell）**：
  → 记忆不是事件报告，而是让阅读者"感受到"发生了什么。
  → ✗ "玩家很恐惧" ✓ "玩家的指尖微微颤抖，只一瞬，便攥紧了拳头"

**3. 潜台词即内容（Subtext is Content）**：
  → 角色没说出口的往往比说出口的更重要。
  → 沉默、省略、岔开话题——这些本身就是信息。

**4. 冲突驱动叙事（Conflict Drives Story）**：
  → 一切值得记住的时刻都源于冲突：人与人的、人与自己的、人与世界的。
  → 没有冲突也有情感——等待、思念、安心，这些也是"故事"。`;

const DEFAULT_EXTRACTION_DIMENSIONS = `## 记忆提取维度（满足任一即提取）
═══════════════════════════════════════════════════════

**▎① 情感节拍 (Emotional Beats)：**
- 角色出现新的情感反应，或已有情感的强度发生明显变化
- 情感与行动的冲突：内心想做A，现实迫使做B
- 压抑/隐藏的情感被某个瞬间触发
- 脆弱时刻：暴露弱点、承认错误、表达真实需求
- 喜悦与温暖：被关心的瞬间、愿望成真、久别重逢

**▎② 关系温度 (Relationship Temperature)：**
- 信任/亲密度/敌意的可感知变化
- 关系转折信号：试探→退缩→坦诚→和解 / 靠近→疏远→背叛
- 权力关系的微妙转移：谁在引导对话？谁在妥协？
- 潜台词：沉默、省略、回避中未言明的情感

**▎③ 角色特征 (Character Traits)：**
- 习惯与仪式：重复出现的行为模式、日常惯例
  （"每天早上煮一壶咖啡"→日常陪伴核心；"每次说谎都摸耳垂"→伏笔信号）
- 偏好锚点：角色明确表达过的喜欢/讨厌/恐惧/向往
  （"我怕打雷""我最喜欢栀子花的味道""我讨厌别人碰我的书"）
- 性格一致性的显现：这一次的选择如何体现/违背了这个角色的性格？

**▎④ 角色弧线 (Character Arc)：**
- 角色做出与以往不同的选择，展现成长或退步
- 价值观、信念受到挑战或强化
- 新揭示的背景故事、隐藏动机、秘密
- 角色认知偏差：角色以为的 vs 叙事实情 —— 这个差距是戏剧张力的来源

**▎⑤ 未兑现的承诺 (Unfulfilled Promises)：**
- 角色说出的"将要/计划/打算/改天"——标记为"待兑现"
- 约定、誓言、赌约、威胁——这些是未来剧情的发动机
- 被推迟但未取消的决定

**▎⑥ 冲突种子 (Conflict Seeds)：**
- 角色间的利益冲突、价值观分歧、隐藏的敌意
- 第三方势力的提及（即使本场景未出现）
- 资源/信息的不对称 → 可能引发后续事件
- 警告、预言、暗示——尚未应验的

**▎⑦ 悬而未决的问题 (Open Questions)：**
- 当前无法解释的现象、反常的细节
- 角色注意到但未追究的异常
- 因果链条中的缺口、信息的缺失

**▎⑧ 情境反转的铺垫 (Reversal Setup)：**
- 过度自信的断言（→ 可能被打脸）
- 被忽视的细节（→ 可能成为关键）
- 看似无关的闲笔（→ 可能是伏笔）
- 角色认知与实际情况不符的暗示

**▎⑨ 世界观线索 (World-building Clues)：**
- 新揭示的世界规则、历史背景、势力格局
- 道具/场所的隐藏属性或历史渊源
- 民间传说、歌谣、典籍中提及的人/事/物

**▎⑩ 感官锚点 (Sensory Anchors)：**
- 能唤起记忆的感官细节：特定的气味、光线、温度、声响
- 这些细节让记忆在检索时能"身临其境"
- 示例："雨打在铁皮屋顶上的声音""她身上淡淡的栀子花香"`;

const MERGED_EXTRACTION_PROMPT = PROMPT_META_GUARD + `你是一个叙事记忆提取助手。从角色扮演对话中识别**情感流动**和**叙事线索**，
提取构成故事血肉的关键时刻。

**工作顺序**：先提取记忆，再根据记忆内容反推需要更新的 NPC/物品/时间线。

═══════════════════════════════════════════════════════
{{CORE_PRINCIPLES}}

═══════════════════════════════════════════════════════
{{EXTRACTION_DIMENSIONS}}

═══════════════════════════════════════════════════════
## 记忆字段
═══════════════════════════════════════════════════════
n=标题(3-8字，精准概括情感核心或线索核心)
tp=类型(event/emotion/habit/fact)
m=一句话摘要(10-20字，突出情感变化本质或线索关键)
c=完整内容(2-5句话，用展示而非说教的语言，保留上下文和感官细节)
v=重要原话(无则""，优先保留承诺/威胁/告白/预言/关键对白)
s=主体名 | a=目标名
i=重要性(0-1，对角色弧线/关系弧线或未来剧情的影响)
e=情感强度(0-1，当前时刻的情感冲击力)
st=故事时间(无则"")
g=标签数组(结构标签可选：情感类[恐惧/喜悦/愤怒/悲伤/温柔/压抑/释然/安心/思念]、
  关系类[信任/敌意/暧昧/和解/背叛/试探/依赖]、
  线索类[伏笔/待兑现/冲突种子/悬念/世界观/习惯/偏好]、
  叙事类[转折/高潮/铺垫/收束])
═══════════════════════════════════════════════════════
## 示例
═══════════════════════════════════════════════════════

【正剧场景示例】
{"n":"指尖的颤抖","tp":"emotion","m":"宣战后玩家难以掩饰恐惧，用握拳来压制","c":"雅赫摩斯宣布宣战后，玩家站在王座厅的阴影中，右手无意识地摩挲着剑柄上的缠绳。当侍从递上征召令时，他的指尖微微颤抖——只一瞬，便握紧了拳头。","v":"","s":"玩家","a":"","i":0.7,"e":0.8,"st":"123年4月15日","g":["恐惧","压抑","战争前夕","内心挣扎"]}

{"n":"老兵的苦笑","tp":"event","m":"酒馆老兵对速胜论露出意味深长的苦笑——暗示战争没那么简单","c":"玩家在酒馆谈论"一个月结束战争"时，邻桌老兵放下酒杯，嘴角扯出一丝苦笑，低声说"我三十年前也这么想"便起身离去。这句轻描淡写的话与主流论调形成尖锐反差。","v":"我三十年前也这么想","s":"无名老兵","a":"玩家","i":0.55,"e":0.4,"st":"123年4月15日","g":["伏笔","反差","老兵","暗示","世界观的复杂性"]}

【日常场景示例】
{"n":"雨天的默契","tp":"habit","m":"每周三下午他都会在咖啡馆靠窗的位子等她——一个未说破的约定","c":"连续第三周的星期三。下午三点十五分，他坐在靠窗的第二个位子上，面前摆着两杯咖啡——一杯已经凉了。门推开时带来一阵潮湿的风，她的伞还在滴水。他什么也没说，把热的那杯推了过去。","v":"","s":"他","a":"她","i":0.5,"e":0.45,"st":"","g":["习惯","默契","等待","温柔","潜台词"]}

{"n":"栀子花香","tp":"emotion","m":"她在花市闻到了童年外婆院子里的栀子花香，一时恍惚","c":"花市的人潮中，她突然停下脚步。是栀子花的味道——很淡，混在潮湿的空气里，差点就错过了。她闭上眼站了几秒，再睁开时眼眶有点红。"外婆走以后，我再也没闻到过这个味道了"，她小声说。","v":"外婆走以后，我再也没闻到过这个味道了","s":"她","a":"","i":0.4,"e":0.7,"st":"","g":["思念","感官锚点","童年记忆","脆弱时刻"]}

若无值得记忆的内容（极罕见），返回空数组 []。

═══════════════════════════════════════════════════════
## 辅助：NPC角色更新（可选，仅本轮新出现或变化的角色）
═══════════════════════════════════════════════════════

仅提取本轮首次登场或属性/关系发生明显变化的角色。
关注：角色弧线节点（立场转变、隐藏面揭示）、关系温度变化。

字段：n(姓名), r(身份/职业), p(性格特征，关注矛盾性和成长性), a(外貌), s(状态), l(位置)
rt=关系数组 [{"n":"关联角色名","r":"关系类型","a":"态度"}]
nt=分级(core/important/minor/background) | ic=一行索引卡(含弧线阶段) | g=标签数组

若无新角色或变化，返回空数组。

═══════════════════════════════════════════════════════
## 辅助：物品更新（可选，仅本轮新出现或状态变化的物品）
═══════════════════════════════════════════════════════

仅提取本轮首次出现或状态改变的有意义物品。
关注：象征维度（代表什么？）、作为伏笔的潜力（何时可能被使用？）。

字段：n(物品名), o(持有者), s(状态:held/used/lost/destroyed)
sig=意义描述(兼顾实用与象征意义), kp=true/false
it=分级(key/equipped/clue/consumable/background) | g=标签数组

若无新物品或变化，返回空数组。

═══════════════════════════════════════════════════════
## 辅助：时间线里程碑（可选，仅记录真正重要的故事节点）
═══════════════════════════════════════════════════════

时间线是故事里程碑，不是日记流水账。
记录门槛：时间跨越一天以上 / 故事阶段转换 / 重大冲突起止 / 核心关系质变 / 剧情关键揭示 / 叙事节奏明显变化

字段：t(故事时间), e(事件摘要), p(参与者数组), l(地点),
active=true/false, imp(对叙事弧线的影响), g(标签数组含节奏标签[起点/转折/高潮/收束/承上启下])

若未达里程碑级别，返回空数组。

═══════════════════════════════════════════════════════
## 输出格式
═══════════════════════════════════════════════════════

返回纯JSON对象（不要markdown代码块）：
{"memories":[...记忆数组，核心输出...], "npc":[...], "items":[...], "timeline":[...]}

{{CALENDAR_REF}}
{{STYLE_BIAS}}

[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

function parseMergedResponse(responseText) {
    if (!responseText || !responseText.trim()) {
        console.warn('[BB-Memory] 合并提取响应为空');
        return { npc: [], items: [], timeline: [], memories: [] };
    }
    let text = responseText.trim();
    // META_DIALOGUE 检测（安全网：即便 extractMergedStage 已检查，解析阶段也再确认一次）
    if (text.toUpperCase().startsWith('META_DIALOGUE')) {
        console.log('[BB-Memory] parseMergedResponse: 检测到 META_DIALOGUE，返回空数据');
        return { npc: [], items: [], timeline: [], memories: [], metaDialogue: true };
    }
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    // 先尝试匹配 JSON 对象；若失败则尝试数组
    let match = text.match(/\{[\s\S]*\}/);
    let parsed;
    if (match) {
        try {
            parsed = JSON.parse(match[0]);
        } catch (e) { /* 对象解析失败，尝试数组 */ }
    }
    // 如果对象解析失败，或者匹配到的是数组（LLM 可能忽略 system prompt）
    if (!parsed || Array.isArray(parsed)) {
        if (!parsed) {
            match = text.match(/\[[\s\S]*\]/);
            if (!match) {
                console.warn('[BB-Memory] 合并提取响应未找到JSON，前200字符:', text.slice(0, 200));
                return { npc: [], items: [], timeline: [], memories: [] };
            }
            try { parsed = JSON.parse(match[0]); } catch (e2) {
                console.warn('[BB-Memory] 合并响应JSON解析失败:', e2.message, '前200字符:', text.slice(0, 200));
                return { npc: [], items: [], timeline: [], memories: [] };
            }
        }
        // 如果解析结果是数组，尝试取第一个对象元素
        if (Array.isArray(parsed)) {
            if (parsed.length > 0 && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
                parsed = parsed[0];
            } else {
                console.warn('[BB-Memory] 合并提取响应为数组但无可用的对象元素');
                return { npc: [], items: [], timeline: [], memories: [] };
            }
        }
    }
    try {
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

function getStyleBias() {
    const settings = getSettings();
    const style = settings.extractionStyle || 'auto';
    switch (style) {
        case 'daily': return STYLE_BIAS_DAILY;
        case 'drama': return STYLE_BIAS_DRAMA;
        case 'custom': return settings.customExtractionBias || '';
        default: return '';  // 'auto' — 不追加偏置
    }
}

/**
 * v7.7.1 动态构建合并提取提示词
 * 支持自定义核心原则、提取维度，以及注入故事历法描述
 */
function buildMergedPrompt(settings, styleBias, calDesc) {
    const s = settings || {};
    calDesc = (calDesc && calDesc.trim()) || '';
    const calRef = calDesc ? `\n**世界历法参考**：${calDesc}\n（仅用于推断故事时间，无需计算天数）` : '';

    let prompt = MERGED_EXTRACTION_PROMPT;

    // 注入自定义核心原则（精确字符串替换）
    prompt = prompt.replace('{{CORE_PRINCIPLES}}', (s.customCorePrinciples || '').trim() || DEFAULT_CORE_PRINCIPLES);
    prompt = prompt.replace('{{EXTRACTION_DIMENSIONS}}', (s.customExtractionDimensions || '').trim() || DEFAULT_EXTRACTION_DIMENSIONS);

    // 注入历法参考和风格偏置
    prompt = prompt.replace('{{CALENDAR_REF}}', calRef);
    prompt = prompt.replace('{{STYLE_BIAS}}', styleBias || '');

    return prompt;
}

async function callMergedExtraction(chatId, userMessage, aiMessage) {
    const settings = getSettings();
    const styleBias = getStyleBias();
    const calDesc = await getCalendarDescription(chatId);
    const prompt = buildMergedPrompt(settings, styleBias, calDesc)
        .replace('{{userMessage}}', userMessage || '(无)')
        .replace('{{aiMessage}}', cleanAiMessage(aiMessage) || '(无)');

    const responseText = await callApi(prompt, { isMerged: true });
    if (responseText && responseText.trim().toUpperCase().startsWith('META_DIALOGUE')) {
        console.log('[BB-Memory] 检测到纯元对话，跳过提取');
        return { isMetaDialogue: true, results: null };
    }
    const results = parseMergedResponse(responseText);
    return { isMetaDialogue: false, results };
}

async function extractMergedStage(chatId, userMessage, aiMessage, sourceInfo) {
    try {
        reportProgress('merged', 0, 5, '正在调用 AI 提取记忆...');
        const { isMetaDialogue, results } = await callMergedExtraction(chatId, userMessage, aiMessage);
        if (isMetaDialogue || !results) {
            reportProgress('merged', 5, 5, '提取完成（纯元对话已跳过）');
            return { isMetaDialogue: true, total: 0 };
        }
        let total = 0;
        reportProgress('merged', 1, 5, '正在解析提取结果...');
        reportProgress('merged', 2, 5, '正在保存 NPC/物品/时间线...');
        for (const npc of results.npc) { await upsertNpcProfile(chatId, { ...npc, ...(sourceInfo || {}) }); total++; }
        for (const item of results.items) { await upsertItem(chatId, { ...item, ...(sourceInfo || {}) }); total++; }
        for (const tl of results.timeline) { await upsertTimelineEntry(chatId, { ...tl, ...(sourceInfo || {}) }); total++; }
        const settings = getSettings();
        const maxPerExchange = settings.maxMemoriesPerExchange ?? 3;
        const limited = results.memories.slice(0, maxPerExchange);
        const existingMemories = await getMemories(chatId);
        const activeMemories = existingMemories.filter(m => m.embedding);
        const hasEmbedding = settings.embeddingEnabled && settings.embeddingEndpoint;
        reportProgress('merged', 3, 5, hasEmbedding ? '正在向量化记忆...' : '正在保存记忆条目...');
        for (const mem of limited) {
            const embedding = hasEmbedding
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
            await addMemory(chatId, { ...mem, embedding, memoryTier: 'stable', ...(sourceInfo || {}) });
            if (embedding) activeMemories.push({ embedding });
            total++;
        }
        reportProgress('merged', 4, 5, '正在汇总结果...');
        console.log('[BB-Memory] 合并提取: NPC' + results.npc.length + '/物品' + results.items.length + '/时间线' + results.timeline.length + '/记忆' + limited.length + ' (保存' + total + '条)');
        reportProgress('merged', 5, 5, '提取完成');
        return total;
    } catch (e) {
        console.warn('[BB-Memory] 合并提取失败:', e.message);
        reportProgress('merged', 5, 5, '提取失败: ' + (e.message || '未知错误'));
        if (typeof globalThis.bbShowErrorPopup === 'function') {
            globalThis.bbShowErrorPopup('AI 提取失败', e.message || '未知错误', '端点: ' + (getSettings().autoGenMode === 'custom' ? (getSettings().autoGenEndpoint || '未配置') : '主 API'));
        }
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

    // v6.3.0: 恢复阈值检查 — 等攒够窗口数量的待提取 exchange 后才开始提取
    const minPending = settings.contextWindowExchanges ?? 3;
    if (exchanges.length < minPending) return;

    // v8.0.0 批量提取：每次取 batchExtractionCount 个 exchange，并行请求 API
    const batchCount = Math.min(settings.batchExtractionCount || 1, exchanges.length);
    const batch = exchanges.slice(0, batchCount);

    // 检查 batch 中第一个是否已处理
    if (await isExchangeProcessed(chatId, batch[0].hash)) return;

    // 记录成功处理的 exchange（用于后续标记）
    const succeeded = [];

    try {
        if (confirmMode === 'active') {
            // Active 模式：逐个提取，结果存入待审核队列由用户确认后保存
            for (const ex of batch) {
                if (await isExchangeProcessed(chatId, ex.hash)) continue;
                try {
                    const { isMetaDialogue, results } = await callMergedExtraction(chatId, ex.userMessage, ex.aiMessage);
                    if (isMetaDialogue || !results) {
                        console.log('[BB-Memory] Active模式检测到纯元对话，跳过');
                        continue;
                    }
                    const sourceInfo = {
                        sourceExchange: ex.hash,
                        sourceFloor: ex.aiIndex,
                        sourceChatId: chatId,
                        sourceMessageHash: cyrb53Hash(ex.aiMessage || ''),
                    };
                    // NPC/物品/时间线直接保存
                    for (const npc of results.npc) { await upsertNpcProfile(chatId, { ...npc, ...sourceInfo }); }
                    for (const item of results.items) { await upsertItem(chatId, { ...item, ...sourceInfo }); }
                    for (const tl of results.timeline) { await upsertTimelineEntry(chatId, { ...tl, ...sourceInfo }); }
                    // 记忆条目存入待审核队列
                    if (results.memories.length > 0) {
                        pendingAutoCandidates.push(...results.memories.map(c => ({ ...c, _chatId: chatId, _sourceInfo: sourceInfo })));
                    }
                    succeeded.push(ex);
                } catch (e) {
                    console.warn('[BB-Memory] Active模式单个 exchange 提取失败:', e.message);
                    lastExtractFailedFloor = ex.aiIndex;
                }
            }
        } else {
            // v8.0.0 并行请求：每个 exchange 独立调用 API，同时发出
            const tasks = batch.map(async (ex) => {
                if (await isExchangeProcessed(chatId, ex.hash)) return null;
                const sourceInfo = {
                    sourceExchange: ex.hash,
                    sourceFloor: ex.aiIndex,
                    sourceChatId: chatId,
                    sourceMessageHash: cyrb53Hash(ex.aiMessage || ''),
                };
                try {
                    const result = await extractMergedStage(chatId, ex.userMessage, ex.aiMessage, sourceInfo);
                    if (result && result.isMetaDialogue) {
                        console.log('[BB-Memory] 并行提取：检测到纯元对话，跳过');
                        return null;
                    }
                    return ex;
                } catch (e) {
                    console.warn('[BB-Memory] 并行提取单个 exchange 失败:', e.message);
                    lastExtractFailedFloor = ex.aiIndex;  // v8.2.1 记录失败楼层供悬浮球重试
                    return null;
                }
            });

            const results = await Promise.allSettled(tasks);
            for (const r of results) {
                if (r.status === 'fulfilled' && r.value) {
                    succeeded.push(r.value);
                }
            }
        }
    } catch (e) {
        console.warn('[BB-Memory] 提取处理异常:', e.message);
        // v8.2.1 外層异常通常说明批量某一步骤整体挂了
        if (batch.length > 0) lastExtractFailedFloor = batch[0].aiIndex;
    }

    // v8.0.0 批量标记所有成功处理的 exchange
    for (const ex of succeeded) {
        await markExchangeExtracted(ex.userIndex, ex.aiIndex, ex.hash);
    }

    // v6.7.0: 线程自动更新检测（按成功处理的 exchange 数计数）
    if (getSettings().timelineSummaryEnabled) {
        const counter = (getSettings()._threadUpdateCounter || 0) + succeeded.length;
        const threshold = getSettings()._threadUpdateThreshold || 5;
        updateSettings({ _threadUpdateCounter: counter });
        if (counter >= threshold) {
            updateSettings({ _threadUpdateCounter: 0 });
            setTimeout(async () => {
                try {
                    const { regenerateThreadSummary } = await import('./memory-maintainer.js');
                    await regenerateThreadSummary(chatId);
                    console.log('[BB-Memory] 线程总结自动更新完成');
                } catch (e) { /* 静默失败 */ }
            }, 3000);
        }
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
    const { onProgress, sourceInfo } = options;
    const results = { npc: 0, items: 0, timeline: 0, memories: 0 };

    if (onProgress) onProgress({ stage: 'merged', progress: '正在 AI 提取记忆（合并模式）...' });

    const settings = getSettings();
    const styleBias = getStyleBias();
    const calDesc = await getCalendarDescription(chatId);
    const prompt = buildMergedPrompt(settings, styleBias, calDesc)
        .replace('{{userMessage}}', contextText)
        .replace('{{aiMessage}}', '(见上下文)');

    try {
        const responseText = await callApi(prompt, { isMerged: true });
        if (responseText && responseText.trim().toUpperCase().startsWith('META_DIALOGUE')) {
            console.log('[BB-Memory] 批量提取检测到纯元对话，跳过');
            return results;
        }
        const parsed = parseMergedResponse(responseText);

        // v7.7.1 合并提取：一次 API 调用获取全部四柱
        for (const npc of parsed.npc) {
            await upsertNpcProfile(chatId, { ...npc, ...(sourceInfo || {}) });
            results.npc++;
        }
        for (const item of parsed.items) {
            await upsertItem(chatId, { ...item, ...(sourceInfo || {}) });
            results.items++;
        }
        for (const tl of parsed.timeline) {
            await upsertTimelineEntry(chatId, { ...tl, ...(sourceInfo || {}) });
            results.timeline++;
        }
        for (const mem of parsed.memories) {
            const embedding = (settings.embeddingEnabled && settings.embeddingEndpoint)
                ? await embedMemoryEntry(mem)
                : null;
            await addMemory(chatId, { ...mem, embedding, memoryTier: 'stable', ...(sourceInfo || {}) });
            results.memories++;
        }
    } catch (e) {
        console.warn('[BB-Memory] 合并提取失败:', e.message);
        if (typeof globalThis.bbShowErrorPopup === 'function') {
            globalThis.bbShowErrorPopup('AI 提取失败', e.message || '未知错误', '端点: ' + (getSettings().autoGenMode === 'custom' ? (getSettings().autoGenEndpoint || '未配置') : '主 API'));
        }
    }

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

        const sourceInfo = mem._sourceInfo || {};
        await addMemory(chatId, { ...mem, embedding, memoryTier: 'stable', source: mem.source || 'auto', ...sourceInfo });
        if (embedding) activeMemories.push({ embedding });
        count++;
        if (onProgress) onProgress(count, candidateMemories.length);
    }
    return count;
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
