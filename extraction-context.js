/** Injection records are attached to the user message that requested generation. */
import { getSettings, getMemories, getNpcProfiles, getItems, getMilestones, getTimeline } from './memory-store.js';
import { cyrb53Hash } from './message-state.js';

const LOADERS = { mem: getMemories, npc: getNpcProfiles, item: getItems, milestone: getMilestones, timeline: getTimeline,
    location: async chatId => (await import('./map-store.js')).getLocations(chatId) };
const ALIASES = { memory: 'mem', memories: 'mem', items: 'item', milestones: 'milestone', threads: 'timeline', map: 'location', locations: 'location' };
let injectionTracker = null;

export function normalizeExtractionPillar(value) {
    const key = String(value || '').toLowerCase();
    return ALIASES[key] || key;
}

export function captureInjectionContext(chatId, userMessage, entriesByPillar = {}, options = {}) {
    if (!chatId || !userMessage || typeof userMessage !== 'object') return null;
    const ids = {};
    for (const [rawPillar, entries] of Object.entries(entriesByPillar)) {
        const pillar = normalizeExtractionPillar(rawPillar);
        if (!LOADERS[pillar]) continue;
        ids[pillar] = [...new Set((Array.isArray(entries) ? entries : []).map(entry =>
            String(typeof entry === 'string' ? entry : entry?.id || '').trim()).filter(Boolean))];
    }
    const record = { chatId: String(chatId), userMessageHash: cyrb53Hash(String(userMessage.mes || '')),
        entriesByPillar: ids, capturedAt: Date.now(), generationType: String(options.generationType || '') };
    userMessage.extra ||= {};
    userMessage.extra.bbMemoryInjectionContext = record;
    userMessage._bbmem_injectionContext = record;
    return record;
}

export function bindInjectionContextToResponse(chatId, aiMessage, userMessage) {
    if (!aiMessage || aiMessage.is_user || aiMessage.is_system) return null;
    const record = userMessage?.extra?.bbMemoryInjectionContext || userMessage?._bbmem_injectionContext;
    if (!record || String(record.chatId) !== String(chatId)
        || record.userMessageHash !== cyrb53Hash(String(userMessage?.mes || ''))) return null;
    aiMessage.extra ||= {};
    aiMessage.extra.bbMemoryInjectionBySwipe ||= {};
    const bound = { ...record, responseHash: cyrb53Hash(String(aiMessage.mes || '')) };
    aiMessage.extra.bbMemoryInjectionBySwipe[String(aiMessage.swipe_id ?? 0)] = bound;
    return bound;
}

function onInjectionResponse(messageIndex) {
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (!ctx?.chatId || !Number.isInteger(messageIndex)) return;
    for (let index = messageIndex - 1; index >= 0; index--) {
        if (!ctx.chat?.[index]?.is_user) continue;
        if (bindInjectionContextToResponse(ctx.chatId, ctx.chat[messageIndex], ctx.chat[index])) ctx.saveChatDebounced?.();
        break;
    }
}

export function initInjectionContextTracking() {
    if (injectionTracker) return;
    const ctx = globalThis.SillyTavern?.getContext?.();
    const eventTypes = ctx?.eventTypes || ctx?.event_types || {};
    if (!eventTypes.MESSAGE_RECEIVED || !ctx?.eventSource) return;
    ctx.eventSource.on(eventTypes.MESSAGE_RECEIVED, onInjectionResponse);
    injectionTracker = { eventSource: ctx.eventSource, event: eventTypes.MESSAGE_RECEIVED };
}

export function stopInjectionContextTracking() {
    if (!injectionTracker) return;
    injectionTracker.eventSource.removeListener(injectionTracker.event, onInjectionResponse);
    injectionTracker = null;
}

function sourceMessages(chat, options) {
    const floors = [...new Set([...(options.sourceFloors || []), options.sourceFloor].filter(Number.isInteger))];
    const records = new Map();
    const add = floor => {
        if (!chat[floor]) return;
        let aiFloor = floor;
        if (chat[floor].is_user) {
            aiFloor = -1;
            for (let index = floor + 1; index < chat.length; index++) {
                if (chat[index]?.is_user) break;
                if (!chat[index]?.is_system) { aiFloor = index; break; }
            }
        }
        if (aiFloor < 0 || chat[aiFloor]?.is_system) return;
        for (let index = aiFloor - 1; index >= 0; index--) {
            if (!chat[index]?.is_user) continue;
            records.set(`${index}:${aiFloor}`, { message: chat[index], index, aiMessage: chat[aiFloor] });
            break;
        }
    };
    floors.forEach(add);
    // Legacy manual callers without floors may identify several replies from their full text.
    if (!floors.length && options.contextText) {
        const text = String(options.contextText);
        for (let index = 0; index < chat.length; index++) {
            const message = chat[index];
            if (message?.mes && !message.is_user && !message.is_system && text.includes(message.mes)) add(index);
        }
        if (!records.size) {
            for (let index = 0; index < chat.length; index++) {
                if (chat[index]?.is_user && chat[index].mes && text.includes(chat[index].mes)) add(index);
            }
        }
    }
    return [...records.values()];
}

export function extractionEntryFingerprint(entry) {
    if (!entry) return '';
    const copy = { ...entry };
    for (const key of ['embedding', 'embeddingRef', 'hitScore', 'hitCount', 'lastHitAt', 'lastHitRound', 'updatedAt']) delete copy[key];
    return JSON.stringify(copy);
}

export async function buildExtractionContext(chatId, options = {}) {
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (String(ctx?.chatId || '') !== String(chatId)) throw new Error('聊天已切换，已停止构建提取上下文');
    const wanted = Object.fromEntries(Object.keys(LOADERS).map(pillar => [pillar, new Set()]));
    for (const { message, aiMessage } of sourceMessages(ctx.chat || [], options)) {
        const swipeRecord = aiMessage?.extra?.bbMemoryInjectionBySwipe?.[String(aiMessage.swipe_id ?? 0)];
        if (swipeRecord && swipeRecord.responseHash !== cyrb53Hash(String(aiMessage.mes || ''))) continue;
        if (!swipeRecord && (aiMessage?.swipes?.length > 1
            || Object.keys(aiMessage?.extra?.bbMemoryInjectionBySwipe || {}).length)) continue;
        const record = swipeRecord || message.extra?.bbMemoryInjectionContext || message._bbmem_injectionContext;
        if (!record || String(record.chatId) !== String(chatId)
            || record.userMessageHash !== cyrb53Hash(String(message.mes || ''))) continue;
        for (const [rawPillar, ids] of Object.entries(record.entriesByPillar || {})) {
            const pillar = normalizeExtractionPillar(rawPillar);
            if (wanted[pillar]) for (const id of (Array.isArray(ids) ? ids : [])) wanted[pillar].add(String(id));
        }
    }
    const collections = await Promise.all(Object.values(LOADERS).map(loader => loader(chatId)));
    const entries = {}, injectedIds = {}, fingerprints = {};
    Object.keys(LOADERS).forEach((pillar, index) => {
        entries[pillar] = collections[index].filter(entry => entry?.id && !entry.archived && wanted[pillar].has(String(entry.id)));
        injectedIds[pillar] = entries[pillar].map(entry => entry.id);
    });
    const count = Math.max(0, Math.min(100, Math.floor(Number(getSettings().extractionRecentMemoryCount ?? 5) || 0)));
    const recent = collections[0].map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry?.id && !entry.archived && entry.memoryTier !== 'archived')
        .sort((a, b) => (Number(b.entry.createdAt) || 0) - (Number(a.entry.createdAt) || 0) || b.index - a.index)
        .slice(0, count).map(({ entry }) => entry);
    const known = new Set(entries.mem.map(entry => String(entry.id)));
    entries.mem.push(...recent.filter(entry => !known.has(String(entry.id))));
    for (const [pillar, list] of Object.entries(entries)) {
        fingerprints[pillar] = Object.fromEntries(list.map(entry => [entry.id, extractionEntryFingerprint(entry)]));
    }
    return { chatId: String(chatId), entries: JSON.parse(JSON.stringify(entries)), injectedIds,
        recentMemoryIds: recent.map(entry => entry.id), fingerprints };
}

export function formatExtractionContext(context) {
    const entries = {};
    for (const [pillar, list] of Object.entries(context?.entries || {})) entries[pillar] = list.map(entry => {
        const copy = { ...entry };
        delete copy.embedding; delete copy.embeddingRef; delete copy._bbmemSourceRollback;
        return copy;
    });
    return JSON.stringify({ injectedIds: context?.injectedIds || {}, recentMemoryIds: context?.recentMemoryIds || [], entries }, null, 2);
}
