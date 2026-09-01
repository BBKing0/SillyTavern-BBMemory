/**
 * realtime-memory.js — BB-Memory v9.3.4 实时记忆（第五柱）
 *
 * 解决的问题：检索完全由最后一条用户消息驱动，query 里没有「车」字，
 * 「坐公交车来电影院」这条记忆就永远进不了注入，后文于是写出「开车回家」。
 * 这是检索机制的结构性盲区，调阈值无解。
 *
 * 做法：抓一层「当下有效的具体细节」，**不做 embedding、不参与检索、无条件注入**。
 * 正是这个「绕过检索」的性质解决了长线逻辑断裂。
 *
 * 生命周期：抓取 → 无条件注入 → 结算（场景切换 / TTL / 容量 / 手动）。
 * 结算时逐条判定晋升长期库、判定无长期价值、或延长有效期。
 */

import {
    getSettings,
    getRealtimeMemories,
    addRealtimeMemories,
    updateRealtimeMemory,
    updateRealtimeMemories,
    removeRealtimeMemories,
    restoreEntriesVerbatim,
    getMemories, addMemory, removeMemory,
    getNpcProfiles, removeNpcProfile,
    getItems, removeItem,
    getMilestones, addMilestone, removeMilestone,
} from './memory-store.js';
import { callCustomApi, callMainApi, cleanAiMessage, saveEntityWithDedup } from './auto-generator.js';
import {
    DEFAULT_REALTIME_DETAIL_EXTRACT_PROMPT,
    DEFAULT_REALTIME_SETTLE_PROMPT,
    fillPromptTemplate,
    getPromptTemplate,
} from './prompt-templates.js';
import { storyTimeDateSignature, normalizeIdentityText } from './dedup-engine.js';
import {
    normalizeRealtimeKind,
    REALTIME_KINDS,
    getRealtimeKindSlotLimits,
} from './memory-types.js';

/** 单条细节的长度上限。提示词要求 20 字以内，这里留一倍余量做硬截断。 */
const MAX_DETAIL_CHARS = 60;
const MAX_SLOT_KEY_CHARS = 40;
/** 送进抓取提示词的回复长度上限。轻量调用，不需要整层原文。 */
const MAX_AI_MESSAGE_CHARS = 1800;

// ═══════════════════════════════════════════════════════════
//  场景标识（纯函数）
// ═══════════════════════════════════════════════════════════

/**
 * 场景标识 = 归一化地点 + 故事日期签名。
 *
 * 刻意用「日期」而不是完整时间：同一地点从下午聊到傍晚仍是同一个场景，
 * 不该因为时刻推进就把细节全部结算掉。换地点或跨天才算换场景。
 *
 * 两侧都拿不到信息时返回空串，代表「场景未知」——场景切换判定会跳过未知场景，
 * 避免刚开始聊、地点还没提取出来时就误触发结算。
 */
export function computeSceneKey(location, storyTime) {
    const place = normalizeIdentityText(location);
    const date = storyTimeDateSignature(storyTime);
    if (!place && !date) return '';
    return `${place}|${date}`;
}

/** 场景是否发生切换。任一侧未知时一律判为「没切换」。 */
export function isSceneChanged(prevKey, nextKey) {
    const a = String(prevKey || '').trim();
    const b = String(nextKey || '').trim();
    if (!a || !b) return false;
    return a !== b;
}

/**
 * 从现有条目反推当前场景状态，避免额外开一份存储。
 * 取 lastSeenFloor 最大的未结算条目所在场景。
 */
export function deriveSceneState(entries) {
    const pool = (Array.isArray(entries) ? entries : []).filter(e =>
        e && e.settleState !== 'settled');
    if (!pool.length) return { sceneKey: '', location: '', storyTime: '', floors: [] };
    const newest = pool.reduce((best, entry) => {
        const a = Number(entry.lastSeenFloor ?? -1);
        const b = Number(best.lastSeenFloor ?? -1);
        if (a > b) return entry;
        if (a === b && Number(entry.createdAt || 0) > Number(best.createdAt || 0)) return entry;
        return best;
    });
    const sceneKey = String(newest.sceneKey || '');
    const sameScene = pool.filter(e => String(e.sceneKey || '') === sceneKey);
    const floors = [...new Set(sameScene
        .map(e => Number(e.createdFloor))
        .filter(n => Number.isFinite(n) && n >= 0))].sort((a, b) => a - b);
    return {
        sceneKey,
        location: newest.location || '',
        storyTime: newest.storyTime || '',
        floors,
    };
}

// ═══════════════════════════════════════════════════════════
//  抓取范围控制（纯函数）
// ═══════════════════════════════════════════════════════════

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 这一层要不要抓。
 *
 * 'always'  每层都抓（默认）
 * 'first_n' 只抓每个场景的前 N 层——场景刚展开时细节最密集，往后多是重复，
 *           这一档用来省 API 调用
 *
 * @param {object} settings
 * @param {object} context { sceneKey, sceneFloors: number[], floor }
 */
export function shouldExtractRealtime(settings = {}, context = {}) {
    if (!settings.realtimeEnabled || !settings.realtimeExtractEnabled) {
        return { extract: false, reason: 'disabled' };
    }
    if (String(settings.realtimeExtractScope || 'always') !== 'first_n') {
        return { extract: true, reason: 'always' };
    }
    const limit = clampInt(settings.realtimeExtractFirstN, 1, 200, 6);
    const floor = Number(context.floor);
    const floors = Array.isArray(context.sceneFloors) ? context.sceneFloors : [];
    // 这一层自己已经抓过就不重复计数
    const distinct = new Set(floors.filter(n => Number.isFinite(n)));
    if (Number.isFinite(floor) && distinct.has(floor)) {
        return { extract: true, reason: 'already-counted' };
    }
    if (distinct.size >= limit) {
        return { extract: false, reason: `first_n 已满（${distinct.size}/${limit}）` };
    }
    return { extract: true, reason: `first_n（${distinct.size + 1}/${limit}）` };
}

// ═══════════════════════════════════════════════════════════
//  响应解析（纯函数）
// ═══════════════════════════════════════════════════════════

function extractJsonObject(rawText) {
    let text = String(rawText || '').trim();
    if (!text) return null;
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    const tryArray = () => {
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) return null;
        try {
            const parsed = JSON.parse(match[0]);
            return Array.isArray(parsed) ? { details: parsed } : null;
        } catch { return null; }
    };
    const tryObject = () => {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            const parsed = JSON.parse(match[0]);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch { return null; }
    };

    // 先看首字符决定顺序：模型忽略「输出对象」要求直接回数组时，
    // /\{[\s\S]*\}/ 会先匹配到数组里的第一个元素对象并解析成功，
    // 结果拿到的是单条细节而不是列表，整批细节就丢了。
    return text.startsWith('[')
        ? (tryArray() || tryObject())
        : (tryObject() || tryArray());
}

/**
 * 解析抓取响应。纯函数，不读库不发请求。
 * @returns {{ details: Array<{kind,text}>, rejected: Array<{reason,raw}>, totalReturned: number }}
 */
export function parseRealtimeDetails(rawText, options = {}) {
    const maxDetails = clampInt(options.maxDetails, 1, 50, 5);
    const allowedKinds = options.allowedKinds instanceof Set
        ? options.allowedKinds
        : new Set(Array.isArray(options.allowedKinds) ? options.allowedKinds : Object.keys(REALTIME_KINDS));
    const existingIds = new Set((Array.isArray(options.existingIds) ? options.existingIds : []).map(String));
    const parsed = extractJsonObject(rawText);
    if (!parsed) {
        return { details: [], rejected: [{ reason: '响应里找不到可解析的 JSON', raw: String(rawText || '').slice(0, 160) }], totalReturned: 0 };
    }
    const raw = Array.isArray(parsed.details) ? parsed.details
        : (Array.isArray(parsed.d) ? parsed.d : (Array.isArray(parsed) ? parsed : []));

    const details = [];
    const rejected = [];
    const seen = new Set();
    for (const item of raw) {
        if (details.length >= maxDetails) break;
        if (!item || typeof item !== 'object') {
            rejected.push({ reason: '条目不是对象', raw: JSON.stringify(item) });
            continue;
        }
        const text = String(item.t ?? item.text ?? '').trim().replace(/\s+/g, ' ');
        if (!text) {
            rejected.push({ reason: '细节文本为空', raw: JSON.stringify(item) });
            continue;
        }
        const kind = normalizeRealtimeKind(item.k ?? item.kind);
        if (!allowedKinds.has(kind)) {
            rejected.push({ reason: `分类 ${kind} 已关闭`, raw: text });
            continue;
        }
        const slotKey = String(item.s ?? item.slot ?? item.slotKey ?? '').trim().replace(/\s+/g, ' ');
        const replaceId = String(item.r ?? item.replaceId ?? '').trim();
        if (replaceId && !existingIds.has(replaceId)) {
            rejected.push({ reason: '引用的现有槽位不存在', raw: replaceId });
            continue;
        }
        const dedupKey = replaceId
            ? `replace:${replaceId}`
            : `${kind}|${normalizeIdentityText(slotKey || text)}`;
        if (!dedupKey || seen.has(dedupKey)) {
            rejected.push({ reason: '同批次重复', raw: text });
            continue;
        }
        seen.add(dedupKey);
        details.push({
            kind,
            text: text.length > MAX_DETAIL_CHARS ? text.slice(0, MAX_DETAIL_CHARS) + '…' : text,
            slotKey: slotKey.length > MAX_SLOT_KEY_CHARS ? slotKey.slice(0, MAX_SLOT_KEY_CHARS) : slotKey,
            replaceId,
        });
    }
    return { details, rejected, totalReturned: raw.length };
}

// ═══════════════════════════════════════════════════════════
//  抓取（调用副 API）
// ═══════════════════════════════════════════════════════════

function pickApi(settings, override) {
    const mode = override || (settings.autoGenMode === 'custom' && settings.autoGenEndpoint ? 'custom' : 'main');
    if (mode === 'custom') {
        if (!settings.autoGenEndpoint) throw new Error('未配置副 API 端点（autoGenEndpoint）');
        return { mode, call: callCustomApi };
    }
    return { mode, call: callMainApi };
}

export function buildRealtimePrompt(aiMessage, options = {}) {
    const settings = options.settings || {};
    const template = getPromptTemplate(settings, 'realtime.detailExtract', DEFAULT_REALTIME_DETAIL_EXTRACT_PROMPT);
    const body = String(aiMessage || '').slice(0, MAX_AI_MESSAGE_CHARS);
    const base = fillPromptTemplate(template, {
        maxDetails: clampInt(settings.realtimeMaxDetailsPerFloor, 1, 50, 5),
        location: options.location || '（未知）',
        storyTime: options.storyTime || '（未知）',
        aiMessage: body,
    });
    const limits = getRealtimeKindSlotLimits(settings);
    const enabled = Object.keys(REALTIME_KINDS).filter(kind => limits[kind] > 0);
    const disabled = Object.keys(REALTIME_KINDS).filter(kind => limits[kind] <= 0);
    const existing = (Array.isArray(options.existingEntries) ? options.existingEntries : [])
        .filter(entry => entry && entry.settleState !== 'settled' && !entry.promotedTo)
        .slice()
        .sort((a, b) => Number(b.lastSeenFloor ?? -1) - Number(a.lastSeenFloor ?? -1));
    const occupied = {};
    for (const entry of existing) {
        const kind = REALTIME_KINDS[entry.kind] ? entry.kind : 'detail';
        occupied[kind] = (occupied[kind] || 0) + 1;
    }
    const rules = enabled.map(kind =>
        `- ${kind}（${REALTIME_KINDS[kind].label}）：最多 ${limits[kind]} 槽，当前 ${occupied[kind] || 0}/${limits[kind]}`)
        .join('\n') || '- 所有分类均已关闭，本次必须返回 {"details":[]}';
    const existingText = existing.length
        ? existing.map(entry => {
            const kind = REALTIME_KINDS[entry.kind] ? entry.kind : 'detail';
            const slot = String(entry.slotKey || '').trim() || '未命名槽位';
            return `- id=${entry.id} | ${kind} | s=${slot} | ${String(entry.text || '').slice(0, MAX_DETAIL_CHARS)}`;
        }).join('\n')
        : '- 暂无';

    // 运行时强制追加，确保用户沿用旧版自定义提示词时也能获得去重上下文与槽位限制。
    return `${base}\n\n## 系统追加：本次分类槽位硬约束\n${rules}`
        + (disabled.length ? `\n- 已关闭分类（不得输出）：${disabled.join('、')}` : '')
        + `\n\n## 系统追加：当前场景已存在的实时细节\n${existingText}`
        + '\n同一事实不得新增副本；重复或变化时用 r 指向现有 id 并沿用其 s。只输出 JSON。';
}

function entryBelongsToScene(entry, sceneKey) {
    if (!entry || entry.settleState === 'settled' || entry.promotedTo) return false;
    const target = String(sceneKey || '').trim();
    const own = String(entry.sceneKey || '').trim();
    // 场景信息尚未回填时宁可参与当前槽位去重，避免并行抓取先写出重复项。
    return !target || !own || target === own;
}

function newestRealtimeFirst(a, b) {
    return (Number(b.lastSeenFloor ?? b.createdFloor ?? -1) - Number(a.lastSeenFloor ?? a.createdFloor ?? -1))
        || (Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        || (Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

/**
 * 规划实时细节的 upsert、重复退场与分类槽位限制。纯函数，便于零 API 回归。
 * 同槽位或完全相同文本会更新原条目；只有新槽位且仍有容量时才新增。
 */
export function planRealtimeDetailWrites(existingEntries, details, context = {}) {
    const limits = getRealtimeKindSlotLimits(context.settings || {});
    let working = (Array.isArray(existingEntries) ? existingEntries : [])
        .filter(entry => entryBelongsToScene(entry, context.sceneKey))
        .map(entry => ({ ...entry }));
    const retire = [];
    const retireIds = new Set();
    const reject = (detail, reason) => ({ detail, reason });

    // 先收拢历史完全重复项。保留最近被看到的那条，副本退出注入并等待楼层清理。
    const exactGroups = new Map();
    for (const entry of working) {
        const kind = REALTIME_KINDS[entry.kind] ? entry.kind : 'detail';
        const identity = normalizeIdentityText(entry.text);
        if (!identity) continue;
        const key = `${kind}|${identity}`;
        if (!exactGroups.has(key)) exactGroups.set(key, []);
        exactGroups.get(key).push(entry);
    }
    for (const group of exactGroups.values()) {
        const ordered = group.slice().sort(newestRealtimeFirst);
        for (const duplicate of ordered.slice(1)) {
            retireIds.add(String(duplicate.id));
            retire.push({ id: duplicate.id, reason: 'duplicate' });
        }
    }
    working = working.filter(entry => !retireIds.has(String(entry.id)));

    // 用户把槽位调小（或设为 0）后，旧数据也按最近优先立即收敛。
    for (const kind of Object.keys(REALTIME_KINDS)) {
        const group = working.filter(entry => (REALTIME_KINDS[entry.kind] ? entry.kind : 'detail') === kind)
            .sort(newestRealtimeFirst);
        for (const overflow of group.slice(limits[kind])) {
            if (retireIds.has(String(overflow.id))) continue;
            retireIds.add(String(overflow.id));
            retire.push({ id: overflow.id, reason: 'slot_capacity' });
        }
    }
    working = working.filter(entry => !retireIds.has(String(entry.id)));

    const updates = [];
    const adds = [];
    const rejected = [];
    const floor = Number.isFinite(Number(context.floor)) ? Number(context.floor) : -1;

    for (const detail of (Array.isArray(details) ? details : [])) {
        const kind = normalizeRealtimeKind(detail?.kind);
        if (limits[kind] <= 0) {
            rejected.push(reject(detail, `分类 ${kind} 已关闭`));
            continue;
        }
        const normalizedText = normalizeIdentityText(detail?.text);
        const normalizedSlot = normalizeIdentityText(detail?.slotKey);
        let target = detail?.replaceId
            ? working.find(entry => String(entry.id) === String(detail.replaceId))
            : null;
        if (target && normalizeRealtimeKind(target.kind) !== kind) {
            rejected.push(reject(detail, '引用槽位的分类不一致'));
            continue;
        }
        if (!target && normalizedText) {
            target = working.find(entry => normalizeRealtimeKind(entry.kind) === kind
                && normalizeIdentityText(entry.text) === normalizedText);
        }
        if (!target && normalizedSlot) {
            target = working.find(entry => normalizeRealtimeKind(entry.kind) === kind
                && normalizeIdentityText(entry.slotKey) === normalizedSlot);
        }

        if (target) {
            const patch = {
                kind,
                text: String(detail.text || '').trim(),
                slotKey: String(detail.slotKey || target.slotKey || '').trim(),
                lastSeenFloor: floor >= 0 ? floor : target.lastSeenFloor,
                sceneKey: context.sceneKey || target.sceneKey || '',
                location: context.location || target.location || '',
                storyTime: context.storyTime || target.storyTime || '',
                settleState: 'active',
                settleReason: '',
                sourceExchange: context.sourceExchange || target.sourceExchange || '',
                sourceFloor: floor >= 0 ? floor : target.sourceFloor,
            };
            updates.push({ id: target.id, patch });
            Object.assign(target, patch);
            continue;
        }

        const occupied = working.filter(entry => normalizeRealtimeKind(entry.kind) === kind).length
            + adds.filter(entry => entry.kind === kind).length;
        if (occupied >= limits[kind]) {
            rejected.push(reject(detail, `${REALTIME_KINDS[kind].label}槽位已满（${occupied}/${limits[kind]}）`));
            continue;
        }
        adds.push({
            kind,
            text: String(detail.text || '').trim(),
            slotKey: String(detail.slotKey || '').trim(),
            sceneKey: context.sceneKey || '',
            location: context.location || '',
            storyTime: context.storyTime || '',
            createdFloor: floor,
            lastSeenFloor: floor,
            source: 'auto',
            sourceExchange: context.sourceExchange || '',
            sourceFloor: floor,
            sourceChatId: context.chatId || '',
        });
    }
    return { adds, updates, retire, rejected, limits };
}

export async function saveRealtimeDetailsWithSlots(chatId, details, context = {}) {
    const existing = await getRealtimeMemories(chatId);
    const plan = planRealtimeDetailWrites(existing, details, { ...context, chatId });
    for (const reason of ['duplicate', 'slot_capacity']) {
        const ids = plan.retire.filter(item => item.reason === reason).map(item => item.id);
        if (ids.length) {
            await updateRealtimeMemories(chatId, ids, {
                settleState: 'settled',
                settleReason: reason,
            });
        }
    }
    const updated = [];
    for (const item of plan.updates) {
        const entry = await updateRealtimeMemory(chatId, item.id, item.patch);
        if (entry) updated.push(entry);
    }
    const added = plan.adds.length ? await addRealtimeMemories(chatId, plan.adds) : [];
    return { added, updated, retired: plan.retire, rejected: plan.rejected };
}

/**
 * 抓一层的场景细节并写入第五柱。
 *
 * 调用方必须把它当「可失败的附加动作」：任何异常都在这里被吞掉并返回 ok:false，
 * 绝不能让它影响主提取的楼层标记状态——楼层标记出错会导致重复提取或永久跳过。
 *
 * @param {string} chatId
 * @param {object} exchange { aiMessage, aiIndex, userIndex, hash }
 * @param {object} options { settings, apiMode, sceneHint }
 */
export async function extractRealtimeDetails(chatId, exchange, options = {}) {
    const settings = options.settings || getSettings();
    const result = {
        ok: false, skipped: false, reason: '', saved: [], updated: [], retired: [], rejected: [],
        apiMode: '', durationMs: 0, sceneKey: '', error: '',
    };
    if (!chatId || !exchange) { result.skipped = true; result.reason = 'no-exchange'; return result; }

    const aiMessage = cleanAiMessage(exchange.aiMessage || '');
    if (!aiMessage.trim()) { result.skipped = true; result.reason = 'empty-message'; return result; }

    const floor = Number.isFinite(Number(exchange.aiIndex)) ? Number(exchange.aiIndex) : -1;

    // 场景状态：优先用调用方给的提示（主提取刚算出来的），否则从现有条目反推
    let existing = [];
    try { existing = await getRealtimeMemories(chatId); } catch { existing = []; }
    let scene = options.sceneHint;
    if (!scene) scene = deriveSceneState(existing);
    const sceneEntries = existing.filter(entry => entryBelongsToScene(entry, scene.sceneKey));

    const gate = shouldExtractRealtime(settings, {
        sceneKey: scene.sceneKey,
        sceneFloors: scene.floors,
        floor,
    });
    if (!gate.extract) { result.skipped = true; result.reason = gate.reason; return result; }

    let api;
    try {
        api = pickApi(settings, options.apiMode);
    } catch (e) {
        result.skipped = true;
        result.reason = e.message;
        return result;
    }
    result.apiMode = api.mode;

    const prompt = buildRealtimePrompt(aiMessage, {
        settings,
        location: scene.location,
        storyTime: scene.storyTime,
        existingEntries: sceneEntries,
    });

    const startedAt = Date.now();
    let rawText = '';
    try {
        rawText = await api.call(prompt, { isMerged: true });
    } catch (e) {
        result.durationMs = Date.now() - startedAt;
        result.error = `实时细节抓取失败：${e.message}`;
        if (settings.debugLogging) console.warn('[BB-Memory]', result.error);
        return result;
    }
    result.durationMs = Date.now() - startedAt;

    const parsed = parseRealtimeDetails(rawText, {
        maxDetails: settings.realtimeMaxDetailsPerFloor,
        allowedKinds: Object.entries(getRealtimeKindSlotLimits(settings))
            .filter(([, slots]) => slots > 0).map(([kind]) => kind),
        existingIds: sceneEntries.map(entry => entry.id),
    });
    result.rejected = parsed.rejected;
    result.sceneKey = scene.sceneKey;

    if (!parsed.details.length) {
        result.ok = true;
        result.reason = parsed.rejected.length ? 'all-rejected' : 'no-details';
        if (settings.debugLogging) {
            console.log(`[BB-Memory] 实时抓取：第 ${floor} 层无可记录细节`
                + (parsed.rejected.length ? `（${parsed.rejected.length} 条被拒）` : ''));
        }
        return result;
    }

    try {
        const write = await saveRealtimeDetailsWithSlots(chatId, parsed.details, {
            settings,
            sceneKey: scene.sceneKey,
            location: scene.location,
            storyTime: scene.storyTime,
            floor,
            sourceExchange: exchange.hash || '',
        });
        result.saved = write.added;
        result.updated = write.updated;
        result.retired = write.retired;
        result.rejected.push(...write.rejected.map(item => ({ reason: item.reason, raw: item.detail?.text || '' })));
        result.ok = true;
        if (settings.debugLogging) {
            console.log(`[BB-Memory] 实时抓取：第 ${floor} 层新增 ${result.saved.length} 条、更新 ${result.updated.length} 条细节`
                + `（${api.mode} API，${result.durationMs}ms）`);
        }
    } catch (e) {
        result.error = `实时细节写入失败：${e.message}`;
        console.warn('[BB-Memory]', result.error);
    }
    return result;
}

/**
 * 主提取算出地点/时间之后回填场景标识。
 *
 * 抓取与主提取是并行的，抓取那一刻往往还不知道本层的地点，
 * 所以先用上一场景的 key 落盘，等主提取出结果再把这一层的条目校正过来。
 * 校正很重要：sceneKey 错了，场景切换结算就会在错误的时机触发。
 */
export async function updateSceneKeyForFloor(chatId, floor, sceneInfo = {}) {
    const settings = getSettings();
    if (!chatId || !settings.realtimeEnabled) return { updated: 0, sceneKey: '' };
    const targetFloor = Number(floor);
    if (!Number.isFinite(targetFloor)) return { updated: 0, sceneKey: '' };

    const location = String(sceneInfo.location || '').trim();
    const storyTime = String(sceneInfo.storyTime || '').trim();
    const sceneKey = computeSceneKey(location, storyTime);
    if (!sceneKey) return { updated: 0, sceneKey: '' };

    let entries = [];
    try { entries = await getRealtimeMemories(chatId); } catch { return { updated: 0, sceneKey }; }
    const targets = entries.filter(entry =>
        Number(entry.createdFloor) === targetFloor
        && entry.settleState !== 'settled'
        && String(entry.sceneKey || '') !== sceneKey);
    if (!targets.length) return { updated: 0, sceneKey };

    const updated = await updateRealtimeMemories(chatId, targets.map(e => e.id), {
        sceneKey,
        location: location || targets[0].location || '',
        storyTime: storyTime || targets[0].storyTime || '',
    });
    if (settings.debugLogging && updated) {
        console.log(`[BB-Memory] 实时记忆场景标识回填：第 ${targetFloor} 层 ${updated} 条 → ${sceneKey}`);
    }
    return { updated, sceneKey };
}

/**
 * 从主提取结果里挑出本层的地点与故事时间。
 * locations 优先取第一个新地点；storyTime 优先取里程碑，其次记忆条目。
 */
export function pickSceneInfoFromExtraction(results = {}) {
    const location = (Array.isArray(results.locations) ? results.locations : [])
        .map(loc => String(loc?.name || '').trim())
        .find(Boolean) || '';
    const storyTime = [
        ...(Array.isArray(results.milestones) ? results.milestones : []),
        ...(Array.isArray(results.memories) ? results.memories : []),
    ].map(entry => String(entry?.storyTime || '').trim()).find(Boolean) || '';
    return { location, storyTime };
}

// ═══════════════════════════════════════════════════════════
//  Task 9：结算引擎 —— 触发器与决定解析
// ═══════════════════════════════════════════════════════════

const SETTLE_UNDO_KEY_PREFIX = 'bb_rt_settle_undo_';
const SETTLE_UNDO_SCHEMA = 'bb-memory-realtime-settle-undo-v1';
export const SETTLE_ACTIONS = Object.freeze(['promote', 'discard', 'keep']);
export const PROMOTE_PILLARS = Object.freeze(['mem', 'npc', 'item', 'milestone']);

export const SETTLE_REASON_LABELS = Object.freeze({
    scene_change: '场景切换',
    ttl: '超过有效期',
    capacity: '超出容量上限',
    manual: '手动结算',
    discarded: '判定无长期价值',
    duplicate: '重复细节',
    slot_capacity: '分类槽位已满',
});

const PROMOTE_PILLAR_LABELS = Object.freeze({
    mem: '记忆条目', npc: 'NPC 档案', item: '物品', milestone: '里程碑',
});

/** 晋升时 AI 可写的字段白名单，排除 id / hitScore / memoryTier / source* 等系统字段。 */
const PROMOTE_WRITABLE_FIELDS = Object.freeze({
    mem: ['title', 'type', 'summary', 'content', 'subject', 'target', 'storyTime', 'importance', 'tags'],
    npc: ['name', 'role', 'appearance', 'status', 'location', 'indexCard', 'tags'],
    item: ['name', 'owner', 'status', 'location', 'significance', 'tags'],
    milestone: ['storyTime', 'event', 'summary', 'location', 'impact', 'tags'],
});

/** 同一时刻只允许一次结算，避免自动结算与手动结算并发写第五柱。 */
let settlementInFlight = false;

export function isSettlementRunning() {
    return settlementInFlight;
}

function getLocalForage() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx?.libs?.localforage || globalThis.localforage || globalThis.SillyTavern?.libs?.localforage;
    } catch {
        return globalThis.localforage || null;
    }
}

function cloneForSnapshot(value) {
    if (!value || typeof value !== 'object') return value;
    try { return JSON.parse(JSON.stringify(value)); } catch { return { ...value }; }
}

/**
 * 判定每条活跃条目该不该进入待结算。纯函数，便于逐触发器测试。
 *
 * 三个触发器并用，优先级 场景切换 > TTL > 容量（先到先标，reason 不覆盖）：
 *  - scene_change：条目所属场景已不是当前场景（换地点或跨天）
 *  - ttl：距上次被提及已过 realtimeTtlFloors 层
 *  - capacity：剩下的活跃条目仍超过 realtimeMaxEntries，最旧的先出
 */
export function planSettlement(entries, currentFloor, settings = {}) {
    const all = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const pool = all.filter(e => e.settleState === 'active');
    if (!pool.length) return { marks: [], byReason: {}, activeCount: 0 };

    const floor = Number(currentFloor);
    const ttl = clampInt(settings.realtimeTtlFloors, 0, 500, 12);
    const maxEntries = clampInt(settings.realtimeMaxEntries, 0, 500, 40);
    const sceneChangeEnabled = settings.realtimeSceneChangeSettle !== false;

    // 当前场景 = 最新未结算条目所在场景
    const currentScene = deriveSceneState(all).sceneKey;

    const marks = new Map();
    const mark = (entry, reason) => {
        if (!marks.has(entry.id)) marks.set(entry.id, { id: entry.id, reason });
    };

    if (sceneChangeEnabled && currentScene) {
        for (const entry of pool) {
            if (isSceneChanged(entry.sceneKey, currentScene)) mark(entry, 'scene_change');
        }
    }
    if (ttl > 0 && Number.isFinite(floor)) {
        for (const entry of pool) {
            const seen = Number(entry.lastSeenFloor ?? entry.createdFloor ?? -1);
            if (Number.isFinite(seen) && seen >= 0 && floor - seen >= ttl) mark(entry, 'ttl');
        }
    }
    if (maxEntries > 0) {
        const stillActive = pool.filter(entry => !marks.has(entry.id));
        const overflow = stillActive.length - maxEntries;
        if (overflow > 0) {
            const oldestFirst = stillActive.slice().sort((a, b) =>
                (Number(a.lastSeenFloor ?? -1) - Number(b.lastSeenFloor ?? -1))
                || (Number(a.createdAt || 0) - Number(b.createdAt || 0)));
            for (const entry of oldestFirst.slice(0, overflow)) mark(entry, 'capacity');
        }
    }

    const byReason = {};
    for (const item of marks.values()) byReason[item.reason] = (byReason[item.reason] || 0) + 1;
    return { marks: [...marks.values()], byReason, activeCount: pool.length };
}

/**
 * 已结算留档的修剪计划（纯函数）。
 * 按楼层窗口保留：距离当前楼层超过 realtimeSettledRetentionFloors 的 settled 条目删除。
 * 晋升条目的长期副本已经落在目标柱，实时溯源仍可由撤销快照恢复，因此同样遵守窗口。
 */
export function planSettledPrune(entries, currentFloor, settings = {}) {
    const settled = (Array.isArray(entries) ? entries : [])
        .filter(e => e && e.settleState === 'settled');
    const retention = clampInt(settings.realtimeSettledRetentionFloors, 0, 500, 5);
    if (retention === 0) return settled.map(entry => entry.id);
    let floor = Number(currentFloor);
    if (!Number.isFinite(floor)) {
        floor = (Array.isArray(entries) ? entries : []).reduce((max, entry) => {
            const seen = Number(entry?.lastSeenFloor ?? entry?.createdFloor);
            return Number.isFinite(seen) ? Math.max(max, seen) : max;
        }, -1);
    }
    if (!Number.isFinite(floor) || floor < 0) return [];
    return settled.filter(entry => {
        const seen = Number(entry.lastSeenFloor ?? entry.createdFloor);
        return Number.isFinite(seen) && seen >= 0 && floor - seen > retention;
    }).map(entry => entry.id);
}

export async function pruneSettledRealtimeMemories(chatId, currentFloor, options = {}) {
    if (!chatId) return 0;
    const settings = options.settings || getSettings();
    const entries = options.entries || await getRealtimeMemories(chatId);
    const ids = planSettledPrune(entries, currentFloor, settings);
    return ids.length ? removeRealtimeMemories(chatId, ids) : 0;
}

/**
 * 标记待结算 + 修剪留档。写库但不调 API，所以随时可以安全调用。
 * @returns {{ marked, byReason, pruned, pendingCount, activeCount }}
 */
export async function checkSettlement(chatId, currentFloor, options = {}) {
    const settings = options.settings || getSettings();
    const result = { marked: 0, byReason: {}, pruned: 0, pendingCount: 0, activeCount: 0 };
    if (!chatId || !settings.realtimeEnabled) return result;

    let entries = [];
    try { entries = await getRealtimeMemories(chatId); } catch { return result; }
    if (!entries.length) return result;

    const plan = planSettlement(entries, currentFloor, settings);
    result.byReason = plan.byReason;
    result.activeCount = plan.activeCount;

    // 同一原因的条目一起改，避免逐条读写整个集合
    const byReason = new Map();
    for (const item of plan.marks) {
        if (!byReason.has(item.reason)) byReason.set(item.reason, []);
        byReason.get(item.reason).push(item.id);
    }
    for (const [reason, ids] of byReason) {
        result.marked += await updateRealtimeMemories(chatId, ids, {
            settleState: 'pending_settle',
            settleReason: reason,
        });
    }

    const afterMark = await getRealtimeMemories(chatId);
    result.pruned = await pruneSettledRealtimeMemories(chatId, currentFloor, { settings, entries: afterMark });
    result.pendingCount = afterMark.filter(e => e.settleState === 'pending_settle').length;

    if (settings.debugLogging && (result.marked || result.pruned)) {
        console.log(`[BB-Memory] 实时结算检查：标记 ${result.marked} 条待结算`
            + `（${Object.entries(result.byReason).map(([k, v]) => `${SETTLE_REASON_LABELS[k] || k}×${v}`).join(' ')}）`
            + (result.pruned ? `，修剪留档 ${result.pruned} 条` : ''));
    }
    return result;
}

/** 手动把所有活跃条目推进待结算（「立即结算」按钮的第一步）。 */
export async function markAllPendingSettle(chatId) {
    if (!chatId) return 0;
    const entries = await getRealtimeMemories(chatId);
    const ids = entries.filter(e => e.settleState === 'active').map(e => e.id);
    if (!ids.length) return 0;
    return updateRealtimeMemories(chatId, ids, { settleState: 'pending_settle', settleReason: 'manual' });
}

// ── 结算提示词 ──

function formatPendingForPrompt(entries) {
    return entries.map(entry => {
        const kindLabel = REALTIME_KINDS[entry.kind]?.label || entry.kind;
        const floor = Number(entry.lastSeenFloor);
        const floorNote = Number.isFinite(floor) && floor >= 0 ? `，第${floor}层` : '';
        return `- id=${entry.id}｜${kindLabel}${floorNote}｜${entry.text}`;
    }).join('\n');
}

/** 长期库的紧凑摘要：只给名称/标题，用来让 AI 避免重复晋升。 */
export function buildLibrarySummary(library = {}, options = {}) {
    const limit = clampInt(options.limit, 5, 200, 40);
    const take = (list, mapper) => (Array.isArray(list) ? list : [])
        .filter(e => e && !e.archived)
        .slice(-limit)
        .map(mapper)
        .filter(Boolean);

    const npc = take(library.npc, e => String(e.name || '').trim());
    const items = take(library.items, e => String(e.name || '').trim());
    const memories = take(library.memories, e => String(e.title || e.summary || '').trim());
    const milestones = take(library.milestones, e => String(e.event || '').trim());

    const lines = [];
    if (npc.length) lines.push(`已有 NPC：${npc.join('、')}`);
    if (items.length) lines.push(`已有物品：${items.join('、')}`);
    if (memories.length) lines.push(`已有记忆：${memories.join('；')}`);
    if (milestones.length) lines.push(`已有里程碑：${milestones.join('；')}`);
    return lines.join('\n') || '（长期库暂时为空）';
}

export function buildSettlePrompt(pending, options = {}) {
    const settings = options.settings || {};
    const template = getPromptTemplate(settings, 'realtime.settle', DEFAULT_REALTIME_SETTLE_PROMPT);
    const reasons = [...new Set((pending || []).map(e => e.settleReason).filter(Boolean))];
    return fillPromptTemplate(template, {
        location: options.location || '（未知）',
        storyTime: options.storyTime || '（未知）',
        settleReason: reasons.map(r => SETTLE_REASON_LABELS[r] || r).join('、') || '手动结算',
        librarySummary: options.librarySummary || '（长期库暂时为空）',
        pendingText: formatPendingForPrompt(pending || []),
    });
}

// ── 决定解析（纯函数） ──

function sanitizePromoteFields(raw, pillar) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const allowed = PROMOTE_WRITABLE_FIELDS[pillar] || [];
    const out = {};
    for (const field of allowed) {
        if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
        const value = raw[field];
        if (value == null) continue;
        if (field === 'importance') {
            const n = Number(value);
            if (Number.isFinite(n)) out.importance = Math.max(0, Math.min(1, n));
        } else if (field === 'tags') {
            const tags = (Array.isArray(value) ? value : String(value).split(/[,，、]/))
                .map(t => (typeof t === 'string' ? t.trim() : String(t?.name || '').trim()))
                .filter(Boolean)
                .map(name => ({ name, weight: 0.6 }));
            if (tags.length) out.tags = tags;
        } else if (typeof value === 'string') {
            const text = value.trim();
            if (text) out[field] = text;
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            out[field] = value;
        }
    }
    return Object.keys(out).length ? out : null;
}

/** 各柱晋升所必需的主字段，缺了就写不成有意义的条目。 */
function promoteRequiredField(fields, pillar) {
    if (pillar === 'npc' || pillar === 'item') return String(fields.name || '').trim();
    if (pillar === 'milestone') return String(fields.event || '').trim();
    return String(fields.content || fields.summary || fields.title || '').trim();
}

/** 「一个小孩」这类描述性称呼不能当实体名，否则长期库里全是无法复用的匿名条目。 */
const VAGUE_NAME_PATTERN = /^(?:一|某|那|这)?(?:个|位|只|名)?(?:人|小孩|孩子|男人|女人|路人|店员|服务员|老板|陌生人|家伙|东西|物品)$/;

export function isVagueEntityName(name) {
    const text = String(name || '').trim();
    if (!text) return true;
    return VAGUE_NAME_PATTERN.test(text);
}

/**
 * 解析结算决定。纯函数，不读库不发请求。
 * @param {string} rawText AI 原始响应
 * @param {object} options { pending: entries }
 * @returns {{ decisions, rejected, missing, totalReturned }}
 */
export function parseSettleDecisions(rawText, options = {}) {
    const pending = Array.isArray(options.pending) ? options.pending.filter(Boolean) : [];
    const byId = new Map(pending.map(entry => [String(entry.id), entry]));

    const parsed = extractJsonObject(rawText);
    if (!parsed) {
        return {
            decisions: [],
            rejected: [{ reason: '响应里找不到可解析的 JSON', raw: String(rawText || '').slice(0, 160) }],
            missing: pending.map(e => e.id),
            totalReturned: 0,
        };
    }
    const raw = Array.isArray(parsed.decisions) ? parsed.decisions
        : (Array.isArray(parsed.details) ? parsed.details : (Array.isArray(parsed) ? parsed : []));

    const decisions = [];
    const rejected = [];
    const handled = new Set();
    for (const item of raw) {
        const reject = (reason) => rejected.push({ id: item?.id, reason });
        if (!item || typeof item !== 'object') { reject('决定不是对象'); continue; }

        const id = String(item.id ?? '').trim();
        const entry = byId.get(id);
        if (!entry) { reject(`id 不在本次待结算列表：${id || '(空)'}`); continue; }
        if (handled.has(id)) { reject(`id 重复出现：${id}`); continue; }

        const action = String(item.action ?? item.a ?? '').trim().toLowerCase();
        if (!SETTLE_ACTIONS.includes(action)) { reject(`未知动作「${item.action ?? ''}」`); continue; }

        const normalized = {
            id,
            action,
            entry,
            reason: String(item.reason || '').trim().slice(0, 200),
        };

        if (action === 'promote') {
            const pillar = String(item.pillar ?? item.p ?? 'mem').trim();
            if (!PROMOTE_PILLARS.includes(pillar)) { reject(`晋升目标柱非法「${item.pillar}」`); continue; }
            const fields = sanitizePromoteFields(item.fields ?? item.f ?? item.result, pillar);
            if (!fields) { reject('晋升缺少可用的 fields'); continue; }
            if (!promoteRequiredField(fields, pillar)) { reject(`晋升到 ${pillar} 缺少必要主字段`); continue; }
            if ((pillar === 'npc' || pillar === 'item') && isVagueEntityName(fields.name)) {
                reject(`晋升到 ${pillar} 的名称过于笼统：「${fields.name}」`); continue;
            }
            normalized.pillar = pillar;
            normalized.fields = fields;
        }

        handled.add(id);
        decisions.push(normalized);
    }

    // AI 漏判的条目绝不当 discard 处理：默认按 keep 多留一轮，宁可留重复不可丢事实
    const missing = pending.filter(entry => !handled.has(String(entry.id))).map(entry => entry.id);
    return { decisions, rejected, missing, totalReturned: raw.length };
}

// ═══════════════════════════════════════════════════════════
//  Task 9：结算引擎 —— 应用、撤销、编排
// ═══════════════════════════════════════════════════════════

async function readSettleUndoStack(chatId) {
    const lf = getLocalForage();
    if (!lf || !chatId) return { schema: SETTLE_UNDO_SCHEMA, chatId, entries: [] };
    const stored = await lf.getItem(SETTLE_UNDO_KEY_PREFIX + chatId);
    if (stored && typeof stored === 'object' && Array.isArray(stored.entries)) return stored;
    return { schema: SETTLE_UNDO_SCHEMA, chatId, entries: [] };
}

async function writeSettleUndoStack(chatId, stack) {
    const lf = getLocalForage();
    if (!lf || !chatId) return false;
    await lf.setItem(SETTLE_UNDO_KEY_PREFIX + chatId, stack);
    return true;
}

/**
 * 应用前记录待结算条目的完整原状。
 * discard 不删数据，所以快照的意义主要在 promote：写错的长期库条目要能撤回。
 */
async function beginSettleSnapshot(chatId, pending, settings) {
    const record = {
        id: 'rtundo_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
        timestamp: Date.now(),
        before: pending.map(cloneForSnapshot),
        promoted: [],   // [{ pillar, id, action }] 晋升写出的长期库条目
        summary: '',
    };
    const stack = await readSettleUndoStack(chatId);
    stack.entries = [record, ...stack.entries].slice(0, clampInt(settings.aiCurateUndoDepth, 1, 20, 3));
    await writeSettleUndoStack(chatId, stack);
    return record.id;
}

async function finalizeSettleSnapshot(chatId, snapshotId, patch = {}) {
    if (!snapshotId) return;
    const stack = await readSettleUndoStack(chatId);
    const record = stack.entries.find(entry => entry.id === snapshotId);
    if (!record) return;
    Object.assign(record, patch);
    await writeSettleUndoStack(chatId, stack);
}

export async function listSettleSnapshots(chatId) {
    const stack = await readSettleUndoStack(chatId);
    return stack.entries.map(entry => ({
        id: entry.id,
        timestamp: entry.timestamp,
        entryCount: entry.before?.length || 0,
        promotedCount: entry.promoted?.length || 0,
        summary: entry.summary || '',
    }));
}

/** 把一条实时细节写进目标长期柱。NPC/物品走 saveEntityWithDedup 防重名。 */
async function promoteToPillar(chatId, decision) {
    const { pillar, fields, entry } = decision;
    const sourceInfo = {
        source: 'realtime_promote',
        sourceExchange: entry.sourceExchange || '',
        sourceFloor: typeof entry.createdFloor === 'number' ? entry.createdFloor : -1,
        creationFloor: typeof entry.createdFloor === 'number' ? entry.createdFloor : -1,
        sourceChatId: chatId,
        sourceMessageHash: entry.sourceMessageHash || '',
    };

    if (pillar === 'npc' || pillar === 'item') {
        const saved = await saveEntityWithDedup(chatId, pillar, { ...fields }, sourceInfo);
        if (!saved?.entry?.id) throw new Error(`${PROMOTE_PILLAR_LABELS[pillar]}写入未返回条目`);
        // action='merged' 表示并入了已有实体，此时不算新建，撤销时不能删掉人家原有的条目
        return { pillar, id: saved.entry.id, action: saved.action || 'created' };
    }
    if (pillar === 'milestone') {
        const saved = await addMilestone(chatId, {
            ...fields,
            storyTime: fields.storyTime || entry.storyTime || '',
            location: fields.location || entry.location || '',
            ...sourceInfo,
        });
        return { pillar, id: saved.id, action: 'created' };
    }
    const saved = await addMemory(chatId, {
        type: fields.type || 'fact',
        ...fields,
        storyTime: fields.storyTime || entry.storyTime || '',
        memoryTier: 'stable',
        ...sourceInfo,
    });
    return { pillar: 'mem', id: saved.id, action: 'created' };
}

/**
 * 应用结算决定。
 *
 * promote  → 写入目标长期柱，条目标 settled + promotedTo（不再注入，避免与长期库重复）
 * discard  → 只标 settled + settleReason='discarded'，**数据留档不删**
 * keep     → 回到 active 并把 lastSeenFloor 推到当前楼层（延长有效期）
 * AI 漏判  → 按 keep 处理
 *
 * @param {object} options { settings, currentFloor, onProgress, skipSnapshot }
 */
export async function applySettleDecisions(chatId, decisions, missing = [], options = {}) {
    const settings = options.settings || getSettings();
    const currentFloor = Number(options.currentFloor);
    const result = {
        ok: true, snapshotId: '', promoted: [], discarded: [], kept: [],
        failed: [], summary: '', createdRefs: [], pruned: 0, cleanupError: '',
    };
    const list = (Array.isArray(decisions) ? decisions : []).filter(Boolean);
    const keepIds = new Set((Array.isArray(missing) ? missing : []).map(String));
    if (!list.length && !keepIds.size) {
        result.summary = '无待结算条目';
        return result;
    }

    if (!options.skipSnapshot) {
        try {
            // 快照必须覆盖**所有会被改到的条目**，包括 keep 与 AI 漏判的那些：
            // 它们的 settleState / lastSeenFloor 也会变，只快照 decisions 会漏掉整轮 keep 的还原能力。
            const affected = new Set([...list.map(d => String(d.id)), ...keepIds]);
            const current = await getRealtimeMemories(chatId);
            const snapshotEntries = current.filter(entry => affected.has(String(entry.id)));
            result.snapshotId = await beginSettleSnapshot(chatId, snapshotEntries, settings);
        } catch (e) {
            // 晋升会写长期库，没有回退网就不动手
            result.ok = false;
            result.summary = `撤销快照写入失败，已中止结算：${e.message}`;
            return result;
        }
    }

    let index = 0;
    for (const decision of list) {
        index++;
        options.onProgress?.({
            phase: 'settle', current: index, total: list.length,
            message: `正在结算（${index}/${list.length}）`,
        });
        try {
            if (decision.action === 'promote') {
                const ref = await promoteToPillar(chatId, decision);
                result.createdRefs.push(ref);
                await updateRealtimeMemories(chatId, [decision.id], {
                    settleState: 'settled',
                    settleReason: 'promoted',
                    promotedTo: { pillar: ref.pillar, id: ref.id },
                });
                result.promoted.push({ ...decision, ref });
            } else if (decision.action === 'discard') {
                await updateRealtimeMemories(chatId, [decision.id], {
                    settleState: 'settled',
                    settleReason: 'discarded',
                });
                result.discarded.push(decision);
            } else {
                keepIds.add(decision.id);
            }
        } catch (e) {
            result.failed.push({ id: decision.id, action: decision.action, error: e.message });
            console.warn(`[BB-Memory] 实时记忆结算失败（${decision.action} ${decision.id}）:`, e);
        }
    }

    if (keepIds.size) {
        const patch = { settleState: 'active', settleReason: '' };
        if (Number.isFinite(currentFloor)) patch.lastSeenFloor = currentFloor;
        const kept = await updateRealtimeMemories(chatId, [...keepIds], patch);
        result.kept = [...keepIds];
        if (settings.debugLogging && kept) {
            console.log(`[BB-Memory] 实时记忆结算：${kept} 条延长有效期`);
        }
    }

    // 快照已覆盖本轮受影响条目，超出保留楼层的 settled 项现在可以安全物理清理；
    // 用户撤销时 restoreEntriesVerbatim 会按原 id 写回。
    if (Number.isFinite(currentFloor)) {
        try {
            result.pruned = await pruneSettledRealtimeMemories(chatId, currentFloor, { settings });
        } catch (error) {
            result.cleanupError = error.message || String(error);
            console.warn('[BB-Memory] 实时结算已完成，但过期留档清理失败:', error);
        }
    }

    const parts = [];
    if (result.promoted.length) {
        const byPillar = {};
        for (const item of result.promoted) {
            const label = PROMOTE_PILLAR_LABELS[item.ref.pillar] || item.ref.pillar;
            byPillar[label] = (byPillar[label] || 0) + 1;
        }
        parts.push('晋升 ' + Object.entries(byPillar).map(([k, v]) => `${v} 条到${k}`).join('、'));
    }
    if (result.discarded.length) parts.push(`留档 ${result.discarded.length} 条`);
    if (result.kept.length) parts.push(`延期 ${result.kept.length} 条`);
    if (result.pruned) parts.push(`清理过期留档 ${result.pruned} 条`);
    if (result.cleanupError) parts.push('过期留档清理将在下次重试');
    if (result.failed.length) parts.push(`${result.failed.length} 条失败`);
    result.summary = parts.join('，') || '无改动';

    if (result.snapshotId) {
        await finalizeSettleSnapshot(chatId, result.snapshotId, {
            promoted: result.createdRefs,
            summary: result.summary,
        }).catch(() => { /* 补写失败不影响已完成的数据修改 */ });
    }
    return result;
}

/**
 * 撤销最近一次结算：删掉晋升新建的长期库条目，并把实时条目还原到结算前。
 * action==='merged' 的晋升不删——那是并进了已有实体，删掉会连带毁掉用户原有条目。
 */
export async function undoLastSettlement(chatId, options = {}) {
    if (!chatId) return { ok: false, error: '没有当前聊天' };
    const stack = await readSettleUndoStack(chatId);
    const targetId = options.snapshotId || stack.entries[0]?.id;
    const index = stack.entries.findIndex(entry => entry.id === targetId);
    if (index < 0) return { ok: false, error: '没有可撤销的结算记录' };

    const record = stack.entries[index];
    const removers = { mem: removeMemory, npc: removeNpcProfile, item: removeItem, milestone: removeMilestone };
    let removed = 0;
    let skippedMerged = 0;
    const failures = [];

    for (const ref of (record.promoted || [])) {
        if (ref.action === 'merged') { skippedMerged++; continue; }
        const remove = removers[ref.pillar];
        if (!remove) continue;
        try {
            if (await remove(chatId, ref.id)) removed++;
        } catch (e) {
            failures.push(`${PROMOTE_PILLAR_LABELS[ref.pillar] || ref.pillar} ${ref.id}：${e.message}`);
        }
    }

    let restored = 0;
    try {
        const outcome = await restoreEntriesVerbatim(chatId, 'realtime', record.before || []);
        restored = outcome.restored + outcome.reinserted;
    } catch (e) {
        failures.push(`实时记忆还原：${e.message}`);
    }

    stack.entries.splice(index, 1);
    await writeSettleUndoStack(chatId, stack);

    const notes = [`还原 ${restored} 条实时记忆`];
    if (removed) notes.push(`撤回 ${removed} 条晋升条目`);
    if (skippedMerged) notes.push(`${skippedMerged} 条已并入既有条目，未撤回`);
    return {
        // 快照本身为空是合法的空操作（那一轮什么都没改），不算失败
        ok: failures.length === 0,
        error: failures.length ? `部分撤销失败：${failures.join('；')}` : '',
        summary: notes.join('，'),
        restored,
        removed,
        skippedMerged,
        opSummary: record.summary || '',
        timestamp: record.timestamp,
    };
}

/**
 * 一次完整结算：标记 → 收集 pending → AI 判定 → 应用。
 *
 * @param {object} options
 *   currentFloor  当前楼层，用于 TTL 判定与 keep 延期
 *   manual        true 时把所有活跃条目一并推进待结算（「立即结算」按钮）
 *   onProgress    ({ phase, message, current, total }) => void
 */
export async function settleRealtimeMemories(chatId, options = {}) {
    const settings = options.settings || getSettings();
    const report = {
        ok: false, error: '', skipped: false, reason: '',
        pendingCount: 0, decisions: [], rejected: [], missing: [],
        applyResult: null, apiMode: '', durationMs: 0, summary: '', declinedPromotions: 0,
    };
    if (!chatId || !settings.realtimeEnabled) {
        report.skipped = true;
        report.reason = 'disabled';
        return report;
    }
    if (settlementInFlight) {
        report.skipped = true;
        report.reason = 'busy';
        report.error = '已有结算任务在运行，请稍后再试';
        return report;
    }

    settlementInFlight = true;
    try {
        options.onProgress?.({ phase: 'check', message: '正在检查待结算条目...' });
        if (options.manual) await markAllPendingSettle(chatId);
        else await checkSettlement(chatId, options.currentFloor, { settings });

        const entries = await getRealtimeMemories(chatId);
        const pending = entries.filter(e => e.settleState === 'pending_settle');
        report.pendingCount = pending.length;
        if (!pending.length) {
            report.ok = true;
            report.summary = '没有需要结算的条目';
            return report;
        }

        options.onProgress?.({ phase: 'ai', message: `正在结算 ${pending.length} 条场景细节...` });

        let api;
        try {
            api = pickApi(settings, options.apiMode);
        } catch (e) {
            report.error = e.message;
            report.summary = e.message;
            return report;
        }
        report.apiMode = api.mode;

        const [npc, items, memories, milestones] = await Promise.all([
            getNpcProfiles(chatId), getItems(chatId), getMemories(chatId), getMilestones(chatId),
        ]);
        const scene = deriveSceneState(entries);
        const prompt = buildSettlePrompt(pending, {
            settings,
            location: scene.location,
            storyTime: scene.storyTime,
            librarySummary: buildLibrarySummary({ npc, items, memories, milestones }),
        });

        const startedAt = Date.now();
        let rawText = '';
        try {
            rawText = await api.call(prompt, { isMerged: true });
        } catch (e) {
            report.durationMs = Date.now() - startedAt;
            report.error = `结算 API 调用失败：${e.message}`;
            report.summary = report.error;
            return report;
        }
        report.durationMs = Date.now() - startedAt;

        const parsed = parseSettleDecisions(rawText, { pending });
        report.decisions = parsed.decisions;
        report.rejected = parsed.rejected;
        report.missing = parsed.missing;

        // 解析全军覆没时不动数据：条目留在 pending，注入照旧生效，下次还能重试
        if (!parsed.decisions.length) {
            report.ok = true;
            report.summary = parsed.rejected.length
                ? `AI 返回的 ${parsed.rejected.length} 条决定全部被拦截，条目保持待结算`
                : 'AI 未给出任何决定，条目保持待结算';
            if (settings.debugLogging) console.warn('[BB-Memory] 结算被拦截:', parsed.rejected);
            return report;
        }

        // realtimePromotionMode='confirm'：晋升要写长期库，先让用户逐条过一眼。
        // 未勾选的转为 keep 而不是 discard——用户拒绝的是「晋升」这个动作，不是这条事实。
        let decisions = parsed.decisions;
        const extraKeep = [];
        const promotions = decisions.filter(d => d.action === 'promote');
        if (promotions.length && String(settings.realtimePromotionMode || 'auto') === 'confirm'
            && options.review !== false && typeof document !== 'undefined') {
            options.onProgress?.({ phase: 'review', message: `${promotions.length} 条晋升待确认` });
            const verdict = await openPromotionReviewPanel(promotions, { settings });
            const declinedIds = new Set(verdict.declined.map(d => String(d.id)));
            decisions = decisions.filter(d => !declinedIds.has(String(d.id)));
            extraKeep.push(...declinedIds);
            report.declinedPromotions = verdict.declined.length;
        }

        report.applyResult = await applySettleDecisions(chatId, decisions, [...parsed.missing, ...extraKeep], {
            settings,
            currentFloor: options.currentFloor,
            onProgress: options.onProgress,
        });
        report.ok = report.applyResult.ok;
        report.summary = report.applyResult.summary
            + (report.declinedPromotions ? `，${report.declinedPromotions} 条晋升被你拒绝（已保留为场景细节）` : '')
            + (parsed.rejected.length ? `，${parsed.rejected.length} 条决定被拦截` : '')
            + (parsed.missing.length ? `，${parsed.missing.length} 条 AI 漏判已按延期处理` : '');

        if (settings.debugLogging) {
            console.log(`[BB-Memory] 实时记忆结算：${report.summary}（${api.mode} API，${report.durationMs}ms）`);
        }
        return report;
    } catch (e) {
        report.error = e.message;
        report.summary = `结算异常：${e.message}`;
        console.warn('[BB-Memory] 实时记忆结算异常:', e);
        return report;
    } finally {
        settlementInFlight = false;
    }
}

/**
 * 提取完成后顺手推进结算。挂在 auto-generator 的后台链上调用。
 * 只有 realtimeSettleMode==='auto' 时才真的调 API；manual 档只标记不结算。
 */
export async function maybeSettleAfterExtraction(chatId, currentFloor, options = {}) {
    const settings = options.settings || getSettings();
    if (!chatId || !settings.realtimeEnabled) return { triggered: false, reason: 'disabled' };

    const check = await checkSettlement(chatId, currentFloor, { settings });
    if (String(settings.realtimeSettleMode || 'auto') !== 'auto') {
        return { triggered: false, reason: 'manual-mode', check };
    }
    if (!check.pendingCount) return { triggered: false, reason: 'nothing-pending', check };

    const report = await settleRealtimeMemories(chatId, { settings, currentFloor });
    return { triggered: true, check, report };
}

// ═══════════════════════════════════════════════════════════
//  Task 10：晋升确认面板（realtimePromotionMode='confirm'）
// ═══════════════════════════════════════════════════════════

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
}

/** 晋升会往长期库写新条目，确认档要让用户逐条过一眼。复用审核面板样式。 */
export function openPromotionReviewPanel(promoteDecisions, options = {}) {
    return new Promise((resolve) => {
        const list = (Array.isArray(promoteDecisions) ? promoteDecisions : []).filter(Boolean);
        if (!list.length) { resolve({ confirmed: [], declined: [] }); return; }

        document.getElementById('bb_rt_promote_overlay')?.remove();
        const state = list.map((decision, index) => ({ decision, index, selected: true }));
        let busy = false;

        const overlay = document.createElement('div');
        overlay.id = 'bb_rt_promote_overlay';
        overlay.className = 'bb-active-review-overlay';
        overlay.innerHTML = `
            <div class="bb-active-review-panel">
                <div class="bb-active-review-header">
                    <div>
                        <div class="bb-active-review-title"><i class="fa-solid fa-arrow-up-right-dots"></i> 场景细节晋升待确认</div>
                        <div class="bb-active-review-subtitle">勾选的会写进长期库；未勾选的保留为场景细节，不会丢失。</div>
                    </div>
                    <button class="menu_button bb-active-review-close" type="button" title="关闭">×</button>
                </div>
                <div class="bb-active-review-toolbar">
                    <button class="menu_button" type="button" data-action="select_all">全选</button>
                    <button class="menu_button" type="button" data-action="invert">反选</button>
                    <span class="bb-active-review-status"></span>
                </div>
                <div class="bb-active-review-list"></div>
                <div class="bb-active-review-footer">
                    <button class="menu_button danger" type="button" data-action="decline">全部不晋升</button>
                    <button class="menu_button" type="button" data-action="confirm">写入选中</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const listEl = overlay.querySelector('.bb-active-review-list');
        const statusEl = overlay.querySelector('.bb-active-review-status');
        const confirmBtn = overlay.querySelector('[data-action="confirm"]');

        function render() {
            listEl.innerHTML = state.map(row => {
                const { decision } = row;
                const pillarLabel = PROMOTE_PILLAR_LABELS[decision.pillar] || decision.pillar;
                const preview = promoteRequiredField(decision.fields, decision.pillar);
                return `
                    <label class="bb-active-review-item" data-index="${row.index}">
                        <input type="checkbox" ${row.selected ? 'checked' : ''} />
                        <div class="bb-active-review-item-body">
                            <div class="bb-active-review-item-head">
                                <span class="bb-active-review-type">晋升 · ${escapeHtml(pillarLabel)}</span>
                                <span class="bb-active-review-source">${escapeHtml(REALTIME_KINDS[decision.entry.kind]?.label || decision.entry.kind)}</span>
                            </div>
                            <div class="bb-active-review-item-title">${escapeHtml(decision.reason || '(AI 未给出理由)')}</div>
                            <div class="bb-curate-diff">
                                <div class="bb-curate-diff-row">
                                    <span class="bb-curate-diff-tag">原细节</span>
                                    <div class="bb-curate-diff-body">${escapeHtml(decision.entry.text)}</div>
                                </div>
                                <div class="bb-curate-diff-row">
                                    <span class="bb-curate-diff-tag ok">写入为</span>
                                    <div class="bb-curate-diff-body">${escapeHtml(preview)}</div>
                                </div>
                            </div>
                        </div>
                    </label>`;
            }).join('');
            statusEl.textContent = `已选 ${state.filter(r => r.selected).length} / ${state.length}`;
        }

        function finish(payload) {
            overlay.remove();
            resolve(payload);
        }

        listEl.addEventListener('change', (event) => {
            const item = event.target.closest('[data-index]');
            if (!item || busy) return;
            const row = state[Number(item.dataset.index)];
            if (row) row.selected = event.target.checked;
            statusEl.textContent = `已选 ${state.filter(r => r.selected).length} / ${state.length}`;
        });

        overlay.querySelector('.bb-active-review-toolbar').addEventListener('click', (event) => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (!action || busy) return;
            if (action === 'select_all') state.forEach(r => { r.selected = true; });
            if (action === 'invert') state.forEach(r => { r.selected = !r.selected; });
            render();
        });

        const declineAll = () => finish({ confirmed: [], declined: list });
        overlay.querySelector('.bb-active-review-close').addEventListener('click', () => { if (!busy) declineAll(); });

        overlay.querySelector('.bb-active-review-footer').addEventListener('click', (event) => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (!action || busy) return;
            if (action === 'decline') { declineAll(); return; }
            if (action !== 'confirm') return;
            busy = true;
            confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 处理中';
            finish({
                confirmed: state.filter(r => r.selected).map(r => r.decision),
                declined: state.filter(r => !r.selected).map(r => r.decision),
            });
        });

        render();
    });
}

// ═══════════════════════════════════════════════════════════
//  自检用例（浏览器控制台执行，零 API）
// ═══════════════════════════════════════════════════════════

export function __selfTestRealtime() {
    const cases = [];
    const add = (name, pass, actual = '') => cases.push({ name, pass, actual });

    // ── 场景标识 ──
    const cinemaAfternoon = computeSceneKey('电影院', '2026年4月9日下午');
    const cinemaEvening = computeSceneKey('电影院', '2026年4月9日傍晚');
    const cinema2130 = computeSceneKey('电影院', '2026年4月9日 21:30');
    const home = computeSceneKey('家', '2026年4月9日下午');
    const cinemaNextDay = computeSceneKey('电影院', '2026年4月10日下午');

    add('同地点不同时段 → 同一 scene key', cinemaAfternoon === cinemaEvening,
        `${cinemaAfternoon} vs ${cinemaEvening}`);
    add('同地点具体时刻 → 同一 scene key', cinemaAfternoon === cinema2130,
        `${cinemaAfternoon} vs ${cinema2130}`);
    add('换地点 → 换 scene key', cinemaAfternoon !== home, `${cinemaAfternoon} vs ${home}`);
    add('跨天 → 换 scene key', cinemaAfternoon !== cinemaNextDay, `${cinemaAfternoon} vs ${cinemaNextDay}`);
    add('地点空格/标点不影响', computeSceneKey(' 电影院 ', '2026年4月9日') === computeSceneKey('电影院', '2026年4月9日'));
    add('只有地点也能成 key', computeSceneKey('电影院', '') !== '');
    add('只有时间也能成 key', computeSceneKey('', '2026年4月9日') !== '');
    add('两者皆空 → 空 key（场景未知）', computeSceneKey('', '') === '' && computeSceneKey(null, undefined) === '');

    add('场景切换：不同 key → true', isSceneChanged('a|b', 'c|d') === true);
    add('场景切换：相同 key → false', isSceneChanged('a|b', 'a|b') === false);
    add('场景切换：任一侧未知 → false（不误触发结算）',
        isSceneChanged('', 'a|b') === false && isSceneChanged('a|b', '') === false
        && isSceneChanged(null, null) === false);

    // ── 场景状态反推 ──
    const entries = [
        { id: '1', sceneKey: 'k1', location: '家', storyTime: 'd1', createdFloor: 10, lastSeenFloor: 10, settleState: 'active' },
        { id: '2', sceneKey: 'k2', location: '电影院', storyTime: 'd1', createdFloor: 40, lastSeenFloor: 40, settleState: 'active' },
        { id: '3', sceneKey: 'k2', location: '电影院', storyTime: 'd1', createdFloor: 42, lastSeenFloor: 43, settleState: 'active' },
        { id: '4', sceneKey: 'k3', location: '公司', storyTime: 'd2', createdFloor: 99, lastSeenFloor: 99, settleState: 'settled' },
    ];
    const state = deriveSceneState(entries);
    add('反推当前场景取最新未结算条目', state.sceneKey === 'k2' && state.location === '电影院',
        JSON.stringify(state));
    add('反推忽略已结算条目（不会取到 k3）', state.sceneKey !== 'k3', state.sceneKey);
    add('反推收集本场景涉及的楼层', state.floors.join(',') === '40,42', state.floors.join(','));
    add('空输入不抛错', deriveSceneState([]).sceneKey === '' && deriveSceneState(null).sceneKey === '');

    // ── 抓取范围控制 ──
    const on = { realtimeEnabled: true, realtimeExtractEnabled: true };
    add('总开关关闭 → 不抓',
        shouldExtractRealtime({ realtimeEnabled: false, realtimeExtractEnabled: true }).extract === false);
    add('抓取开关关闭 → 不抓',
        shouldExtractRealtime({ realtimeEnabled: true, realtimeExtractEnabled: false }).extract === false);
    add('always 档每层都抓',
        shouldExtractRealtime({ ...on, realtimeExtractScope: 'always' }, { sceneFloors: [1, 2, 3, 4, 5, 6, 7, 8], floor: 9 }).extract === true);
    add('未设 scope 时默认 always',
        shouldExtractRealtime(on, { sceneFloors: Array.from({ length: 50 }, (_, i) => i), floor: 99 }).extract === true);
    const firstN = { ...on, realtimeExtractScope: 'first_n', realtimeExtractFirstN: 3 };
    add('first_n 档：场景前 3 层抓',
        shouldExtractRealtime(firstN, { sceneFloors: [10, 11], floor: 12 }).extract === true);
    add('first_n 档：第 4 层不抓',
        shouldExtractRealtime(firstN, { sceneFloors: [10, 11, 12], floor: 13 }).extract === false,
        JSON.stringify(shouldExtractRealtime(firstN, { sceneFloors: [10, 11, 12], floor: 13 })));
    add('first_n 档：同一层重复调用仍放行（已计数过）',
        shouldExtractRealtime(firstN, { sceneFloors: [10, 11, 12], floor: 12 }).extract === true);
    add('first_n 档：换场景后计数从头开始',
        shouldExtractRealtime(firstN, { sceneFloors: [], floor: 50 }).extract === true);

    // ── 响应解析 ──
    const okJson = JSON.stringify({
        details: [
            { k: 'transport', s: 'A和B的交通', t: 'A和B坐公交车前往电影院' },
            { k: '衣着', s: 'A的衣着', t: 'A穿连衣裙' },
            { k: 'bogus', s: '门边的雨伞', t: 'B把伞靠在门边' },
        ],
    });
    const okParsed = parseRealtimeDetails(okJson, { maxDetails: 5 });
    add('解析正常响应', okParsed.details.length === 3, JSON.stringify(okParsed));
    add('kind 英文键原样', okParsed.details[0].kind === 'transport');
    add('kind 中文标签被归一化', okParsed.details[1].kind === 'outfit', okParsed.details[1].kind);
    add('kind 未知值回退 detail', okParsed.details[2].kind === 'detail', okParsed.details[2].kind);
    add('槽位名被解析', okParsed.details[0].slotKey === 'A和B的交通', okParsed.details[0].slotKey);

    add('带代码块与外包文字仍可解析',
        parseRealtimeDetails('好的：\n```json\n{"details":[{"k":"outfit","t":"A穿风衣"}]}\n```', {}).details.length === 1);
    add('裸数组也接受（模型忽略"输出对象"要求时）',
        parseRealtimeDetails('[{"k":"state","t":"A被雨淋湿了"}]', {}).details.length === 1,
        JSON.stringify(parseRealtimeDetails('[{"k":"state","t":"A被雨淋湿了"}]', {})));
    add('多条裸数组不会只剩第一条', (() => {
        const res = parseRealtimeDetails('[{"k":"state","t":"A被雨淋湿了"},{"k":"outfit","t":"B穿风衣"}]', {});
        return res.details.length === 2;
    })(), JSON.stringify(parseRealtimeDetails('[{"k":"state","t":"A"},{"k":"outfit","t":"B"}]', {}).details));
    add('对象响应仍优先走对象路径',
        parseRealtimeDetails('{"details":[{"k":"outfit","t":"A穿风衣"},{"k":"state","t":"A淋湿"}]}', {}).details.length === 2);
    add('空 details 正常返回', parseRealtimeDetails('{"details":[]}', {}).details.length === 0);
    add('非 JSON 被拒且不抛错', (() => {
        const res = parseRealtimeDetails('这一层没有值得记录的细节。', {});
        return res.details.length === 0 && res.rejected.length === 1;
    })());
    add('空文本条目被拒',
        parseRealtimeDetails('{"details":[{"k":"outfit","t":"  "}]}', {}).details.length === 0);
    add('同批次重复被去掉', (() => {
        const res = parseRealtimeDetails(JSON.stringify({
            details: [{ k: 'outfit', t: 'A穿连衣裙' }, { k: 'outfit', t: 'A穿连衣裙' }],
        }), {});
        return res.details.length === 1 && res.rejected.length === 1;
    })());
    add('超出 maxDetails 被截断', (() => {
        const res = parseRealtimeDetails(JSON.stringify({
            details: Array.from({ length: 10 }, (_, i) => ({ k: 'detail', t: `细节${i}` })),
        }), { maxDetails: 3 });
        return res.details.length === 3;
    })());
    add(`过长文本被截到 ${MAX_DETAIL_CHARS} 字`, (() => {
        const res = parseRealtimeDetails(JSON.stringify({
            details: [{ k: 'detail', t: '很长的细节'.repeat(40) }],
        }), {});
        return res.details[0].text.length === MAX_DETAIL_CHARS + 1; // +1 是省略号
    })(), String(parseRealtimeDetails(JSON.stringify({ details: [{ k: 'detail', t: '很长的细节'.repeat(40) }] }), {}).details[0]?.text.length));
    add('兼容 text/kind 长字段名',
        parseRealtimeDetails('{"details":[{"kind":"present","text":"检票员在场"}]}', {}).details[0].kind === 'present');
    add('关闭分类在解析层被拦截', (() => {
        const res = parseRealtimeDetails('{"details":[{"k":"outfit","s":"A","t":"A穿风衣"}]}', {
            allowedKinds: ['transport'],
        });
        return res.details.length === 0 && res.rejected[0]?.reason.includes('已关闭');
    })());
    add('r 只能引用现有槽位 id', (() => {
        const pass = parseRealtimeDetails('{"details":[{"k":"outfit","r":"old1","t":"A换成风衣"}]}', { existingIds: ['old1'] });
        const reject = parseRealtimeDetails('{"details":[{"k":"outfit","r":"ghost","t":"A换成风衣"}]}', { existingIds: ['old1'] });
        return pass.details[0]?.replaceId === 'old1' && reject.details.length === 0;
    })());

    // ── 提示词构建 ──
    const prompt = buildRealtimePrompt('A和B坐公交车来到电影院，A穿着连衣裙。', {
        settings: { realtimeMaxDetailsPerFloor: 4 },
        location: '电影院',
        storyTime: '2026年4月9日下午',
    });
    add('提示词无占位符残留',
        !/\{\{(maxDetails|location|storyTime|aiMessage)\}\}/.test(prompt), prompt.slice(0, 80));
    add('提示词带入 maxDetails', prompt.includes('最多 4 条'));
    add('提示词带入地点与时间', prompt.includes('电影院') && prompt.includes('2026年4月9日下午'));
    add('提示词带入本层回复', prompt.includes('A和B坐公交车来到电影院'));
    add('提示词明确排除里程碑级内容', prompt.includes('里程碑级内容'));
    add('自定义模板覆盖生效且仍追加系统槽位约束', (() => {
        const custom = buildRealtimePrompt('x', { settings: { customPromptTemplates: { 'realtime.detailExtract': '自定义：{{aiMessage}}' } } });
        return custom.startsWith('自定义：x') && custom.includes('本次分类槽位硬约束');
    })());
    add('超长回复被截断',
        buildRealtimePrompt('字'.repeat(5000), { settings: {} }).length < 5000 + 2000,
        String(buildRealtimePrompt('字'.repeat(5000), { settings: {} }).length));

    // ── 主提取结果里取场景信息 ──
    const picked = pickSceneInfoFromExtraction({
        locations: [{ name: '电影院' }, { name: '售票厅' }],
        milestones: [{ storyTime: '2026年4月9日下午' }],
        memories: [{ storyTime: '2026年4月9日傍晚' }],
    });
    add('取第一个地点', picked.location === '电影院', picked.location);
    add('里程碑时间优先于记忆时间', picked.storyTime === '2026年4月9日下午', picked.storyTime);
    add('无地点无时间时返回空串',
        (() => { const p = pickSceneInfoFromExtraction({}); return p.location === '' && p.storyTime === ''; })());
    add('记忆时间兜底',
        pickSceneInfoFromExtraction({ memories: [{ storyTime: 'd9' }] }).storyTime === 'd9');
    add('10 种分类全部可被归一化命中',
        Object.keys(REALTIME_KINDS).every(k => normalizeRealtimeKind(k) === k));

    // ── 固定分类槽位与 upsert ──
    const slotExisting = [
        { id: 'o1', kind: 'outfit', slotKey: 'A的衣着', text: 'A穿红裙', sceneKey: 'S', createdFloor: 10, lastSeenFloor: 10, settleState: 'active' },
    ];
    const slotSettings = { realtimeOutfitSlots: 1 };
    const replacePlan = planRealtimeDetailWrites(slotExisting, [
        { kind: 'outfit', slotKey: 'A的衣着', text: 'A换成蓝裙' },
    ], { settings: slotSettings, sceneKey: 'S', floor: 12 });
    add('同分类同槽位更新原条目而不新增',
        replacePlan.updates.length === 1 && replacePlan.adds.length === 0
        && replacePlan.updates[0].id === 'o1' && replacePlan.updates[0].patch.text === 'A换成蓝裙',
        JSON.stringify(replacePlan));
    const fullPlan = planRealtimeDetailWrites(slotExisting, [
        { kind: 'outfit', slotKey: 'B的衣着', text: 'B穿风衣' },
    ], { settings: slotSettings, sceneKey: 'S', floor: 12 });
    add('分类槽位已满时拒绝新增对象',
        fullPlan.adds.length === 0 && fullPlan.rejected[0]?.reason.includes('槽位已满'), JSON.stringify(fullPlan));
    const duplicatePlan = planRealtimeDetailWrites([
        ...slotExisting,
        { ...slotExisting[0], id: 'o2', createdFloor: 11, lastSeenFloor: 11 },
    ], [], { settings: { realtimeOutfitSlots: 2 }, sceneKey: 'S', floor: 12 });
    add('历史完全重复项只保留最新一条参与当前场景',
        duplicatePlan.retire.length === 1 && duplicatePlan.retire[0].id === 'o1'
        && duplicatePlan.retire[0].reason === 'duplicate', JSON.stringify(duplicatePlan.retire));
    add('分类设 0 时旧活跃项退出、新条目被拒绝', (() => {
        const plan = planRealtimeDetailWrites(slotExisting, [
            { kind: 'outfit', slotKey: 'A的衣着', text: 'A穿红裙' },
        ], { settings: { realtimeOutfitSlots: 0 }, sceneKey: 'S', floor: 12 });
        return plan.retire.some(item => item.id === 'o1') && plan.adds.length === 0 && plan.rejected.length === 1;
    })());

    // ── Task 9：结算触发器 ──
    const mk = (over = {}) => ({
        id: 'x', kind: 'detail', text: 't', sceneKey: 'S1', location: '电影院', storyTime: 'd1',
        createdFloor: 40, lastSeenFloor: 40, settleState: 'active', settleReason: '',
        promotedTo: null, createdAt: 1000, updatedAt: 1000, ...over,
    });
    const settleCfg = {
        realtimeTtlFloors: 12, realtimeMaxEntries: 40, realtimeSceneChangeSettle: true,
    };

    // 场景切换：当前场景取最新条目的 sceneKey，旧场景条目被标记
    const sceneMix = [
        mk({ id: 'old1', sceneKey: 'HOME|d1', lastSeenFloor: 30 }),
        mk({ id: 'old2', sceneKey: 'HOME|d1', lastSeenFloor: 31 }),
        mk({ id: 'new1', sceneKey: 'CINEMA|d1', lastSeenFloor: 42 }),
    ];
    const scenePlan = planSettlement(sceneMix, 43, settleCfg);
    add('触发器·场景切换：旧场景 2 条被标记，当前场景不动',
        scenePlan.marks.length === 2 && scenePlan.marks.every(m => m.reason === 'scene_change')
        && !scenePlan.marks.some(m => m.id === 'new1'),
        JSON.stringify(scenePlan.marks));
    // 关掉场景切换后单独验证：同时关掉 TTL/容量，确保测的就是场景切换这一个触发器
    add('触发器·场景切换可关闭',
        planSettlement(sceneMix, 43, {
            realtimeSceneChangeSettle: false, realtimeTtlFloors: 0, realtimeMaxEntries: 0,
        }).marks.length === 0,
        JSON.stringify(planSettlement(sceneMix, 43, {
            realtimeSceneChangeSettle: false, realtimeTtlFloors: 0, realtimeMaxEntries: 0,
        }).marks));
    add('触发器：多个触发器可同时命中不同条目', (() => {
        const plan = planSettlement(sceneMix, 43, settleCfg);
        // old1/old2 属于旧场景 → scene_change 先标；开着 TTL 也不会改写 reason
        return plan.marks.length === 2 && plan.marks.every(m => m.reason === 'scene_change');
    })());
    add('场景未知时不误触发场景切换',
        planSettlement([mk({ id: 'a', sceneKey: '' }), mk({ id: 'b', sceneKey: '' })], 41, settleCfg).marks.length === 0);

    // TTL
    const ttlPlan = planSettlement([
        mk({ id: 'fresh', lastSeenFloor: 45 }),
        mk({ id: 'stale', lastSeenFloor: 30 }),
    ], 45, settleCfg);
    add('触发器·TTL：超过 12 层未提及的被标记',
        ttlPlan.marks.length === 1 && ttlPlan.marks[0].id === 'stale' && ttlPlan.marks[0].reason === 'ttl',
        JSON.stringify(ttlPlan.marks));
    add('触发器·TTL 边界：正好 12 层触发',
        planSettlement([mk({ id: 'edge', lastSeenFloor: 30 })], 42, settleCfg).marks.length === 1);
    add('触发器·TTL 边界：11 层不触发',
        planSettlement([mk({ id: 'edge', lastSeenFloor: 30 })], 41, settleCfg).marks.length === 0);
    add('触发器·TTL 设 0 时关闭',
        planSettlement([mk({ id: 'stale', lastSeenFloor: 0 })], 999, { ...settleCfg, realtimeTtlFloors: 0 }).marks.length === 0);

    // 容量：最旧的先出
    const capEntries = Array.from({ length: 5 }, (_, i) =>
        mk({ id: 'c' + i, lastSeenFloor: 40 + i, createdAt: 1000 + i }));
    const capPlan = planSettlement(capEntries, 44, { ...settleCfg, realtimeMaxEntries: 3, realtimeTtlFloors: 0 });
    add('触发器·容量：超出 2 条，最旧的先出',
        capPlan.marks.length === 2 && capPlan.marks.map(m => m.id).sort().join(',') === 'c0,c1',
        JSON.stringify(capPlan.marks.map(m => m.id)));
    add('触发器·容量在场景/TTL 之后算（不重复标记）',
        planSettlement([
            mk({ id: 'stale', lastSeenFloor: 10 }),
            mk({ id: 'k1', lastSeenFloor: 44 }),
            mk({ id: 'k2', lastSeenFloor: 45 }),
        ], 45, { ...settleCfg, realtimeMaxEntries: 2 }).marks.length === 1);
    add('触发器：已 pending / settled 的条目不再参与',
        planSettlement([
            mk({ id: 'p', settleState: 'pending_settle', lastSeenFloor: 1 }),
            mk({ id: 's', settleState: 'settled', lastSeenFloor: 1 }),
        ], 999, settleCfg).marks.length === 0);
    add('触发器：空输入不抛错',
        planSettlement([], 10, settleCfg).marks.length === 0 && planSettlement(null, 10, settleCfg).marks.length === 0);

    // 留档修剪
    const settledMany = Array.from({ length: 10 }, (_, i) =>
        mk({ id: 'sd' + i, settleState: 'settled', createdFloor: 30 + i, lastSeenFloor: 30 + i, updatedAt: 1000 + i }));
    const prune = planSettledPrune(settledMany, 40, { realtimeSettledRetentionFloors: 5 });
    add('留档修剪：只删除当前楼层 5 层范围以外的 settled',
        prune.length === 5 && prune.join(',') === 'sd0,sd1,sd2,sd3,sd4', prune.join(','));
    add('留档修剪：正好相距 5 层仍保留',
        !prune.includes('sd5'));
    add('留档修剪：窗口足够大时不修剪',
        planSettledPrune(settledMany, 40, { realtimeSettledRetentionFloors: 20 }).length === 0);
    add('留档修剪：窗口设 0 时所有 settled 立即清理',
        planSettledPrune(settledMany, 40, { realtimeSettledRetentionFloors: 0 }).length === settledMany.length);
    add('留档修剪：已晋升条目同样遵守楼层窗口',
        planSettledPrune(settledMany.map(e => ({ ...e, promotedTo: { pillar: 'mem', id: 'm1' } })),
            40, { realtimeSettledRetentionFloors: 5 }).length === 5);
    add('留档修剪：活跃条目不修剪',
        planSettledPrune(Array.from({ length: 10 }, (_, i) => mk({ id: 'a' + i })), 99,
            { realtimeSettledRetentionFloors: 0 }).length === 0);

    // ── Task 9：决定解析 ──
    const pendingFixture = [
        mk({ id: 'd1', kind: 'transport', text: 'A和B坐公交车前往电影院', settleState: 'pending_settle', settleReason: 'scene_change' }),
        mk({ id: 'd2', kind: 'outfit', text: 'A穿连衣裙', settleState: 'pending_settle', settleReason: 'scene_change' }),
        mk({ id: 'd3', kind: 'present', text: '卖爆米花的小孩', settleState: 'pending_settle', settleReason: 'scene_change' }),
    ];
    const decisionJson = JSON.stringify({
        decisions: [
            { id: 'd1', action: 'discard', reason: '行程已结束' },
            { id: 'd2', action: 'discard', reason: '换场景即失效' },
            { id: 'd3', action: 'promote', pillar: 'npc', fields: { name: '爆米花小孩', role: '影院小贩' }, reason: '有辨识度' },
        ],
    });
    const decided = parseSettleDecisions(decisionJson, { pending: pendingFixture });
    add('解析结算决定：3 条全部通过', decided.decisions.length === 3 && !decided.rejected.length,
        JSON.stringify(decided.rejected));
    add('解析：promote 带出 pillar 与 fields',
        decided.decisions[2].pillar === 'npc' && decided.decisions[2].fields.name === '爆米花小孩');
    add('解析：无漏判时 missing 为空', decided.missing.length === 0);

    add('解析：AI 漏判的条目进 missing（按延期处理，不当 discard）', (() => {
        const res = parseSettleDecisions('{"decisions":[{"id":"d1","action":"discard"}]}', { pending: pendingFixture });
        return res.missing.length === 2 && res.missing.join(',') === 'd2,d3';
    })());
    add('解析：不在待结算列表的 id 被拦截',
        parseSettleDecisions('{"decisions":[{"id":"zzz","action":"discard"}]}', { pending: pendingFixture }).decisions.length === 0);
    add('解析：重复 id 被拦截', (() => {
        const res = parseSettleDecisions(JSON.stringify({
            decisions: [{ id: 'd1', action: 'discard' }, { id: 'd1', action: 'keep' }],
        }), { pending: pendingFixture });
        return res.decisions.length === 1 && res.rejected.length === 1;
    })());
    add('解析：未知动作被拦截',
        parseSettleDecisions('{"decisions":[{"id":"d1","action":"nuke"}]}', { pending: pendingFixture }).decisions.length === 0);
    add('解析：非法目标柱被拦截',
        parseSettleDecisions('{"decisions":[{"id":"d1","action":"promote","pillar":"bogus","fields":{"content":"x"}}]}',
            { pending: pendingFixture }).decisions.length === 0);
    add('解析：promote 缺 fields 被拦截',
        parseSettleDecisions('{"decisions":[{"id":"d1","action":"promote","pillar":"mem"}]}',
            { pending: pendingFixture }).decisions.length === 0);
    add('解析：promote 到 mem 缺主内容被拦截',
        parseSettleDecisions('{"decisions":[{"id":"d1","action":"promote","pillar":"mem","fields":{"subject":"A"}}]}',
            { pending: pendingFixture }).decisions.length === 0);
    add('解析：promote 到 npc 缺 name 被拦截',
        parseSettleDecisions('{"decisions":[{"id":"d1","action":"promote","pillar":"npc","fields":{"role":"小贩"}}]}',
            { pending: pendingFixture }).decisions.length === 0);
    add('解析：笼统实体名被拦截（「一个小孩」）',
        parseSettleDecisions('{"decisions":[{"id":"d1","action":"promote","pillar":"npc","fields":{"name":"一个小孩"}}]}',
            { pending: pendingFixture }).decisions.length === 0);
    add('解析：fields 系统字段被剥离', (() => {
        const res = parseSettleDecisions(JSON.stringify({
            decisions: [{
                id: 'd1', action: 'promote', pillar: 'mem',
                fields: { id: 'hack', hitScore: 999, memoryTier: 'eternal', content: '一起看了电影。' },
            }],
        }), { pending: pendingFixture });
        return Object.keys(res.decisions[0].fields).join(',') === 'content';
    })(), JSON.stringify(parseSettleDecisions(JSON.stringify({ decisions: [{ id: 'd1', action: 'promote', pillar: 'mem', fields: { id: 'hack', hitScore: 9, content: 'x' } }] }), { pending: pendingFixture }).decisions[0]?.fields));
    add('解析：非 JSON 时全部条目进 missing（不误 discard）', (() => {
        const res = parseSettleDecisions('这些细节我看不出来。', { pending: pendingFixture });
        return res.decisions.length === 0 && res.missing.length === 3;
    })());
    add('解析：一条非法不影响同批其他条', (() => {
        const res = parseSettleDecisions(JSON.stringify({
            decisions: [{ id: 'd1', action: 'nuke' }, { id: 'd2', action: 'keep', reason: '还在场' }],
        }), { pending: pendingFixture });
        return res.decisions.length === 1 && res.decisions[0].id === 'd2' && res.rejected.length === 1;
    })());
    add('笼统名判定：具体名通过',
        !isVagueEntityName('爆米花小孩') && !isVagueEntityName('林澈') && isVagueEntityName('一个小孩')
        && isVagueEntityName('路人') && isVagueEntityName(''));

    // ── Task 9：结算提示词 ──
    const settlePrompt = buildSettlePrompt(pendingFixture, {
        settings: {},
        location: '电影院',
        storyTime: '2026年4月9日下午',
        librarySummary: '已有 NPC：林澈',
    });
    add('结算提示词无占位符残留',
        !/\{\{(location|storyTime|settleReason|librarySummary|pendingText)\}\}/.test(settlePrompt),
        settlePrompt.slice(0, 80));
    add('结算提示词含三条待结算细节',
        ['d1', 'd2', 'd3'].every(id => settlePrompt.includes(`id=${id}`)));
    add('结算提示词带入长期库摘要（避免重复晋升）', settlePrompt.includes('已有 NPC：林澈'));
    add('结算提示词带入结算原因', settlePrompt.includes('场景切换'));
    add('结算提示词说明 discard 只是留档不是删除', settlePrompt.includes('留档'));
    add('结算提示词自定义模板生效',
        buildSettlePrompt([], { settings: { customPromptTemplates: { 'realtime.settle': '自定义结算' } } }) === '自定义结算');

    const summary = buildLibrarySummary({
        npc: [{ name: '林澈' }, { name: '归档的', archived: true }],
        items: [{ name: '银钥匙' }],
        memories: [{ title: '交出银钥匙' }],
        milestones: [{ event: '确认同盟' }],
    });
    add('长期库摘要包含四柱', ['林澈', '银钥匙', '交出银钥匙', '确认同盟'].every(t => summary.includes(t)), summary);
    add('长期库摘要排除归档条目', !summary.includes('归档的'), summary);
    add('长期库为空时给占位文案', buildLibrarySummary({}) === '（长期库暂时为空）');

    const pass = cases.every(c => c.pass);
    return { pass, cases };
}
