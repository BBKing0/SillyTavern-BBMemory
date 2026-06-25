/**
 * vector-store.js — compressed embedding storage for BB-Memory v9.2.4.
 *
 * Entries keep only embeddingRef. The actual vector is stored once per
 * character/group scope as Float16 + Base64 records.
 */

const VECTOR_BANK_PREFIX = 'bb_vec_bank_';
const VECTOR_SCHEMA = 'bb-memory-vector-ref-v1';
const VECTOR_ENCODING = 'f16-base64';
const DEFAULT_MODEL = 'unknown-embedding-model';

function getContextSafe() {
    try { return SillyTavern.getContext(); } catch { return null; }
}

function getLocalForage() {
    const ctx = getContextSafe();
    return ctx?.libs?.localforage || globalThis.localforage || globalThis.SillyTavern?.libs?.localforage;
}

function getSettingsSafe() {
    const ctx = getContextSafe();
    return ctx?.extensionSettings?.bb_memory || {};
}

function normalizeScopeText(value) {
    return String(value ?? '').trim() || 'global';
}

export function getVectorScope(chatId = '') {
    const ctx = getContextSafe();
    if (ctx?.groupId !== undefined && ctx.groupId !== null && ctx.groupId !== '') return `group:${ctx.groupId}`;
    if (ctx?.characterId !== undefined && ctx.characterId !== null) return `char:${ctx.characterId}`;
    if (ctx?.this_chid !== undefined && ctx.this_chid !== null && ctx.this_chid !== '') return `char:${ctx.this_chid}`;
    return `chat:${chatId || ctx?.chatId || 'global'}`;
}

export function stableHash(text) {
    let h = 2166136261;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

function bankKey(scope) {
    return VECTOR_BANK_PREFIX + stableHash(normalizeScopeText(scope));
}

function clonePlain(value) {
    if (!value || typeof value !== 'object') return value;
    try { return JSON.parse(JSON.stringify(value)); } catch { return Array.isArray(value) ? [...value] : { ...value }; }
}

export function buildEmbeddingText(entry = {}) {
    const tags = (entry.tags || []).map(t => typeof t === 'string' ? t : t?.name).filter(Boolean).join(' ');
    const threadEntries = Array.isArray(entry.entries)
        ? entry.entries.map(e => [e.period || e.storyTime || e.time, e.event || e.title || e.summary || e.note, e.status].filter(Boolean).join(' ')).join('\n')
        : '';
    const relations = Array.isArray(entry.relationships)
        ? entry.relationships.map(r => [r.name || r.n, r.type || r.r, r.attitude || r.a].filter(Boolean).join(' ')).join('\n')
        : '';
    const edges = Array.isArray(entry.edges)
        ? entry.edges.map(e => [e.toName || e.toId || e.to, e.distance, e.pathType || e.type, e.difficulty].filter(Boolean).join(' ')).join('\n')
        : '';
    return [
        entry.title, entry.name, entry.summary, entry.content, entry.description,
        entry.event, entry.significance, entry.role, entry.personality,
        entry.location, entry.region, entry.subject, entry.target,
        threadEntries, relations, edges, tags,
    ].filter(Boolean).join('\n').slice(0, 1200);
}

function currentEmbeddingModel() {
    return String(getSettingsSafe().embeddingModel || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function normalizeModel(model) {
    return String(model || currentEmbeddingModel()).trim() || DEFAULT_MODEL;
}

export function makeVectorId(model, dims, textHash) {
    return 'vec_' + stableHash(`${normalizeModel(model)}|${Number(dims) || 0}|${String(textHash || '')}`);
}

function floatToHalf(value) {
    if (Number.isNaN(value)) return 0x7e00;
    if (value === Infinity) return 0x7c00;
    if (value === -Infinity) return 0xfc00;
    const sign = value < 0 ? 1 : 0;
    let val = Math.abs(Number(value) || 0);
    if (val === 0) return sign << 15;
    if (val >= 65504) return (sign << 15) | 0x7bff;
    if (val < 6.103515625e-5) return (sign << 15) | Math.round(val / 5.960464477539063e-8);
    const exp = Math.floor(Math.log2(val));
    const mant = val / Math.pow(2, exp) - 1;
    let halfExp = exp + 15;
    let halfMant = Math.round(mant * 1024);
    if (halfMant === 1024) {
        halfMant = 0;
        halfExp += 1;
    }
    if (halfExp >= 31) return (sign << 15) | 0x7bff;
    return (sign << 15) | (halfExp << 10) | (halfMant & 0x03ff);
}

function halfToFloat(half) {
    const sign = (half & 0x8000) ? -1 : 1;
    const exp = (half >> 10) & 0x1f;
    const mant = half & 0x03ff;
    if (exp === 0) return sign * mant * Math.pow(2, -24);
    if (exp === 31) return mant ? NaN : sign * Infinity;
    return sign * (1 + mant / 1024) * Math.pow(2, exp - 15);
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function base64ToBytes(base64) {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export function encodeVectorF16(vector) {
    const bytes = new Uint8Array(vector.length * 2);
    const view = new DataView(bytes.buffer);
    vector.forEach((value, index) => view.setUint16(index * 2, floatToHalf(value), true));
    return bytesToBase64(bytes);
}

export function decodeVectorRecord(record) {
    if (!record) return null;
    if (Array.isArray(record.embedding)) return record.embedding;
    if (record.encoding !== VECTOR_ENCODING || !record.vector) return null;
    const bytes = base64ToBytes(record.vector);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    for (let offset = 0; offset + 1 < bytes.byteLength; offset += 2) {
        out.push(halfToFloat(view.getUint16(offset, true)));
    }
    return out;
}

function makeEmptyBank(scope) {
    return {
        schema: VECTOR_SCHEMA,
        encoding: VECTOR_ENCODING,
        scope: normalizeScopeText(scope),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        records: {},
    };
}

export async function getVectorBank(chatId = '') {
    const lf = getLocalForage();
    const scope = getVectorScope(chatId);
    if (!lf) return makeEmptyBank(scope);
    const key = bankKey(scope);
    const bank = await lf.getItem(key);
    if (bank && typeof bank === 'object' && bank.records && typeof bank.records === 'object') {
        bank.schema = bank.schema || VECTOR_SCHEMA;
        bank.encoding = bank.encoding || VECTOR_ENCODING;
        bank.scope = bank.scope || scope;
        return bank;
    }
    return makeEmptyBank(scope);
}

async function saveVectorBank(chatId, bank) {
    const lf = getLocalForage();
    if (!lf) return false;
    bank.updatedAt = Date.now();
    await lf.setItem(bankKey(bank.scope || getVectorScope(chatId)), bank);
    return true;
}

export async function storeVectorForEntry(chatId, entry, embedding, options = {}) {
    if (!Array.isArray(embedding) || !embedding.length) return null;
    const embeddingText = buildEmbeddingText(entry);
    const textHash = options.textHash || stableHash(embeddingText || JSON.stringify(embedding.slice(0, 32)));
    const model = normalizeModel(options.model);
    const dims = embedding.length;
    const id = options.id || makeVectorId(model, dims, textHash);
    const now = Date.now();
    const bank = await getVectorBank(chatId);
    const previous = bank.records[id];
    bank.records[id] = {
        id,
        dims,
        model,
        textHash,
        encoding: VECTOR_ENCODING,
        vector: previous?.vector || encodeVectorF16(embedding),
        createdAt: previous?.createdAt || now,
        updatedAt: now,
    };
    await saveVectorBank(chatId, bank);
    return { id, dims, model, textHash };
}

export async function convertEntryEmbeddingToRef(chatId, entry, options = {}) {
    if (!entry || typeof entry !== 'object') return entry;
    if (Array.isArray(entry.embedding) && entry.embedding.length) {
        const ref = await storeVectorForEntry(chatId, entry, entry.embedding, options);
        if (ref) entry.embeddingRef = ref;
    } else if (entry.embeddingRef && typeof entry.embeddingRef === 'object') {
        entry.embeddingRef = {
            id: entry.embeddingRef.id,
            dims: entry.embeddingRef.dims,
            model: entry.embeddingRef.model || normalizeModel(options.model),
            textHash: entry.embeddingRef.textHash || stableHash(buildEmbeddingText(entry)),
        };
    }
    delete entry.embedding;
    return entry;
}

export async function convertCollectionEmbeddingsToRefs(chatId, entries, options = {}) {
    if (!Array.isArray(entries)) return entries;
    for (const entry of entries) await convertEntryEmbeddingToRef(chatId, entry, options);
    return entries;
}

export async function convertMapEmbeddingsToRefs(chatId, mapData, options = {}) {
    if (!mapData || typeof mapData !== 'object') return mapData;
    for (const entry of Object.values(mapData.locations || {})) {
        await convertEntryEmbeddingToRef(chatId, entry, options);
    }
    return mapData;
}

export async function normalizeDataEmbeddingsToRefs(chatId, data, options = {}) {
    const normalized = data && typeof data === 'object' ? data : {};
    await Promise.all([
        convertCollectionEmbeddingsToRefs(chatId, normalized.npc, options),
        convertCollectionEmbeddingsToRefs(chatId, normalized.items, options),
        convertCollectionEmbeddingsToRefs(chatId, normalized.milestones, options),
        convertCollectionEmbeddingsToRefs(chatId, normalized.timeline, options),
        convertCollectionEmbeddingsToRefs(chatId, normalized.memories, options),
        convertMapEmbeddingsToRefs(chatId, normalized.map, options),
    ]);
    return normalized;
}

export async function hydrateEntryEmbedding(chatId, entry) {
    if (!entry || typeof entry !== 'object') return entry;
    if (Array.isArray(entry.embedding) && entry.embedding.length) return entry;
    const ref = entry.embeddingRef;
    if (!ref?.id) return entry;
    const bank = await getVectorBank(chatId);
    const vector = decodeVectorRecord(bank.records?.[ref.id]);
    if (vector) entry.embedding = vector;
    return entry;
}

export async function hydrateCollectionEmbeddings(chatId, entries) {
    if (!Array.isArray(entries) || !entries.length) return entries || [];
    const bank = await getVectorBank(chatId);
    for (const entry of entries) {
        if (!entry || Array.isArray(entry.embedding)) continue;
        const ref = entry.embeddingRef;
        if (!ref?.id) continue;
        const vector = decodeVectorRecord(bank.records?.[ref.id]);
        if (vector) entry.embedding = vector;
    }
    return entries;
}

export async function hydrateMapEmbeddings(chatId, mapData) {
    if (!mapData || typeof mapData !== 'object') return mapData;
    await hydrateCollectionEmbeddings(chatId, Object.values(mapData.locations || {}));
    return mapData;
}

function collectRefsFromEntries(entries, refs) {
    for (const entry of entries || []) {
        if (entry?.embeddingRef?.id) refs.set(entry.embeddingRef.id, entry.embeddingRef);
    }
}

export function collectEmbeddingRefs(data) {
    const refs = new Map();
    collectRefsFromEntries(data?.npc, refs);
    collectRefsFromEntries(data?.items, refs);
    collectRefsFromEntries(data?.milestones, refs);
    collectRefsFromEntries(data?.timeline, refs);
    collectRefsFromEntries(data?.memories, refs);
    collectRefsFromEntries(Object.values(data?.map?.locations || {}), refs);
    return refs;
}

export async function buildVectorPack(chatId, data, options = {}) {
    const bank = await getVectorBank(chatId);
    const refs = collectEmbeddingRefs(data);
    const records = [];
    for (const id of refs.keys()) {
        const record = bank.records?.[id];
        if (record) records.push(clonePlain(record));
    }
    return {
        schema: VECTOR_SCHEMA,
        encoding: VECTOR_ENCODING,
        sourceSlot: options.sourceSlot || '',
        model: records[0]?.model || currentEmbeddingModel(),
        dims: records[0]?.dims || 0,
        recordCount: records.length,
        createdAt: Date.now(),
        records,
    };
}

export async function importVectorPack(chatId, vectorPack) {
    if (!vectorPack || typeof vectorPack !== 'object') return { imported: 0, skipped: 0 };
    const records = Array.isArray(vectorPack.records) ? vectorPack.records : [];
    const bank = await getVectorBank(chatId);
    let imported = 0;
    let skipped = 0;
    for (const raw of records) {
        if (!raw?.id) { skipped++; continue; }
        let record = null;
        if (raw.encoding === VECTOR_ENCODING && raw.vector) {
            record = { ...raw, encoding: VECTOR_ENCODING };
        } else if (Array.isArray(raw.embedding)) {
            const dims = raw.embedding.length;
            const model = normalizeModel(raw.model || vectorPack.model);
            const textHash = raw.textHash || stableHash(raw.id);
            record = {
                id: raw.id,
                dims,
                model,
                textHash,
                encoding: VECTOR_ENCODING,
                vector: encodeVectorF16(raw.embedding),
                createdAt: raw.createdAt || Date.now(),
                updatedAt: Date.now(),
            };
        }
        if (!record) { skipped++; continue; }
        bank.records[record.id] = {
            id: record.id,
            dims: record.dims,
            model: normalizeModel(record.model || vectorPack.model),
            textHash: record.textHash || '',
            encoding: VECTOR_ENCODING,
            vector: record.vector,
            createdAt: record.createdAt || Date.now(),
            updatedAt: Date.now(),
        };
        imported++;
    }
    if (imported) await saveVectorBank(chatId, bank);
    return { imported, skipped };
}

export function stripRuntimeEmbeddings(value) {
    if (Array.isArray(value)) return value.map(stripRuntimeEmbeddings);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            if (key === 'embedding') continue;
            out[key] = stripRuntimeEmbeddings(val);
        }
        return out;
    }
    return value;
}

export function countEmbeddingRefs(data) {
    return collectEmbeddingRefs(data).size;
}

export const VECTOR_STORE_SCHEMA = VECTOR_SCHEMA;
export const VECTOR_STORE_ENCODING = VECTOR_ENCODING;
