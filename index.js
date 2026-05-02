/**
 * Smart Memory – SillyTavern Extension
 *
 * Intelligent memory system with human-like STM/LTM architecture,
 * associative retrieval, per-message summarization, and structured tagging.
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
         exportSlot, importSlot, getStats, deactivateMemory, replaceMemories,
         runMemoryConsolidation, refreshAssociativeLinks, getMemoriesByType,
         promoteToLongTerm, demoteToShortTerm } from './memory-store.js';
import { processMessage, extractQueryKeywords, summarizeMessage, generateTags } from './summarizer.js';
import { createRetriever, touchEntry, FuseRetriever } from './retriever.js';
import { createMemoryEntry, makeExcerpt } from './memory-entry.js';

// ─── Constants ────────────────────────────────────────────

const MODULE_NAME = 'smart_memory';
const DISPLAY_NAME = 'Smart Memory';
const INJECTION_KEY = 'smart_memory_injection';

const DEFAULT_CONFIG = {
    enabled: true,
    // API
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
    // Personalization
    globalSummarizeDirective: '',
    globalTagDirective: '',
    importanceCriteria: '',
    // Retrieval
    retrieverStrategy: 'keyword',
    maxRetrievedMemories: 5,
    minRetrievalScore: 0.1,
    applyDecay: false,
    // Injection
    injectionPosition: 1,
    injectionDepth: 4,
    injectionTemplate: '[Recalled Memories]\n{{memories}}',
    // Weights
    matchWeight: 0.5,
    importanceWeight: 0.3,
    decayWeight: 0.2,
    // Consolidation
    consolidationImportanceThreshold: 7,
    consolidationRetrievalThreshold: 3,
    stmCapacity: 50,
    stmDecayHalfLifeDays: 2,
    ltmDecayHalfLifeDays: 90,
    // Associative
    enableAssociativeRetrieval: true,
    associativeBoostFactor: 0.3,
    maxAssociativeHops: 1,
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

function getEnhancedStats(chatId) {
    const memories = getMemories(chatId);
    const active = memories.filter(m => m.isActive);
    return {
        total: active.length,
        ltm: active.filter(m => m.memoryType === 'long_term').length,
        stm: active.filter(m => (m.memoryType || 'short_term') === 'short_term').length,
        pinned: active.filter(m => m.isPinned).length,
        slotCount: Object.keys(getSlots(chatId)).length,
    };
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
        updateStatusIndicator('processing', `正在总结 #${messageIndex}...`);

        const entry = await processMessage({
            messageText: text,
            messageIndex,
            chatId,
            source: isUser ? 'user' : 'assistant',
            apiSettings: getApiSettings(),
            customSummarizePrompt: cfg.customSummarizePrompt || undefined,
            globalSummarizeDirective: cfg.globalSummarizeDirective || undefined,
            globalTagDirective: cfg.globalTagDirective || undefined,
            importanceCriteria: cfg.importanceCriteria || undefined,
        });

        if (cfg.applyDecay) {
            entry.decay.halfLifeDays = cfg.stmDecayHalfLifeDays || 2;
        }

        addMemory(chatId, entry);
        log(`Memory stored: [${entry.tags.keywords.join(', ')}] ${entry.summary}`);

        triggerConsolidation(chatId);

        updateStatusIndicator('idle');
        refreshSidebar();
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

function triggerConsolidation(chatId) {
    const cfg = getConfig();
    try {
        const result = runMemoryConsolidation(chatId, {
            importanceThreshold: cfg.consolidationImportanceThreshold ?? 7,
            retrievalThreshold: cfg.consolidationRetrievalThreshold ?? 3,
            stmCapacity: cfg.stmCapacity ?? 50,
            stmDecayHalfLifeDays: cfg.stmDecayHalfLifeDays ?? 2,
            ltmDecayHalfLifeDays: cfg.ltmDecayHalfLifeDays ?? 90,
        });
        if (result.promoted.length > 0) {
            log(`Consolidated ${result.promoted.length} memories to LTM`);
            refreshAssociativeLinks(chatId);
        }
        if (result.deactivated.length > 0) {
            log(`Deactivated ${result.deactivated.length} low-activation STM entries`);
        }
    } catch (err) {
        warn('Consolidation failed:', err);
    }
}

// ─── Core: Retrieval & Injection ──────────────────────────

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
            enableAssociative: cfg.enableAssociativeRetrieval ?? true,
            associativeBoost: cfg.associativeBoostFactor ?? 0.3,
            maxAssociativeHops: cfg.maxAssociativeHops ?? 1,
            stmHalfLifeDays: cfg.stmDecayHalfLifeDays ?? 2,
            ltmHalfLifeDays: cfg.ltmDecayHalfLifeDays ?? 90,
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
                retrievalCount: touched.retrievalCount,
                lastRetrievedAt: touched.lastRetrievedAt,
                activationLevel: touched.activationLevel,
            });
        }

        const memoryLines = results.map(r => {
            const typeTag = r.entry.memoryType === 'long_term' ? 'LTM' : 'STM';
            const src = r.detail?.source === 'associative' ? '~联想' : '';
            return `- [${typeTag}|重要性:${r.entry.importance}${src}] ${r.entry.summary}`;
        }).join('\n');

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
    refreshSidebar();
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

// ─── Sidebar UI ───────────────────────────────────────────

function updateStatusIndicator(status, message = '') {
    const labels = { idle: '空闲', processing: '处理中...', error: '错误' };
    for (const el of document.querySelectorAll('.smart-memory-status')) {
        el.className = `smart-memory-status smart-memory-status--${status}`;
        const textEl = el.querySelector('.smart-memory-status-text');
        if (textEl) {
            textEl.textContent = message || labels[status] || status;
        }
    }
}

function refreshSidebar() {
    const chatId = getChatId();
    if (!chatId) return;
    const stats = getEnhancedStats(chatId);

    const setTextById = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
    };

    setTextById('smart_memory_sidebar_total', stats.total);
    setTextById('smart_memory_sidebar_ltm', stats.ltm);
    setTextById('smart_memory_sidebar_stm', stats.stm);
    setTextById('smart_memory_sidebar_pinned', stats.pinned);
}

// ─── Popup ────────────────────────────────────────────────

let popupHtmlCache = null;

async function getPopupHtml() {
    if (popupHtmlCache) return popupHtmlCache;
    try {
        popupHtmlCache = await renderExtensionTemplateAsync('third-party/smart-memory', 'popup');
    } catch {
        warn('Could not load popup template');
        popupHtmlCache = '<div>Error loading popup.</div>';
    }
    return popupHtmlCache;
}

async function openPopup() {
    const html = await getPopupHtml();

    const overlay = document.createElement('div');
    overlay.id = 'sm_popup_overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--SmartThemeBlurTintColor, #1e1e2e);border:1px solid var(--SmartThemeBorderColor, #444);border-radius:12px;padding:20px;max-width:700px;width:95vw;max-height:85vh;overflow-y:auto;position:relative;box-shadow:0 8px 32px rgba(0,0,0,0.4);';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:10px;right:14px;background:none;border:none;color:var(--SmartThemeBodyColor);font-size:1.3em;cursor:pointer;z-index:10;';
    closeBtn.addEventListener('click', () => overlay.remove());

    const title = document.createElement('h3');
    title.textContent = 'Smart Memory 管理面板';
    title.style.cssText = 'margin:0 0 10px;color:var(--SmartThemeBodyColor);';

    dialog.appendChild(closeBtn);
    dialog.appendChild(title);
    dialog.insertAdjacentHTML('beforeend', html);
    overlay.appendChild(dialog);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);

    initPopupTabs(dialog);
    loadPopupValues(dialog);
    bindPopupEvents(dialog, overlay);
    refreshPopupMemoryList(dialog);
}

function initPopupTabs(root) {
    const tabs = root.querySelectorAll('.sm-tab-btn');
    const contents = root.querySelectorAll('.sm-tab-content');

    tabs.forEach(btn => {
        btn.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const target = root.querySelector(`.sm-tab-content[data-tab="${btn.dataset.tab}"]`);
            if (target) target.classList.add('active');
        });
    });
}

function loadPopupValues(root) {
    const cfg = getConfig();

    const setVal = (id, v) => { const el = root.querySelector(`#${id}`); if (el) el.value = v; };
    const setChk = (id, v) => { const el = root.querySelector(`#${id}`); if (el) el.checked = v; };

    // Overview
    setChk('sm_pop_enabled', cfg.enabled ?? true);

    // API
    setVal('sm_pop_api_url', cfg.apiUrl || '');
    setVal('sm_pop_api_key', cfg.apiKey || '');
    setVal('sm_pop_model', cfg.model || '');
    setVal('sm_pop_temperature', cfg.temperature ?? 0.3);
    setVal('sm_pop_max_tokens', cfg.maxTokens ?? 512);

    // Settings
    setChk('sm_pop_auto_summarize', cfg.autoSummarize ?? true);
    setChk('sm_pop_summarize_user', cfg.summarizeUser ?? false);
    setChk('sm_pop_summarize_assistant', cfg.summarizeAssistant ?? true);
    setVal('sm_pop_min_length', cfg.minMessageLength ?? 50);
    setVal('sm_pop_max_results', cfg.maxRetrievedMemories ?? 5);
    setVal('sm_pop_retriever_strategy', cfg.retrieverStrategy || 'keyword');
    setChk('sm_pop_apply_decay', cfg.applyDecay ?? false);
    setChk('sm_pop_enable_associative', cfg.enableAssociativeRetrieval ?? true);
    setVal('sm_pop_associative_boost', cfg.associativeBoostFactor ?? 0.3);
    setVal('sm_pop_consolidation_importance', cfg.consolidationImportanceThreshold ?? 7);
    setVal('sm_pop_consolidation_retrieval', cfg.consolidationRetrievalThreshold ?? 3);
    setVal('sm_pop_stm_capacity', cfg.stmCapacity ?? 50);
    setVal('sm_pop_stm_decay', cfg.stmDecayHalfLifeDays ?? 2);
    setVal('sm_pop_ltm_decay', cfg.ltmDecayHalfLifeDays ?? 90);
    setVal('sm_pop_injection_depth', cfg.injectionDepth ?? 4);
    setVal('sm_pop_injection_template', cfg.injectionTemplate || DEFAULT_CONFIG.injectionTemplate);
    setVal('sm_pop_match_weight', cfg.matchWeight ?? 0.5);
    setVal('sm_pop_importance_weight', cfg.importanceWeight ?? 0.3);
    setVal('sm_pop_decay_weight', cfg.decayWeight ?? 0.2);

    // Prompts
    setVal('sm_pop_global_summarize', cfg.globalSummarizeDirective || '');
    setVal('sm_pop_custom_prompt', cfg.customSummarizePrompt || '');
    setVal('sm_pop_global_tag', cfg.globalTagDirective || '');
    setVal('sm_pop_importance_criteria', cfg.importanceCriteria || '');
    setVal('sm_pop_injection_tpl', cfg.injectionTemplate || DEFAULT_CONFIG.injectionTemplate);

    // Stats
    refreshPopupStats(root);

    // Slots
    refreshPopupSlots(root);
}

function refreshPopupStats(root) {
    const chatId = getChatId();
    if (!chatId) return;
    const stats = getEnhancedStats(chatId);

    const setText = (id, v) => { const el = root.querySelector(`#${id}`); if (el) el.textContent = v; };
    setText('sm_stat_total', stats.total);
    setText('sm_stat_ltm', stats.ltm);
    setText('sm_stat_stm', stats.stm);
    setText('sm_stat_pinned', stats.pinned);
}

function refreshPopupSlots(root) {
    const chatId = getChatId();
    if (!chatId) return;

    const select = root.querySelector('#sm_pop_slot_select');
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

function refreshPopupMemoryList(root) {
    const chatId = getChatId();
    if (!chatId) return;

    const memories = getMemories(chatId).filter(m => m.isActive);
    const search = (root.querySelector('#sm_pop_search')?.value || '').toLowerCase();
    const filterType = root.querySelector('#sm_pop_filter_type')?.value || 'all';

    let filtered = memories;
    if (filterType === 'long_term') filtered = filtered.filter(m => m.memoryType === 'long_term');
    else if (filterType === 'short_term') filtered = filtered.filter(m => (m.memoryType || 'short_term') === 'short_term');
    else if (filterType === 'pinned') filtered = filtered.filter(m => m.isPinned);

    if (search) {
        filtered = filtered.filter(m =>
            m.summary.toLowerCase().includes(search) ||
            (m.tags?.keywords || []).some(k => k.toLowerCase().includes(search))
        );
    }

    const ltm = filtered.filter(m => m.memoryType === 'long_term');
    const stm = filtered.filter(m => (m.memoryType || 'short_term') === 'short_term');

    const ltmCount = root.querySelector('#sm_pop_ltm_count');
    const stmCount = root.querySelector('#sm_pop_stm_count');
    if (ltmCount) ltmCount.textContent = ltm.length;
    if (stmCount) stmCount.textContent = stm.length;

    const ltmList = root.querySelector('#sm_pop_ltm_list');
    const stmList = root.querySelector('#sm_pop_stm_list');

    if (ltmList) ltmList.innerHTML = ltm.length ? ltm.map(m => renderMemoryItem(m, 'ltm')).join('') : '<div class="smart-memory-empty">暂无长期记忆</div>';
    if (stmList) stmList.innerHTML = stm.length ? stm.map(m => renderMemoryItem(m, 'stm')).join('') : '<div class="smart-memory-empty">暂无短期记忆</div>';

    refreshPopupStats(root);
}

function renderMemoryItem(m, type) {
    const badgeClass = type === 'ltm' ? 'badge-ltm' : 'badge-stm';
    const badgeText = type === 'ltm' ? '长期' : '短期';
    const itemClass = type === 'ltm' ? 'ltm-item' : 'stm-item';
    const activation = Math.round((m.activationLevel ?? 0.5) * 100);
    const emotional = Math.round((m.emotionalIntensity ?? 0) * 100);

    return `
        <div class="smart-memory-item ${itemClass} ${m.isPinned ? 'pinned' : ''}" data-id="${m.id}">
            <div class="smart-memory-item-header">
                <span class="sm-memory-type-badge ${badgeClass}">${badgeText}</span>
                <span class="smart-memory-importance" title="重要性: ${m.importance}">
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
            <div class="sm-memory-detail-row">
                <span>激活: ${activation}%</span>
                <span>情感: ${emotional}%</span>
                <span>检索: ${m.retrievalCount ?? 0}次</span>
                <span>关联: ${(m.associativeLinks || []).length}条</span>
            </div>
            <div class="smart-memory-actions">
                <button class="smart-memory-btn btn-pin menu_button" data-action="pin" title="${m.isPinned ? '取消固定' : '固定'}">
                    ${m.isPinned ? '📌' : '📍'}
                </button>
                ${type === 'stm' ? `<button class="smart-memory-btn menu_button" data-action="promote" title="晋升为长期记忆">⬆️</button>` : ''}
                ${type === 'ltm' ? `<button class="smart-memory-btn menu_button" data-action="demote" title="降级为短期记忆">⬇️</button>` : ''}
                <button class="smart-memory-btn btn-edit menu_button" data-action="edit" title="编辑">✏️</button>
                <button class="smart-memory-btn btn-delete menu_button" data-action="delete" title="删除">🗑️</button>
            </div>
        </div>
    `;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Popup Event Binding ──────────────────────────────────

function bindPopupEvents(root, overlay) {
    const chatId = getChatId();

    // ─ config inputs (auto-save on change) ─
    const configBindings = [
        // API
        { id: 'sm_pop_api_url', key: 'apiUrl', type: 'text' },
        { id: 'sm_pop_api_key', key: 'apiKey', type: 'text' },
        { id: 'sm_pop_model', key: 'model', type: 'text' },
        { id: 'sm_pop_temperature', key: 'temperature', type: 'float' },
        { id: 'sm_pop_max_tokens', key: 'maxTokens', type: 'int' },
        // Settings
        { id: 'sm_pop_min_length', key: 'minMessageLength', type: 'int' },
        { id: 'sm_pop_max_results', key: 'maxRetrievedMemories', type: 'int' },
        { id: 'sm_pop_retriever_strategy', key: 'retrieverStrategy', type: 'text' },
        { id: 'sm_pop_associative_boost', key: 'associativeBoostFactor', type: 'float' },
        { id: 'sm_pop_consolidation_importance', key: 'consolidationImportanceThreshold', type: 'int' },
        { id: 'sm_pop_consolidation_retrieval', key: 'consolidationRetrievalThreshold', type: 'int' },
        { id: 'sm_pop_stm_capacity', key: 'stmCapacity', type: 'int' },
        { id: 'sm_pop_stm_decay', key: 'stmDecayHalfLifeDays', type: 'float' },
        { id: 'sm_pop_ltm_decay', key: 'ltmDecayHalfLifeDays', type: 'float' },
        { id: 'sm_pop_injection_depth', key: 'injectionDepth', type: 'int' },
        { id: 'sm_pop_injection_template', key: 'injectionTemplate', type: 'text' },
        { id: 'sm_pop_match_weight', key: 'matchWeight', type: 'float' },
        { id: 'sm_pop_importance_weight', key: 'importanceWeight', type: 'float' },
        { id: 'sm_pop_decay_weight', key: 'decayWeight', type: 'float' },
        // Prompts
        { id: 'sm_pop_global_summarize', key: 'globalSummarizeDirective', type: 'text' },
        { id: 'sm_pop_custom_prompt', key: 'customSummarizePrompt', type: 'text' },
        { id: 'sm_pop_global_tag', key: 'globalTagDirective', type: 'text' },
        { id: 'sm_pop_importance_criteria', key: 'importanceCriteria', type: 'text' },
        { id: 'sm_pop_injection_tpl', key: 'injectionTemplate', type: 'text' },
    ];

    for (const b of configBindings) {
        const el = root.querySelector(`#${b.id}`);
        if (!el) continue;
        el.addEventListener('input', () => {
            let value = el.value;
            if (b.type === 'int') value = parseInt(value, 10) || 0;
            else if (b.type === 'float') value = parseFloat(value) || 0;
            setConfig({ [b.key]: value });
        });
    }

    const checkBindings = [
        { id: 'sm_pop_enabled', key: 'enabled' },
        { id: 'sm_pop_auto_summarize', key: 'autoSummarize' },
        { id: 'sm_pop_summarize_user', key: 'summarizeUser' },
        { id: 'sm_pop_summarize_assistant', key: 'summarizeAssistant' },
        { id: 'sm_pop_apply_decay', key: 'applyDecay' },
        { id: 'sm_pop_enable_associative', key: 'enableAssociativeRetrieval' },
    ];

    for (const b of checkBindings) {
        const el = root.querySelector(`#${b.id}`);
        if (!el) continue;
        el.addEventListener('change', () => {
            setConfig({ [b.key]: el.checked });
            if (b.key === 'enabled') {
                const sidebarCheck = document.getElementById('smart_memory_enabled');
                if (sidebarCheck) sidebarCheck.checked = el.checked;
            }
        });
    }

    // ─ Test Connection ─
    root.querySelector('#sm_pop_test_btn')?.addEventListener('click', async () => {
        const btn = root.querySelector('#sm_pop_test_btn');
        const resultEl = root.querySelector('#sm_pop_test_result');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中...';
        const result = await testConnection(getApiSettings());
        btn.innerHTML = result.success
            ? '<i class="fa-solid fa-check"></i> 连接成功！'
            : '<i class="fa-solid fa-xmark"></i> 连接失败';
        if (resultEl) {
            resultEl.textContent = result.message;
            resultEl.className = `sm-test-result ${result.success ? 'success' : 'error'}`;
        }
        setTimeout(() => {
            btn.innerHTML = '<i class="fa-solid fa-plug"></i> 测试连接';
            btn.disabled = false;
        }, 3000);
    });

    // ─ Slot management ─
    root.querySelector('#sm_pop_slot_select')?.addEventListener('change', (e) => {
        if (!chatId) return;
        switchSlot(chatId, e.target.value);
        refreshPopupMemoryList(root);
        refreshSidebar();
    });

    root.querySelector('#sm_pop_new_slot')?.addEventListener('click', () => {
        if (!chatId) return;
        const name = prompt('输入新存档名称:');
        if (!name) return;
        const id = createSlot(chatId, name);
        switchSlot(chatId, id);
        refreshPopupSlots(root);
        refreshPopupMemoryList(root);
        refreshSidebar();
    });

    root.querySelector('#sm_pop_dup_slot')?.addEventListener('click', () => {
        if (!chatId) return;
        const activeId = getActiveSlotId(chatId);
        const name = prompt('输入分支存档名称:');
        if (!name) return;
        const id = duplicateSlot(chatId, activeId, name);
        switchSlot(chatId, id);
        refreshPopupSlots(root);
        refreshPopupMemoryList(root);
        refreshSidebar();
    });

    root.querySelector('#sm_pop_rename_slot')?.addEventListener('click', () => {
        if (!chatId) return;
        const activeId = getActiveSlotId(chatId);
        const name = prompt('输入新名称:');
        if (!name) return;
        renameSlot(chatId, activeId, name);
        refreshPopupSlots(root);
    });

    root.querySelector('#sm_pop_delete_slot')?.addEventListener('click', () => {
        if (!chatId) return;
        const activeId = getActiveSlotId(chatId);
        if (!confirm('确定要删除此存档及其所有记忆吗？')) return;
        try {
            deleteSlot(chatId, activeId);
            refreshPopupSlots(root);
            refreshPopupMemoryList(root);
            refreshSidebar();
        } catch (err) {
            alert(err.message);
        }
    });

    root.querySelector('#sm_pop_export_slot')?.addEventListener('click', () => {
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

    root.querySelector('#sm_pop_import_slot')?.addEventListener('click', () => {
        if (!chatId) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const text = await file.text();
            try {
                const name = prompt('导入存档名称:', file.name.replace('.json', ''));
                importSlot(chatId, text, name);
                refreshPopupSlots(root);
                refreshPopupMemoryList(root);
                refreshSidebar();
            } catch (err) {
                alert('导入失败: ' + err.message);
            }
        });
        input.click();
    });

    // ─ Consolidation & Links ─
    root.querySelector('#sm_pop_consolidate')?.addEventListener('click', () => {
        if (!chatId) return;
        triggerConsolidation(chatId);
        refreshPopupMemoryList(root);
        refreshSidebar();
        alert('记忆巩固完成！');
    });

    root.querySelector('#sm_pop_rebuild_links')?.addEventListener('click', () => {
        if (!chatId) return;
        refreshAssociativeLinks(chatId);
        refreshPopupMemoryList(root);
        alert('联想链接已重建！');
    });

    // ─ Search & Filter ─
    root.querySelector('#sm_pop_search')?.addEventListener('input', () => {
        refreshPopupMemoryList(root);
    });

    root.querySelector('#sm_pop_filter_type')?.addEventListener('change', () => {
        refreshPopupMemoryList(root);
    });

    // ─ Memory list actions (event delegation) ─
    for (const listId of ['sm_pop_ltm_list', 'sm_pop_stm_list']) {
        root.querySelector(`#${listId}`)?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn || !chatId) return;
            const item = btn.closest('.smart-memory-item');
            const entryId = item?.dataset?.id;
            if (!entryId) return;

            const action = btn.dataset.action;
            switch (action) {
                case 'pin':
                    togglePin(chatId, entryId);
                    refreshPopupMemoryList(root);
                    refreshSidebar();
                    break;
                case 'delete':
                    if (confirm('确定要删除这条记忆吗？')) {
                        removeMemory(chatId, entryId);
                        refreshPopupMemoryList(root);
                        refreshSidebar();
                    }
                    break;
                case 'edit': {
                    const memories = getMemories(chatId);
                    const entry = memories.find(m => m.id === entryId);
                    if (!entry) break;
                    const newSummary = prompt('编辑记忆摘要:', entry.summary);
                    if (newSummary !== null && newSummary !== entry.summary) {
                        updateMemory(chatId, entryId, { summary: newSummary });
                        refreshPopupMemoryList(root);
                    }
                    break;
                }
                case 'promote':
                    promoteToLongTerm(chatId, entryId, {
                        ltmDecayHalfLifeDays: getConfig().ltmDecayHalfLifeDays ?? 90,
                    });
                    refreshPopupMemoryList(root);
                    refreshSidebar();
                    break;
                case 'demote':
                    demoteToShortTerm(chatId, entryId);
                    refreshPopupMemoryList(root);
                    refreshSidebar();
                    break;
            }
        });
    }

    // ─ Summarize All ─
    root.querySelector('#sm_pop_summarize_all')?.addEventListener('click', async () => {
        if (!chatId || !isConfigured()) {
            alert('请先配置 API。');
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

            updateStatusIndicator('processing', `正在总结 ${count + 1}... (消息 #${i})`);
            try {
                const entry = await processMessage({
                    messageText: msg.mes,
                    messageIndex: i,
                    chatId,
                    source: msg.is_user ? 'user' : 'assistant',
                    apiSettings: getApiSettings(),
                    customSummarizePrompt: cfg.customSummarizePrompt || undefined,
                    globalSummarizeDirective: cfg.globalSummarizeDirective || undefined,
                    globalTagDirective: cfg.globalTagDirective || undefined,
                    importanceCriteria: cfg.importanceCriteria || undefined,
                });
                if (cfg.applyDecay) {
                    entry.decay.halfLifeDays = cfg.stmDecayHalfLifeDays || 2;
                }
                addMemory(chatId, entry);
                count++;
            } catch (err) {
                warn(`Failed to summarize message #${i}:`, err);
            }
        }

        triggerConsolidation(chatId);
        updateStatusIndicator('idle');
        refreshPopupMemoryList(root);
        refreshSidebar();
        log(`Batch summarization complete: ${count} new memories created.`);
        alert(`批量总结完成！共创建 ${count} 条新记忆。`);
    });
}

// ─── Sidebar Event Binding ────────────────────────────────

function bindSidebarEvents() {
    document.getElementById('smart_memory_enabled')?.addEventListener('change', e => {
        setConfig({ enabled: e.target.checked });
    });

    document.getElementById('smart_memory_open_popup')?.addEventListener('click', () => {
        openPopup();
    });
}

// ─── Initialisation ───────────────────────────────────────

function loadSidebarSettings() {
    const cfg = getConfig();
    const el = document.getElementById('smart_memory_enabled');
    if (el) el.checked = cfg.enabled ?? true;
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

    loadSidebarSettings();
    bindSidebarEvents();

    const ctx = getContext();
    const eventSource = ctx.eventSource;
    const eventTypes = ctx.eventTypes;

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onUserMessageRendered);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);

    refreshSidebar();
    log('Ready.');
}

export async function activate() {
    // nothing needed at this stage
}

const ctx = getContext();
ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
    setTimeout(init, 500);
});
