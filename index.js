/**
 * Smart Memory – SillyTavern Extension
 *
 * Intelligent memory system with per-message summarization,
 * structured tagging, and retrieval-augmented context injection.
 */

/* eslint-disable */
import {
    saveSettingsDebounced,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';
import {
    getContext,
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

import { testConnection } from './api.js';
import { initStore, getConfig, setConfig, getMemories, addMemory, removeMemory,
         updateMemory, togglePin, getSlots, getActiveSlotId, getActiveSlot,
         switchSlot, createSlot, renameSlot, deleteSlot, duplicateSlot,
         exportSlot, importSlot, getStats, deactivateMemory, replaceMemories } from './memory-store.js';
import { processMessage, extractQueryKeywords, summarizeMessage, generateTags } from './summarizer.js';
import { createRetriever, touchEntry, FuseRetriever } from './retriever.js';
import { createMemoryEntry, makeExcerpt } from './memory-entry.js';

// ─── Constants ────────────────────────────────────────────

const MODULE_NAME = 'smart_memory';
const DISPLAY_NAME = 'Smart Memory';
const INJECTION_KEY = 'smart_memory_injection';

const DEFAULT_CONFIG = {
    enabled: true,
    // API settings
    apiUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.3,
    maxTokens: 512,
    // Summarization
    autoSummarize: true,
    summarizeUser: false,
    summarizeAssistant: true,
    minMessageLength: 50,
    customSummarizePrompt: '',
    // Retrieval
    retrieverStrategy: 'keyword',
    maxRetrievedMemories: 5,
    minRetrievalScore: 0.1,
    applyDecay: false,
    decayHalfLifeDays: 30,
    // Injection
    injectionPosition: 1,
    injectionDepth: 4,
    injectionTemplate: '[Recalled Memories]\n{{memories}}',
    // Weights
    matchWeight: 0.5,
    importanceWeight: 0.3,
    decayWeight: 0.2,
};

// ─── State ────────────────────────────────────────────────

let isProcessing = false;
let pendingSummarizations = [];
let retrieverInstance = null;

// ─── Helpers ──────────────────────────────────────────────

function getChatId() {
    const ctx = getContext();
    if (!ctx.chatId) return null;
    return String(ctx.chatId);
}

function getApiSettings() {
    const cfg = getConfig();
    return {
        apiUrl: cfg.apiUrl || '',
        apiKey: cfg.apiKey || '',
        model: cfg.model || '',
        temperature: cfg.temperature ?? 0.3,
        maxTokens: cfg.maxTokens ?? 512,
    };
}

function isConfigured() {
    const s = getApiSettings();
    return !!(s.apiUrl && s.apiKey && s.model);
}

function getRetriever() {
    const cfg = getConfig();
    if (!retrieverInstance || retrieverInstance._strategy !== cfg.retrieverStrategy) {
        retrieverInstance = createRetriever(cfg.retrieverStrategy || 'keyword');
        retrieverInstance._strategy = cfg.retrieverStrategy || 'keyword';
    }
    return retrieverInstance;
}

function log(...args) {
    console.log(`[${DISPLAY_NAME}]`, ...args);
}

function warn(...args) {
    console.warn(`[${DISPLAY_NAME}]`, ...args);
}

// ─── Core: Summarization Pipeline ─────────────────────────

async function handleNewMessage(messageIndex) {
    const cfg = getConfig();
    if (!cfg.enabled || !cfg.autoSummarize || !isConfigured()) return;

    const chatId = getChatId();
    if (!chatId) return;

    const ctx = getContext();
    const message = ctx.chat?.[messageIndex];
    if (!message) return;

    const isUser = message.is_user;
    const isSystem = message.is_system;
    if (isSystem) return;
    if (isUser && !cfg.summarizeUser) return;
    if (!isUser && !cfg.summarizeAssistant) return;

    const text = message.mes || '';
    if (text.length < (cfg.minMessageLength || 50)) return;

    const existing = getMemories(chatId);
    if (existing.some(m => m.messageIndex === messageIndex)) return;

    if (isProcessing) {
        pendingSummarizations.push(messageIndex);
        return;
    }

    try {
        isProcessing = true;
        log(`Summarizing message #${messageIndex}...`);
        updateStatusIndicator('processing', `Summarizing #${messageIndex}...`);

        const entry = await processMessage({
            messageText: text,
            messageIndex,
            chatId,
            source: isUser ? 'user' : 'assistant',
            apiSettings: getApiSettings(),
            customSummarizePrompt: cfg.customSummarizePrompt || undefined,
        });

        if (cfg.applyDecay) {
            entry.decay.halfLifeDays = cfg.decayHalfLifeDays || 30;
        }

        addMemory(chatId, entry);
        log(`Memory stored: [${entry.tags.keywords.join(', ')}] ${entry.summary}`);
        updateStatusIndicator('idle');
        refreshUI();
    } catch (err) {
        warn('Summarization failed:', err);
        updateStatusIndicator('error', err.message);
    } finally {
        isProcessing = false;
        if (pendingSummarizations.length > 0) {
            const next = pendingSummarizations.shift();
            handleNewMessage(next);
        }
    }
}

// ─── Core: Retrieval & Injection ──────────────────────────

/**
 * The generate_interceptor: called before every text generation.
 * Analyses the user's latest message, retrieves relevant memories,
 * and injects them using setExtensionPrompt.
 */
globalThis.smartMemoryInterceptor = async function (chat, contextSize, abort, type) {
    const cfg = getConfig();
    if (!cfg.enabled || !isConfigured()) return;
    if (type === 'quiet') return;

    const chatId = getChatId();
    if (!chatId) return;

    const lastUserMsg = [...chat].reverse().find(m => m.is_user);
    if (!lastUserMsg?.mes) return;

    const memories = getMemories(chatId);
    if (!memories || memories.length === 0) return;

    try {
        const keywords = await extractQueryKeywords(lastUserMsg.mes, getApiSettings());
        if (!keywords || keywords.length === 0) return;

        log('Query keywords:', keywords);

        const retriever = getRetriever();

        let FuseClass = null;
        try {
            FuseClass = globalThis.SillyTavern?.libs?.Fuse ?? null;
        } catch { /* Fuse not available */ }

        const query = { keywords };
        const searchOpts = {
            maxResults: cfg.maxRetrievedMemories || 5,
            minScore: cfg.minRetrievalScore || 0.1,
            applyDecay: cfg.applyDecay ?? false,
            matchWeight: cfg.matchWeight ?? 0.5,
            importanceWeight: cfg.importanceWeight ?? 0.3,
            decayWeight: cfg.decayWeight ?? 0.2,
        };
        const results = retriever instanceof FuseRetriever
            ? retriever.search(query, memories, searchOpts, FuseClass)
            : retriever.search(query, memories, searchOpts);

        if (results.length === 0) {
            clearInjection();
            return;
        }

        for (const r of results) {
            const touched = touchEntry(r.entry);
            updateMemory(chatId, r.entry.id, {
                decay: touched.decay,
            });
        }

        const memoryLines = results.map(r =>
            `- [Importance:${r.entry.importance}] ${r.entry.summary}`
        ).join('\n');

        const template = cfg.injectionTemplate || '[Recalled Memories]\n{{memories}}';
        const injectionText = template.replace('{{memories}}', memoryLines);

        const ctx = getContext();
        ctx.setExtensionPrompt(
            INJECTION_KEY,
            injectionText,
            cfg.injectionPosition ?? extension_prompt_types.IN_CHAT,
            cfg.injectionDepth ?? 4,
            false,
            extension_prompt_roles.SYSTEM,
        );

        log(`Injected ${results.length} memories`);
    } catch (err) {
        warn('Retrieval/injection failed:', err);
    }
};

function clearInjection() {
    try {
        const ctx = getContext();
        ctx.setExtensionPrompt(INJECTION_KEY, '', 0, 0);
    } catch { /* ignore */ }
}

// ─── Event Handlers ───────────────────────────────────────

function onChatChanged() {
    clearInjection();
    refreshUI();
    log('Chat changed, memory context reset.');
}

function onMessageReceived(messageIndex) {
    handleNewMessage(messageIndex);
}

function onUserMessageRendered(messageIndex) {
    const cfg = getConfig();
    if (cfg.summarizeUser) {
        handleNewMessage(messageIndex);
    }
}

// ─── UI ───────────────────────────────────────────────────

function updateStatusIndicator(status, message = '') {
    const el = document.getElementById('smart_memory_status');
    if (!el) return;
    el.className = `smart-memory-status smart-memory-status--${status}`;
    const textEl = el.querySelector('.smart-memory-status-text');
    if (textEl) {
        const labels = { idle: 'Idle', processing: 'Processing...', error: 'Error' };
        textEl.textContent = message || labels[status] || status;
    }
}

function refreshUI() {
    const chatId = getChatId();
    if (!chatId) return;

    refreshSlotSelector();
    refreshMemoryList();
    refreshStats();
}

function refreshSlotSelector() {
    const chatId = getChatId();
    if (!chatId) return;
    const select = document.getElementById('smart_memory_slot_select');
    if (!select) return;

    const slots = getSlots(chatId);
    const activeId = getActiveSlotId(chatId);
    select.innerHTML = '';
    for (const [id, slot] of Object.entries(slots)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = slot.name;
        opt.selected = id === activeId;
        select.appendChild(opt);
    }
}

function refreshMemoryList() {
    const chatId = getChatId();
    const container = document.getElementById('smart_memory_list');
    if (!container || !chatId) return;

    const memories = getMemories(chatId).filter(m => m.isActive);
    if (memories.length === 0) {
        container.innerHTML = '<div class="smart-memory-empty">No memories yet.</div>';
        return;
    }

    container.innerHTML = memories.map(m => `
        <div class="smart-memory-item ${m.isPinned ? 'pinned' : ''}" data-id="${m.id}">
            <div class="smart-memory-item-header">
                <span class="smart-memory-importance" title="Importance: ${m.importance}">
                    ${'★'.repeat(Math.min(m.importance, 10))}${'☆'.repeat(Math.max(0, 10 - m.importance))}
                </span>
                <span class="smart-memory-source">${m.source === 'user' ? '👤' : '🤖'}</span>
                <span class="smart-memory-msg-idx">#${m.messageIndex}</span>
            </div>
            <div class="smart-memory-summary">${escapeHtml(m.summary)}</div>
            <div class="smart-memory-tags">
                ${(m.tags?.keywords || []).map(t => `<span class="smart-memory-tag tag-keyword">${escapeHtml(t)}</span>`).join('')}
                ${(m.tags?.emotions || []).map(t => `<span class="smart-memory-tag tag-emotion">${escapeHtml(t)}</span>`).join('')}
                ${(m.tags?.categories || []).map(t => `<span class="smart-memory-tag tag-category">${escapeHtml(t)}</span>`).join('')}
            </div>
            <div class="smart-memory-actions">
                <button class="smart-memory-btn btn-pin menu_button" data-action="pin" title="${m.isPinned ? 'Unpin' : 'Pin'}">
                    ${m.isPinned ? '📌' : '📍'}
                </button>
                <button class="smart-memory-btn btn-edit menu_button" data-action="edit" title="Edit">✏️</button>
                <button class="smart-memory-btn btn-delete menu_button" data-action="delete" title="Delete">🗑️</button>
            </div>
        </div>
    `).join('');
}

function refreshStats() {
    const chatId = getChatId();
    const el = document.getElementById('smart_memory_stats');
    if (!el || !chatId) return;
    const stats = getStats(chatId);
    el.textContent = `Memories: ${stats.active} active / ${stats.total} total | Pinned: ${stats.pinned} | Slots: ${stats.slotCount}`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── UI Event Binding ─────────────────────────────────────

function bindUIEvents() {
    // API config
    document.getElementById('smart_memory_api_url')?.addEventListener('input', e => {
        setConfig({ apiUrl: e.target.value });
    });
    document.getElementById('smart_memory_api_key')?.addEventListener('input', e => {
        setConfig({ apiKey: e.target.value });
    });
    document.getElementById('smart_memory_model')?.addEventListener('input', e => {
        setConfig({ model: e.target.value });
    });
    document.getElementById('smart_memory_temperature')?.addEventListener('input', e => {
        setConfig({ temperature: parseFloat(e.target.value) || 0.3 });
    });
    document.getElementById('smart_memory_max_tokens')?.addEventListener('input', e => {
        setConfig({ maxTokens: parseInt(e.target.value, 10) || 512 });
    });

    // Test connection
    document.getElementById('smart_memory_test_btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('smart_memory_test_btn');
        btn.disabled = true;
        btn.textContent = 'Testing...';
        const result = await testConnection(getApiSettings());
        btn.textContent = result.success ? '✓ Connected!' : '✗ Failed';
        btn.title = result.message;
        setTimeout(() => { btn.textContent = 'Test Connection'; btn.disabled = false; }, 3000);
    });

    // Toggle switches
    document.getElementById('smart_memory_enabled')?.addEventListener('change', e => {
        setConfig({ enabled: e.target.checked });
    });
    document.getElementById('smart_memory_auto_summarize')?.addEventListener('change', e => {
        setConfig({ autoSummarize: e.target.checked });
    });
    document.getElementById('smart_memory_summarize_user')?.addEventListener('change', e => {
        setConfig({ summarizeUser: e.target.checked });
    });
    document.getElementById('smart_memory_summarize_assistant')?.addEventListener('change', e => {
        setConfig({ summarizeAssistant: e.target.checked });
    });
    document.getElementById('smart_memory_apply_decay')?.addEventListener('change', e => {
        setConfig({ applyDecay: e.target.checked });
    });

    // Numeric settings
    document.getElementById('smart_memory_min_length')?.addEventListener('input', e => {
        setConfig({ minMessageLength: parseInt(e.target.value, 10) || 50 });
    });
    document.getElementById('smart_memory_max_results')?.addEventListener('input', e => {
        setConfig({ maxRetrievedMemories: parseInt(e.target.value, 10) || 5 });
    });
    document.getElementById('smart_memory_decay_halflife')?.addEventListener('input', e => {
        setConfig({ decayHalfLifeDays: parseInt(e.target.value, 10) || 30 });
    });
    document.getElementById('smart_memory_injection_depth')?.addEventListener('input', e => {
        setConfig({ injectionDepth: parseInt(e.target.value, 10) || 4 });
    });

    // Custom prompts
    document.getElementById('smart_memory_custom_prompt')?.addEventListener('input', e => {
        setConfig({ customSummarizePrompt: e.target.value });
    });
    document.getElementById('smart_memory_injection_template')?.addEventListener('input', e => {
        setConfig({ injectionTemplate: e.target.value });
    });

    // Slot management
    document.getElementById('smart_memory_slot_select')?.addEventListener('change', e => {
        const chatId = getChatId();
        if (chatId) {
            switchSlot(chatId, e.target.value);
            refreshUI();
        }
    });

    document.getElementById('smart_memory_new_slot')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) return;
        const name = prompt('Enter name for new save slot:');
        if (!name) return;
        const id = createSlot(chatId, name);
        switchSlot(chatId, id);
        refreshUI();
    });

    document.getElementById('smart_memory_dup_slot')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) return;
        const activeId = getActiveSlotId(chatId);
        const name = prompt('Enter name for the duplicated slot:');
        if (!name) return;
        const id = duplicateSlot(chatId, activeId, name);
        switchSlot(chatId, id);
        refreshUI();
    });

    document.getElementById('smart_memory_rename_slot')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) return;
        const activeId = getActiveSlotId(chatId);
        const name = prompt('Enter new name:');
        if (!name) return;
        renameSlot(chatId, activeId, name);
        refreshUI();
    });

    document.getElementById('smart_memory_delete_slot')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) return;
        const activeId = getActiveSlotId(chatId);
        if (!confirm('Delete this save slot and all its memories?')) return;
        try {
            deleteSlot(chatId, activeId);
            refreshUI();
        } catch (err) {
            alert(err.message);
        }
    });

    document.getElementById('smart_memory_export_slot')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) return;
        const json = exportSlot(chatId);
        if (!json) return;
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `smart-memory-${chatId}-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    document.getElementById('smart_memory_import_slot')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const text = await file.text();
            try {
                const name = prompt('Name for imported slot:', file.name.replace('.json', ''));
                importSlot(chatId, text, name);
                refreshUI();
            } catch (err) {
                alert('Import failed: ' + err.message);
            }
        });
        input.click();
    });

    // Memory list actions (event delegation)
    document.getElementById('smart_memory_list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const chatId = getChatId();
        if (!chatId) return;
        const item = btn.closest('.smart-memory-item');
        const entryId = item?.dataset?.id;
        if (!entryId) return;

        const action = btn.dataset.action;
        switch (action) {
            case 'pin':
                togglePin(chatId, entryId);
                refreshMemoryList();
                break;
            case 'delete':
                if (confirm('Remove this memory?')) {
                    removeMemory(chatId, entryId);
                    refreshUI();
                }
                break;
            case 'edit': {
                const memories = getMemories(chatId);
                const entry = memories.find(m => m.id === entryId);
                if (!entry) break;
                const newSummary = prompt('Edit summary:', entry.summary);
                if (newSummary !== null && newSummary !== entry.summary) {
                    updateMemory(chatId, entryId, { summary: newSummary });
                    refreshMemoryList();
                }
                break;
            }
        }
    });

    // Manual summarize button
    document.getElementById('smart_memory_summarize_all')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId || !isConfigured()) {
            alert('Please configure the API first.');
            return;
        }
        const ctx = getContext();
        const chat = ctx.chat || [];
        const cfg = getConfig();
        const existing = getMemories(chatId);
        const existingIndices = new Set(existing.map(m => m.messageIndex));

        let count = 0;
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (msg.is_system) continue;
            if (msg.is_user && !cfg.summarizeUser) continue;
            if (!msg.is_user && !cfg.summarizeAssistant) continue;
            if ((msg.mes || '').length < (cfg.minMessageLength || 50)) continue;
            if (existingIndices.has(i)) continue;

            updateStatusIndicator('processing', `Summarizing ${count + 1}... (msg #${i})`);
            try {
                const entry = await processMessage({
                    messageText: msg.mes,
                    messageIndex: i,
                    chatId,
                    source: msg.is_user ? 'user' : 'assistant',
                    apiSettings: getApiSettings(),
                    customSummarizePrompt: cfg.customSummarizePrompt || undefined,
                });
                if (cfg.applyDecay) {
                    entry.decay.halfLifeDays = cfg.decayHalfLifeDays || 30;
                }
                addMemory(chatId, entry);
                count++;
            } catch (err) {
                warn(`Failed to summarize message #${i}:`, err);
            }
        }

        updateStatusIndicator('idle');
        refreshUI();
        log(`Batch summarization complete: ${count} new memories created.`);
    });
}

// ─── Initialisation ───────────────────────────────────────

function loadSettings() {
    const cfg = getConfig();
    const fields = {
        smart_memory_api_url: cfg.apiUrl || '',
        smart_memory_api_key: cfg.apiKey || '',
        smart_memory_model: cfg.model || '',
        smart_memory_temperature: cfg.temperature ?? 0.3,
        smart_memory_max_tokens: cfg.maxTokens ?? 512,
        smart_memory_min_length: cfg.minMessageLength ?? 50,
        smart_memory_max_results: cfg.maxRetrievedMemories ?? 5,
        smart_memory_decay_halflife: cfg.decayHalfLifeDays ?? 30,
        smart_memory_injection_depth: cfg.injectionDepth ?? 4,
        smart_memory_custom_prompt: cfg.customSummarizePrompt || '',
        smart_memory_injection_template: cfg.injectionTemplate || DEFAULT_CONFIG.injectionTemplate,
    };
    for (const [id, value] of Object.entries(fields)) {
        const el = document.getElementById(id);
        if (el) el.value = value;
    }

    const checks = {
        smart_memory_enabled: cfg.enabled ?? true,
        smart_memory_auto_summarize: cfg.autoSummarize ?? true,
        smart_memory_summarize_user: cfg.summarizeUser ?? false,
        smart_memory_summarize_assistant: cfg.summarizeAssistant ?? true,
        smart_memory_apply_decay: cfg.applyDecay ?? false,
    };
    for (const [id, value] of Object.entries(checks)) {
        const el = document.getElementById(id);
        if (el) el.checked = value;
    }
}

async function init() {
    log('Initialising...');

    initStore(getContext, saveSettingsDebounced);

    const root = getContext().extensionSettings;
    if (!root[MODULE_NAME]) {
        root[MODULE_NAME] = { config: { ...DEFAULT_CONFIG }, chats: {} };
        saveSettingsDebounced();
    }

    try {
        const settingsHtml = await renderExtensionTemplateAsync(
            'third-party/smart-memory',
            'settings',
        );
        document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', settingsHtml);
    } catch (err) {
        warn('Could not load settings template:', err);
    }

    loadSettings();
    bindUIEvents();

    const ctx = getContext();
    const eventSource = ctx.eventSource;
    const eventTypes = ctx.eventTypes;

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onUserMessageRendered);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);

    refreshUI();
    log('Ready.');
}

// SillyTavern calls this hook during the loading phase
export async function activate() {
    // nothing needed at this stage
}

// Main init after app is ready
const ctx = getContext();
ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
    setTimeout(init, 500);
});
