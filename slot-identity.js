/**
 * slot-identity.js —— BB-Memory 存档身份与救援 (v9.3.1)
 *
 * 【问题背景】
 * v9.3.0 及更早版本使用 SillyTavern 的 ctx.characterId 作为存档槽命名空间：
 *     bb_memory_slot_<characterId>_<slotName>
 * 但 ctx.characterId 是 characters 数组的**下标**（等价于 this_chid），
 * 并不是稳定标识。导入 / 删除角色，或改变角色排序后，所有下标都会平移，
 * 于是：
 *   - listSlots() 找不到任何槽 -> 只剩一个凭空生成的空 default
 *   - 更糟：另一个角色可能占据旧下标，导致跨角色覆盖写入（真实数据损坏）
 *
 * 【本模块职责】
 * 1. 提供稳定角色 ID：char:<avatar 文件名> / group:<groupId>
 * 2. 维护身份台账，记录 稳定ID <-> 历史下标 的映射，使漂移可追溯
 * 3. 扫描 localforage 中所有存档命名空间，为「存档救援」提供数据
 * 4. 基于证据的自动迁移（复制，绝不删除旧键）
 *
 * 【安全原则】
 * - 所有写入只发生在稳定命名空间
 * - 迁移一律复制，旧键原样保留，直到用户明确确认清理
 * - 证据不足时不猜测归属，交由「存档救援」面板人工认领
 */

import { getSettings, updateSettings } from './memory-store.js';

// ═══ 存储键 ═══

const SLOT_PREFIX = 'bb_memory_slot_';
const SLOT_LIST_PREFIX = 'bb_memory_slot_list_';
const IDENTITY_KEY = 'bb_memory_char_identity';
const REMOTE_SLOT_INDEX_KEY = 'bb_memory_slot_index';
const IDENTITY_VERSION = 1;

// 这些前缀虽然以 SLOT_PREFIX 开头，但不是槽数据本身，扫描时必须排除
const NON_SLOT_SUBPREFIXES = ['list_', 'data_', 'claim_'];

function getCtx() {
    try { return SillyTavern.getContext(); } catch { return null; }
}

function getLF() {
    const ctx = getCtx();
    return ctx?.libs?.localforage || globalThis.localforage || globalThis.SillyTavern?.libs?.localforage;
}

// ═══════════════════════════════════════════════════════════
//  稳定角色 ID
// ═══════════════════════════════════════════════════════════

/**
 * 稳定角色 ID。
 * 群聊 -> group:<groupId>（groupId 本身即为稳定生成 ID）
 * 单人 -> char:<avatar 文件名>（SillyTavern 自身即以 avatar 作为角色身份）
 *
 * 无法解析时返回 null —— 刻意不回退到数组下标，
 * 因为下标不稳定，回退等于把 v9.3.0 的 bug 带回来。
 */
export function getStableCharacterId() {
    const ctx = getCtx();
    if (!ctx) return null;

    const gid = ctx.groupId;
    if (gid !== undefined && gid !== null && gid !== '') return `group:${gid}`;

    const char = getCurrentCharacter();
    if (char?.avatar) return `char:${String(char.avatar)}`;
    if (char?.name) return `charname:${String(char.name)}`;

    // 刻意不回退到数组下标。宁可让上层报"无法获取角色ID"并停手，
    // 也不能用不稳定的下标去读写存档 —— 那正是 v9.3.0 存档丢失的根因。
    if (!warnedMissingStableId) {
        warnedMissingStableId = true;
        console.warn(
            '[BB-Memory] 无法解析稳定角色 ID（characters/groupId 均不可用）。'
            + '存档读写将暂停以保护数据，请把这条日志反馈给开发者。',
            { hasCharacters: Array.isArray(ctx.characters), characterId: ctx.characterId, this_chid: ctx.this_chid },
        );
    }
    return null;
}

let warnedMissingStableId = false;

/**
 * v9.3.0 及更早版本使用的（不稳定的）角色下标，仅用于迁移与救援匹配。
 */
export function getLegacyCharacterIndex() {
    const ctx = getCtx();
    if (!ctx) return null;
    if (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        return String(ctx.characterId);
    }
    if (ctx.this_chid !== undefined && ctx.this_chid !== null && ctx.this_chid !== '') {
        return String(ctx.this_chid);
    }
    return null;
}

function getCurrentCharacter() {
    const ctx = getCtx();
    if (!ctx || !Array.isArray(ctx.characters)) return null;
    const idx = (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '')
        ? ctx.characterId
        : ctx.this_chid;
    if (idx === undefined || idx === null || idx === '') return null;
    return ctx.characters[idx] || null;
}

export function getCharacterDisplayName(stableId = null) {
    const ctx = getCtx();
    if (stableId && String(stableId).startsWith('group:')) {
        const gid = String(stableId).slice('group:'.length);
        const group = (ctx?.groups || []).find(g => String(g.id) === gid);
        if (group?.name) return group.name;
        return `群组 ${gid}`;
    }
    const char = getCurrentCharacter();
    if (char?.name) return char.name;
    if (stableId) return String(stableId).replace(/^char(name)?:/, '');
    return '';
}

export function isLegacyNamespaceId(charId) {
    const text = String(charId ?? '');
    if (!text) return false;
    return /^\d+$/.test(text);
}

// ═══════════════════════════════════════════════════════════
//  身份台账
// ═══════════════════════════════════════════════════════════

function emptyLedger() {
    return { version: IDENTITY_VERSION, updatedAt: 0, chars: {}, claims: {} };
}

function normalizeLedger(raw) {
    const base = emptyLedger();
    if (!raw || typeof raw !== 'object') return base;
    base.updatedAt = Number(raw.updatedAt) || 0;
    if (raw.chars && typeof raw.chars === 'object' && !Array.isArray(raw.chars)) {
        for (const [id, entry] of Object.entries(raw.chars)) {
            if (!id || !entry || typeof entry !== 'object') continue;
            base.chars[id] = {
                name: String(entry.name || ''),
                legacyIds: Array.isArray(entry.legacyIds) ? [...new Set(entry.legacyIds.map(String))] : [],
                lastIndex: entry.lastIndex === undefined || entry.lastIndex === null ? null : String(entry.lastIndex),
                migrations: Array.isArray(entry.migrations) ? entry.migrations.slice(0, 40) : [],
                firstSeenAt: Number(entry.firstSeenAt) || 0,
                updatedAt: Number(entry.updatedAt) || 0,
            };
        }
    }
    if (raw.claims && typeof raw.claims === 'object' && !Array.isArray(raw.claims)) {
        for (const [legacyId, owner] of Object.entries(raw.claims)) {
            if (!legacyId || !owner) continue;
            base.claims[String(legacyId)] = String(owner);
        }
    }
    return base;
}

export async function readIdentityLedger() {
    const lf = getLF();
    if (!lf) return emptyLedger();
    try {
        return normalizeLedger(await lf.getItem(IDENTITY_KEY));
    } catch {
        return emptyLedger();
    }
}

async function writeIdentityLedger(ledger) {
    const lf = getLF();
    if (!lf) return false;
    try {
        const clean = normalizeLedger(ledger);
        clean.updatedAt = Date.now();
        await lf.setItem(IDENTITY_KEY, clean);
        return true;
    } catch {
        return false;
    }
}

/**
 * 记录当前角色的身份信息与当前下标。
 * 这样即使日后下标再次漂移，也能通过台账反查回来。
 */
export async function recordCharacterIdentity(stableId = getStableCharacterId()) {
    if (!stableId) return null;
    const ledger = await readIdentityLedger();
    const now = Date.now();
    const legacyIndex = getLegacyCharacterIndex();
    const entry = ledger.chars[stableId] || {
        name: '', legacyIds: [], lastIndex: null, migrations: [], firstSeenAt: now, updatedAt: 0,
    };
    const name = getCharacterDisplayName(stableId);
    if (name) entry.name = name;
    if (legacyIndex !== null) entry.lastIndex = legacyIndex;
    entry.updatedAt = now;
    if (!entry.firstSeenAt) entry.firstSeenAt = now;
    ledger.chars[stableId] = entry;
    await writeIdentityLedger(ledger);
    return entry;
}

/**
 * 该角色已确认关联（迁移过）的历史命名空间。
 */
export async function getLinkedLegacyIds(stableId) {
    if (!stableId) return [];
    const ledger = await readIdentityLedger();
    return ledger.chars[stableId]?.legacyIds || [];
}

/**
 * 读取远程槽索引 / 旧作用域键时可接受的所有 charId（稳定 ID + 已确认历史命名空间）。
 */
export async function getAcceptableCharIds(stableId) {
    const ids = [];
    if (stableId) ids.push(String(stableId));
    for (const legacy of await getLinkedLegacyIds(stableId)) ids.push(String(legacy));
    return [...new Set(ids)];
}

// chatMetadata 相关读取是同步的，但台账在 localforage 里。
// 用一个内存缓存桥接：冷缓存时退化为只认稳定 ID（安全方向）。
let acceptableCache = { stableId: null, ids: [] };

export function getAcceptableCharIdsSync(stableId) {
    if (stableId && acceptableCache.stableId === String(stableId)) return acceptableCache.ids;
    return stableId ? [String(stableId)] : [];
}

export async function primeIdentityCache(stableId = getStableCharacterId()) {
    if (!stableId) {
        acceptableCache = { stableId: null, ids: [] };
        return [];
    }
    const ids = await getAcceptableCharIds(stableId);
    acceptableCache = { stableId: String(stableId), ids };
    return ids;
}

function invalidateIdentityCache() {
    acceptableCache = { stableId: null, ids: [] };
}

// ═══════════════════════════════════════════════════════════
//  命名空间扫描
// ═══════════════════════════════════════════════════════════

function isNonSlotKey(key) {
    const rest = key.slice(SLOT_PREFIX.length);
    return NON_SLOT_SUBPREFIXES.some(p => rest.startsWith(p));
}

function pillarCountsOf(value) {
    if (Array.isArray(value)) {
        return { npc: 0, items: 0, milestones: 0, timeline: 0, memories: value.length, map: 0, clues: 0 };
    }
    if (!value || typeof value !== 'object') {
        return { npc: 0, items: 0, milestones: 0, timeline: 0, memories: 0, map: 0, clues: 0 };
    }
    const len = (v) => (Array.isArray(v) ? v.length : 0);
    return {
        npc: len(value.npc),
        items: len(value.items),
        milestones: len(value.milestones),
        timeline: len(value.timeline),
        memories: len(value.memories),
        map: Object.keys(value.map?.locations || {}).length,
        clues: len(value.clueBoard?.nodes),
    };
}

/**
 * 只保留轻量摘要，避免把整库存档留在内存里。
 */
function summarizeSlotValue(value) {
    const counts = pillarCountsOf(value);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const titles = [];
    const pick = (list, field) => {
        for (const e of (Array.isArray(list) ? list : [])) {
            if (titles.length >= 6) return;
            const t = String(e?.[field] || e?.name || e?.title || e?.event || '').trim();
            if (t) titles.push(t.length > 24 ? `${t.slice(0, 24)}...` : t);
        }
    };
    if (!Array.isArray(value) && value && typeof value === 'object') {
        pick(value.npc, 'name');
        pick(value.memories, 'title');
        pick(value.milestones, 'event');
        pick(value.items, 'name');
    } else {
        pick(value, 'title');
    }
    return {
        count: total,
        counts,
        titles,
        createdAt: Number(value?._slotCreatedAt || value?.createdAt) || 0,
        updatedAt: Number(value?._slotUpdatedAt || value?.updatedAt) || 0,
    };
}

/**
 * 扫描 localforage，按命名空间分组列出所有存档槽。
 *
 * 枚举策略：
 * 1. bb_memory_slot_list_<charId> 索引键直接给出命名空间（无歧义）
 * 2. 台账 / 当前角色提供的额外候选命名空间
 * 3. 剩余未匹配键用正则回退识别纯数字（历史下标）与 group: 命名空间
 * 4. 仍无法归类的键放入 unresolved，原样呈现给用户，不做猜测
 */
export async function scanSlotNamespaces({ extraCandidates = [] } = {}) {
    const lf = getLF();
    if (!lf) return { namespaces: [], unresolved: [], scanned: 0 };

    const indexLists = new Map();
    const slotEntries = [];
    let scanned = 0;

    try {
        await lf.iterate((value, key) => {
            if (typeof key !== 'string' || !key.startsWith(SLOT_PREFIX)) return;
            scanned++;
            if (key.startsWith(SLOT_LIST_PREFIX)) {
                const charId = key.slice(SLOT_LIST_PREFIX.length);
                if (charId) indexLists.set(charId, Array.isArray(value) ? value.map(String) : []);
                return;
            }
            if (isNonSlotKey(key)) return;
            slotEntries.push({ key, summary: summarizeSlotValue(value) });
        });
    } catch (e) {
        console.warn('[BB-Memory] 存档命名空间扫描失败:', e?.message || e);
    }

    const ledger = await readIdentityLedger();
    const candidates = new Set();
    for (const id of indexLists.keys()) candidates.add(id);
    for (const id of extraCandidates) if (id) candidates.add(String(id));
    for (const [id, entry] of Object.entries(ledger.chars)) {
        candidates.add(id);
        for (const legacy of entry.legacyIds || []) candidates.add(legacy);
        if (entry.lastIndex) candidates.add(entry.lastIndex);
    }
    for (const legacyId of Object.keys(ledger.claims)) candidates.add(legacyId);

    // 长前缀优先，避免 "5" 抢走本应属于 "5_5" 的键
    const ordered = [...candidates].filter(Boolean).sort((a, b) => b.length - a.length);

    const buckets = new Map();
    const bucketOf = (charId) => {
        if (!buckets.has(charId)) buckets.set(charId, { charId, slots: [], fromIndexOnly: [] });
        return buckets.get(charId);
    };
    for (const charId of ordered) bucketOf(charId);

    const unresolved = [];
    for (const { key, summary } of slotEntries) {
        let matched = null;
        for (const charId of ordered) {
            const prefix = `${SLOT_PREFIX}${charId}_`;
            if (key.startsWith(prefix)) {
                matched = { charId, slotName: key.slice(prefix.length) };
                break;
            }
        }
        if (!matched) {
            const m = /^bb_memory_slot_(\d+)_(.+)$/.exec(key)
                || /^bb_memory_slot_(group:[^_]+)_(.+)$/.exec(key);
            if (m) matched = { charId: m[1], slotName: m[2] };
        }
        if (!matched) {
            unresolved.push({ key, ...summary });
            continue;
        }
        bucketOf(matched.charId).slots.push({
            name: matched.slotName,
            key,
            ...summary,
        });
    }

    // 索引里登记了但数据键已不存在的槽，也要如实呈现
    for (const [charId, names] of indexLists.entries()) {
        const bucket = bucketOf(charId);
        const present = new Set(bucket.slots.map(s => s.name));
        for (const name of names) {
            if (!present.has(name)) bucket.fromIndexOnly.push(name);
        }
    }

    const namespaces = [...buckets.values()]
        .map(bucket => {
            const total = bucket.slots.reduce((sum, s) => sum + s.count, 0);
            const updatedAt = bucket.slots.reduce((max, s) => Math.max(max, s.updatedAt || s.createdAt || 0), 0);
            return {
                ...bucket,
                slotCount: bucket.slots.length,
                totalEntries: total,
                updatedAt,
                legacy: isLegacyNamespaceId(bucket.charId),
                claimedBy: ledger.claims[bucket.charId] || null,
                displayName: ledger.chars[bucket.charId]?.name || '',
            };
        })
        .filter(ns => ns.slotCount > 0 || ns.fromIndexOnly.length > 0)
        .sort((a, b) => b.totalEntries - a.totalEntries);

    return { namespaces, unresolved, scanned };
}

// ═══════════════════════════════════════════════════════════
//  救援候选评估
// ═══════════════════════════════════════════════════════════

function readRemoteSlotIndexCharId() {
    const ctx = getCtx();
    const raw = ctx?.chatMetadata?.[REMOTE_SLOT_INDEX_KEY];
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.charId === undefined || parsed.charId === null || parsed.charId === '') return null;
        return String(parsed.charId);
    } catch {
        return null;
    }
}

/**
 * 为当前角色评估所有可认领的历史命名空间。
 *
 * 置信度：
 *  high   —— 当前聊天的云端槽索引指向该命名空间（聊天文件随角色走，证据可靠）
 *            或身份台账已记录该命名空间属于本角色
 *  medium —— 与当前角色下标一致（升级后首次运行的常见情形）
 *  low    —— 其它历史下标命名空间，归属未知
 */
export async function collectRescueCandidates(stableId = getStableCharacterId()) {
    const legacyIndex = getLegacyCharacterIndex();
    const metaCharId = readRemoteSlotIndexCharId();
    const linked = await getLinkedLegacyIds(stableId);
    const ledger = await readIdentityLedger();

    const scan = await scanSlotNamespaces({
        extraCandidates: [stableId, legacyIndex, metaCharId, ...linked].filter(Boolean),
    });

    const own = scan.namespaces.find(ns => ns.charId === stableId) || null;
    const candidates = [];

    for (const ns of scan.namespaces) {
        if (!stableId || ns.charId === stableId) continue;
        if (ns.slotCount === 0) continue;

        const claimedBy = ledger.claims[ns.charId] || null;
        const claimedByOther = Boolean(claimedBy && claimedBy !== stableId);

        let confidence = 'low';
        let reason = '历史命名空间，归属待人工确认';
        if (linked.includes(String(ns.charId))) {
            confidence = 'high';
            reason = '身份台账记录该命名空间属于本角色';
        } else if (metaCharId && String(ns.charId) === metaCharId) {
            confidence = 'high';
            reason = '当前聊天的云端槽索引指向该命名空间';
        } else if (legacyIndex !== null && String(ns.charId) === legacyIndex) {
            confidence = 'medium';
            reason = '与当前角色下标一致（升级前写入的命名空间）';
        } else if (!ns.legacy) {
            confidence = 'low';
            reason = '属于其它角色的稳定命名空间';
        }

        candidates.push({ ...ns, confidence, reason, claimedBy, claimedByOther });
    }

    const rank = { high: 0, medium: 1, low: 2 };
    candidates.sort((a, b) => {
        if (a.claimedByOther !== b.claimedByOther) return a.claimedByOther ? 1 : -1;
        if (rank[a.confidence] !== rank[b.confidence]) return rank[a.confidence] - rank[b.confidence];
        return b.totalEntries - a.totalEntries;
    });

    return {
        stableId,
        legacyIndex,
        metaCharId,
        own,
        ownSlotCount: own?.slotCount || 0,
        ownEntries: own?.totalEntries || 0,
        candidates,
        unresolved: scan.unresolved,
        scanned: scan.scanned,
    };
}

// ═══════════════════════════════════════════════════════════
//  迁移（复制，绝不删除）
// ═══════════════════════════════════════════════════════════

function slotKeyFor(charId, slotName) {
    return `${SLOT_PREFIX}${charId}_${slotName}`;
}

function uniqueSlotName(base, taken) {
    if (!taken.has(base)) return base;
    const suffix = '-救援';
    let name = `${base}${suffix}`;
    let n = 2;
    while (taken.has(name)) {
        name = `${base}${suffix}${n}`;
        n++;
    }
    return name;
}

/**
 * 把历史命名空间的槽复制到稳定命名空间。
 *
 * - 旧键完整保留（可重复执行、可回头核对）
 * - 同名槽默认不覆盖，改名为 "<名字>-救援"
 * - 同步迁移 chatSlotBindings 里的绑定关系
 */
export async function migrateLegacyNamespace(legacyId, stableId = getStableCharacterId(), options = {}) {
    const lf = getLF();
    if (!lf) throw new Error('无法访问本地存储');
    if (!legacyId) throw new Error('缺少来源命名空间');
    if (!stableId) throw new Error('无法解析当前角色的稳定 ID');
    if (String(legacyId) === String(stableId)) throw new Error('来源与目标命名空间相同');

    const onlySlots = Array.isArray(options.slotNames) && options.slotNames.length
        ? new Set(options.slotNames.map(String))
        : null;
    const overwrite = options.overwrite === true;

    const scan = await scanSlotNamespaces({ extraCandidates: [legacyId, stableId] });
    const source = scan.namespaces.find(ns => ns.charId === String(legacyId));
    if (!source || source.slotCount === 0) throw new Error(`命名空间 "${legacyId}" 没有可迁移的存档`);

    const targetNs = scan.namespaces.find(ns => ns.charId === String(stableId));
    const taken = new Set((targetNs?.slots || []).map(s => s.name));
    const existingIndex = await lf.getItem(SLOT_LIST_PREFIX + stableId);
    const indexNames = new Set(Array.isArray(existingIndex) ? existingIndex.map(String) : []);
    for (const n of indexNames) taken.add(n);

    const migrated = [];
    const skipped = [];
    let entries = 0;

    for (const slot of source.slots) {
        if (onlySlots && !onlySlots.has(slot.name)) continue;
        let raw;
        try {
            raw = await lf.getItem(slot.key);
        } catch (e) {
            skipped.push({ name: slot.name, reason: `读取失败: ${e?.message || e}` });
            continue;
        }
        if (raw === null || raw === undefined) {
            skipped.push({ name: slot.name, reason: '来源数据为空' });
            continue;
        }

        const targetName = overwrite ? slot.name : uniqueSlotName(slot.name, taken);
        try {
            await lf.setItem(slotKeyFor(stableId, targetName), raw);
        } catch (e) {
            skipped.push({ name: slot.name, reason: `写入失败: ${e?.message || e}` });
            continue;
        }
        taken.add(targetName);
        indexNames.add(targetName);
        entries += slot.count;
        migrated.push({ from: slot.name, to: targetName, count: slot.count });
    }

    if (!migrated.length) {
        return { migrated, skipped, entries: 0, slotCount: 0, legacyId: String(legacyId), stableId };
    }

    try {
        await lf.setItem(SLOT_LIST_PREFIX + stableId, [...indexNames]);
    } catch (e) {
        console.warn('[BB-Memory] 写入槽索引失败:', e?.message || e);
    }

    // 台账登记：此命名空间已被本角色认领
    const ledger = await readIdentityLedger();
    const now = Date.now();
    const entry = ledger.chars[stableId] || {
        name: getCharacterDisplayName(stableId), legacyIds: [], lastIndex: getLegacyCharacterIndex(),
        migrations: [], firstSeenAt: now, updatedAt: now,
    };
    entry.legacyIds = [...new Set([...(entry.legacyIds || []), String(legacyId)])];
    entry.migrations = [
        { from: String(legacyId), at: now, slots: migrated.map(m => m.to) },
        ...(entry.migrations || []),
    ].slice(0, 40);
    entry.updatedAt = now;
    if (!entry.name) entry.name = getCharacterDisplayName(stableId);
    ledger.chars[stableId] = entry;
    ledger.claims[String(legacyId)] = String(stableId);
    await writeIdentityLedger(ledger);

    migrateChatSlotBindings(String(legacyId), String(stableId), migrated);
    invalidateIdentityCache();
    await primeIdentityCache(stableId);

    return {
        migrated,
        skipped,
        entries,
        slotCount: migrated.length,
        legacyId: String(legacyId),
        stableId,
    };
}

/**
 * 绑定表也是按 charId 分组的，同样需要跟着迁移。
 */
function migrateChatSlotBindings(legacyId, stableId, migrated) {
    try {
        const settings = getSettings();
        const raw = settings.chatSlotBindings;
        const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const rawEntries = source.entries && typeof source.entries === 'object' && !Array.isArray(source.entries)
            ? source.entries
            : source;
        const legacyMap = rawEntries?.[legacyId];
        if (!legacyMap || typeof legacyMap !== 'object') return 0;

        const rename = new Map(migrated.map(m => [m.from, m.to]));
        const entries = { ...rawEntries };
        const targetMap = { ...(entries[stableId] || {}) };
        let moved = 0;
        for (const [chatId, value] of Object.entries(legacyMap)) {
            const slotName = typeof value === 'string' ? value : String(value?.slotName || '');
            if (!slotName) continue;
            const mapped = rename.get(slotName) || slotName;
            if (targetMap[chatId]) continue;
            targetMap[chatId] = { slotName: mapped, updatedAt: Number(value?.updatedAt) || Date.now() };
            moved++;
        }
        if (!moved) return 0;
        entries[stableId] = targetMap;
        updateSettings({ chatSlotBindings: { version: 1, entries } });
        return moved;
    } catch (e) {
        console.warn('[BB-Memory] 迁移聊天存档绑定失败:', e?.message || e);
        return 0;
    }
}

// ═══════════════════════════════════════════════════════════
//  自动救援（仅在证据充分时执行）
// ═══════════════════════════════════════════════════════════

/**
 * 角色载入时调用。
 *
 * 返回:
 *  { status: 'ok' }              已有稳定命名空间数据，无需处理
 *  { status: 'migrated', ... }   证据充分，已自动迁移
 *  { status: 'review', ... }     存在候选但证据不足，需要人工认领
 *  { status: 'none' }            没有任何可认领的历史存档
 */
export async function autoRescueSlots(stableId = getStableCharacterId()) {
    if (!stableId) return { status: 'none', reason: 'no-stable-id' };

    await recordCharacterIdentity(stableId);
    const report = await collectRescueCandidates(stableId);

    if (report.ownSlotCount > 0) {
        return { status: 'ok', report };
    }

    const usable = report.candidates.filter(c => !c.claimedByOther);
    if (!usable.length) return { status: 'none', report };

    const high = usable.filter(c => c.confidence === 'high');
    if (high.length === 1) {
        const result = await migrateLegacyNamespace(high[0].charId, stableId);
        return { status: 'migrated', evidence: 'high', candidate: high[0], result, report };
    }

    // 单角色库 / 无歧义场景：全库只有一个未认领的历史命名空间，且正好是当前下标
    const medium = usable.filter(c => c.confidence === 'medium');
    if (!high.length && medium.length === 1 && usable.length === 1) {
        const result = await migrateLegacyNamespace(medium[0].charId, stableId);
        return { status: 'migrated', evidence: 'medium-unambiguous', candidate: medium[0], result, report };
    }

    return { status: 'review', report, candidates: usable };
}

/**
 * 清理已确认迁移过的历史命名空间（需要用户显式确认）。
 */
export async function purgeLegacyNamespace(legacyId, stableId = getStableCharacterId()) {
    const lf = getLF();
    if (!lf) throw new Error('无法访问本地存储');
    const ledger = await readIdentityLedger();
    const owner = ledger.claims[String(legacyId)];
    if (!owner) throw new Error(`命名空间 "${legacyId}" 尚未被认领，拒绝清理`);
    if (stableId && owner !== String(stableId)) {
        throw new Error(`命名空间 "${legacyId}" 属于其它角色，拒绝清理`);
    }

    const scan = await scanSlotNamespaces({ extraCandidates: [legacyId] });
    const source = scan.namespaces.find(ns => ns.charId === String(legacyId));
    if (!source) return { removed: 0 };

    let removed = 0;
    for (const slot of source.slots) {
        try {
            await lf.removeItem(slot.key);
            removed++;
        } catch { /* ignore */ }
    }
    try { await lf.removeItem(SLOT_LIST_PREFIX + legacyId); } catch { /* ignore */ }
    return { removed };
}
