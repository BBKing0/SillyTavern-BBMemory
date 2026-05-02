/**
 * Memory storage engine with save-slot management.
 *
 * Data hierarchy:
 *   extension_settings['smart_memory'] = {
 *       config: { ... },              // plugin settings
 *       chats: {
 *           [chatId]: {
 *               activeSlotId: string,
 *               slots: {
 *                   [slotId]: SaveSlot
 *               }
 *           }
 *       }
 *   }
 *
 * A "SaveSlot" holds an independent set of memories for a given chat,
 * enabling IF-line branching.
 */

import { createMemoryEntry } from './memory-entry.js';

const MODULE_NAME = 'smart_memory';

/**
 * @typedef {Object} SaveSlot
 * @property {string}        id
 * @property {string}        name
 * @property {MemoryEntry[]} memories
 * @property {number}        createdAt
 * @property {string}        [description]
 */

/**
 * @typedef {Object} ChatData
 * @property {string}                  activeSlotId
 * @property {Record<string, SaveSlot>} slots
 */

// ─── helpers ──────────────────────────────────────────────

let _getContext = null;
let _saveSettings = null;

/**
 * Initialise the store with SillyTavern context helpers.
 * Must be called once during plugin startup.
 */
export function initStore(getContextFn, saveSettingsFn) {
    _getContext = getContextFn;
    _saveSettings = saveSettingsFn;
}

function _root() {
    const ctx = _getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = { config: {}, chats: {} };
    }
    return ctx.extensionSettings[MODULE_NAME];
}

function _chatData(chatId) {
    const root = _root();
    if (!root.chats[chatId]) {
        const defaultSlotId = _newSlotId();
        root.chats[chatId] = {
            activeSlotId: defaultSlotId,
            slots: {
                [defaultSlotId]: _createSlot(defaultSlotId, 'Default'),
            },
        };
    }
    return root.chats[chatId];
}

function _newSlotId() {
    return `slot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function _createSlot(id, name) {
    return { id, name, memories: [], createdAt: Date.now(), description: '' };
}

function _save() {
    _saveSettings?.();
}

// ─── config (plugin settings) ─────────────────────────────

export function getConfig() {
    return _root().config || {};
}

export function setConfig(config) {
    _root().config = { ..._root().config, ...config };
    _save();
}

// ─── slot management ──────────────────────────────────────

export function getSlots(chatId) {
    return _chatData(chatId).slots;
}

export function getActiveSlotId(chatId) {
    return _chatData(chatId).activeSlotId;
}

export function getActiveSlot(chatId) {
    const cd = _chatData(chatId);
    return cd.slots[cd.activeSlotId] ?? null;
}

export function switchSlot(chatId, slotId) {
    const cd = _chatData(chatId);
    if (!cd.slots[slotId]) throw new Error(`Slot ${slotId} not found`);
    cd.activeSlotId = slotId;
    _save();
}

export function createSlot(chatId, name, description = '') {
    const cd = _chatData(chatId);
    const id = _newSlotId();
    cd.slots[id] = { ..._createSlot(id, name), description };
    _save();
    return id;
}

export function renameSlot(chatId, slotId, newName) {
    const cd = _chatData(chatId);
    if (!cd.slots[slotId]) return;
    cd.slots[slotId].name = newName;
    _save();
}

export function deleteSlot(chatId, slotId) {
    const cd = _chatData(chatId);
    if (!cd.slots[slotId]) return;
    if (Object.keys(cd.slots).length <= 1) {
        throw new Error('Cannot delete the last save slot.');
    }
    delete cd.slots[slotId];
    if (cd.activeSlotId === slotId) {
        cd.activeSlotId = Object.keys(cd.slots)[0];
    }
    _save();
}

/**
 * Deep-clone the active slot into a new slot (branch for IF lines).
 */
export function duplicateSlot(chatId, slotId, newName) {
    const cd = _chatData(chatId);
    const source = cd.slots[slotId];
    if (!source) throw new Error(`Slot ${slotId} not found`);

    const newId = _newSlotId();
    cd.slots[newId] = {
        id: newId,
        name: newName || `${source.name} (copy)`,
        memories: JSON.parse(JSON.stringify(source.memories)),
        createdAt: Date.now(),
        description: source.description,
    };
    _save();
    return newId;
}

// ─── memory CRUD ──────────────────────────────────────────

/**
 * Get all memories in the active slot.
 */
export function getMemories(chatId) {
    return getActiveSlot(chatId)?.memories ?? [];
}

/**
 * Add a memory entry to the active slot.
 * @param {string} chatId
 * @param {Partial<MemoryEntry>} data
 * @returns {MemoryEntry} the created entry
 */
export function addMemory(chatId, data) {
    const slot = getActiveSlot(chatId);
    if (!slot) throw new Error('No active slot');
    const entry = createMemoryEntry({ ...data, chatId });
    slot.memories.push(entry);
    _save();
    return entry;
}

/**
 * Update a memory entry by id (shallow merge).
 */
export function updateMemory(chatId, entryId, updates) {
    const slot = getActiveSlot(chatId);
    if (!slot) return null;
    const idx = slot.memories.findIndex(m => m.id === entryId);
    if (idx === -1) return null;
    slot.memories[idx] = { ...slot.memories[idx], ...updates };
    _save();
    return slot.memories[idx];
}

/**
 * Remove a memory entry by id.
 */
export function removeMemory(chatId, entryId) {
    const slot = getActiveSlot(chatId);
    if (!slot) return;
    slot.memories = slot.memories.filter(m => m.id !== entryId);
    _save();
}

/**
 * Deactivate (soft-delete) a memory entry.
 */
export function deactivateMemory(chatId, entryId) {
    return updateMemory(chatId, entryId, { isActive: false });
}

/**
 * Toggle pin state.
 */
export function togglePin(chatId, entryId) {
    const slot = getActiveSlot(chatId);
    if (!slot) return;
    const entry = slot.memories.find(m => m.id === entryId);
    if (!entry) return;
    entry.isPinned = !entry.isPinned;
    _save();
    return entry;
}

/**
 * Bulk-replace all memories in the active slot (used for import).
 */
export function replaceMemories(chatId, memories) {
    const slot = getActiveSlot(chatId);
    if (!slot) return;
    slot.memories = memories;
    _save();
}

// ─── import / export ──────────────────────────────────────

/**
 * Export the active slot's memories as a JSON string.
 */
export function exportSlot(chatId, slotId) {
    const cd = _chatData(chatId);
    const slot = cd.slots[slotId || cd.activeSlotId];
    if (!slot) return null;
    return JSON.stringify(slot, null, 2);
}

/**
 * Import memories from a JSON string into a new slot.
 */
export function importSlot(chatId, jsonString, slotName) {
    const parsed = JSON.parse(jsonString);
    const id = _newSlotId();
    const slot = {
        id,
        name: slotName || parsed.name || 'Imported',
        memories: Array.isArray(parsed.memories) ? parsed.memories : [],
        createdAt: Date.now(),
        description: parsed.description || '',
    };
    const cd = _chatData(chatId);
    cd.slots[id] = slot;
    _save();
    return id;
}

// ─── stats ────────────────────────────────────────────────

export function getStats(chatId) {
    const memories = getMemories(chatId);
    return {
        total: memories.length,
        active: memories.filter(m => m.isActive).length,
        pinned: memories.filter(m => m.isPinned).length,
        slotCount: Object.keys(getSlots(chatId)).length,
    };
}
