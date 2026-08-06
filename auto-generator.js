/**
 * auto-generator.js —— BB-Memory v5.0 自动提取系统
 *
 * 当前实现：每个 exchange 使用一次合并提取调用，同时返回
 * memories / npc / items / milestones / locations / timeline。
 * 解析器仍按集合拆分结果并写入对应存储。
 */

import {
    getSettings, updateSettings, getMemories, addMemory, updateMemory,
    addNpcProfile, addItem, upsertMilestone,
    upsertTimeline, getTimeline,
    updateNpcProfile, updateItem, updateMilestone,
    getNpcProfiles, getItems, getMilestones,
    getCalendarDescription,
} from './memory-store.js';
import {
    getExtractableExchanges, markExchangeExtracted, isExchangeProcessed,
    markExchangeMetaSkipped, unmarkExchangeProcessed, computeExchangeHash, cyrb53Hash, refreshExtractionMarkers,
    syncMessageVisibility,
} from './message-state.js';
import { normalizeNpcTier, normalizeItemTier } from './entity-tiers.js';
import {
    DEFAULT_CONCRETE_TIME_RULE,
    DEFAULT_INITIALIZATION_PROMPT,
    fillPromptTemplate,
    getPromptTemplate,
} from './prompt-templates.js';
import { hydrateCollectionEmbeddings } from './vector-store.js';
import { findBestDuplicate, mergeEntityAliases, normalizeAliases } from './dedup-engine.js';

// ═══ v9.3.0 混合去重：文本指纹 + 结构字段 + 可选向量 ═══

function mergeMemoryFields(existing, incoming) {
    const mergeText = (base, next) => {
        const a = String(base || '').trim();
        const b = String(next || '').trim();
        if (!b || a.includes(b)) return a;
        if (!a || b.includes(a)) return b;
        return `${a}\n[补充] ${b}`;
    };
    const mergeTags = () => {
        const out = [];
        const seen = new Set();
        for (const tag of [...(existing.tags || []), ...(incoming.tags || [])]) {
            const name = String(typeof tag === 'string' ? tag : tag?.name || '').trim();
            const key = name.toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(typeof tag === 'string' ? { name, weight: 0.6 } : tag);
        }
        return out;
    };
    return {
        title: existing.title || incoming.title,
        content: mergeText(existing.content, incoming.content),
        summary: mergeText(existing.summary, incoming.summary),
        verbatim: incoming.verbatim || existing.verbatim,
        subject: existing.subject || incoming.subject,
        target: existing.target || incoming.target,
        storyTime: existing.storyTime || incoming.storyTime,
        truthStatus: incoming.truthStatus || existing.truthStatus,
        tags: mergeTags(),
        dedupReview: null,
        importance: Math.min(1.0, Math.max(existing.importance || 0.5, incoming.importance || 0.5) + 0.05),
        emotionalWeight: Math.max(existing.emotionalWeight || 0, incoming.emotionalWeight || 0),
        updatedAt: Date.now(),
    };
}

function dedupThresholds(pillar) {
    const settings = getSettings();
    return {
        autoMergeThreshold: pillar === 'memory'
            ? (settings.mergeSimilarityThreshold ?? 0.85)
            : (settings.entityMergeSimilarityThreshold ?? 0.90),
        reviewThreshold: settings.dedupReviewSimilarityThreshold ?? 0.74,
    };
}

function resolveAmbiguousDedupAction(decision) {
    if (!decision || decision.action !== 'review') return decision?.action || 'none';
    // 真值、持有者或地点存在冲突时，即使选择“积极合并”，也不得自动覆盖事实。
    if (decision.conflict) return 'save_review';
    const action = getSettings().dedupAmbiguousAction || 'save_review';
    if (action === 'merge' || action === 'skip') return action;
    return 'save_review';
}

function makeDedupReview(decision, pillar) {
    return decision ? {
        candidateId: decision.entry?.id || '',
        candidateTitle: decision.entry?.title || decision.entry?.name || '',
        pillar,
        score: Number(decision.score.toFixed(4)),
        similarity: Number(decision.score.toFixed(4)),
        reason: decision.reason || '疑似重复',
        createdAt: Date.now(),
    } : null;
}

function mergeUniqueBy(items, keyFn) {
    const out = [];
    const seen = new Set();
    for (const item of items || []) {
        const key = keyFn(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function mergeEntityPatch(pillar, existing, incoming) {
    const text = (base, next) => {
        const a = String(base || '').trim();
        const b = String(next || '').trim();
        if (!b || a.includes(b)) return a;
        if (!a || b.includes(a)) return b;
        return `${a}\n[补充] ${b}`;
    };
    const common = {
        ...incoming,
        name: existing.name || incoming.name,
        aliases: mergeEntityAliases(existing, incoming),
        tags: mergeUniqueBy([...(existing.tags || []), ...(incoming.tags || [])], tag => String(typeof tag === 'string' ? tag : tag?.name || '').toLowerCase()),
        dedupReview: null,
    };
    delete common.existingId;
    if (pillar === 'npc') {
        return {
            ...common,
            role: incoming.role || existing.role,
            personality: text(existing.personality, incoming.personality),
            appearance: text(existing.appearance, incoming.appearance),
            status: incoming.status || existing.status,
            location: incoming.location || existing.location,
            indexCard: incoming.indexCard || existing.indexCard,
            relationships: mergeUniqueBy([...(existing.relationships || []), ...(incoming.relationships || [])], rel => `${rel?.name || ''}|${rel?.type || ''}`.toLowerCase()),
        };
    }
    return {
        ...common,
        owner: incoming.owner || existing.owner,
        status: incoming.status || existing.status,
        location: incoming.location || existing.location,
        significance: text(existing.significance, incoming.significance),
        keepPermanent: Boolean(existing.keepPermanent || incoming.keepPermanent),
    };
}

async function saveEntityWithDedup(chatId, pillar, incoming, sourceInfo = {}) {
    const settings = getSettings();
    const loader = pillar === 'npc' ? getNpcProfiles : getItems;
    const updater = pillar === 'npc' ? updateNpcProfile : updateItem;
    const creator = pillar === 'npc' ? addNpcProfile : addItem;
    const existingEntries = await loader(chatId);
    if (incoming.embedding) await hydrateCollectionEmbeddings(chatId, existingEntries);
    const explicit = incoming.existingId ? existingEntries.find(entry => entry.id === incoming.existingId) : null;
    const decision = settings.entityDedupEnabled
        ? (explicit ? { entry: explicit, score: 1, reason: 'AI 复用已有实体 ID', action: 'merge', conflict: false }
            : findBestDuplicate(pillar, incoming, existingEntries, dedupThresholds(pillar)))
        : null;
    const action = resolveAmbiguousDedupAction(decision);

    if (decision && action === 'merge') {
        const entry = await updater(chatId, decision.entry.id, {
            ...mergeEntityPatch(pillar, decision.entry, incoming),
            ...sourceInfo,
        });
        return { entry, action: 'merged', decision };
    }
    if (decision && action === 'skip') {
        return { entry: decision.entry, action: 'skipped', decision };
    }

    const clean = { ...incoming };
    delete clean.existingId;
    if (decision) {
        clean.dedupReview = makeDedupReview(decision, pillar);
        try {
            globalThis.bbMemoryRecordActivity?.('warning', '疑似重复待审核', `${pillar === 'npc' ? 'NPC' : '物品'}「${incoming.name}」与「${decision.entry?.name || ''}」相似 ${(decision.score * 100).toFixed(0)}%`);
        } catch {}
    }
    const entry = await creator(chatId, { ...clean, ...sourceInfo });
    return { entry, action: decision ? 'review' : 'created', decision };
}

function findMemoryDedupDecision(memory, embedding, existingMemories) {
    if (!getSettings().dedupEnabled) return null;
    return findBestDuplicate('memory', { ...memory, embedding }, existingMemories, dedupThresholds('memory'));
}

// ═══ 四个提取提示词 ═══

const PROMPT_META_GUARD = `你是一个角色扮演(RP)叙事记忆提取助手。

**职责**：从角色扮演对话中提取记忆条目（必做），以及可选的 NPC/物品/里程碑/时间线更新。

**内容边界**：
❌ 不提取：用户给AI的元指令、OOC标注、系统设置、风格指导
❌ 不提取：AI的自我介绍、能力声明、工具说明
✅ 只提取：角色扮演中的剧情内容、角色互动、情感交流
✅ 用户发言同样是记忆来源：当用户以玩家/主角身份表达偏好、背景、目标、承诺、选择、恐惧、关系态度或身体/情绪状态时，必须作为玩家/主角信息提取。

**混合内容处理**：
- 如果消息中既有RP剧情又夹着元指令（如"(我们跳过三天)""角色应该知道..."），
  忽略元指令部分，只提取RP剧情内容。
- 如果整条消息都是元对话、不包含任何RP剧情，只输出一句话：META_DIALOGUE

**提取优先级（重要）**：
- 🅼 记忆条目：优先提取真正值得长期保留的剧情、情感、习惯、事实。不要为了凑数制造记忆。
- 🅽 NPC 更新：可选。仅当新角色出场或已知角色属性/关系发生明显变化时。
- 🅸 物品更新：可选。仅当新物品出现或已知物品状态/持有者改变时。
- 🅻 里程碑：可选且克制。仅当出现重要关系变化、剧情拐点、伏笔兑现或阶段结果时记录。
- 🆃 时间线：可选。仅用于持续存在的主线、支线、情感线或世界线，不记录单个普通事件。

**字段完整性要求（强制）**：
- 一旦决定输出某个条目，就要优先、尽量填写该条目的所有字段；不要因为字段可选就省略可从上下文推断的信息。
- 时间、主体、目标、地点、参与者、状态、关系、持有者、标签都属于重要信息；能从上下文推断就必须填写。
- 只有原文和上下文都没有依据时，才留空或写“时间未明”；不要编造事实或日期。

`;



// ═══ 风格偏置指令 ═══

const STYLE_BIAS_DAILY = `
**当前为【日常陪伴】模式。调整提取侧重：**

优先提取：
- 角色特征（习惯/仪式/偏好锚点）——记住TA喜欢什么、怕什么、每天做什么
- 情感节拍中的温暖与脆弱面——被关心的瞬间、小小的喜悦、安全感
- 关系温度的微妙变化——默契的建立、内部梗的诞生、无声的理解
- 具体事实锚点——人物、地点、约定、物品状态、关键原话

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
                aliases: normalizeAliases(item.al || item.aliases),
                existingId: typeof (item.eid || item.existingId) === 'string' ? String(item.eid || item.existingId).trim() : '',
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
                aliases: normalizeAliases(item.al || item.aliases),
                existingId: typeof (item.eid || item.existingId) === 'string' ? String(item.eid || item.existingId).trim() : '',
                owner: typeof item.o === 'string' ? item.o.trim() : '',
                status: ['held', 'used', 'lost', 'destroyed'].includes(item.s) ? item.s : 'held',
                significance: typeof item.sig === 'string' ? item.sig.trim() : '',
                location: typeof item.l === 'string' ? item.l.trim() : '',
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

function parseTimelineThreadResponse(responseText) {
    const text = cleanJsonText(responseText);
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : (parsed && parsed.n ? [parsed] : []);
        return arr
            .filter(item => item && (item.n || item.name) && typeof (item.n || item.name) === 'string')
            .map(item => ({
                name: String(item.n || item.name || '').trim(),
                type: ['plot', 'emotional', 'side', 'world'].includes(item.tp || item.type) ? (item.tp || item.type) : 'plot',
                status: ['ongoing', 'paused', 'ended', 'archived', 'resident'].includes(item.st || item.status) ? (item.st || item.status) : 'ongoing',
                priority: ['high', 'medium', 'low'].includes(item.p || item.priority) ? (item.p || item.priority) : 'medium',
                summary: typeof (item.s || item.summary) === 'string' ? String(item.s || item.summary).trim() : '',
                entries: Array.isArray(item.entries) ? item.entries : [],
                source: 'auto',
            }));
    } catch (e) {
        if (getSettings().debugLogging) console.warn('[BB-Memory] 时间线响应解析失败:', e.message);
        return [];
    }
}

function normalizeTimelineFingerprintText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[\s"'“”‘’.,，。:：;；!?！？、()[\]【】{}<>《》·\-—_/\\]+/g, '')
        .trim();
}

function getTimelineFingerprint(entry) {
    const period = normalizeTimelineFingerprintText(entry?.storyTime || entry?.period || entry?.time || entry?.t || '');
    const event = normalizeTimelineFingerprintText(entry?.event || entry?.title || entry?.summary || entry?.note || entry?.e || '');
    if (!event) return null;
    return { full: `${period}|${event}`, event, hasPeriod: Boolean(period) };
}

function buildThreadTimelineIndex(threads = []) {
    const full = new Set();
    const eventWithoutPeriod = new Set();
    for (const thread of threads || []) {
        for (const entry of (thread.entries || [])) {
            const fp = getTimelineFingerprint(entry);
            if (!fp) continue;
            full.add(fp.full);
            if (!fp.hasPeriod) eventWithoutPeriod.add(fp.event);
        }
    }
    return { full, eventWithoutPeriod };
}

function isForeshadowTimeline(entry) {
    const tagText = (entry?.tags || [])
        .map(tag => typeof tag === 'string' ? tag : tag?.name)
        .filter(Boolean)
        .join(' ');
    return entry?.status === 'foreshadow' || /伏笔|待兑现|待揭示/.test(tagText);
}

function isImportantTimeline(entry) {
    return entry?.resident === true
        || entry?.keepPermanent === true
        || entry?.memoryTier === 'core'
        || entry?.memoryTier === 'eternal'
        || isForeshadowTimeline(entry);
}

function isTimelineCoveredByThread(entry, threadIndex) {
    const fp = getTimelineFingerprint(entry);
    if (!fp) return false;
    if (threadIndex.full.has(fp.full)) return true;
    if (!fp.hasPeriod && [...threadIndex.full].some(key => key.endsWith(`|${fp.event}`))) return true;
    return threadIndex.eventWithoutPeriod.has(fp.event);
}

function filterTimelineCoveredByThreads(result) {
    const legacyTimelineAsMilestones = !result?.milestones?.length && looksLikeMilestoneArray(result?.timeline);
    const milestonesIn = result?.milestones || (legacyTimelineAsMilestones ? result?.timeline : []);
    if (!result || !Array.isArray(milestonesIn) || !milestonesIn.length) return result;
    const threadIndex = buildThreadTimelineIndex(result.timeline || result.threads || []);
    if (!threadIndex.full.size && !threadIndex.eventWithoutPeriod.size) return result;
    let skipped = 0;
    const milestones = milestonesIn.filter(entry => {
        if (isImportantTimeline(entry)) return true;
        if (!isTimelineCoveredByThread(entry, threadIndex)) return true;
        skipped++;
        return false;
    });
    if (skipped && getSettings().debugLogging) {
        console.log(`[BB-Memory] 里程碑降噪：${skipped} 条已由时间线覆盖，跳过保存/注入`);
    }
    return { ...result, milestones, timeline: legacyTimelineAsMilestones ? [] : (result.timeline || []), threads: result.threads || result.timeline || [] };
}

function looksLikeMilestoneArray(entries) {
    return Array.isArray(entries) && entries.some(entry =>
        entry && typeof entry === 'object'
        && (entry.e || entry.event || entry.storyTime || entry.impact)
        && !(entry.n || entry.name)
        && !Array.isArray(entry.entries)
    );
}

// v8.7.0 地点解析器
function parseLocationResponse(responseText) {
    const text = cleanJsonText(responseText);
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : (parsed && parsed.n ? [parsed] : []);
        return arr
            .filter(item => item && item.n && typeof item.n === 'string')
            .map(item => ({
                name: (item.n || '').trim(),
                description: typeof item.desc === 'string' ? item.desc.trim() : '',
                region: typeof item.reg === 'string' ? item.reg.trim() : '',
                realWorldRef: typeof item.rw === 'string' ? item.rw.trim() : '',
                edges: Array.isArray(item.conn)
                    ? item.conn.filter(c => c && c.to).map(c => ({
                        toName: c.to, distance: c.dist || '', pathType: c.type || '',
                        difficulty: ['easy','normal','hard'].includes(c.diff) ? c.diff : 'normal',
                    }))
                    : [],
                source: 'auto',
            }));
    } catch (e) {
        if (getSettings().debugLogging) console.warn('[BB-Memory] 地点响应解析失败:', e.message);
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
    // 安全检查：必须是 http 或 https 协议
    if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
        throw new Error('API endpoint 必须使用 http:// 或 https:// 协议');
    }
    if (cleaned.endsWith('/chat/completions')) return cleaned;
    if (cleaned.endsWith('/v1')) return cleaned + '/chat/completions';
    return cleaned + '/v1/chat/completions';
}

function normalizeEmbeddingEndpoint(url) {
    let cleaned = url.trim().replace(/\/+$/, '');
    // 安全检查：必须是 http 或 https 协议
    if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
        throw new Error('Embedding endpoint 必须使用 http:// 或 https:// 协议');
    }
    if (cleaned.endsWith('/embeddings')) return cleaned;
    if (cleaned.endsWith('/v1')) return cleaned + '/embeddings';
    return cleaned + '/v1/embeddings';
}

const DEFAULT_API_JSON_SYSTEM_PROMPT = '你是一个JSON格式的记忆提取助手。只输出{{formatHint}}，不要包含其他文字。';

export async function callMainApi(prompt, options = {}) {
    const { generateRaw } = SillyTavern.getContext();
    const formatHint = options.isMerged ? '纯JSON对象' : '纯JSON';
    const systemPrompt = fillPromptTemplate(
        getPromptTemplate(getSettings(), 'extract.apiJsonSystem', DEFAULT_API_JSON_SYSTEM_PROMPT),
        { formatHint }
    );
    const result = await generateRaw({
        systemPrompt,
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
    const systemPrompt = fillPromptTemplate(
        getPromptTemplate(settings, 'extract.apiJsonSystem', DEFAULT_API_JSON_SYSTEM_PROMPT),
        { formatHint }
    );

    const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${autoGenApiKey}`,
        },
        body: JSON.stringify({
            model: autoGenModel || 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: systemPrompt },
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
    const tags = (mem.tags || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean).join(' ');
    const threadEntries = Array.isArray(mem.entries)
        ? mem.entries.map(e => [e.period || e.storyTime || e.time, e.event || e.title || e.summary || e.note, e.status].filter(Boolean).join(' ')).join('\n')
        : '';
    const relations = Array.isArray(mem.relationships)
        ? mem.relationships.map(r => [r.name, r.type, r.attitude].filter(Boolean).join(' ')).join('\n')
        : '';
    const edges = Array.isArray(mem.edges)
        ? mem.edges.map(e => [e.toName || e.toId || e.to, e.distance, e.pathType || e.type, e.difficulty].filter(Boolean).join(' ')).join('\n')
        : '';
    const text = [
        mem.title, mem.name, mem.summary, mem.content, mem.description,
        mem.event, mem.significance, mem.role, mem.personality,
        mem.location, mem.region, mem.subject, mem.target, threadEntries,
        relations, edges, tags,
    ].filter(Boolean).join('\n').slice(0, 1200);
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

const DEFAULT_EXTRACTION_MESSAGE_TAGS = Object.freeze(['content', 'context', 'status']);

function normalizeExtractionMessageTags(tags) {
    const source = Array.isArray(tags) ? tags : DEFAULT_EXTRACTION_MESSAGE_TAGS;
    const out = [];
    const seen = new Set();
    for (const raw of source) {
        const tag = String(raw || '')
            .trim()
            .replace(/^<\/?/, '')
            .replace(/>$/, '')
            .toLowerCase();
        if (!/^[a-z][\w:-]{0,63}$/.test(tag) || seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
    }
    return out;
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractConfiguredTagBlocks(text, tags) {
    const parts = [];
    for (const tag of tags) {
        const re = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`, 'gi');
        let match;
        while ((match = re.exec(text)) !== null) {
            const body = String(match[1] || '').trim();
            if (!body) continue;
            parts.push(`【${tag}】\n${body}`);
        }
    }
    return parts.join('\n\n').trim();
}

function cleanAiMessage(text) {
    if (!text) return '';
    let cleaned = text;
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const selectedTags = normalizeExtractionMessageTags(getSettings().extractionMessageTags);
    if (selectedTags.length) {
        const taggedText = extractConfiguredTagBlocks(cleaned, selectedTags);
        if (taggedText) return taggedText;
    }
    cleaned = cleaned.replace(/\[[\w\s:/.-]+\]/g, '');
    return cleaned.trim();
}

// ═══ 构建 Prompt（注入对话） ═══


// ═══ 状态管理 ═══

let processingTimer = null;
let processingChain = Promise.resolve();
let pendingProcessingWaiters = [];

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

const CANDIDATE_PILLARS = {
    npc: { group: 'npc', label: 'NPC' },
    item: { group: 'item', label: '物品' },
    milestone: { group: 'milestone', label: '里程碑' },
    timeline: { group: 'timeline', label: '时间线' },
    thread: { group: 'timeline', label: '时间线' },
    location: { group: 'location', label: '地点' },
    memory: { group: 'memory', label: '记忆' },
};

function cloneCandidatePayload(payload) {
    if (!payload || typeof payload !== 'object') return {};
    try {
        return JSON.parse(JSON.stringify(payload));
    } catch {
        return { ...payload };
    }
}

function makeCandidateId(pillar, index, sourceInfo = {}) {
    const floor = Number.isInteger(sourceInfo.sourceFloor) ? sourceInfo.sourceFloor : 'x';
    return `cand_${pillar}_${floor}_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 7)}`;
}

function formatTagNames(tags) {
    if (!Array.isArray(tags)) return '';
    return tags
        .map(tag => typeof tag === 'string' ? tag : tag?.name)
        .filter(Boolean)
        .join(', ');
}

function buildCandidateDisplay(pillar, payload = {}) {
    switch (pillar) {
        case 'npc':
            return {
                type: payload.npcTier || 'minor',
                title: payload.name || '未命名 NPC',
                summary: [payload.role, payload.personality, payload.status, payload.location].filter(Boolean).join(' / '),
            };
        case 'item':
            return {
                type: payload.itemTier || payload.status || 'item',
                title: payload.name || '未命名物品',
                summary: [payload.owner ? `持有者:${payload.owner}` : '', payload.status, payload.location, payload.significance].filter(Boolean).join(' / '),
            };
        case 'milestone':
            return {
                type: payload.injectionMode === 'vector' ? '向量命中' : (payload.status || '里程碑'),
                title: payload.event || payload.summary || '未命名里程碑',
                summary: [payload.storyTime, payload.location, payload.impact, formatTagNames(payload.tags)].filter(Boolean).join(' / '),
            };
        case 'timeline':
        case 'thread':
            return {
                type: payload.type || payload.status || 'timeline',
                title: payload.name || '未命名时间线',
                summary: [payload.status, payload.priority, payload.summary].filter(Boolean).join(' / '),
            };
        case 'location':
            return {
                type: payload.region || 'location',
                title: payload.name || '未命名地点',
                summary: [payload.region, payload.description, payload.realWorldRef].filter(Boolean).join(' / '),
            };
        case 'memory':
        default:
            return {
                type: payload.type || 'event',
                title: payload.title || payload.summary || payload.content?.slice(0, 40) || '未命名记忆',
                summary: [payload.summary, payload.storyTime, payload.subject, payload.target, formatTagNames(payload.tags)].filter(Boolean).join(' / '),
            };
    }
}

export function buildExtractedCandidates(results, chatId, sourceInfo = {}) {
    const out = [];
    const push = (pillar, payload, index) => {
        if (!payload || typeof payload !== 'object') return;
        const meta = CANDIDATE_PILLARS[pillar] || CANDIDATE_PILLARS.memory;
        const display = buildCandidateDisplay(pillar, payload);
        out.push({
            id: makeCandidateId(pillar, index, sourceInfo),
            pillar,
            group: meta.group,
            label: meta.label,
            type: display.type,
            title: display.title,
            summary: display.summary,
            payload: cloneCandidatePayload(payload),
            sourceInfo: { ...(sourceInfo || {}) },
            sourceFloor: sourceInfo?.sourceFloor,
            selected: true,
            _selected: true,
            _chatId: chatId,
        });
    };

    (results?.npc || []).forEach((entry, index) => push('npc', entry, index));
    (results?.items || []).forEach((entry, index) => push('item', entry, index));
    (results?.milestones || []).forEach((entry, index) => push('milestone', entry, index));
    (results?.timeline || []).forEach((entry, index) => push('timeline', entry, index));
    (results?.threads || []).forEach((entry, index) => push('timeline', entry, index));
    (results?.locations || []).forEach((entry, index) => push('location', entry, index));
    (results?.memories || []).forEach((entry, index) => push('memory', entry, index));
    return out;
}

// ═══ 进度回调 ═══

let onAutoExtractProgress = null;
let extractionTaskSequence = 0;
const extractionTasks = new Map();

const EXTRACTION_MODE_LABELS = Object.freeze({
    auto: '自动提取',
    manual: '手动提取',
    switch: '换楼提取',
    retry: '重新提取',
});

export function setAutoExtractProgressCallback(cb) {
    onAutoExtractProgress = cb;
}

function normalizeProgressFloors(floors = []) {
    return [...new Set((Array.isArray(floors) ? floors : [floors])
        .filter(n => Number.isInteger(n) && n >= 0))]
        .sort((a, b) => a - b);
}

function emitExtractionProgress(info) {
    if (typeof onAutoExtractProgress === 'function') {
        onAutoExtractProgress(info);
    }
}

export function beginExtractionProgress(meta = {}) {
    const id = `extract_${Date.now().toString(36)}_${++extractionTaskSequence}`;
    const floors = normalizeProgressFloors(meta.floors);
    const stepsPerFloor = Math.max(1, Number(meta.stepsPerFloor) || 5);
    const task = {
        taskId: id,
        state: 'running',
        mode: EXTRACTION_MODE_LABELS[meta.mode] ? meta.mode : 'auto',
        floors,
        floor: Number.isInteger(meta.floor) ? meta.floor : (floors[0] ?? null),
        phase: meta.phase || 'prepare',
        current: 0,
        total: meta.aggregate === true ? stepsPerFloor : Math.max(stepsPerFloor, stepsPerFloor * Math.max(1, floors.length)),
        stepsPerFloor,
        aggregate: meta.aggregate === true,
        floorProgress: {},
        text: meta.text || '准备中...',
        startedAt: Date.now(),
        result: null,
        error: '',
    };
    extractionTasks.set(id, task);
    emitExtractionProgress({ ...task, floorProgress: { ...task.floorProgress } });
    return id;
}

export function updateExtractionProgress(taskId, patch = {}) {
    const task = extractionTasks.get(taskId);
    if (!task || task.state !== 'running') return null;
    const floor = Number.isInteger(patch.floor) ? patch.floor : task.floor;
    if (task.aggregate && Number.isFinite(Number(patch.current))) {
        task.current = Math.max(task.current, Math.min(task.total, Number(patch.current) || 0));
    } else if (Number.isInteger(floor) && Number.isFinite(Number(patch.current))) {
        const step = Math.max(0, Math.min(task.stepsPerFloor, Number(patch.current) || 0));
        task.floorProgress[floor] = Math.max(Number(task.floorProgress[floor]) || 0, step);
        task.current = Object.values(task.floorProgress).reduce((sum, value) => sum + (Number(value) || 0), 0);
    } else if (Number.isFinite(Number(patch.current))) {
        task.current = Math.max(task.current, Number(patch.current) || 0);
    }
    if (Number.isInteger(floor)) task.floor = floor;
    if (patch.phase) task.phase = patch.phase;
    if (patch.text !== undefined) task.text = String(patch.text || '');
    if (patch.floors) task.floors = normalizeProgressFloors(patch.floors);
    emitExtractionProgress({ ...task, floorProgress: { ...task.floorProgress } });
    return task;
}

export function completeExtractionProgress(taskId, result = null, text = '提取完成') {
    const task = extractionTasks.get(taskId);
    if (!task) return null;
    task.state = 'done';
    task.phase = 'done';
    task.current = task.total;
    task.text = text;
    task.result = result;
    task.completedAt = Date.now();
    emitExtractionProgress({ ...task, floorProgress: { ...task.floorProgress } });
    extractionTasks.delete(taskId);
    return task;
}

export function failExtractionProgress(taskId, error, text = '') {
    const task = extractionTasks.get(taskId);
    if (!task) return null;
    const message = error?.message || String(error || '未知错误');
    task.state = 'failed';
    task.phase = 'failed';
    task.text = text || `提取失败：${message}`;
    task.error = message;
    task.completedAt = Date.now();
    emitExtractionProgress({ ...task, floorProgress: { ...task.floorProgress } });
    extractionTasks.delete(taskId);
    return task;
}

function reportProgress(phase, current, total, text, context = {}) {
    if (context.taskId) {
        updateExtractionProgress(context.taskId, {
            phase,
            current,
            total,
            text: text || '',
            floor: context.floor,
        });
        return;
    }
    emitExtractionProgress({
        taskId: '',
        state: current >= total && total > 0 ? (/失败|错误/.test(text || '') ? 'failed' : 'done') : 'running',
        mode: context.mode || 'auto',
        floors: normalizeProgressFloors(context.floors),
        floor: Number.isInteger(context.floor) ? context.floor : null,
        phase,
        current,
        total,
        text: text || '',
    });
}

function formatFloorList(indices) {
    return [...new Set(indices.filter(n => Number.isInteger(n) && n >= 0))]
        .sort((a, b) => a - b)
        .join(', ');
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
    if (!settings.enabled || !settings.autoGenEnabled) return { skipped: true, reason: 'disabled' };

    const chatId = getChatId();
    if (!chatId) return { skipped: true, reason: 'no-chat' };

    // 防抖
    const delay = _messageIndex === -1 ? 500 : 2500;
    if (processingTimer) clearTimeout(processingTimer);
    return new Promise((resolve, reject) => {
        pendingProcessingWaiters.push({ resolve, reject });
        processingTimer = setTimeout(() => {
            processingTimer = null;
            const waiters = pendingProcessingWaiters.splice(0);
            const run = processingChain.then(() => processLatestExchange(chatId));
            processingChain = run.catch(() => {});
            run.then(
                result => waiters.forEach(waiter => waiter.resolve(result)),
                error => waiters.forEach(waiter => waiter.reject(error)),
            );
        }, delay);
    });
}

// ═══ 合并提取（默认）═══

// v7.7.1 默认提示词片段（供自定义设置恢复默认时参考）
const DEFAULT_CORE_PRINCIPLES = `## 核心原则
═══════════════════════════════════════════════════════

**1. 契诃夫之枪**：如果第一幕挂着枪，第三幕它必须开火。
  → 记录每一把"枪"的存在（承诺、威胁、预言、可疑物品）。
  → 标记它的状态：待发射 / 已发射 / 哑火。

**2. 事实摘要优先**：
  → 记忆是给后续检索和注入使用的事实记录，不写文学化描写。
  → 保留人物、地点、事件、物品状态、关系变化和关键原话。
  → 时间写入 st/storyTime 字段，正文不要反复铺陈时间。

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

**▎⑩ 事实锚点 (Factual Anchors)：**
- 需要后续稳定复用的人物、地点、事件、物品状态、关系状态
- 关键原话：承诺、拒绝、威胁、告白、预言、规则说明
- 示例："贝找雅赫摩斯要商场会员卡""雅赫摩斯回复：不去"`;

const MERGED_EXTRACTION_PROMPT = PROMPT_META_GUARD + `你是一个叙事记忆提取助手。从角色扮演对话中识别**情感流动**和**叙事线索**，
提取构成故事血肉的关键时刻。

**工作顺序**：先提取记忆，再根据记忆内容反推需要更新的 NPC/物品/里程碑。

{{KNOWN_ENTITY_INDEX}}

**已有实体复用规则（强制）**：
- 如果本轮 NPC / 物品只是已有实体的别称、简称、量词变化或新增描述，必须沿用已有实体的标准名称，并填写 eid。
- al 用于补充本轮出现的新别名。不要仅因“白色睡裙 / 一条睡裙 / 白色刺猬睡裙”这类描述差异创建多个物品。
- 只有能确认是另一个独立人物或独立物品时，才输出为新实体并令 eid 为空。

**用户/玩家信息规则（必须遵守）**：
- 同时阅读“用户”和“角色”两侧内容；不要只总结角色回复。
- 用户以第一人称或操控主角表达的事实、偏好、目标、计划、承诺、拒绝、关系态度、伤势、情绪、能力、物品状态，都应进入 memories。
- 如果用户消息包含可长期复用的真实玩家偏好（例如想要的互动边界、叙事口味），只有在它不是临时 OOC 指令且会影响后续 RP 体验时才记录为 habit/fact。
- 纯 OOC 指令、格式要求、模型控制、风格命令仍然跳过；混合消息只提取其中的 RP/长期偏好部分。
- 主体字段优先写明确角色名；未知时用“玩家”或“主角”，不要默认忽略用户侧信息。

**字段填写总规则（强制）**：
- 已决定输出的每个记忆、NPC、物品、地点、里程碑和时间线条目，都要尽量填写完整字段。
- 尤其是时间字段：记忆条目的 st / storyTime 优先具体到年月日；能从当前对话、世界历法、上下文顺序或已有锚点推断，就必须填写具体故事时间。
- 无法确认时才写“时间未明”或留空；不要把可推断信息留空，也不要编造日期。

═══════════════════════════════════════════════════════
{{CORE_PRINCIPLES}}

═══════════════════════════════════════════════════════
{{EXTRACTION_DIMENSIONS}}

═══════════════════════════════════════════════════════
## 记忆字段
═══════════════════════════════════════════════════════
n=标题(3-8字，精准概括情感核心或线索核心)
tp=类型(event/emotion/habit/fact)
m=一句话摘要(10-20字，概括事实和长期复用点)
c=完整内容(1-3句事实摘要；保留人物、地点、事件、关键原话；不要文学化描写；时间留在st字段，不在正文重复铺陈)
v=重要原话(无则""，优先保留承诺/威胁/告白/预言/关键对白)
s=主体名 | a=目标名
i=重要性(0-1，对角色弧线/关系弧线或未来剧情的影响)
e=情感强度(0-1，当前时刻的情感冲击力)
st=具体故事时间(记忆条目优先写到年月日；无法推断才写"时间未明"或"")
g=标签数组(结构标签可选：情感类[恐惧/喜悦/愤怒/悲伤/温柔/压抑/释然/安心/思念]、
  关系类[信任/敌意/暧昧/和解/背叛/试探/依赖]、
  线索类[伏笔/待兑现/冲突种子/悬念/世界观/习惯/偏好]、
  叙事类[转折/高潮/铺垫/收束])
═══════════════════════════════════════════════════════
## 示例
═══════════════════════════════════════════════════════

【正剧场景示例】
{"n":"宣战反应","tp":"emotion","m":"雅赫摩斯宣战后玩家表现出恐惧并压制情绪","c":"雅赫摩斯宣布宣战。玩家听到征召令后表现出恐惧，并通过握紧拳头压制情绪。","v":"","s":"玩家","a":"雅赫摩斯","i":0.7,"e":0.8,"st":"王国历123年4月15日","g":["恐惧","战争前夕","关系状态"]}

{"n":"老兵警告","tp":"event","m":"酒馆老兵用亲历经验否定速胜论","c":"玩家在酒馆谈到“一个月结束战争”。邻桌老兵回应：“我三十年前也这么想”，暗示战争不会如众人预期那样简单。","v":"我三十年前也这么想","s":"无名老兵","a":"玩家","i":0.55,"e":0.4,"st":"王国历123年4月15日","g":["伏笔","老兵","战争"]}

【日常场景示例】
{"n":"咖啡馆约定","tp":"habit","m":"他固定在咖啡馆靠窗座位等她并准备咖啡","c":"他每周三下午会在咖啡馆靠窗的第二个位子等她，并准备两杯咖啡。她到达后，他把热咖啡推给她。","v":"","s":"他","a":"她","i":0.5,"e":0.45,"st":"2025年7月16日下午3点15分","g":["习惯","默契","咖啡馆"]}

{"n":"栀子花记忆","tp":"emotion","m":"她闻到栀子花后提到外婆去世后的思念","c":"她在花市闻到栀子花后想起外婆。她说：“外婆走以后，我再也没闻到过这个味道了。”","v":"外婆走以后，我再也没闻到过这个味道了","s":"她","a":"外婆","i":0.4,"e":0.7,"st":"时间未明","g":["思念","童年记忆","亲情"]}

若无值得记忆的内容（极罕见），返回空数组 []。

═══════════════════════════════════════════════════════
## 辅助：NPC角色更新（可选，仅本轮新出现或变化的角色）
═══════════════════════════════════════════════════════

仅提取本轮首次登场或属性/关系发生明显变化的角色。
关注：角色弧线节点（立场转变、隐藏面揭示）、关系温度变化。

字段：n(姓名), eid(已有实体ID，无则""), al(别名数组), r(身份/职业), p(性格特征，关注矛盾性和成长性), a(外貌), s(状态), l(位置)
rt=关系数组 [{"n":"关联角色名","r":"关系类型","a":"态度"}]
nt=分级(core/important/minor/background) | ic=一行索引卡(含弧线阶段) | g=标签数组

示例：
{"n":"林澈","r":"旧案调查员","p":"谨慎、嘴硬，但在雨夜交出钥匙后开始愿意托付风险","a":"黑发，灰色风衣，左手有旧伤疤","s":"与玩家结盟","l":"东港旧车站","rt":[{"n":"玩家","r":"同盟/暧昧","a":"信任上升"}],"nt":"important","ic":"旧案调查员；2026年4月3日夜开始真正信任玩家","g":["旧案","同盟","信任"]}

若无新角色或变化，返回空数组。

═══════════════════════════════════════════════════════
## 辅助：物品更新（可选，仅本轮新出现或状态变化的物品）
═══════════════════════════════════════════════════════

仅提取本轮首次出现或状态改变的有意义物品。
关注：象征维度（代表什么？）、作为伏笔的潜力（何时可能被使用？）。

字段：n(物品名), eid(已有实体ID，无则""), al(别名数组), o(持有者), s(状态:held/used/lost/destroyed), l(所在地点)
sig=意义描述(兼顾实用与象征意义), kp=true/false
it=分级(key/equipped/clue/consumable/background) | g=标签数组

示例：
{"n":"银钥匙","o":"玩家","s":"held","l":"东港旧车站","sig":"能打开旧档案室，也是林澈把信任交给玩家的象征","kp":true,"it":"key","g":["钥匙","旧案","信任"]}

若无新物品或变化，返回空数组。

═══════════════════════════════════════════════════════
## 辅助：地图地点更新 v8.7.0（可选，仅本轮新出现或提及的地点）
═══════════════════════════════════════════════════════
记录本轮对话中出现或提及的新地点，已有地点不需要重复；若只是新增了相邻关系或重要描述，也可以返回该地点用于更新连接。
{{WORLD_REF}}

字段：n(地名), desc(描述), reg(区域), rw(现实原型参考-可留空使用全局),
     conn(连接: [{to:相邻地名, dist:距离, type:路径类型, diff:easy/normal/hard}])

示例：
{"n":"东港旧车站","desc":"废弃车站，旧档案室入口藏在站务室后方","reg":"东港","rw":"","conn":[{"to":"旧档案室","dist":"站务室后方","type":"暗门","diff":"normal"}]}

若无新地点或空间关系变化，返回空数组。

═══════════════════════════════════════════════════════
## 辅助：里程碑（可选，极克制，只记录真正重要的故事节点）
═══════════════════════════════════════════════════════

里程碑不是日记流水账，也不是时间线的普通节点。
记录门槛：时间跨越一天以上 / 故事阶段转换 / 重大冲突起止 / 核心关系质变 / 剧情关键揭示 / 叙事节奏明显变化。
只有“以后回看整个故事时必须记住的时间点”才输出为 milestones；普通推进、日常互动、单轮情绪波动不要输出。
如果同一事件已经写入 timeline.entries，除非它是伏笔、常驻或阶段转折，否则不要重复输出为 milestones。

字段：t(具体故事时间，优先填写), e(事件摘要), p(参与者数组), l(地点),
active=true/false, imp(对叙事弧线的影响), g(标签数组含节奏标签[起点/转折/高潮/收束/承上启下])

示例：
{"t":"2026年4月3日夜","e":"林澈交出银钥匙并确认同盟","p":["林澈","玩家"],"l":"东港旧车站","active":true,"imp":"核心关系从临时合作转为互相信任，旧案主线进入共同调查阶段","g":["转折","信任","主线"]}

若未达里程碑级别，返回空数组。

═══════════════════════════════════════════════════════
## 辅助：时间线（可选，初始化或阶段总结时使用）
═══════════════════════════════════════════════════════

时间线用于概括一条持续存在的叙事线，不是单个事件。
仅当输入中有清晰的主线、感情线、支线或世界观线索时输出。
持续叙事线下的普通节点优先放入 entries，而不是另建 milestones。

字段：n(时间线名), tp(类型:plot/emotional/side/world), st(状态:ongoing/paused/ended/resident),
p(优先级:high/medium/low), s(一句话总结), entries(可留空数组；若有条目，每条优先填写 period/故事时间)

示例：
{"n":"主线·旧案调查","tp":"plot","st":"ongoing","p":"high","s":"玩家与林澈围绕旧档案室追查东港旧案","entries":[{"period":"2026年4月3日夜","event":"林澈交出银钥匙，二人确认共同调查","status":"milestone"}]}

若无法形成持续线索，返回空数组。

═══════════════════════════════════════════════════════
## 输出格式
═══════════════════════════════════════════════════════

返回纯JSON对象（不要markdown代码块）：
{"memories":[...记忆数组，核心输出...], "npc":[...], "items":[...], "milestones":[...里程碑数组...], "locations":[...地点数组...], "timeline":[...时间线数组...]}

{{CALENDAR_REF}}
{{STYLE_BIAS}}

[当前对话]
用户: {{userMessage}}
角色: {{aiMessage}}`;

export function getAutoGeneratorPromptTemplates() {
    return [
        {
            key: 'extract.metaGuard',
            title: '提取元对话防护',
            category: '记忆提取',
            description: '用于自动/手动提取前过滤 OOC、元指令和非 RP 内容。',
            defaultValue: PROMPT_META_GUARD,
        },
        {
            key: 'extract.concreteTimeRule',
            title: '具体真实时间规则',
            category: '记忆提取',
            description: '约束记忆、里程碑和时间线节点使用可推断的具体日期，避免抽象相对时间。',
            defaultValue: DEFAULT_CONCRETE_TIME_RULE,
        },
        {
            key: 'extract.corePrinciples',
            title: '核心原则',
            category: '记忆提取',
            description: '插入合并提取提示词的核心判断原则，决定哪些叙事信息值得长期保存。',
            defaultValue: DEFAULT_CORE_PRINCIPLES,
            legacySettingKey: 'customCorePrinciples',
        },
        {
            key: 'extract.dimensions',
            title: '提取维度',
            category: '记忆提取',
            description: '插入合并提取提示词的候选维度，覆盖情感、关系、伏笔、世界观等。',
            defaultValue: DEFAULT_EXTRACTION_DIMENSIONS,
            legacySettingKey: 'customExtractionDimensions',
        },
        {
            key: 'extract.mergedTemplate',
            title: '合并提取总模板',
            category: '五柱/地图提取',
            description: '自动提取和手动楼层提取使用的主提示词，输出记忆、NPC、物品、里程碑、地图地点和时间线。',
            defaultValue: MERGED_EXTRACTION_PROMPT,
        },
        {
            key: 'extract.initializationTemplate',
            title: '初始化提取模板',
            category: '五柱/地图提取',
            description: '初始化工作台把角色卡、世界书和聊天记录转为 BB-Memory JSON 草稿时使用。',
            defaultValue: DEFAULT_INITIALIZATION_PROMPT,
        },
        {
            key: 'extract.styleDaily',
            title: '日常陪伴风格偏置',
            category: '记忆提取',
            description: '当提取风格选择“日常陪伴”时追加，强调习惯、关系温度和事实锚点。',
            defaultValue: STYLE_BIAS_DAILY,
        },
        {
            key: 'extract.styleDrama',
            title: '正剧叙事风格偏置',
            category: '记忆提取',
            description: '当提取风格选择“正剧叙事”时追加，强调伏笔、冲突和角色弧线。',
            defaultValue: STYLE_BIAS_DRAMA,
        },
        {
            key: 'extract.apiJsonSystem',
            title: '主 API JSON 系统提示',
            category: 'API 调用',
            description: '调用 SillyTavern 主 API 进行提取或总结时使用的系统提示，{{formatHint}} 会被替换。',
            defaultValue: DEFAULT_API_JSON_SYSTEM_PROMPT,
        },
    ];
}

function parseMergedResponse(responseText) {
    if (!responseText || !responseText.trim()) {
        console.warn('[BB-Memory] 合并提取响应为空');
        return { npc: [], items: [], milestones: [], timeline: [], memories: [], locations: [], threads: [] };
    }
    let text = responseText.trim();
    // META_DIALOGUE 检测（安全网：即便 extractMergedStage 已检查，解析阶段也再确认一次）
    if (text.toUpperCase().startsWith('META_DIALOGUE')) {
        console.log('[BB-Memory] parseMergedResponse: 检测到 META_DIALOGUE，返回空数据');
        return { npc: [], items: [], milestones: [], timeline: [], memories: [], locations: [], threads: [], metaDialogue: true };
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
                return { npc: [], items: [], milestones: [], timeline: [], memories: [], locations: [], threads: [] };
            }
            try { parsed = JSON.parse(match[0]); } catch (e2) {
                console.warn('[BB-Memory] 合并响应JSON解析失败:', e2.message, '前200字符:', text.slice(0, 200));
                return { npc: [], items: [], milestones: [], timeline: [], memories: [], locations: [], threads: [] };
            }
        }
        // 如果解析结果是数组，尝试取第一个对象元素
        if (Array.isArray(parsed)) {
            if (parsed.length > 0 && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
                parsed = parsed[0];
            } else {
                console.warn('[BB-Memory] 合并提取响应为数组但无可用的对象元素');
                return { npc: [], items: [], milestones: [], timeline: [], memories: [], locations: [], threads: [] };
            }
        }
    }
    try {
        // v6.2.0: 兼容不同字段名
        const memArr = parsed.memories || parsed.memory || parsed.mem || [];
        const npcArr = parsed.npc || [];
        const itemsArr = parsed.items || [];
        const rawTimelineArr = parsed.timeline || parsed.threads || parsed.timelineThreads || parsed.timeThreads || [];
        const timelineIsLegacyMilestones = looksLikeMilestoneArray(rawTimelineArr);
        const milestoneArr = parsed.milestones || parsed.milestone || (timelineIsLegacyMilestones ? rawTimelineArr : []);
        const locArr = parsed.locations || parsed.map || [];  // v8.7.0
        const threadArr = timelineIsLegacyMilestones ? (parsed.threads || parsed.timelineThreads || parsed.timeThreads || []) : rawTimelineArr;
        const milestones = parseTimelineResponse(JSON.stringify(milestoneArr));
        const timeline = parseTimelineThreadResponse(JSON.stringify(threadArr));
        const result = {
            npc: parseNpcResponse(JSON.stringify(npcArr)),
            items: parseItemResponse(JSON.stringify(itemsArr)),
            milestones,
            timeline,
            memories: parseMemoryResponse(JSON.stringify(memArr)),
            locations: parseLocationResponse(JSON.stringify(locArr)),
            threads: timeline,
        };
        if (memArr.length === 0 && npcArr.length === 0 && itemsArr.length === 0 && milestoneArr.length === 0 && locArr.length === 0 && threadArr.length === 0) {
            console.log('[BB-Memory] 合并提取: 本轮无需提取');
        }
        return result;
    } catch (e) {
        console.warn('[BB-Memory] 合并响应JSON解析失败:', e.message, '前200字符:', text.slice(0, 200));
        return { npc: [], items: [], milestones: [], timeline: [], memories: [], locations: [], threads: [] };
    }
}

export async function attachEntryEmbedding(entry, options = {}) {
    const settings = getSettings();
    const force = options.force === true;
    if (!entry || typeof entry !== 'object') return entry;
    if (!settings.embeddingEnabled || !settings.embeddingEndpoint) return entry;
    if (!force && Array.isArray(entry.embedding) && entry.embedding.length) return entry;
    if (!force && entry.embeddingRef?.id) return entry;
    const embedding = await embedMemoryEntry(entry);
    return embedding ? { ...entry, embedding } : entry;
}

function getStyleBias() {
    const settings = getSettings();
    const style = settings.extractionStyle || 'auto';
    switch (style) {
        case 'daily': return getPromptTemplate(settings, 'extract.styleDaily', STYLE_BIAS_DAILY);
        case 'drama': return getPromptTemplate(settings, 'extract.styleDrama', STYLE_BIAS_DRAMA);
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

    let prompt = getPromptTemplate(s, 'extract.mergedTemplate', MERGED_EXTRACTION_PROMPT);
    const metaGuard = getPromptTemplate(s, 'extract.metaGuard', PROMPT_META_GUARD);
    if (prompt.startsWith(PROMPT_META_GUARD)) {
        prompt = metaGuard + prompt.slice(PROMPT_META_GUARD.length);
    }
    prompt = prompt.replace('{{META_GUARD}}', metaGuard);

    // 注入自定义核心原则（精确字符串替换）
    const concreteTimeRule = getPromptTemplate(s, 'extract.concreteTimeRule', DEFAULT_CONCRETE_TIME_RULE);
    const corePrinciples = getPromptTemplate(s, 'extract.corePrinciples', DEFAULT_CORE_PRINCIPLES, { legacyKey: 'customCorePrinciples' });
    const extractionDimensions = getPromptTemplate(s, 'extract.dimensions', DEFAULT_EXTRACTION_DIMENSIONS, { legacyKey: 'customExtractionDimensions' });
    prompt = prompt.replace('{{CORE_PRINCIPLES}}', `${corePrinciples}\n\n${concreteTimeRule}`);
    prompt = prompt.replace('{{EXTRACTION_DIMENSIONS}}', extractionDimensions);
    prompt = prompt.replace('{{CONCRETE_TIME_RULE}}', concreteTimeRule);

    // 注入历法参考和风格偏置
    prompt = prompt.replace('{{CALENDAR_REF}}', calRef);
    prompt = prompt.replace('{{STYLE_BIAS}}', styleBias || '');
    // v8.7.1 全局现实原型
    const worldRef = (s.worldRealWorldRef || '').trim();
    prompt = prompt.replace('{{WORLD_REF}}', worldRef
        ? `⚠ 本世界的现实原型参考：${worldRef}。请基于此参考来推断地理关系、距离、方位。`
        : '');

    return prompt;
}

async function buildKnownEntityIndex(chatId) {
    const settings = getSettings();
    if (!settings.entityDedupEnabled) return '';
    const limit = Math.max(0, Math.min(100, Number(settings.dedupKnownEntityLimit) || 0));
    if (!limit) return '';
    const [npcs, items] = await Promise.all([getNpcProfiles(chatId), getItems(chatId)]);
    const rank = (entry) => (entry.archived ? -1000 : 0) + (Number(entry.hitCount) || 0) + (Number(entry.hitScore) || 0);
    const compact = (entries, mapper) => entries
        .filter(entry => entry && !entry.archived)
        .sort((a, b) => rank(b) - rank(a))
        .slice(0, limit)
        .map(mapper);
    const npcRows = compact(npcs, npc => ({
        id: npc.id,
        name: npc.name,
        aliases: normalizeAliases(npc.aliases),
        role: npc.role || '',
        location: npc.location || '',
    }));
    const itemRows = compact(items, item => ({
        id: item.id,
        name: item.name,
        aliases: normalizeAliases(item.aliases),
        owner: item.owner || '',
        location: item.location || '',
        status: item.status || '',
    }));
    if (!npcRows.length && !itemRows.length) return '';
    return `【已有实体索引｜只用于复用 ID 与标准名称，不是待提取文本】\nNPC=${JSON.stringify(npcRows)}\n物品=${JSON.stringify(itemRows)}`;
}

function applyKnownEntityIndex(prompt, indexText) {
    if (prompt.includes('{{KNOWN_ENTITY_INDEX}}')) {
        return prompt.replace('{{KNOWN_ENTITY_INDEX}}', indexText || '【已有实体索引】当前为空');
    }
    return indexText ? `${indexText}\n\n${prompt}` : prompt;
}

const INITIAL_PILLARS = ['memories', 'npc', 'items', 'milestones', 'locations', 'timeline'];
const INITIAL_PILLAR_LABELS = {
    memories: '记忆条目',
    npc: 'NPC角色',
    items: '物品',
    milestones: '里程碑',
    locations: '地图地点',
    timeline: '时间线',
};

function normalizeInitialPillars(pillars) {
    if (!Array.isArray(pillars) || pillars.length === 0) return new Set(INITIAL_PILLARS);
    const aliases = {
        mem: 'memories',
        memory: 'memories',
        item: 'items',
        map: 'locations',
        location: 'locations',
        milestone: 'milestones',
        timeline_entry: 'milestones',
        thread: 'timeline',
        threads: 'timeline',
        timelineThreads: 'timeline',
        timeThreads: 'timeline',
    };
    const selected = new Set();
    for (const p of pillars) {
        const key = aliases[p] || p;
        if (INITIAL_PILLARS.includes(key)) selected.add(key);
    }
    return selected.size ? selected : new Set(INITIAL_PILLARS);
}

function filterInitialResult(result, selectedSet) {
    const out = { npc: [], items: [], milestones: [], timeline: [], memories: [], locations: [], threads: [] };
    for (const key of INITIAL_PILLARS) {
        out[key] = selectedSet.has(key) && Array.isArray(result?.[key]) ? result[key] : [];
    }
    out.threads = out.timeline;
    return out;
}

function markInitialSource(result, source = 'init') {
    for (const key of INITIAL_PILLARS) {
        if (!Array.isArray(result?.[key])) continue;
        for (const entry of result[key]) {
            if (entry && typeof entry === 'object') entry.source = source;
        }
    }
    return result;
}

function buildInitializationPrompt(settings, styleBias, calDesc, selectedPillars) {
    const s = settings || {};
    const selected = normalizeInitialPillars(selectedPillars);
    const selectedLines = INITIAL_PILLARS
        .map(key => `${selected.has(key) ? '需要' : '不要'}输出 ${INITIAL_PILLAR_LABELS[key]}（${key}）`)
        .join('\n');
    const calRef = calDesc && calDesc.trim()
        ? `\n世界历法参考：${calDesc.trim()}\n仅用于判断故事时间和事件顺序，不要机械换算。`
        : '';
    const worldRef = (s.worldRealWorldRef || '').trim()
        ? `\n现实原型参考：${(s.worldRealWorldRef || '').trim()}。地点、距离、方位可参考这个原型推断。`
        : '';

    const concreteTimeRule = getPromptTemplate(s, 'extract.concreteTimeRule', DEFAULT_CONCRETE_TIME_RULE);
    const template = getPromptTemplate(s, 'extract.initializationTemplate', DEFAULT_INITIALIZATION_PROMPT);
    if (template && template.trim()) {
        return fillPromptTemplate(template, {
            selectedLines,
            calRef,
            worldRef,
            styleBias: styleBias || '',
            CONCRETE_TIME_RULE: concreteTimeRule,
            CONTEXT_TEXT: '{{CONTEXT_TEXT}}',
        });
    }

    return `你是 BB-Memory 初始化提取助手。输入可能包含角色卡、世界书、聊天记录或用户上传资料。

任务：把资料整理成 BB-Memory 可保存的结构化草稿。请只输出 JSON 对象，不要 markdown，不要解释。

读取边界：
- 角色卡和世界书通常是背景设定，优先提取 NPC、物品、地点、世界观事实、持续时间线。
- 聊天记录中已经发生的剧情可以提取为记忆条目；只有极重要节点才提取为里程碑。
- 不要把 OOC/元指令/工具说明当作剧情记忆。
- 不确定的信息可以用 truthStatus:"unknown" 或时间线 status:"paused" 标记。
- 同一人物、物品、地点或事件不要重复输出；必要时合并成更完整的一条。
- 时间线 timeline 是持续叙事线地图；普通线索节点优先放进 timeline.entries。
- 里程碑 milestones 只输出未被 timeline.entries 覆盖的关键时间点、伏笔或阶段转折。
- 每个已输出条目都要优先、尽量填写完整字段；能从上下文推断的时间、地点、主体、目标、参与者、状态和标签不要留空。
- memories[].c 写事实摘要，保留人物、地点、事件和关键原话；不要写文学化、感官化描写；时间留在 st/storyTime 字段。

本次勾选的提取范围：
${selectedLines}

字段格式：
1. memories 数组：
{ "n":"标题", "tp":"event/emotion/habit/fact", "m":"一句话摘要", "c":"1-3句事实摘要", "v":"重要原话", "s":"主体", "a":"目标", "i":0.6, "e":0.2, "st":"具体故事时间", "g":["标签"] }

2. npc 数组：
{ "n":"姓名", "r":"身份/职业", "p":"性格", "a":"外貌", "s":"状态", "l":"所在地", "rt":[{"n":"关联角色","r":"关系","a":"态度"}], "nt":"core/important/minor/background", "ic":"一句话索引卡", "g":["标签"] }

3. items 数组：
{ "n":"物品名", "o":"持有者", "s":"held/used/lost/destroyed", "l":"所在地点", "sig":"意义与用途", "kp":false, "it":"key/equipped/clue/consumable/background", "g":["标签"] }

4. milestones 数组：
{ "t":"具体故事时间", "e":"事件摘要", "p":["参与者"], "l":"地点", "active":true, "imp":"影响", "g":["标签"] }
status 可通过 active 推断；伏笔类事件请在 g 中加入"伏笔"或"待兑现"。
如果同一事件已经作为 timeline.entries 输出，普通事件不要再放入 milestones。

5. locations 数组：
{ "n":"地名", "desc":"地点描述", "reg":"区域", "rw":"现实原型参考，可为空", "conn":[{"to":"相邻地名","dist":"距离","type":"路径类型","diff":"easy/normal/hard"}] }

6. timeline 数组：
{ "n":"时间线名", "tp":"plot/emotional/side/world", "st":"ongoing/paused/ended/resident", "p":"high/medium/low", "s":"一句话总结", "entries":[] }

返回 JSON：
{"memories":[],"npc":[],"items":[],"milestones":[],"locations":[],"timeline":[]}

${calRef}${worldRef}
${styleBias || ''}

[初始化资料]
{{CONTEXT_TEXT}}`;
}

async function callMergedExtraction(chatId, userMessage, aiMessage) {
    const settings = getSettings();
    const styleBias = getStyleBias();
    const calDesc = await getCalendarDescription(chatId);
    const knownEntityIndex = await buildKnownEntityIndex(chatId);
    const prompt = applyKnownEntityIndex(buildMergedPrompt(settings, styleBias, calDesc), knownEntityIndex)
        .replace('{{userMessage}}', userMessage || '(无)')
        .replace('{{aiMessage}}', cleanAiMessage(aiMessage) || '(无)');

    const responseText = await callApi(prompt, { isMerged: true });
    if (responseText && responseText.trim().toUpperCase().startsWith('META_DIALOGUE')) {
        console.log('[BB-Memory] 检测到纯元对话，跳过提取');
        return { isMetaDialogue: true, results: null };
    }
    const results = filterTimelineCoveredByThreads(parseMergedResponse(responseText));
    return { isMetaDialogue: false, results };
}

function notifyMetaDialogueFloor(aiIndex) {
    const msg = `[BB-Memory] 检测到第 ${aiIndex} 楼为纯元对话楼层，已选择不提取`;
    try {
        if (typeof globalThis.bbMemoryRecordActivity === 'function') {
            globalThis.bbMemoryRecordActivity('warning', '纯元对话跳过', `检测到第 ${aiIndex} 楼为纯元对话楼层，已选择不提取`);
        }
    } catch { /* ignore */ }
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.warning === 'function') {
            ctx.toastr.warning(msg, '', { timeOut: 3500 });
            return;
        }
    } catch { /* ignore */ }
    if (typeof globalThis.bbMemoryShowToast === 'function') {
        globalThis.bbMemoryShowToast(msg, 'warning');
    } else {
        console.log(msg);
    }
}

async function saveExtractedLocations(chatId, locations, sourceInfo = {}) {
    if (!locations || locations.length === 0) return 0;
    let count = 0;
    try {
        const { getLocations, addLocation, updateLocation, addBidirectionalEdge } = await import('./map-store.js');
        const existingLocs = await getLocations(chatId);
        const findByName = (name) => existingLocs.find(l => (l.name || '').toLowerCase() === String(name || '').toLowerCase());
        const settings = getSettings();
        const hasEmbedding = settings.embeddingEnabled && settings.embeddingEndpoint;
        for (const loc of locations) {
            if (!loc?.name) continue;
            const embedding = hasEmbedding ? await embedMemoryEntry(loc) : null;
            const existing = findByName(loc.name);
            let locId;
            if (existing) {
                locId = existing.id;
                const patch = {};
                if (loc.description && loc.description !== existing.description) patch.description = loc.description;
                if (loc.region && loc.region !== existing.region) patch.region = loc.region;
                if (loc.realWorldRef && loc.realWorldRef !== existing.realWorldRef) patch.realWorldRef = loc.realWorldRef;
                if (embedding && !existing.embedding) patch.embedding = embedding;
                if (Object.keys(patch).length) {
                    const updated = await updateLocation(chatId, locId, { ...patch, ...(sourceInfo || {}) });
                    Object.assign(existing, updated || patch);
                    count++;
                }
            } else {
                const newLoc = await addLocation(chatId, { ...loc, embedding, ...(sourceInfo || {}) });
                locId = newLoc.id;
                existingLocs.push(newLoc);
                count++;
            }
            if (loc.edges && loc.edges.length > 0) {
                for (const edge of loc.edges) {
                    if (!edge.toName) continue;
                    const target = findByName(edge.toName);
                    if (target && target.id !== locId) {
                        await addBidirectionalEdge(chatId, locId, target.id, {
                            distance: edge.distance, pathType: edge.pathType, difficulty: edge.difficulty,
                        });
                    }
                }
            }
        }
    } catch (e) {
        if (getSettings().debugLogging) console.warn('[BB-Memory] 地点保存失败:', e.message);
    }
    return count;
}

async function extractMergedStage(chatId, userMessage, aiMessage, sourceInfo, progressContext = {}) {
    try {
        reportProgress('ai', 0, 5, '正在调用 AI 提取记忆...', progressContext);
        const { isMetaDialogue, results } = await callMergedExtraction(chatId, userMessage, aiMessage);
        if (isMetaDialogue || !results) {
            reportProgress('done', 5, 5, '提取完成（纯元对话已跳过）', progressContext);
            return { isMetaDialogue: true, total: 0 };
        }
        let total = 0;
        const settings = getSettings();
        const hasEmbedding = settings.embeddingEnabled && settings.embeddingEndpoint;
        reportProgress('parse', 1, 5, '正在解析提取结果...', progressContext);
        reportProgress('save-entities', 2, 5, '正在保存 NPC/物品/里程碑/时间线...', progressContext);
        for (const npc of results.npc) {
            const embedding = hasEmbedding ? await embedMemoryEntry(npc) : null;
            const saved = await saveEntityWithDedup(chatId, 'npc', { ...npc, embedding }, sourceInfo || {});
            if (saved.action !== 'skipped') total++;
        }
        for (const item of results.items) {
            const embedding = hasEmbedding ? await embedMemoryEntry(item) : null;
            const saved = await saveEntityWithDedup(chatId, 'item', { ...item, embedding }, sourceInfo || {});
            if (saved.action !== 'skipped') total++;
        }
        for (const milestone of results.milestones || []) {
            const embedding = hasEmbedding ? await embedMemoryEntry(milestone) : null;
            await upsertMilestone(chatId, { ...milestone, embedding, ...(sourceInfo || {}) });
            total++;
        }
        // v8.7.0 地点提取
        total += await saveExtractedLocations(chatId, results.locations, sourceInfo);
        const timelineSave = { timeline: 0, threads: 0, merged: 0, skipped: 0 };
        await saveInitialThreads(chatId, results.timeline || results.threads || [], sourceInfo, timelineSave);
        total += timelineSave.timeline + timelineSave.merged;
        const maxPerExchange = settings.maxMemoriesPerExchange ?? 3;
        const limited = results.memories.slice(0, maxPerExchange);
        const existingMemories = await getMemories(chatId);
        await hydrateCollectionEmbeddings(chatId, existingMemories);
        const activeMemories = existingMemories.filter(m => m.embedding);
        reportProgress('save-memories', 3, 5, hasEmbedding ? '正在向量化记忆...' : '正在保存记忆条目...', progressContext);
        for (const mem of limited) {
            const embedding = hasEmbedding
                ? await embedMemoryEntry(mem)
                : null;
            const decision = findMemoryDedupDecision(mem, embedding, existingMemories);
            const dedupAction = resolveAmbiguousDedupAction(decision);
            if (decision && dedupAction === 'merge') {
                const merged = { ...mergeMemoryFields(decision.entry, mem), embedding: embedding || decision.entry.embedding, ...(sourceInfo || {}) };
                await updateMemory(chatId, decision.entry.id, merged);
                const idx = activeMemories.findIndex(m => m.id === decision.entry.id);
                if (idx >= 0) activeMemories[idx] = { ...activeMemories[idx], ...merged };
                const allIdx = existingMemories.findIndex(m => m.id === decision.entry.id);
                if (allIdx >= 0) existingMemories[allIdx] = { ...existingMemories[allIdx], ...merged };
                continue;
            }
            if (decision && dedupAction === 'skip') continue;
            if (decision) {
                mem.dedupReview = makeDedupReview(decision, 'memory');
                mem.importance = Math.max(0.3, (mem.importance || 0.5) - 0.15);
            }
            const saved = await addMemory(chatId, { ...mem, embedding, memoryTier: 'stable', ...(sourceInfo || {}) });
            existingMemories.push(saved);
            if (embedding) activeMemories.push(saved);
            total++;
        }
        reportProgress('summarize', 4, 5, '正在汇总结果...', progressContext);
        console.log('[BB-Memory] 合并提取: NPC' + results.npc.length + '/物品' + results.items.length + '/里程碑' + (results.milestones || []).length + '/时间线' + (results.timeline || []).length + '/记忆' + limited.length + ' (保存' + total + '条)');
        reportProgress('done', 5, 5, '提取完成', progressContext);
        return { total };
    } catch (e) {
        console.warn('[BB-Memory] 合并提取失败:', e.message);
        reportProgress('failed', 5, 5, '提取失败: ' + (e.message || '未知错误'), progressContext);
        if (typeof globalThis.bbShowErrorPopup === 'function') {
            globalThis.bbShowErrorPopup('AI 提取失败', e.message || '未知错误', '端点: ' + (getSettings().autoGenMode === 'custom' ? (getSettings().autoGenEndpoint || '未配置') : '主 API'));
        }
        return { failed: true, error: e.message || '未知错误', total: 0 };
    }
}



// ═══ 自动提取调度（窗口入队 + 合并提取）═══

async function processLatestExchange(chatId) {
    // 先同步窗口状态，将超出保留窗口的完整 exchange 标记为待提取
    await syncMessageVisibility();

    const settings = getSettings();
    const confirmMode = settings.extractionConfirmMode || 'semi';

    const exchanges = await getExtractableExchanges();
    if (!exchanges.length) return;

    // v8.0.0 批量提取：窗口外有完整 exchange 就立即处理；batchExtractionCount 控制并行数量。
    const batchCount = Math.min(settings.batchExtractionCount || 1, exchanges.length);
    const batch = exchanges.slice(0, batchCount);
    const taskFloors = batch.map(ex => ex.aiIndex);
    const taskId = beginExtractionProgress({
        mode: 'auto',
        floors: taskFloors,
        text: taskFloors.length > 1 ? `准备自动提取 ${taskFloors.length} 个楼层...` : '准备自动提取...',
    });

    // 检查 batch 中第一个是否已处理
    if (await isExchangeProcessed(chatId, batch[0].hash)) {
        completeExtractionProgress(taskId, { skipped: true }, '楼层已处理，已跳过');
        return { skipped: true };
    }

    // 记录成功处理的 exchange（用于后续标记）
    const succeeded = [];
    const failed = [];

    try {
        if (confirmMode === 'active') {
            // Active 模式：逐个提取，结果存入待审核队列由用户确认后保存
            for (const ex of batch) {
                if (await isExchangeProcessed(chatId, ex.hash)) continue;
                try {
                    updateExtractionProgress(taskId, { floor: ex.aiIndex, phase: 'ai', current: 0, text: '正在调用 AI 提取记忆...' });
                    const { isMetaDialogue, results } = await callMergedExtraction(chatId, ex.userMessage, ex.aiMessage);
                    if (isMetaDialogue || !results) {
                        console.log('[BB-Memory] Active模式检测到纯元对话，跳过');
                        await markExchangeMetaSkipped(ex.userIndex, ex.aiIndex, ex.hash, 'auto', ex.extraIndices);
                        notifyMetaDialogueFloor(ex.aiIndex);
                        updateExtractionProgress(taskId, { floor: ex.aiIndex, phase: 'done', current: 5, text: '纯元对话已跳过' });
                        continue;
                    }
                    updateExtractionProgress(taskId, { floor: ex.aiIndex, phase: 'parse', current: 2, text: '正在整理待审核候选...' });
                    const sourceInfo = {
                        sourceExchange: ex.hash,
                        sourceFloor: ex.aiIndex,
                        sourceChatId: chatId,
                        sourceMessageHash: cyrb53Hash(ex.aiMessage || ''),
                    };
                    const candidates = buildExtractedCandidates(results, chatId, sourceInfo);
                    if (candidates.length > 0) {
                        pendingAutoCandidates.push(...candidates);
                    }
                    succeeded.push(ex);
                    updateExtractionProgress(taskId, { floor: ex.aiIndex, phase: 'done', current: 5, text: '提取完成，等待用户审核' });
                } catch (e) {
                    console.warn('[BB-Memory] Active模式单个 exchange 提取失败:', e.message);
                    lastExtractFailedFloor = ex.aiIndex;
                    failed.push({ ex, error: e });
                    if (typeof globalThis.bbMemoryRecordActivity === 'function') {
                        globalThis.bbMemoryRecordActivity('error', '自动提取失败', `第 ${ex.aiIndex} 楼提取失败：${e.message || '未知错误'}`);
                    }
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
                    const result = await extractMergedStage(chatId, ex.userMessage, ex.aiMessage, sourceInfo, {
                        taskId,
                        mode: 'auto',
                        floors: taskFloors,
                        floor: ex.aiIndex,
                    });
                    if (result && result.isMetaDialogue) {
                        console.log('[BB-Memory] 并行提取：检测到纯元对话，跳过');
                        await markExchangeMetaSkipped(ex.userIndex, ex.aiIndex, ex.hash, 'auto', ex.extraIndices);
                        notifyMetaDialogueFloor(ex.aiIndex);
                        return null;
                    }
                    if (result && result.failed) {
                        lastExtractFailedFloor = ex.aiIndex;
                        failed.push({ ex, error: new Error(result.error || '未知错误') });
                        if (typeof globalThis.bbMemoryRecordActivity === 'function') {
                            globalThis.bbMemoryRecordActivity('error', '自动提取失败', `第 ${ex.aiIndex} 楼提取失败：${result.error || '未知错误'}`);
                        }
                        return null;
                    }
                    return ex;
                } catch (e) {
                    console.warn('[BB-Memory] 并行提取单个 exchange 失败:', e.message);
                    lastExtractFailedFloor = ex.aiIndex;  // v8.2.1 记录失败楼层供悬浮球重试
                    failed.push({ ex, error: e });
                    if (typeof globalThis.bbMemoryRecordActivity === 'function') {
                        globalThis.bbMemoryRecordActivity('error', '自动提取失败', `第 ${ex.aiIndex} 楼提取失败：${e.message || '未知错误'}`);
                    }
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
        if (batch.length > 0) {
            lastExtractFailedFloor = batch[0].aiIndex;
            failed.push({ ex: batch[0], error: e });
        }
    }

    // v8.0.0 批量标记所有成功处理的 exchange
    for (const ex of succeeded) {
        await markExchangeExtracted(ex.userIndex, ex.aiIndex, ex.hash, ex.extraIndices);
    }
    if (succeeded.length && typeof globalThis.bbMemoryRecordActivity === 'function') {
        const floors = succeeded.flatMap(ex => [...(ex.extraIndices || []), ex.userIndex, ex.aiIndex]);
        globalThis.bbMemoryRecordActivity('success', '自动提取完成', `已处理楼层 ${formatFloorList(floors)}，共 ${succeeded.length} 个 exchange`);
    }

    if (failed.length) {
        const failedFloors = [...new Set(failed.map(item => item.ex?.aiIndex).filter(Number.isInteger))];
        const message = failedFloors.length
            ? `自动提取失败：第 ${formatFloorList(failedFloors)} 层${succeeded.length ? `（已成功 ${succeeded.length} 个 exchange）` : ''}`
            : '自动提取失败';
        failExtractionProgress(taskId, failed[0].error, message);
    } else {
        completeExtractionProgress(taskId, { succeeded: succeeded.length }, succeeded.length
            ? `自动提取完成：${succeeded.length} 个 exchange`
            : '自动提取完成（没有需要保存的新条目）');
    }

    // v6.7.0: 时间线自动更新检测（按成功处理的 exchange 数计数）
    if (getSettings().timelineSummaryEnabled) {
        const counter = (getSettings()._timelineUpdateCounter ?? getSettings()._threadUpdateCounter ?? 0) + succeeded.length;
        const threshold = getSettings()._timelineUpdateThreshold ?? getSettings()._threadUpdateThreshold ?? 5;
        updateSettings({ _timelineUpdateCounter: counter, _threadUpdateCounter: counter });
        if (counter >= threshold) {
            updateSettings({ _timelineUpdateCounter: 0, _threadUpdateCounter: 0 });
            setTimeout(async () => {
                try {
                    const { regenerateThreadSummary } = await import('./memory-maintainer.js');
                    await regenerateThreadSummary(chatId);
                    console.log('[BB-Memory] 时间线总结自动更新完成');
                } catch (e) { /* 静默失败 */ }
            }, 3000);
        }
    }

    setTimeout(() => refreshExtractionMarkers(), 200);
    return { succeeded: succeeded.length, failed: failed.length };
}

// ═══ 批量提取（用于初始化） ═══

/**
 * 从上下文批量提取记忆（初始化功能用）
 * @param {string} chatId
 * @param {string} contextText - 拼接好的上下文文本（角色卡+世界书+对话）
 * @returns {object} { npc, items, timeline, memories }
 */
export async function extractInitialDataFromContext(chatId, contextText, options = {}) {
    const { onProgress, selectedPillars } = options;
    const selected = normalizeInitialPillars(selectedPillars);
    if (!contextText || !contextText.trim()) {
        throw new Error('初始化资料为空');
    }

    if (onProgress) onProgress({ stage: 'prepare', progress: '正在构建初始化提示词...' });
    const settings = getSettings();
    const styleBias = getStyleBias();
    const calDesc = await getCalendarDescription(chatId);
    const prompt = buildInitializationPrompt(settings, styleBias, calDesc, [...selected])
        .replace('{{CONTEXT_TEXT}}', contextText.trim());

    if (onProgress) onProgress({ stage: 'ai', progress: '正在调用 AI 生成初始化草稿...' });
    const responseText = await callApi(prompt, { isMerged: true });
    if (responseText && responseText.trim().toUpperCase().startsWith('META_DIALOGUE')) {
        return { npc: [], items: [], milestones: [], timeline: [], memories: [], locations: [], threads: [], metaDialogue: true };
    }

    if (onProgress) onProgress({ stage: 'parse', progress: '正在解析初始化草稿...' });
    const parsed = parseMergedResponse(responseText);
    const scoped = filterInitialResult(parsed, selected);
    return markInitialSource(selected.has('timeline') ? filterTimelineCoveredByThreads(scoped) : scoped, 'init');
}

function mergeTextField(existingText, incomingText) {
    const a = String(existingText || '').trim();
    const b = String(incomingText || '').trim();
    if (!b) return a;
    if (!a) return b;
    if (a.includes(b)) return a;
    if (b.includes(a)) return b;
    return `${a}\n[初始化合并] ${b}`;
}

async function saveInitialThreads(chatId, threads, sourceInfo, result) {
    if (!Array.isArray(threads) || threads.length === 0) return;
    const existing = await getTimeline(chatId);
    const byName = new Map(existing.map(t => [(t.name || '').toLowerCase().trim(), t]).filter(([k]) => k));
    const settings = getSettings();
    const hasEmbedding = settings.embeddingEnabled && settings.embeddingEndpoint;
    for (const thread of threads) {
        if (!thread?.name) continue;
        const key = thread.name.toLowerCase().trim();
        const old = byName.get(key);
        const embedding = hasEmbedding ? await embedMemoryEntry(thread) : null;
        const data = { ...thread, ...(embedding ? { embedding } : {}), ...sourceInfo };
        if (old) {
            data.id = old.id;
            data.summary = mergeTextField(old.summary, thread.summary);
            data.entries = Array.isArray(old.entries) && old.entries.length ? old.entries : (Array.isArray(thread.entries) ? thread.entries : []);
            if (!data.embedding && old.embedding) data.embedding = old.embedding;
            await upsertTimeline(chatId, data);
            result.merged++;
        } else {
            const saved = await upsertTimeline(chatId, data);
            byName.set(key, saved);
            result.timeline = (result.timeline || 0) + 1;
            if ('threads' in result) result.threads++;
        }
    }
}

async function saveInitialMemories(chatId, memories, sourceInfo, result) {
    if (!Array.isArray(memories) || memories.length === 0) return;
    const settings = getSettings();
    const existingMemories = await getMemories(chatId);
    await hydrateCollectionEmbeddings(chatId, existingMemories);
    const activeMemories = existingMemories.filter(m => m.embedding);
    const exactKeys = new Map();
    for (const mem of existingMemories) {
        const key = `${(mem.title || '').toLowerCase().trim()}|${(mem.content || '').toLowerCase().trim().slice(0, 120)}`;
        if (key !== '|') exactKeys.set(key, mem);
    }

    for (const mem of memories) {
        if (!mem || !(mem.content || mem.summary)) continue;
        const embedding = settings.embeddingEnabled && settings.embeddingEndpoint
            ? await embedMemoryEntry(mem)
            : null;

        const decision = findMemoryDedupDecision(mem, embedding, existingMemories);
        const dedupAction = resolveAmbiguousDedupAction(decision);
        if (decision && dedupAction === 'merge') {
            await updateMemory(chatId, decision.entry.id, { ...mergeMemoryFields(decision.entry, mem), embedding: embedding || decision.entry.embedding, ...sourceInfo });
            result.merged++;
            continue;
        }
        if (decision && dedupAction === 'skip') {
            result.skipped++;
            continue;
        }
        if (decision) {
            mem.dedupReview = makeDedupReview(decision, 'memory');
            mem.importance = Math.max(0.3, (mem.importance || 0.5) - 0.15);
        }

        const exactKey = `${(mem.title || '').toLowerCase().trim()}|${(mem.content || '').toLowerCase().trim().slice(0, 120)}`;
        const exact = exactKeys.get(exactKey);
        if (exact) {
            if ((mem.summary || mem.verbatim) && (mem.summary !== exact.summary || mem.verbatim !== exact.verbatim)) {
                await updateMemory(chatId, exact.id, {
                    summary: mem.summary || exact.summary,
                    verbatim: mem.verbatim || exact.verbatim,
                    importance: Math.max(exact.importance || 0.5, mem.importance || 0.5),
                    ...sourceInfo,
                });
                result.merged++;
            } else {
                result.skipped++;
            }
            continue;
        }

        const saved = await addMemory(chatId, { ...mem, embedding, memoryTier: mem.memoryTier || 'stable', ...sourceInfo });
        existingMemories.push(saved);
        if (embedding) activeMemories.push(saved);
        exactKeys.set(exactKey, saved);
        result.memories++;
    }
}

export async function saveInitialExtractionResult(chatId, data, options = {}) {
    const selected = normalizeInitialPillars(options.selectedPillars);
    const dataForSave = selected.has('timeline') ? filterTimelineCoveredByThreads(data) : data;
    const sourceInfo = {
        source: 'init',
        sourceChatId: chatId,
        ...(options.sourceInfo || {}),
    };
    const result = { npc: 0, items: 0, milestones: 0, timeline: 0, threads: 0, locations: 0, memories: 0, merged: 0, skipped: 0 };
    const settings = getSettings();
    const hasEmbedding = settings.embeddingEnabled && settings.embeddingEndpoint;

    if (selected.has('npc')) {
        for (const npc of (dataForSave?.npc || [])) {
            if (!npc?.name) continue;
            const embedding = hasEmbedding ? await embedMemoryEntry(npc) : null;
            const saved = await saveEntityWithDedup(chatId, 'npc', { ...npc, embedding }, sourceInfo);
            if (saved.action === 'merged') result.merged++;
            else if (saved.action === 'skipped') result.skipped++;
            else result.npc++;
        }
    }
    if (selected.has('items')) {
        for (const item of (dataForSave?.items || [])) {
            if (!item?.name) continue;
            const embedding = hasEmbedding ? await embedMemoryEntry(item) : null;
            const saved = await saveEntityWithDedup(chatId, 'item', { ...item, embedding }, sourceInfo);
            if (saved.action === 'merged') result.merged++;
            else if (saved.action === 'skipped') result.skipped++;
            else result.items++;
        }
    }
    if (selected.has('milestones')) {
        for (const milestone of (dataForSave?.milestones || [])) {
            if (!milestone?.event) continue;
            const embedding = hasEmbedding ? await embedMemoryEntry(milestone) : null;
            await upsertMilestone(chatId, { ...milestone, embedding, ...sourceInfo });
            result.milestones++;
        }
    }
    if (selected.has('locations')) {
        result.locations += await saveExtractedLocations(chatId, dataForSave?.locations || [], sourceInfo);
    }
    if (selected.has('timeline')) {
        await saveInitialThreads(chatId, dataForSave?.timeline || dataForSave?.threads || [], sourceInfo, result);
    }
    if (selected.has('memories')) {
        await saveInitialMemories(chatId, dataForSave?.memories || [], sourceInfo, result);
    }

    return result;
}

export async function extractFromContext(chatId, contextText, options = {}) {
    const { onProgress, sourceInfo } = options;
    const results = { npc: 0, items: 0, milestones: 0, timeline: 0, threads: 0, locations: 0, memories: 0 };
    const taskMode = EXTRACTION_MODE_LABELS[options.mode] ? options.mode : 'manual';
    const taskFloors = normalizeProgressFloors(options.floors || options.floor || sourceInfo?.sourceFloor);
    const ownsTask = !options.taskId;
    const taskId = options.taskId || beginExtractionProgress({
        mode: taskMode,
        floors: taskFloors,
        floor: taskFloors[0],
        aggregate: true,
        text: taskMode === 'retry' ? '准备重新提取...' : '准备手动提取...',
    });
    const progressContext = {
        taskId,
        mode: taskMode,
        floors: taskFloors,
        floor: Number.isInteger(options.floor) ? options.floor : taskFloors[0],
    };
    const notify = (stage, current, progress) => {
        if (onProgress) onProgress({ stage, current, total: 5, progress });
        reportProgress(stage, current, 5, progress, progressContext);
    };

    notify('ai', 0, '正在调用 AI 提取记忆...');

    const settings = getSettings();
    const styleBias = getStyleBias();
    const calDesc = await getCalendarDescription(chatId);
    const knownEntityIndex = await buildKnownEntityIndex(chatId);
    const prompt = applyKnownEntityIndex(buildMergedPrompt(settings, styleBias, calDesc), knownEntityIndex)
        .replace('{{userMessage}}', contextText)
        .replace('{{aiMessage}}', '(见上下文)');

    try {
        const responseText = await callApi(prompt, { isMerged: true });
        if (responseText && responseText.trim().toUpperCase().startsWith('META_DIALOGUE')) {
            console.log('[BB-Memory] 批量提取检测到纯元对话，跳过');
            notify('done', 5, '提取完成（纯元对话已跳过）');
            if (ownsTask) completeExtractionProgress(taskId, results, '提取完成（纯元对话已跳过）');
            return results;
        }
        const parsed = filterTimelineCoveredByThreads(parseMergedResponse(responseText));
        const hasEmbedding = settings.embeddingEnabled && settings.embeddingEndpoint;
        notify('parse', 1, '正在解析提取结果...');
        notify('save-entities', 2, '正在保存 NPC/物品/里程碑/时间线...');

        // v7.7.1 合并提取：一次 API 调用获取全部四柱
        for (const npc of parsed.npc) {
            const embedding = hasEmbedding ? await embedMemoryEntry(npc) : null;
            const saved = await saveEntityWithDedup(chatId, 'npc', { ...npc, embedding }, sourceInfo || {});
            if (saved.action !== 'skipped') results.npc++;
        }
        for (const item of parsed.items) {
            const embedding = hasEmbedding ? await embedMemoryEntry(item) : null;
            const saved = await saveEntityWithDedup(chatId, 'item', { ...item, embedding }, sourceInfo || {});
            if (saved.action !== 'skipped') results.items++;
        }
        for (const milestone of parsed.milestones || []) {
            const embedding = hasEmbedding ? await embedMemoryEntry(milestone) : null;
            await upsertMilestone(chatId, { ...milestone, embedding, ...(sourceInfo || {}) });
            results.milestones++;
        }
        results.locations += await saveExtractedLocations(chatId, parsed.locations, sourceInfo);
        const timelineSave = { timeline: 0, threads: 0, merged: 0, skipped: 0 };
        await saveInitialThreads(chatId, parsed.timeline || parsed.threads || [], sourceInfo || {}, timelineSave);
        results.timeline += timelineSave.timeline + timelineSave.merged;
        results.threads += timelineSave.threads + timelineSave.merged;

        const existingMemories = await getMemories(chatId);
        await hydrateCollectionEmbeddings(chatId, existingMemories);
        const activeMemories = existingMemories.filter(m => m.embedding);
        notify('save-memories', 3, hasEmbedding ? '正在向量化并保存记忆...' : '正在保存记忆条目...');
        for (const mem of parsed.memories) {
            const embedding = hasEmbedding
                ? await embedMemoryEntry(mem)
                : null;
            const decision = findMemoryDedupDecision(mem, embedding, existingMemories);
            const dedupAction = resolveAmbiguousDedupAction(decision);
            if (decision && dedupAction === 'merge') {
                await updateMemory(chatId, decision.entry.id, { ...mergeMemoryFields(decision.entry, mem), embedding: embedding || decision.entry.embedding, ...(sourceInfo || {}) });
                results.memories++;
                continue;
            }
            if (decision && dedupAction === 'skip') continue;
            if (decision) {
                mem.dedupReview = makeDedupReview(decision, 'memory');
                mem.importance = Math.max(0.3, (mem.importance || 0.5) - 0.15);
            }
            const saved = await addMemory(chatId, { ...mem, embedding, memoryTier: 'stable', ...(sourceInfo || {}) });
            existingMemories.push(saved);
            if (embedding) activeMemories.push(saved);
            results.memories++;
        }
        notify('summarize', 4, '正在汇总提取结果...');
        notify('done', 5, '提取完成');
        if (ownsTask) completeExtractionProgress(taskId, results, '提取完成');
    } catch (e) {
        console.warn('[BB-Memory] 合并提取失败:', e.message);
        if (typeof globalThis.bbShowErrorPopup === 'function') {
            globalThis.bbShowErrorPopup('AI 提取失败', e.message || '未知错误', '端点: ' + (getSettings().autoGenMode === 'custom' ? (getSettings().autoGenEndpoint || '未配置') : '主 API'));
        }
        results.failed = true;
        results.error = e.message || '未知错误';
        if (ownsTask) failExtractionProgress(taskId, e);
    }

    return results;
}

/**
 * 精确重新提取指定 AI 楼层。手动调用不受 autoGenEnabled 限制，
 * 返回的 Promise 只会在 AI 调用、保存和楼层标记全部结束后完成。
 */
export async function reextractFloor(chatId, floor, options = {}) {
    const settings = getSettings();
    if (!settings.enabled) throw new Error('BB-Memory 当前未启用');
    if (!chatId) throw new Error('当前聊天不可用');

    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    const aiMessage = chat[floor];
    if (!Number.isInteger(floor) || floor < 0 || floor >= chat.length || !aiMessage || aiMessage.is_user || aiMessage.is_system) {
        throw new Error(`第 ${floor} 层不是可提取的 AI 消息`);
    }

    let pairedUserIndex = -1;
    let pairedUserText = '';
    for (let index = floor - 1; index >= 0; index--) {
        if (chat[index]?.is_user) {
            pairedUserIndex = index;
            pairedUserText = chat[index].mes || '';
            break;
        }
    }
    if (pairedUserIndex < 0) throw new Error(`第 ${floor} 层之前没有可配对的用户消息`);
    const retryHash = computeExchangeHash(pairedUserText, aiMessage.mes || '');
    await unmarkExchangeProcessed(chatId, retryHash);

    aiMessage._bbmem_extracted = false;
    aiMessage._bbmem_skipped = false;
    aiMessage._bbmem_pendingExtraction = true;
    delete aiMessage._bbmem_meta_marker;
    delete aiMessage._bbmem_meta_reason;
    delete aiMessage._bbmem_meta_pair;
    const pairedUser = chat[pairedUserIndex];
    if (pairedUser) {
        pairedUser._bbmem_extracted = false;
        pairedUser._bbmem_skipped = false;
        pairedUser._bbmem_pendingExtraction = true;
        delete pairedUser._bbmem_meta_marker;
        delete pairedUser._bbmem_meta_reason;
        delete pairedUser._bbmem_meta_pair;
    }
    try { ctx.saveChatDebounced?.(); } catch {}

    const exchanges = await getExtractableExchanges();
    const ex = exchanges.find(item => item.aiIndex === floor);
    if (!ex) throw new Error(`未能构建第 ${floor} 层的对话 exchange，请刷新楼层标记后重试`);

    const taskId = beginExtractionProgress({ mode: options.mode || 'retry', floors: [floor], floor, text: '准备重新提取...' });
    const sourceInfo = {
        sourceExchange: ex.hash,
        sourceFloor: ex.aiIndex,
        sourceChatId: chatId,
        sourceMessageHash: cyrb53Hash(ex.aiMessage || ''),
    };

    try {
        let result;
        if ((settings.extractionConfirmMode || 'semi') === 'active') {
            updateExtractionProgress(taskId, { floor, phase: 'ai', current: 0, text: '正在调用 AI 提取记忆...' });
            const extracted = await callMergedExtraction(chatId, ex.userMessage, ex.aiMessage);
            if (extracted.isMetaDialogue || !extracted.results) {
                await markExchangeMetaSkipped(ex.userIndex, ex.aiIndex, ex.hash, 'retry', ex.extraIndices);
                notifyMetaDialogueFloor(ex.aiIndex);
                result = { isMetaDialogue: true, total: 0 };
            } else {
                updateExtractionProgress(taskId, { floor, phase: 'parse', current: 2, text: '正在整理待审核候选...' });
                const candidates = buildExtractedCandidates(extracted.results, chatId, sourceInfo);
                if (candidates.length) pendingAutoCandidates.push(...candidates);
                await markExchangeExtracted(ex.userIndex, ex.aiIndex, ex.hash, ex.extraIndices);
                result = { pendingReview: candidates.length, total: candidates.length };
            }
        } else {
            result = await extractMergedStage(chatId, ex.userMessage, ex.aiMessage, sourceInfo, {
                taskId,
                mode: options.mode || 'retry',
                floors: [floor],
                floor,
            });
            if (result?.failed) throw new Error(result.error || 'AI 提取失败');
            if (result?.isMetaDialogue) {
                await markExchangeMetaSkipped(ex.userIndex, ex.aiIndex, ex.hash, 'retry', ex.extraIndices);
                notifyMetaDialogueFloor(ex.aiIndex);
            } else {
                await markExchangeExtracted(ex.userIndex, ex.aiIndex, ex.hash, ex.extraIndices);
            }
        }

        if (lastExtractFailedFloor === floor) lastExtractFailedFloor = null;
        completeExtractionProgress(taskId, result, result?.pendingReview
            ? `重新提取完成：${result.pendingReview} 条待审核`
            : `第 ${floor} 层重新提取完成`);
        setTimeout(() => refreshExtractionMarkers(), 100);
        return result;
    } catch (error) {
        lastExtractFailedFloor = floor;
        failExtractionProgress(taskId, error, `第 ${floor} 层重新提取失败：${error.message || '未知错误'}`);
        setTimeout(() => refreshExtractionMarkers(), 100);
        throw error;
    }
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
    const waiters = pendingProcessingWaiters.splice(0);
    waiters.forEach(waiter => waiter.resolve({ skipped: true, reason: 'stopped' }));
}

// ═══ Active 模式：保存候选人 ═══

function shouldSaveCandidate(candidate) {
    return candidate && candidate._selected !== false && candidate.selected !== false;
}

function normalizeCandidatePillar(candidate) {
    const raw = String(candidate?.pillar || candidate?.collection || candidate?.typeKey || 'memory').toLowerCase();
    if (raw === 'mem' || raw === 'memories') return 'memory';
    if (raw === 'items') return 'item';
    if (raw === 'locations' || raw === 'map') return 'location';
    if (raw === 'threads' || raw === 'thread') return 'timeline';
    if (raw === 'timeline_entry') return 'milestone';
    return CANDIDATE_PILLARS[raw] ? raw : 'memory';
}

function getCandidatePayload(candidate) {
    if (candidate?.payload && typeof candidate.payload === 'object') {
        return cloneCandidatePayload(candidate.payload);
    }
    const {
        id: _candidateId,
        pillar: _pillar,
        group: _group,
        label: _label,
        payload: _payload,
        sourceInfo: _sourceInfo,
        selected: _selectedPublic,
        _selected,
        _chatId,
        _sourceInfo: _legacySourceInfo,
        sourceFloor: _candidateSourceFloor,
        ...payload
    } = candidate || {};
    return cloneCandidatePayload(payload);
}

function getCandidateSourceInfo(candidate) {
    return { ...(candidate?._sourceInfo || {}), ...(candidate?.sourceInfo || {}) };
}

async function saveMemoryCandidate(chatId, mem, sourceInfo, activeMemories) {
    const existing = activeMemories ? null : await getMemories(chatId);
    if (existing) await hydrateCollectionEmbeddings(chatId, existing);
    const vectorPool = activeMemories || existing.filter(m => m.embedding);
    const allMemories = existing || await getMemories(chatId);
    if (!existing) await hydrateCollectionEmbeddings(chatId, allMemories);

    const embedding = getSettings().embeddingEnabled && getSettings().embeddingEndpoint
        ? await embedMemoryEntry(mem)
        : null;

    const decision = findMemoryDedupDecision(mem, embedding, allMemories);
    const dedupAction = resolveAmbiguousDedupAction(decision);
    if (decision && dedupAction === 'merge') {
        const updates = mergeMemoryFields(decision.entry, mem);
        await updateMemory(chatId, decision.entry.id, { ...updates, embedding: embedding || decision.entry.embedding, ...sourceInfo });
        return { saved: 1, merged: 1 };
    }
    if (decision && dedupAction === 'skip') {
        return { saved: 0, merged: 0, skipped: 1 };
    }
    if (decision) {
        mem.dedupReview = makeDedupReview(decision, 'memory');
        mem.importance = Math.max(0.3, (mem.importance || 0.5) - 0.15);
    }

    const saved = await addMemory(chatId, { ...mem, embedding, memoryTier: mem.memoryTier || 'stable', source: mem.source || 'auto', ...sourceInfo });
    if (embedding && vectorPool) vectorPool.push(saved);
    return { saved: 1, merged: 0 };
}

export async function saveExtractedCandidates(chatId, candidates, onProgress) {
    const result = { npc: 0, items: 0, milestones: 0, timeline: 0, threads: 0, locations: 0, memories: 0, merged: 0, skipped: 0, total: 0 };
    const selected = (Array.isArray(candidates) ? candidates : []).filter(shouldSaveCandidate);
    const settings = getSettings();
    const hasEmbedding = settings.embeddingEnabled && settings.embeddingEndpoint;
    const existingMemories = await getMemories(chatId);
    await hydrateCollectionEmbeddings(chatId, existingMemories);
    const activeMemories = existingMemories.filter(m => m.embedding);
    let done = 0;
    const reportCandidateProgress = (candidate) => {
        done++;
        if (onProgress) onProgress(done, selected.length, result, candidate);
    };

    for (const candidate of selected) {
        const pillar = normalizeCandidatePillar(candidate);
        const payload = getCandidatePayload(candidate);
        const sourceInfo = getCandidateSourceInfo(candidate);

        if (pillar === 'npc') {
            if (!payload.name) { result.skipped++; reportCandidateProgress(candidate); continue; }
            const embedding = hasEmbedding ? await embedMemoryEntry(payload) : null;
            const saved = await saveEntityWithDedup(chatId, 'npc', { ...payload, embedding }, sourceInfo);
            if (saved.action === 'merged') result.merged++;
            else if (saved.action === 'skipped') result.skipped++;
            else result.npc++;
            if (saved.action !== 'skipped') result.total++;
        } else if (pillar === 'item') {
            if (!payload.name) { result.skipped++; reportCandidateProgress(candidate); continue; }
            const embedding = hasEmbedding ? await embedMemoryEntry(payload) : null;
            const saved = await saveEntityWithDedup(chatId, 'item', { ...payload, embedding }, sourceInfo);
            if (saved.action === 'merged') result.merged++;
            else if (saved.action === 'skipped') result.skipped++;
            else result.items++;
            if (saved.action !== 'skipped') result.total++;
        } else if (pillar === 'milestone') {
            if (!payload.event && !payload.summary) { result.skipped++; reportCandidateProgress(candidate); continue; }
            const embedding = hasEmbedding ? await embedMemoryEntry(payload) : null;
            await upsertMilestone(chatId, { ...payload, embedding, ...sourceInfo });
            result.milestones++;
            result.total++;
        } else if (pillar === 'location') {
            if (!payload.name) { result.skipped++; reportCandidateProgress(candidate); continue; }
            const saved = await saveExtractedLocations(chatId, [payload], sourceInfo);
            result.locations += saved;
            result.total += saved;
        } else if (pillar === 'timeline') {
            if (!payload.name) { result.skipped++; reportCandidateProgress(candidate); continue; }
            const beforeTimeline = result.timeline;
            const beforeMerged = result.merged;
            await saveInitialThreads(chatId, [payload], sourceInfo, result);
            result.total += (result.timeline - beforeTimeline) + (result.merged - beforeMerged);
        } else {
            if (!payload.content && !payload.summary) { result.skipped++; reportCandidateProgress(candidate); continue; }
            const saved = await saveMemoryCandidate(chatId, payload, sourceInfo, activeMemories);
            result.memories += saved.saved;
            result.merged += saved.merged;
            result.skipped += saved.skipped || 0;
            result.total += saved.saved;
        }

        reportCandidateProgress(candidate);
    }

    return result;
}

export async function saveExtractedMemories(chatId, candidateMemories, onProgress) {
    const wrapped = (Array.isArray(candidateMemories) ? candidateMemories : []).map(mem => ({
        pillar: 'memory',
        payload: getCandidatePayload(mem),
        sourceInfo: getCandidateSourceInfo(mem),
        selected: mem?._selected !== false && mem?.selected !== false,
        _selected: mem?._selected !== false && mem?.selected !== false,
    }));
    const result = await saveExtractedCandidates(chatId, wrapped, onProgress);
    return result.memories;
}

/**
 * 嵌入现有记忆（批量补 embedding）
 */
async function persistEntryEmbedding(chatId, collection, entry, embedding) {
    if (!chatId || !entry?.id || !embedding) return;
    switch (collection) {
        case 'npc':
            await updateNpcProfile(chatId, entry.id, { embedding });
            break;
        case 'item':
            await updateItem(chatId, entry.id, { embedding });
            break;
        case 'milestone':
        case 'timeline_entry':
            await updateMilestone(chatId, entry.id, { embedding });
            break;
        case 'map': {
            const { updateLocation } = await import('./map-store.js');
            await updateLocation(chatId, entry.id, { embedding });
            break;
        }
        case 'threads':
        case 'thread':
        case 'timeline':
            await upsertTimeline(chatId, { id: entry.id, embedding });
            break;
        case 'mem':
        default:
            await updateMemory(chatId, entry.id, { embedding });
            break;
    }
}

export async function embedExistingMemories(chatIdOrMemories, memoriesOrProgress, onProgress, collection = 'mem') {
    let chatId = null;
    let memories = chatIdOrMemories;
    let progress = memoriesOrProgress;
    if (!Array.isArray(chatIdOrMemories)) {
        chatId = chatIdOrMemories;
        memories = Array.isArray(memoriesOrProgress) ? memoriesOrProgress : [];
        progress = onProgress;
    }
    let done = 0;
    let updated = 0;
    let failed = 0;
    if (chatId) await hydrateCollectionEmbeddings(chatId, memories);
    for (const mem of memories) {
        if (!mem.embedding && !mem.embeddingRef?.id) {
            const embedding = await embedMemoryEntry(mem);
            if (embedding) {
                mem.embedding = embedding;
                updated++;
                await persistEntryEmbedding(chatId, collection, mem, embedding);
            } else {
                failed++;
            }
        }
        done++;
        if (progress) progress(done, memories.length);
    }
    return { total: memories.length, updated, failed };
}

