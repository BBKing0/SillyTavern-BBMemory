/**
 * index.js —— BB-Memory v6.1 主入口
 *
 * 四柱架构编排器：NPC档案 / 物品栏 / 时间线 / 记忆条目。
 * 负责初始化、拦截器、UI、斜杠命令。
 */

// ═══ 导入 ═══
import {
    MODULE_NAME, DEFAULT_SETTINGS, getSettings, updateSettings,
    getNpcProfiles, addNpcProfile, updateNpcProfile, removeNpcProfile, upsertNpcProfile,
    getItems, addItem, updateItem, removeItem, upsertItem,
    getTimeline, addTimelineEntry, updateTimelineEntry, removeTimelineEntry, upsertTimelineEntry,
    getMemories, addMemory, updateMemory, removeMemory,
    clearAllData, deleteByExchange, getMemoryStats, refreshAllSourceFloors,
    exportMemoriesToChatMetadata, importMemoriesFromChatMetadata,
    migrateV4ToV5, recordHits, checkDemotions,
    exportMemories, importMemories, updateFactContent, addHiddenNote, removeHiddenNote,
    scheduleAutoBackup, extractKeywords,
} from './memory-store.js';

import {
    getRelevantMemories, getResidentMemories, buildMemoryInjectionPrompt,
    mergeExpandedRelevantResults, simpleSearch, searchMemories,
    getNpcForInjection, getItemsForInjection, getTimelineForInjection,
} from './retriever.js';

import { MEMORY_TYPES, TRUTH_STATUS, HIDDEN_NOTE_TYPES } from './memory-types.js';
import { NPC_TIERS, ITEM_TIERS, expandMemoriesForEntityKeyword } from './entity-tiers.js';

import {
    initAutoGenerator, stopAutoGenerator, extractFromContext, saveExtractedMemories,
    setAutoExtractProgressCallback, getPendingAutoCandidates, clearPendingAutoCandidates,
    callEmbeddingApi, embedExistingMemories,
} from './auto-generator.js';

import {
    syncMessageVisibility, refreshExtractionMarkers,
    markExchangeExtracted, hideExchange,
} from './message-state.js';

import {
    MEMORY_STATUS, checkMaintenanceNeeded, dismissMaintenanceRemind,
    performMaintenance,
    fuzzyMemory, archiveMemory, restoreMemory, autoMaintain,
    generateTimelineSummary,
    getMaintenanceResolved, clearMaintenanceResolved,
} from './memory-maintainer.js';

import { openAssistant } from './memory-assistant.js';
import { openMemoryManager } from './memory-manager.js';
import { getCharacterId, listSlots, saveToSlot, loadFromSlot, createEmptySlot, deleteSlot } from './memory-slots.js';

// ═══ 常量 ═══
const INJECTION_KEY = 'bb_memory_injection';
const POSITION_IN_CHAT = 1; // in-chat
const ROLE_SYSTEM = 0;

// ═══ 全局状态 ═══
let lastRetrievalResult = null;
let settingsPanelMounted = false;

// ═══════════════════════════════════════════════════════════
//  拦截器（核心）
// ═══════════════════════════════════════════════════════════

globalThis.bbMemoryInterceptor = async function (chat, contextSize, abort, type) {
    if (type === 'quiet') return chat;

    const settings = getSettings();
    if (!settings.enabled) { clearInjection(); return chat; }

    const ctx = SillyTavern.getContext();
    const chatId = ctx.chatId || (ctx.chat?.[0]?.chatId) || null;
    if (!chatId) { clearInjection(); return chat; }

    // 1. 提取最后一条用户消息
    let userMessage = '';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && chat[i].mes?.trim()) {
            userMessage = chat[i].mes.trim();
            break;
        }
    }
    if (!userMessage) { clearInjection(); return chat; }

    // 2. 上下文隐藏安全网 —— 只隐藏已提取的消息
    for (const msg of chat) {
        if (msg._bbmem_extracted && !msg.is_hidden) {
            msg.is_hidden = true;
            msg._bbmem_hideSource = 'plugin';
        }
    }

    // 3. 迁移检查
    if (!settings.migratedFromV4) {
        try { await migrateV4ToV5(chatId); } catch (e) { /* ignore */ }
    }

    // 4. 加载数据
    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);

    const hasData = npc.length + items.length + timeline.length + memories.length > 0;
    if (!hasData) { clearInjection(); return chat; }

    // 5. 降格检查
    try { await checkDemotions(chatId); } catch (e) { /* ignore */ }

    // 6. Embedding（如有）
    let queryEmbedding = null;
    if (settings.embeddingEnabled && settings.embeddingEndpoint) {
        try {
            queryEmbedding = await callEmbeddingApi(userMessage, 3000);
        } catch { /* 降级到关键词 */ }
    }

    // 7. 检索各支柱
    const npcForInjection = getNpcForInjection(npc, userMessage);
    const itemsForInjection = getItemsForInjection(items, userMessage);
    const tlForInjection = getTimelineForInjection(timeline);
    const residentMems = getResidentMemories(memories);
    const relevantResults = getRelevantMemories(memories, userMessage, {
        maxResults: settings.maxResults || 10,
        queryEmbedding,
    });
    const excludeIds = new Set([...npcForInjection.map(n => n.id), ...residentMems.map(m => m.id)]);
    for (const r of relevantResults) excludeIds.add(r.memory.id);
    const merged = mergeExpandedRelevantResults(memories, userMessage, relevantResults, excludeIds, 12, settings.maxResults, queryEmbedding);

    if (!npcForInjection.length && !itemsForInjection.length &&
        !tlForInjection.ongoing.length && !tlForInjection.ended.length && !merged.length) {
        clearInjection(); return chat;
    }

    // 8. 记录命中
    const hitRecords = [];
    for (const n of npcForInjection) hitRecords.push({ collection: 'npc', id: n.id });
    for (const i of itemsForInjection) hitRecords.push({ collection: 'item', id: i.id });
    for (const r of merged) hitRecords.push({ collection: 'mem', id: r.memory.id });
    recordHits(chatId, hitRecords).catch(() => {});

    // 9. 构建注入文本
    const { text, tokenEstimate, stats } = buildMemoryInjectionPrompt({
        npcProfiles: npcForInjection,
        items: itemsForInjection,
        timeline: tlForInjection,
        relevantResults: merged,
        settings,
    });

    // 10. 注入
    const injectionText = (settings.injectionTemplate || '[BB-Memory 长期记忆]\n{{memories}}')
        .replace('{{memories}}', text);
    ctx.setExtensionPrompt(INJECTION_KEY, injectionText, POSITION_IN_CHAT, 4, ROLE_SYSTEM);

    if (settings.debugLogging) {
        console.log(`[BB-Memory] 注入: NPC${stats.npcCount} 物品${stats.itemCount} 时间线${stats.timelineCount} 记忆${stats.memoryCount} | ~${tokenEstimate} tokens`);
    }

    // 11. 存储命中追踪
    lastRetrievalResult = {
        chatId, timestamp: Date.now(),
        hits: merged.map(r => ({ id: r.memory.id, title: r.memory.title, type: r.memory.type, score: r.score, level: r.level })),
        stats,
    };
    // 同步侧边栏命中列表
    setTimeout(() => updateSidebarHitList(), 50);

    // 12. Active 模式：显示审核面板
    if (settings.extractionConfirmMode === 'active' && settings.activeConfirmStyle === 'popup') {
        const pending = getPendingAutoCandidates();
        if (pending.length) {
            showFloatingReviewPanel(chatId, pending);
            clearPendingAutoCandidates();
        }
    }

    // 13. v4.4.3: 上下文隐藏 —— 清空已提取消息的 mes
    const hiddenBackups = [];
    for (const msg of chat) {
        if (msg._bbmem_extracted) {
            hiddenBackups.push({ msg, mes: msg.mes });
            msg.mes = '';
        }
    }
    if (hiddenBackups.length) {
        setTimeout(() => {
            for (const { msg, mes } of hiddenBackups) msg.mes = mes;
        }, 100);
    }

    return chat;
};

function clearInjection() {
    try {
        SillyTavern.getContext().setExtensionPrompt(INJECTION_KEY, '', POSITION_IN_CHAT, 0, ROLE_SYSTEM);
    } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════
//  悬浮审核面板（Active 模式）
// ═══════════════════════════════════════════════════════════

function showFloatingReviewPanel(chatId, candidates) {
    if (!candidates.length) return;
    // 简化实现：使用 ST 的确认弹窗
    const ctx = SillyTavern.getContext();
    const lines = candidates.slice(0, 5).map((c, i) =>
        `${i + 1}. [${c.type || 'event'}] ${c.title || c.summary?.slice(0, 40) || '(无标题)'}`
    ).join('\n');
    if (typeof ctx.callPopup === 'function') {
        ctx.callPopup(`[BB-Memory] 提取到 ${candidates.length} 条候选记忆：\n${lines}\n是否保存？`, 'confirm')
            .then(result => {
                if (result) saveExtractedMemories(chatId, candidates.map(c => ({ ...c, _selected: true })));
            });
    }
}

// ═══════════════════════════════════════════════════════════
//  UI 辅助
// ═══════════════════════════════════════════════════════════

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
}

function getExtensionFolder() {
    // 从 import.meta.url 解析扩展目录路径，不依赖 ST 核心模块的静态导入
    try {
        const url = String(import.meta.url);
        let m = url.match(/\/scripts\/extensions\/(.+?)\/index\.mjs(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/index\.js(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/[^/]+\.(?:js|mjs)(?:\?|[#]|$)/i);
        if (m?.[1]) return m[1];
    } catch { /* 忽略 */ }
    // 最终回退：假定为标准 third-party 安装路径
    return 'third-party/BB-Memory';
}

// ═══════════════════════════════════════════════════════════
//  世界书导入（v5 适配）
// ═══════════════════════════════════════════════════════════

async function handleWorldBookImport(chatId, jsonString) {
    const { importWorldBook } = await import('./world-book-importer.js');
    return importWorldBook(chatId, jsonString);
}

async function handleWorldBookImportWithAI(chatId, jsonString) {
    const { importWorldBookWithAI } = await import('./world-book-importer.js');
    return importWorldBookWithAI(chatId, jsonString);
}

// ═══════════════════════════════════════════════════════════
//  初始化记忆（新功能）
// ═══════════════════════════════════════════════════════════

async function handleInitMemory(chatId) {
    const ctx = SillyTavern.getContext();

    // 收集上下文
    let contextText = '';

    // 角色卡信息
    try {
        if (ctx.characters && ctx.characterId !== undefined) {
            const char = ctx.characters[ctx.characterId];
            if (char) {
                contextText += `【角色卡】\n角色名：${char.name || ''}\n`;
                if (char.description) contextText += `描述：${char.description}\n`;
                if (char.personality) contextText += `性格：${char.personality}\n`;
                if (char.first_mes) contextText += `开场白：${char.first_mes}\n`;
                contextText += '\n';
            }
        }
    } catch { /* ignore */ }

    // 世界书
    try {
        if (ctx.worldInfo && ctx.worldInfo.entries) {
            const entries = Object.values(ctx.worldInfo.entries);
            contextText += `【世界书】\n${entries.map(e => `${e.key?.join(',') || ''}: ${e.content}`).join('\n')}\n\n`;
        }
    } catch { /* ignore */ }

    // 聊天记录
    try {
        const chat = ctx.chat || [];
        const recent = chat.filter(m => m.mes?.trim()).slice(-8);
        if (recent.length) {
            contextText += `【最近对话】\n${recent.map(m => `${m.is_user ? '用户' : m.name || '角色'}: ${m.mes}`).join('\n')}`;
        }
    } catch { /* ignore */ }

    if (!contextText.trim()) {
        throw new Error('没有可用的上下文（角色卡、世界书、对话记录均为空）');
    }

    // 使用分阶段提取
    const progressEl = createProgressToast('初始化记忆: 准备中...');

    const updateProgress = (info) => {
        if (progressEl) progressEl.textContent = `初始化记忆: ${info.progress || ''}`;
    };

    const results = await extractFromContext(chatId, contextText, { onProgress: updateProgress });

    if (progressEl) {
        progressEl.textContent = `初始化完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`;
        setTimeout(() => progressEl.remove(), 3000);
    }

    showToast(`初始化完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`, 'success');
    return results;
}

function createProgressToast(text) {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.info === 'function') {
            const el = document.createElement('div');
            el.textContent = text;
            ctx.toastr.info(el, '', { timeOut: 0, extendedTimeOut: 0 });
            return el;
        }
    } catch { /* ignore */ }
    return null;
}

function showToast(msg, type = 'info') {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.[type] === 'function') {
            ctx.toastr[type](msg, '', { timeOut: 3000 });
        }
    } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════
//  设置面板绑定
// ═══════════════════════════════════════════════════════════

function pickExtensionsSettingsContainer() {
    return document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings')
        || document.querySelector('#extensionsPane #extensions_settings2')
        || document.querySelector('#extensionsPane #extensions_settings');
}

async function mountExtensionSettingsHtml(html, maxAttempts = 50, delayMs = 100) {
    for (let i = 0; i < maxAttempts; i++) {
        const container = pickExtensionsSettingsContainer();
        if (container) {
            container.insertAdjacentHTML('beforeend', html);
            return true;
        }
        await new Promise(r => setTimeout(r, delayMs));
    }
    console.error('[BB-Memory] 未找到扩展设置容器 (#extensions_settings / #extensions_settings2)，无法在酒馆界面显示设置');
    return false;
}

function restoreApiSettings(settings) {
    const fields = {
        '#bb_auto_gen_endpoint': 'autoGenEndpoint',
        '#bb_auto_gen_api_key': 'autoGenApiKey',
        '#bb_auto_gen_model': 'autoGenModel',
        '#bb_embedding_endpoint': 'embeddingEndpoint',
        '#bb_embedding_api_key': 'embeddingApiKey',
        '#bb_embedding_model': 'embeddingModel',
    };
    for (const [sel, key] of Object.entries(fields)) {
        const el = document.querySelector(sel);
        if (el) el.value = settings[key] || '';
    }
}

function bindSidebarEvents() {
    const settings = getSettings();

    // 基础开关
    bindCheckbox('#bb_memory_enabled', 'enabled');
    bindCheckbox('#bb_auto_gen_enabled', 'autoGenEnabled');
    bindCheckbox('#bb_embedding_enabled', 'embeddingEnabled');
    bindCheckbox('#bb_dedup_enabled', 'dedupEnabled');
    bindCheckbox('#bb_cluster_enabled', 'clusterEnabled');
    bindCheckbox('#bb_debug_logging', 'debugLogging');
    bindCheckbox('#bb_timeline_summary_enabled', 'timelineSummaryEnabled');
    bindCheckbox('#bb_auto_backup_enabled', 'autoBackupEnabled');

    // 选择器
    bindSelect('#bb_auto_gen_mode', 'autoGenMode');
    bindSelect('#bb_extraction_confirm_mode', 'extractionConfirmMode');
    bindSelect('#bb_active_confirm_style', 'activeConfirmStyle');

    bindSelect('#bb_extraction_mode', 'extractionMode');

    // 数字/文本输入
    bindInput('#bb_context_window', 'contextWindowExchanges', 'number');
    bindInput('#bb_token_budget', 'tokenBudget', 'number');
    bindInput('#bb_max_results', 'maxResults', 'number');
    bindInput('#bb_maintenance_mem_threshold', 'maintenanceMemThreshold', 'number');
    bindInput('#bb_maintenance_npc_threshold', 'maintenanceNpcThreshold', 'number');
    bindInput('#bb_maintenance_item_threshold', 'maintenanceItemThreshold', 'number');
    bindInput('#bb_diversity_limit', 'diversityLimitPerTag', 'number');
    bindInput('#bb_injection_template', 'injectionTemplate', 'string');
    bindInput('#bb_calendar_description', 'calendarDescription', 'string');

    // 按钮
    document.querySelector('#bb_memory_backup_now')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const result = await exportMemoriesToChatMetadata(chatId);
        showToast(`备份完成：${result.count} 条`, 'success');
    });
    document.querySelector('#bb_memory_restore_now')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const result = await importMemoriesFromChatMetadata(chatId);
        showToast(`恢复：${result.restored} 条新增，${result.skipped} 条跳过`, 'success');
    });
    document.querySelector('#bb_init_memory_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        try {
            const results = await handleInitMemory(chatId);
            showToast(`初始化完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`, 'success');
        } catch (e) {
            showToast(`初始化失败: ${e.message}`, 'error');
        }
    });

    // v5.5: 记忆管家 → 完整管理器
    document.querySelector('#bb_memory_manage_btn')?.addEventListener('click', () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        openMemoryManager(chatId);
    });

    // v5.5: 记忆维护
    document.querySelector('#bb_memory_extract_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        showToast('正在收集上下文并提取记忆...', 'info');
        try {
            const results = await handleInitMemory(chatId);
            showToast(`提取完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`, 'success');
        } catch (e) {
            showToast(`提取失败: ${e.message}`, 'error');
        }
    });

    // v5.3: 标记消息
    document.querySelector('#bb_memory_meta_btn')?.addEventListener('click', () => {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat || chat.length < 2) { showToast('聊天消息不足', 'warning'); return; }
        let aiIdx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && !chat[i].is_system) { aiIdx = i; break; }
        }
        if (aiIdx === -1) { showToast('未找到 AI 消息', 'warning'); return; }
        chat[aiIdx]._bbmem_meta_marker = !chat[aiIdx]._bbmem_meta_marker;
        try { ctx.saveChatDebounced(); } catch {}
        setTimeout(() => refreshExtractionMarkers(), 100);
        const label = chat[aiIdx]._bbmem_meta_marker ? '已标记为元指令（不提取）' : '已标记为可提取';
        showToast(label, 'info');
    });

    // v5.9.5: 楼层可见（三态切换：隐藏 → 半透明 → 完全可见）
    document.querySelector('#bb_memory_toggle_vis_btn')?.addEventListener('click', () => {
        cycleExtractedVisibility();
    });

    // v5.5: 记忆维护按钮
    document.querySelector('#bb_memory_maintenance_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        try {
            const result = await checkMaintenanceNeeded(chatId);
            showMaintenancePopup(chatId, result);
        } catch (e) {
            console.warn('[BB-Memory] 维护检查异常:', e.message);
            showToast('维护检查出错: ' + e.message, 'error');
            // 仍然打开面板（空数据模式）
            showMaintenancePopup(chatId, { issues: [], issueCount: 0, totalItems: 0, needed: false });
        }
    });
    // 世界书导入
    document.querySelector('#bb_memory_import_wb_btn')?.addEventListener('click', () => {
        pickFile('.json', async (text) => {
            const chatId = getChatId();
            if (!chatId) return;
            const count = await handleWorldBookImport(chatId, text);
            showToast(`直接导入：${count} 条`, 'success');
        });
    });
    document.querySelector('#bb_memory_import_wb_ai_btn')?.addEventListener('click', () => {
        pickFile('.json', async (text) => {
            const chatId = getChatId();
            if (!chatId) return;
            const progressEl = createProgressToast('世界书AI导入: 正在解析...');
            try {
                // 包装导入函数，注入进度回调
                const count = await handleWorldBookImportWithAI(chatId, text, (msg) => {
                    if (progressEl) progressEl.textContent = `世界书AI导入: ${msg}`;
                });
                if (progressEl) {
                    progressEl.textContent = `世界书AI导入完成！共 ${count} 条`;
                    setTimeout(() => progressEl.remove(), 3000);
                }
                showToast(`AI 导入：${count} 条`, 'success');
            } catch (e) {
                if (progressEl) progressEl.remove();
                showToast(`AI 导入失败: ${e.message}`, 'error');
            }
        });
    });

    document.querySelector('#bb_embedding_reindex_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const memories = await getMemories(chatId);
        await embedExistingMemories(memories, (done, total) => {
            if (done % 10 === 0) console.log(`[BB-Memory] Reindex: ${done}/${total}`);
        });
        showToast(`Reindex 完成：${memories.length} 条`, 'success');
    });

}

// ═══ 折叠设置面板 ═══

function initCollapsibleSettings() {
    document.querySelectorAll('.bb-settings-section-header').forEach(header => {
        header.addEventListener('click', () => {
            const body = header.nextElementSibling;
            const chevron = header.querySelector('.bb-settings-chevron i');
            const isCollapsed = body.style.display === 'none';

            body.style.display = isCollapsed ? '' : 'none';
            if (chevron) {
                if (isCollapsed) {
                    chevron.classList.remove('fa-chevron-right');
                    chevron.classList.add('fa-chevron-down');
                } else {
                    chevron.classList.remove('fa-chevron-down');
                    chevron.classList.add('fa-chevron-right');
                }
            }

            const sectionKey = header.dataset.section;
            const s = getSettings();
            if (!s._collapsedSections) s._collapsedSections = {};
            s._collapsedSections[sectionKey] = !isCollapsed;
            updateSettings({ _collapsedSections: s._collapsedSections });
        });
    });

    // 恢复折叠状态
    const s = getSettings();
    const collapsed = s._collapsedSections || {};
    document.querySelectorAll('.bb-settings-section-header').forEach(header => {
        const key = header.dataset.section;
        if (collapsed[key]) {
            const body = header.nextElementSibling;
            if (body) body.style.display = 'none';
            const chevron = header.querySelector('.bb-settings-chevron i');
            if (chevron) {
                chevron.classList.remove('fa-chevron-down');
                chevron.classList.add('fa-chevron-right');
            }
        }
    });
}

function bindCheckbox(selector, settingKey) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.checked = getSettings()[settingKey];
    el.addEventListener('change', () => updateSettings({ [settingKey]: el.checked }));
}

function bindSelect(selector, settingKey) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.value = getSettings()[settingKey] || '';
    el.addEventListener('change', () => updateSettings({ [settingKey]: el.value }));
}

function bindInput(selector, settingKey, type) {
    const el = document.querySelector(selector);
    if (!el) return;
    const val = getSettings()[settingKey];
    el.value = val ?? '';
    el.addEventListener('change', () => {
        const v = type === 'number' ? Number(el.value) : el.value;
        updateSettings({ [settingKey]: v });
    });
}

function pickFile(accept, callback) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => callback(reader.result);
        reader.readAsText(file);
        input.remove();
    });
    document.body.appendChild(input);
    input.click();
}

function getChatId() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx.chatId || (ctx.chat?.[0]?.chatId) || null;
    } catch { return null; }
}

// ═══ 反馈包装器 ═══

function withFeedback(btn, fn, { loadingText, successText, errorText } = {}) {
    if (btn.disabled) return Promise.resolve();
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${loadingText || '处理中...'}`;
    const restore = () => { btn.disabled = false; btn.innerHTML = origHTML; };
    return fn()
        .then(r => { if (successText) showToast(successText, 'success'); restore(); return r; })
        .catch(e => { if (errorText) showToast(`${errorText}: ${e.message}`, 'error'); else showToast(e.message, 'error'); restore(); throw e; });
}

// ═══ 记忆维护面板 ═══

function showMaintenancePopup(chatId, result) {
    const existing = document.querySelector('.bb-maint-overlay');
    if (existing) existing.remove();

    const issues = result?.issues || [];
    const issueCount = result?.issueCount ?? issues.length;
    const totalItems = result?.totalItems ?? 0;
    const overlay = document.createElement('div');
    overlay.className = 'bb-maint-overlay';

    const panel = document.createElement('div');
    panel.className = 'bb-maint-panel';
    panel.style.cssText = 'display:flex;flex-direction:column;max-height:80vh;';

    // Header
    const header = document.createElement('div');
    header.className = 'bb-maint-header';
    header.style.cssText = 'display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;';
    header.innerHTML = `
        <i class="fa-solid fa-toolbox"></i>
        <div style="display:flex;flex-direction:column;flex:1;">
            <div style="display:flex;align-items:center;gap:8px;">
                <strong>记忆维护</strong>
                <span class="bb-maint-cat-count" style="font-size:0.85em;">${issueCount}条待处理</span>
            </div>
            <p style="margin:4px 0 0;font-size:0.85em;opacity:0.7;">共 ${totalItems} 条条目</p>
        </div>
        <button class="bb-maint-close-btn" style="background:none;border:none;color:inherit;font-size:24px;cursor:pointer;opacity:0.6;line-height:1;padding:0 4px;">&times;</button>
    `;
    panel.appendChild(header);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;';
    const pendingBtn = document.createElement('button');
    pendingBtn.textContent = `待维护 (${issueCount})`;
    pendingBtn.style.cssText = 'flex:1;padding:10px;border:none;background:var(--SmartThemeBlurTintColor,#2a2a3e);color:inherit;cursor:pointer;font-size:0.9em;font-weight:600;border-bottom:2px solid #fab387;';
    const resolvedBtn = document.createElement('button');
    resolvedBtn.textContent = '已维护';
    resolvedBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
    tabBar.appendChild(pendingBtn);
    tabBar.appendChild(resolvedBtn);
    panel.appendChild(tabBar);

    // Body
    const body = document.createElement('div');
    body.className = 'bb-maint-body';
    body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 20px;min-height:0;';
    panel.appendChild(body);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const close = () => { document.removeEventListener('keydown', onKeyDown); overlay.remove(); };
    header.querySelector('.bb-maint-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const onKeyDown = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKeyDown);

    const issueTypeDefs = {
        idle_transient_memory: { icon: 'fa-regular fa-clock', label: '瞬时记忆（长期未命中）' },
        status_changed_item:   { icon: 'fa-solid fa-box',     label: '状态变更的物品' },
        compressible_timeline: { icon: 'fa-solid fa-compress', label: '可压缩的时间线' },
        low_tier_npc:          { icon: 'fa-solid fa-user',     label: '低优先级NPC' },
        foreshadow:            { icon: 'fa-solid fa-eye',      label: '待确认伏笔' },
    };

    function refreshBadges() {
        const total = body.querySelectorAll('.bb-maint-issue-item').length;
        const badgeEl = header.querySelector('.bb-maint-cat-count');
        if (badgeEl) badgeEl.textContent = total + '条待处理';
        pendingBtn.textContent = `待维护 (${total})`;
        // 移除空的分类
        body.querySelectorAll('.bb-maint-category').forEach(cat => {
            if (!cat.querySelector('.bb-maint-issue-item')) cat.remove();
        });
        if (total === 0) {
            body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">所有待维护项已处理</div>';
        }
    }

    function renderPending() {
        pendingBtn.style.cssText = 'flex:1;padding:10px;border:none;background:var(--SmartThemeBlurTintColor,#2a2a3e);color:inherit;cursor:pointer;font-size:13px;font-weight:600;border-bottom:2px solid #fab387;';
        resolvedBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:13px;opacity:0.6;border-bottom:2px solid transparent;';
        body.innerHTML = '';

        const grouped = {};
        for (const iss of issues) {
            if (!grouped[iss.type]) grouped[iss.type] = [];
            grouped[iss.type].push(iss);
        }

        if (issues.length === 0) {
            body.innerHTML = `<div style="text-align:center;padding:40px;opacity:0.6;">
                <i class="fa-solid fa-circle-check" style="font-size:2em;color:#4caf50;display:block;margin-bottom:12px;"></i>
                记忆状态良好，没有待维护项
            </div>`;
            return;
        }

        // Legend
        const legend = document.createElement('div');
        legend.className = 'bb-maint-legend';
        legend.style.cssText = 'padding:0 0 12px;border:none;display:flex;gap:14px;flex-wrap:wrap;font-size:0.8em;opacity:0.7;';
        legend.innerHTML = [
            ['#4caf50','保留'],['#2196f3','升级'],['#ff9800','降级'],['#f44336','删除'],['#9c27b0','压缩']
        ].map(([c,l]) => `<span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:${c};display:inline-block;"></span>${l}</span>`).join('');
        body.appendChild(legend);

        for (const [type, typeIssues] of Object.entries(grouped)) {
            const meta = issueTypeDefs[type] || { icon: 'fa-solid fa-circle', label: type };
            const cat = document.createElement('div');
            cat.className = 'bb-maint-category';

            const catHeader = document.createElement('div');
            catHeader.className = 'bb-maint-cat-header';
            catHeader.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 0;cursor:pointer;';
            catHeader.innerHTML = `<i class="${meta.icon}"></i><span style="flex:1;font-size:0.9em;font-weight:500;">${meta.label}</span><span class="bb-maint-cat-count">${typeIssues.length}条</span><i class="fa-solid fa-chevron-down" style="font-size:0.75em;opacity:0.5;"></i>`;

            const itemList = document.createElement('div');
            itemList.className = 'bb-maint-cat-items';

            for (const iss of typeIssues) {
                const item = iss.item;
                const label = item.name || item.title || item.event || item.id;
                const itemDiv = document.createElement('div');
                itemDiv.className = 'bb-maint-issue-item';
                itemDiv.dataset.collection = iss.collection;
                itemDiv.dataset.id = item.id;
                itemDiv.style.cssText = 'display:flex;align-items:center;padding:6px 0;gap:8px;border-bottom:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,0.05));';

                const infoDiv = document.createElement('div');
                infoDiv.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;gap:2px;';
                infoDiv.innerHTML = `<span class="bb-maint-issue-title" style="font-size:0.85em;">${escapeHtml(label)}</span><span class="bb-maint-issue-reason" style="font-size:0.75em;opacity:0.5;">${escapeHtml(iss.reason || '')}</span>`;

                const actionDiv = document.createElement('div');
                actionDiv.style.cssText = 'display:flex;gap:3px;flex-shrink:0;';

                const addBtn = (op, color, text) => {
                    const btn = document.createElement('button');
                    btn.style.cssText = `padding:2px 6px;border:1px solid ${color};background:transparent;color:${color};border-radius:4px;cursor:pointer;font-size:0.75em;`;
                    btn.textContent = text;
                    btn.addEventListener('mouseenter', () => { btn.style.background = color + '22'; });
                    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        withFeedback(btn, async () => {
                            await performMaintenance(chatId, [{ collection: iss.collection, id: item.id, op }]);
                            itemDiv.remove();
                            // 同步移除 result.issues 中的对应项
                            const idx = result.issues.findIndex(i => i.item.id === item.id && i.collection === iss.collection);
                            if (idx >= 0) result.issues.splice(idx, 1);
                            refreshBadges();
                        }, { successText: `${text}: ${label}` });
                    });
                    actionDiv.appendChild(btn);
                };
                addBtn('keep', '#4caf50', '保留');
                addBtn('promote', '#2196f3', '升级');
                addBtn('demote', '#ff9800', '降级');
                addBtn('delete', '#f44336', '删除');
                if (type === 'compressible_timeline') {
                    addBtn('compress_timeline', '#9c27b0', '压缩');
                }

                itemDiv.appendChild(infoDiv);
                itemDiv.appendChild(actionDiv);
                itemList.appendChild(itemDiv);
            }

            catHeader.addEventListener('click', () => {
                const hidden = itemList.style.display === 'none';
                itemList.style.display = hidden ? '' : 'none';
                const chevron = catHeader.querySelector('.fa-chevron-down');
                if (chevron) chevron.style.transform = hidden ? '' : 'rotate(-90deg)';
            });

            cat.appendChild(catHeader);
            cat.appendChild(itemList);
            body.appendChild(cat);
        }

        // Bottom actions
        const bottomBar = document.createElement('div');
        bottomBar.style.cssText = 'display:flex;gap:8px;padding:12px 0 0;flex-wrap:wrap;border-top:1px solid var(--SmartThemeBorderColor,#45475a);margin-top:8px;';
        const keepAllBtn = document.createElement('button');
        keepAllBtn.className = 'bb-maint-btn-auto menu_button';
        keepAllBtn.textContent = '全部保留';
        keepAllBtn.addEventListener('click', () => {
            withFeedback(keepAllBtn, async () => {
                const items = body.querySelectorAll('.bb-maint-issue-item');
                const actions = [...items].map(el => ({ collection: el.dataset.collection, id: el.dataset.id, op: 'keep' }));
                const res = await performMaintenance(chatId, actions);
                body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">所有待维护项已保留</div>';
                // 同步更新 result.issues
                const actionIds = new Set(actions.map(a => a.id));
                result.issues = result.issues.filter(i => !actionIds.has(i.item.id));
                refreshBadges();
            }, { loadingText: '正在全部保留...', successText: '已全部保留' });
        });
        const laterBtn = document.createElement('button');
        laterBtn.className = 'bb-maint-btn-later menu_button';
        laterBtn.textContent = '稍后提醒(24h)';
        laterBtn.addEventListener('click', () => { dismissMaintenanceRemind(); close(); showToast('24小时内不再提醒', 'info'); });
        bottomBar.appendChild(keepAllBtn);
        bottomBar.appendChild(laterBtn);
        body.appendChild(bottomBar);
    }

    function renderResolved() {
        resolvedBtn.style.cssText = 'flex:1;padding:10px;border:none;background:var(--SmartThemeBlurTintColor,#2a2a3e);color:inherit;cursor:pointer;font-size:0.9em;font-weight:600;border-bottom:2px solid #fab387;';
        pendingBtn.style.cssText = 'flex:1;padding:10px;border:none;background:transparent;color:inherit;cursor:pointer;font-size:0.9em;opacity:0.6;border-bottom:2px solid transparent;';
        body.innerHTML = '';

        const resolved = getMaintenanceResolved(chatId);
        if (!resolved.length) {
            body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">暂无已维护记录</div>';
            return;
        }
        for (let i = resolved.length - 1; i >= 0; i--) {
            const entry = resolved[i];
            const d = new Date(entry.resolvedAt);
            const timeStr = d.toLocaleString();
            // 展示详细操作内容
            const r = entry.results || {};
            const parts = [];
            if (r.kept) parts.push(`保留 ${r.kept} 条`);
            if (r.deleted) parts.push(`删除 ${r.deleted} 条`);
            if (r.promoted) parts.push(`升级 ${r.promoted} 条`);
            if (r.demoted) parts.push(`降级 ${r.demoted} 条`);
            if (r.compressed) parts.push(`压缩 ${r.compressed} 条`);
            const detail = parts.length ? parts.join(' · ') : `${entry.actions || 0} 条已处理`;

            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);font-size:0.85em;gap:8px;';
            row.innerHTML = `<span style="opacity:0.5;min-width:20px;">#${resolved.length - i}</span><span style="flex:1;">${escapeHtml(detail)}</span><span style="opacity:0.4;font-size:0.8em;white-space:nowrap;">${escapeHtml(timeStr)}</span>`;
            body.appendChild(row);
        }
        const clearBtn = document.createElement('button');
        clearBtn.className = 'menu_button'; clearBtn.textContent = '清空已维护'; clearBtn.style.cssText = 'margin-top:12px;';
        clearBtn.addEventListener('click', () => {
            withFeedback(clearBtn, async () => {
                clearMaintenanceResolved(chatId);
                body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.6;">已清空</div>';
            }, { successText: '已清空' });
        });
        body.appendChild(clearBtn);
    }

    pendingBtn.addEventListener('click', renderPending);
    resolvedBtn.addEventListener('click', renderResolved);
    renderPending();
}

// ═══════════════════════════════════════════════════════════
//  斜杠命令
// ═══════════════════════════════════════════════════════════

function registerSlashCommands() {
    const ctx = SillyTavern.getContext();
    const addCmd = (name, callback, helpText) => {
        try {
            if (typeof ctx.SlashCommandParser?.addCommandObject === 'function') {
                ctx.SlashCommandParser.addCommandObject({
                    name, callback,
                    aliases: [],
                    helpText: helpText || '',
                    returns: '',
                });
            } else if (typeof ctx.registerSlashCommand === 'function') {
                ctx.registerSlashCommand(name, callback, [], helpText);
            }
        } catch (e) {
            console.warn(`[BB-Memory] 注册命令 ${name} 失败:`, e.message);
        }
    };

    addCmd('bb-init', async (args) => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        try {
            const results = await handleInitMemory(chatId);
            showToast(`初始化：NPC${results.npc}/物品${results.items}/时间线${results.timeline}/记忆${results.memories}`, 'success');
        } catch (e) {
            showToast(`初始化失败: ${e.message}`, 'error');
        }
    }, '初始化 BB-Memory 记忆（从角色卡+世界书+对话）');

    addCmd('bb-backup', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const result = await exportMemoriesToChatMetadata(chatId);
        showToast(`备份完成：${result.count} 条 (${(result.size/1024).toFixed(1)}KB)`, 'success');
    }, '手动备份记忆到服务器');

    addCmd('bb-restore', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const result = await importMemoriesFromChatMetadata(chatId);
        showToast(`恢复：${result.restored} 新增，${result.skipped} 跳过`, 'success');
    }, '从服务器恢复记忆');

    addCmd('bb-stats', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const stats = await getMemoryStats(chatId);
        const msg = `BB-Memory 统计：\nNPC: ${stats.npc.total} | 物品: ${stats.items.total} | 时间线: ${stats.timeline.total} | 记忆: ${stats.memories.total}`;
        showToast(msg, 'info');
    }, '查看记忆统计');

    addCmd('bb-manage', () => {
        const chatId = getChatId();
        if (!chatId) return;
        openAssistant(chatId, 'dashboard');
    }, '打开记忆管家面板');

    addCmd('bb-maintenance', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        try {
            const result = await checkMaintenanceNeeded(chatId);
            showMaintenancePopup(chatId, result);
        } catch (e) {
            console.warn('[BB-Memory] 维护检查异常:', e.message);
            showToast('维护检查出错: ' + e.message, 'error');
            showMaintenancePopup(chatId, { issues: [], issueCount: 0, totalItems: 0, needed: false });
        }
    }, '打开记忆维护面板');

    addCmd('bb-clear', async () => {
        const chatId = getChatId();
        if (!chatId) return;
        const confirmed = await new Promise(resolve => {
            if (typeof ctx.callPopup === 'function') {
                ctx.callPopup('[BB-Memory] 确定要清空所有记忆数据吗？此操作不可恢复。', 'confirm').then(r => resolve(r));
            } else {
                resolve(confirm('确定要清空所有记忆数据吗？'));
            }
        });
        if (confirmed) {
            await clearAllData(chatId);
            showToast('所有记忆已清空', 'warning');
        }
    }, '清空当前聊天的所有记忆');

    addCmd('bb-delete-floor', async (args) => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const floor = parseInt(args, 10);
        if (isNaN(floor)) { showToast('用法: /bb-delete-floor <楼层号>', 'warning'); return; }
        // 查找该楼层 AI 消息的 exchange hash
        const ctx2 = SillyTavern.getContext();
        const chat = ctx2.chat || [];
        if (floor < 0 || floor >= chat.length) { showToast(`楼层 ${floor} 不存在`, 'warning'); return; }
        const msg = chat[floor];
        if (!msg || msg.is_user) { showToast(`第 ${floor} 层不是AI消息`, 'warning'); return; }
        // 查找前一条用户消息，计算 exchange hash
        let userMsg = '';
        for (let j = floor - 1; j >= 0; j--) {
            if (chat[j].is_user && chat[j].mes) { userMsg = chat[j].mes; break; }
        }
        const { computeExchangeHash } = await import('./message-state.js');
        const exchangeHash = computeExchangeHash(userMsg, msg.mes || '');
        const result = await deleteByExchange(chatId, exchangeHash);
        showToast(`已删除: NPC${result.npc}/物品${result.items}/时间线${result.timeline}/记忆${result.memories}`, 'success');
    }, '删除指定楼层的所有关联记忆');

    addCmd('bb-re-extract', async (args) => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const floor = parseInt(args, 10);
        if (isNaN(floor)) { showToast('用法: /bb-re-extract <楼层号>', 'warning'); return; }
        const ctx2 = SillyTavern.getContext();
        const chat = ctx2.chat || [];
        if (floor < 0 || floor >= chat.length) { showToast(`楼层 ${floor} 不存在`, 'warning'); return; }
        const aiMsg = chat[floor];
        if (!aiMsg || aiMsg.is_user) { showToast(`第 ${floor} 层不是AI消息`, 'warning'); return; }
        // 向前查找用户消息配对
        let userMsg = '';
        for (let j = floor - 1; j >= 0; j--) {
            if (chat[j].is_user && chat[j].mes) { userMsg = chat[j].mes; break; }
        }
        // 先删除旧记忆，再重新提取
        const { computeExchangeHash } = await import('./message-state.js');
        const exchangeHash = computeExchangeHash(userMsg, aiMsg.mes || '');
        await deleteByExchange(chatId, exchangeHash);
        // 清除提取标记以便重新提取
        aiMsg._bbmem_extracted = false;
        aiMsg._bbmem_pendingExtraction = true;
        try { ctx2.saveChatDebounced(); } catch {}
        // 触发提取
        showToast('正在重新提取...', 'info');
        const { onMessageReceived } = await import('./auto-generator.js');
        onMessageReceived(floor);
    }, '删除并重新提取指定楼层的记忆');

    addCmd('bb-floor-refresh', async () => {
        const chatId = getChatId();
        if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }
        const stats = await refreshAllSourceFloors(chatId);
        const total = stats.npc + stats.items + stats.timeline + stats.memories;
        if (total === 0) {
            showToast('当前没有需要刷新的楼层记忆（所有记忆已标记为旧聊天来源）', 'info');
        } else {
            showToast(`楼层刷新完成！已标记 ${total} 条记忆为旧聊天来源（NPC:${stats.npc} 物品:${stats.items} 时间线:${stats.timeline} 记忆:${stats.memories}）`, 'success');
        }
    }, '换楼刷新 — 将所有记忆的楼层标记为旧聊天来源（开新聊天后使用）');

    if (getSettings().debugLogging) {
        console.log('[BB-Memory] 斜杠命令已注册');
    }
}

// ═══════════════════════════════════════════════════════════
//  事件处理
// ═══════════════════════════════════════════════════════════

async function onChatChanged() {
    clearInjection();
    lastRetrievalResult = null;

    const chatId = getChatId();
    if (!chatId) return;

    const settings = getSettings();

    // 迁移检查
    if (!settings.migratedFromV4) {
        try { await migrateV4ToV5(chatId); } catch { /* ignore */ }
    }

    // 可见性同步
    setTimeout(() => {
        syncMessageVisibility().catch(() => {});
        refreshExtractionMarkers();
    }, 800);

    // 维护提醒（3秒后）
    setTimeout(async () => {
        try {
            const result = await checkMaintenanceNeeded(chatId);
            if (result.needed) {
                showToast(`记忆维护提醒：${result.issueCount} 条待处理。输入 /bb-maintenance 查看`, 'warning');
            }
        } catch { /* ignore */ }
    }, 3000);

    // 跨设备恢复（5秒后）
    if (settings.autoBackupEnabled) {
        setTimeout(async () => {
            try {
                const result = await importMemoriesFromChatMetadata(chatId);
                if (result.restored > 0 && settings.debugLogging) {
                    console.log(`[BB-Memory] 自动恢复: ${result.restored} 条`);
                }
            } catch { /* ignore */ }
        }, 5000);
    }
}

function onNewMessage() {
    if (!getSettings().autoGenEnabled) {
        syncMessageVisibility().catch(() => {});
    }
    setTimeout(() => refreshExtractionMarkers(), 300);
}

// ═══════════════════════════════════════════════════════════
//  悬浮球 (Floating Action Hub) —— v4.4.2 移植
// ═══════════════════════════════════════════════════════════

function renderHubHitItem(h, typeIcons, levelColors, dimmed) {
    const icon = typeIcons[h.cognitiveType] || 'fa-circle';
    const color = levelColors[h.level] || '#888';
    const scorePct = Math.round(h.score * 100);
    const shortTitle = (h.title || '').length > 14
        ? escapeHtml(h.title.slice(0, 14)) + '...'
        : escapeHtml(h.title);
    const opacityStyle = dimmed ? 'opacity:0.55;' : '';
    return `<div class="bb-hub-hit-item" title="${escapeHtml(h.title)}" style="${opacityStyle}">
        <i class="fa-solid ${icon}" style="color:${color};font-size:0.7em;"></i>
        <span class="bb-hub-hit-title">${shortTitle}</span>
        <span class="bb-hub-hit-level" style="color:${color}">${h.level}</span>
        <span class="bb-hub-hit-score">${scorePct}%</span>
    </div>`;
}

async function renderHubHitList(listEl, chatId) {
    const result = lastRetrievalResult;
    const typeIcons = { fact: 'fa-lightbulb', episode: 'fa-film', emotion: 'fa-heart', habit: 'fa-repeat' };
    const levelColors = { L4: '#ce93d8', L3: '#4fc3f7', L2: '#ffb74d', L1: '#9e9e9e' };

    if (!result || !result.hits || !result.hits.length) {
        listEl.innerHTML = '<div class="bb-hub-hit-item" style="opacity:0.5;justify-content:center;">暂无命中记忆</div>';
        return;
    }

    let html = result.hits.map(h => renderHubHitItem(h, typeIcons, levelColors, false)).join('');

    // 追加概率最高但未命中的 5 条记忆
    try {
        const allMemories = await getMemories(chatId);
        const hitIds = new Set(result.hits.map(h => h.id));
        const nonHitMemories = allMemories.filter(m => !hitIds.has(m.id));
        nonHitMemories.sort((a, b) => (b.strength || 0) * (b.importance || 0) - (a.strength || 0) * (a.importance || 0));
        const top5 = nonHitMemories.slice(0, 5);
        if (top5.length > 0) {
            html += '<div class="bb-hub-hit-item" style="opacity:0.4;justify-content:center;font-size:0.7em;border-top:1px solid var(--SmartThemeBorderColor,#444);margin-top:2px;padding-top:4px;">— 未命中高分记忆 —</div>';
            html += top5.map(m => renderHubHitItem({
                id: m.id,
                title: m.title || (m.content || '').slice(0, 30),
                cognitiveType: m.cognitiveType || 'fact',
                score: (m.strength || 0) * (m.importance || 0),
                level: m.resident ? 'L4' : 'L1',
            }, typeIcons, levelColors, true)).join('');
        }
    } catch (e) {
        // 获取全量记忆失败时忽略
    }

    listEl.innerHTML = html;
}

function injectFloatingHub() {
    if (document.getElementById('bb_floating_hub')) return;

    const hub = document.createElement('div');
    hub.id = 'bb_floating_hub';
    hub.className = 'bb-floating-hub';
    hub.innerHTML = '<i class="fa-solid fa-brain"></i><span class="bb-hub-badge" id="bb_hub_badge" style="display:none;">0</span>';

    // 菜单面板
    const menu = document.createElement('div');
    menu.id = 'bb_floating_menu';
    menu.className = 'bb-floating-menu';
    menu.style.display = 'none';
    menu.innerHTML = `
        <div class="bb-floating-menu-header">
            <i class="fa-solid fa-brain"></i> BB-Memory
        </div>
        <div class="bb-floating-menu-body">
            <div class="bb-floating-menu-item" id="bb_hub_slot_info">
                <i class="fa-solid fa-floppy-disk"></i>
                <span>存档: <strong>default</strong> · <strong>0</strong> 条</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" id="bb_hub_hit_info" data-action="toggle_hit_list">
                <i class="fa-solid fa-bullseye"></i>
                <span>命中: <strong id="bb_hub_hit_count">-</strong> 条</span>
                <i class="fa-solid fa-chevron-down" style="margin-left:auto;font-size:0.7em;opacity:0.5;"></i>
            </div>
            <div id="bb_hub_hit_list" style="display:none;"></div>
            <div class="bb-floating-menu-item" id="bb_hub_extract_progress" style="display:flex;">
                <i class="fa-solid fa-moon"></i>
                <span>空闲 <strong id="bb_hub_extract_pct"></strong></span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="toggle_visibility">
                <i class="fa-solid fa-eye-slash"></i>
                <span>切换楼层可见</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="meta_last">
                <i class="fa-solid fa-tag"></i>
                <span>标记最后消息</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="manual_extract">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <span>手动提取</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="floor_refresh">
                <i class="fa-solid fa-arrows-rotate"></i>
                <span>换楼刷新</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_maintenance">
                <i class="fa-solid fa-toolbox"></i>
                <span>记忆维护</span>
            </div>
            <div class="bb-floating-menu-item bb-floating-menu-action" data-action="open_manager">
                <i class="fa-solid fa-gear"></i>
                <span>记忆管理</span>
            </div>
        </div>
    `;

    hub.appendChild(menu);
    document.body.appendChild(hub);

    // 拖拽逻辑
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let hasMoved = false;

    hub.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        hasMoved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = hub.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        hub.style.transition = 'none';
        e.preventDefault();
    });

    hub.addEventListener('touchstart', (e) => {
        dragging = true;
        hasMoved = false;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        const rect = hub.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        hub.style.transition = 'none';
    }, { passive: false });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        let newLeft = startLeft + dx;
        let newTop = startTop + dy;
        newLeft = Math.max(0, Math.min(window.innerWidth - hub.offsetWidth, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, newTop));
        hub.style.left = newLeft + 'px';
        hub.style.top = newTop + 'px';
    });

    document.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        let newLeft = startLeft + dx;
        let newTop = startTop + dy;
        newLeft = Math.max(0, Math.min(window.innerWidth - hub.offsetWidth, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - hub.offsetHeight, newTop));
        hub.style.left = newLeft + 'px';
        hub.style.top = newTop + 'px';
    }, { passive: false });

    const endDrag = () => {
        dragging = false;
        hub.style.transition = '';
    };
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchend', endDrag);

    // 点击展开菜单
    hub.addEventListener('click', (e) => {
        if (hasMoved) { e.preventDefault(); e.stopPropagation(); return; }
        if (menu.contains(e.target)) return;
        toggleFloatingMenu();
    });

    // 菜单项点击
    menu.addEventListener('click', async (e) => {
        const actionItem = e.target.closest('.bb-floating-menu-action');
        if (!actionItem) return;
        const action = actionItem.dataset.action;
        await handleFloatingMenuAction(action);
        if (action !== 'toggle_hit_list' && action !== 'toggle_visibility') {
            menu.style.display = 'none';
        }
    });

    // 点击其他区域关闭菜单
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== hub && !hub.contains(e.target)) {
            menu.style.display = 'none';
        }
    });

    // 定期更新
    setInterval(() => refreshFloatingHubData(), 5000);
}

let floatingMenuVisible = false;
function toggleFloatingMenu() {
    const menu = document.getElementById('bb_floating_menu');
    const hub = document.getElementById('bb_floating_hub');
    if (!menu || !hub) return;
    floatingMenuVisible = !floatingMenuVisible;
    if (floatingMenuVisible) {
        const hubRect = hub.getBoundingClientRect();
        const menuWidth = 268;
        const menuMaxHeight = 320;
        const gap = 56;
        const edgeMargin = 16;

        if (hubRect.right + menuWidth > window.innerWidth - edgeMargin) {
            menu.style.left = 'auto';
            menu.style.right = '0';
        } else {
            menu.style.right = 'auto';
            menu.style.left = '0';
        }

        if (hubRect.top - menuMaxHeight - gap < edgeMargin) {
            menu.style.bottom = 'auto';
            menu.style.top = gap + 'px';
        } else {
            menu.style.top = 'auto';
            menu.style.bottom = gap + 'px';
        }

        menu.style.display = 'block';
        refreshFloatingHubData();
    } else {
        menu.style.display = 'none';
    }
}

async function refreshFloatingHubData() {
    const hitCountEl = document.getElementById('bb_hub_hit_count');
    const badge = document.getElementById('bb_hub_badge');
    if (hitCountEl || badge) {
        const chatId = getChatId();
        if (chatId) {
            try {
                const mems = await getMemories(chatId);
                const hits = mems.filter(m => (m.hitScore || m.lastHitScore || 0) > 0);
                const count = hits.length;
                if (hitCountEl) hitCountEl.textContent = String(count);
                if (badge) {
                    badge.textContent = count > 99 ? '99+' : String(count);
                    badge.style.display = count > 0 ? 'block' : 'none';
                }
            } catch { /* ignore */ }
        }
    }

    // 更新存档信息
    const slotInfo = document.getElementById('bb_hub_slot_info');
    if (slotInfo) {
        try {
            const chatId = getChatId();
            if (chatId) {
                const mems = await getMemories(chatId);
                const settings = getSettings();
                const slotName = settings.currentSlotName || 'default';
                slotInfo.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> <span>存档: <strong>${escapeHtml(slotName)}</strong> · <strong>${mems.length}</strong> 条</span>`;
            }
        } catch { /* ignore */ }
    }

    // 更新可见性按钮图标（三态）
    const toggleItem = document.querySelector('.bb-floating-menu-action[data-action="toggle_visibility"] i');
    if (toggleItem) {
        const mode = getSettings().extractedMsgDisplay || 'hidden';
        if (mode === 'visible') toggleItem.className = 'fa-solid fa-eye';
        else if (mode === 'transparent') toggleItem.className = 'fa-solid fa-eye';
        else toggleItem.className = 'fa-solid fa-eye-slash';
    }

    // 命中列表展开时同步刷新
    const hitList = document.getElementById('bb_hub_hit_list');
    if (hitList && hitList.style.display !== 'none') {
        const chatId = getChatId();
        if (chatId) renderHubHitList(hitList, chatId);
    }
}

function cycleExtractedVisibility() {
    const settings = getSettings();
    const current = settings.extractedMsgDisplay || 'hidden';
    const next = current === 'hidden' ? 'transparent' : current === 'transparent' ? 'visible' : 'hidden';

    // 更新设置
    updateSettings({ extractedMsgDisplay: next });

    // 更新 body class
    document.body.classList.remove('bb-show-extracted', 'bb-show-extracted-clear');
    if (next === 'transparent') document.body.classList.add('bb-show-extracted');
    else if (next === 'visible') document.body.classList.add('bb-show-extracted-clear');

    // 更新悬浮球图标
    const toggleItem = document.querySelector('.bb-floating-menu-action[data-action="toggle_visibility"] i');
    if (toggleItem) {
        toggleItem.className = next === 'hidden' ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    }

    const labels = { hidden: '楼层已隐藏', transparent: '楼层半透明显示（可区分）', visible: '楼层完全可见' };
    showToast(labels[next], 'info');
}

async function handleFloatingMenuAction(action) {
    const chatId = getChatId();
    switch (action) {
        case 'toggle_visibility': {
            cycleExtractedVisibility();
            return;  // 不关闭菜单
        }
        case 'meta_last': {
            const ctx = SillyTavern.getContext();
            const chat = ctx.chat;
            if (!chat || chat.length < 2) {
                showToast('聊天消息不足', 'warning');
                return;
            }
            let aiIdx = -1;
            for (let i = chat.length - 1; i >= 0; i--) {
                if (!chat[i].is_user && !chat[i].is_system) { aiIdx = i; break; }
            }
            if (aiIdx === -1) { showToast('未找到 AI 消息', 'warning'); return; }
            chat[aiIdx]._bbmem_meta_marker = !chat[aiIdx]._bbmem_meta_marker;
            try { ctx.saveChatDebounced(); } catch {}
            setTimeout(() => refreshExtractionMarkers(), 100);
            const label = chat[aiIdx]._bbmem_meta_marker ? '🤖 已标记为元指令（不提取）' : '🗃️ 已标记为可提取';
            showToast(label, 'info');
            break;
        }
        case 'manual_extract': {
            if (!chatId) return;
            showToast('正在提取记忆...', 'info');
            try {
                const results = await handleInitMemory(chatId);
                showToast(`提取完成！NPC ${results.npc} / 物品 ${results.items} / 时间线 ${results.timeline} / 记忆 ${results.memories}`, 'success');
                refreshSidebar();
            } catch (e) {
                showToast(`提取失败: ${e.message}`, 'error');
            }
            break;
        }
        case 'open_manager': {
            if (chatId) openMemoryManager(chatId);
            break;
        }
        case 'floor_refresh': {
            if (!chatId) return;
            const stats = await refreshAllSourceFloors(chatId);
            const total = stats.npc + stats.items + stats.timeline + stats.memories;
            if (total === 0) {
                showToast('当前没有需要刷新的楼层记忆', 'info');
            } else {
                showToast(`已标记 ${total} 条记忆为旧聊天来源`, 'success');
            }
            break;
        }
        case 'open_maintenance': {
            if (!chatId) return;
            try {
                const result = await checkMaintenanceNeeded(chatId);
                showMaintenancePopup(chatId, result);
            } catch (e) {
                console.warn('[BB-Memory] 维护检查异常:', e.message);
                showMaintenancePopup(chatId, { issues: [], issueCount: 0, totalItems: 0, needed: false });
            }
            break;
        }
        case 'toggle_hit_list': {
            const hitList = document.getElementById('bb_hub_hit_list');
            const hitRow = document.getElementById('bb_hub_hit_info');
            if (!hitList || !hitRow) return;
            const chevron = hitRow.querySelector('.fa-chevron-down, .fa-chevron-up');
            if (hitList.style.display === 'none') {
                renderHubHitList(hitList, chatId);
                hitList.style.display = '';
                if (chevron) {
                    chevron.className = 'fa-solid fa-chevron-up';
                    chevron.style.cssText = 'margin-left:auto;font-size:0.7em;opacity:0.5;';
                }
            } else {
                hitList.style.display = 'none';
                if (chevron) {
                    chevron.className = 'fa-solid fa-chevron-down';
                    chevron.style.cssText = 'margin-left:auto;font-size:0.7em;opacity:0.5;';
                }
            }
            return;
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  初始化
// ═══════════════════════════════════════════════════════════

async function init() {
    console.log('[BB-Memory] v6.1 初始化开始...');

    // 确保默认设置
    getSettings();

    // 挂载设置面板
    try {
        const folder = getExtensionFolder();
        const ctx = SillyTavern.getContext();
        if (typeof ctx.renderExtensionTemplateAsync === 'function') {
            const html = await ctx.renderExtensionTemplateAsync(folder, 'settings');
            await mountExtensionSettingsHtml(html);
            restoreApiSettings(getSettings());
            bindSidebarEvents();
            initCollapsibleSettings();
            settingsPanelMounted = true;
        }
    } catch (e) {
        console.warn('[BB-Memory] 设置面板挂载失败:', e.message);
    }

    // 初始化自动生成器
    if (getSettings().autoGenEnabled) {
        initAutoGenerator();
    }

    // 进度回调（同步悬浮球 + 侧边栏）
    setAutoExtractProgressCallback((info) => {
        if (getSettings().debugLogging) {
            console.log(`[BB-Memory] 提取进度: ${info.phase} ${info.current}/${info.total}`);
        }
        const isDone = info.current >= info.total && info.total > 0;

        // 同步悬浮球进度
        const hubRow = document.getElementById('bb_hub_extract_progress');
        if (hubRow) {
            const icon = hubRow.querySelector('i');
            const strong = hubRow.querySelector('strong');
            if (isDone) {
                if (icon) { icon.className = 'fa-solid fa-check-circle'; icon.style.color = '#4caf50'; }
                if (strong) strong.textContent = '完成';
            } else if (info.phase) {
                if (icon) { icon.className = 'fa-solid fa-spinner fa-spin'; icon.style.color = ''; }
                const pct = info.total > 0 ? Math.round((info.current / info.total) * 100) : 0;
                if (strong) strong.textContent = pct + '%';
            } else {
                if (icon) { icon.className = 'fa-solid fa-moon'; icon.style.color = ''; }
                if (strong) strong.textContent = '';
            }
        }

        // 同步侧边栏进度
        const sidebarRow = document.getElementById('bb_sidebar_extract_progress');
        if (sidebarRow) {
            const icon = sidebarRow.querySelector('i');
            const strong = sidebarRow.querySelector('strong');
            if (isDone) {
                if (icon) { icon.className = 'fa-solid fa-check-circle'; icon.style.color = '#4caf50'; }
                if (strong) strong.textContent = '完成';
            } else if (info.phase) {
                if (icon) { icon.className = 'fa-solid fa-spinner fa-spin'; icon.style.color = ''; }
                const pct = info.total > 0 ? Math.round((info.current / info.total) * 100) : 0;
                if (strong) strong.textContent = pct + '%';
            } else {
                if (icon) { icon.className = 'fa-solid fa-moon'; icon.style.color = ''; }
                if (strong) strong.textContent = '空闲';
            }
        }

        // 同步维护面板进度（如有打开）
        const maintOverlay = document.querySelector('.bb-maint-overlay');
        if (maintOverlay) {
            const progressEl = maintOverlay.querySelector('.bb-maint-progress');
            if (progressEl) {
                if (isDone) {
                    progressEl.style.display = 'none';
                } else if (info.phase) {
                    progressEl.style.display = 'block';
                    const pct = info.total > 0 ? Math.round((info.current / info.total) * 100) : 0;
                    progressEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 提取进度: ${info.phase} ${info.current}/${info.total} (${pct}%)`;
                } else {
                    progressEl.style.display = 'none';
                }
            }
        }
    });

    // 注册命令
    registerSlashCommands();

    // 事件订阅
    try {
        const ctx = SillyTavern.getContext();
        const ev = ctx.eventSource;
        const eventTypes = ctx.eventTypes || ctx.event_types || {};

        const chatChanged = eventTypes.CHAT_CHANGED;
        if (chatChanged && ev) ev.on(chatChanged, onChatChanged);

        const msgReceived = eventTypes.MESSAGE_RECEIVED;
        if (msgReceived && ev && !getSettings().autoGenEnabled) {
            ev.on(msgReceived, onNewMessage);
        }
    } catch (e) {
        console.warn('[BB-Memory] 事件订阅失败:', e.message);
    }

    // 刷新 UI
    refreshSidebar();

    // 注入可拖拽悬浮球
    injectFloatingHub();

    // v6.1: 监听消息删除，自动清理关联记忆
    initMessageDeletionWatch();

    console.log('[BB-Memory] v6.1 初始化完成');
}

// v6.1: MutationObserver 监听 .mes 删除事件 → 自动清理关联记忆
function initMessageDeletionWatch() {
    const setup = () => {
        const chatArea = document.querySelector('#chat');
        if (!chatArea) {
            setTimeout(setup, 2000);
            return;
        }
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.removedNodes) {
                    if (node.nodeType !== 1) continue;
                    // 检查被移除的元素或其子元素中是否有带 exchange hash 的 .mes
                    const mesEls = node.classList?.contains('mes') ? [node] : [];
                    if (mesEls.length === 0 && node.querySelectorAll) {
                        node.querySelectorAll('.mes[data-bb-exchange-hash]').forEach(el => mesEls.push(el));
                    }
                    for (const mesEl of mesEls) {
                        const hash = mesEl.getAttribute('data-bb-exchange-hash');
                        if (hash) {
                            handleMessageDeletedByExchange(hash);
                        }
                    }
                }
            }
        });
        observer.observe(chatArea, { childList: true, subtree: true });
    };
    setup();
}

async function handleMessageDeletedByExchange(exchangeHash) {
    const chatId = getChatId();
    if (!chatId || !exchangeHash) return;
    try {
        const removed = await deleteByExchange(chatId, exchangeHash);
        const total = removed.npc + removed.items + removed.timeline + removed.memories;
        if (total > 0) {
            console.log(`[BB-Memory] 自动清理已删除楼层的关联记忆: NPC${removed.npc}/物品${removed.items}/时间线${removed.timeline}/记忆${removed.memories}`);
            showToast(`已自动清理 ${total} 条关联记忆`, 'info');
        }
    } catch (e) {
        console.warn('[BB-Memory] 自动清理失败:', e.message);
    }
}

function refreshSidebar() {
    // 更新侧边栏记忆计数
    const updateCount = async () => {
        const chatId = getChatId();
        if (!chatId) return;
        try {
            const stats = await getMemoryStats(chatId);
            const total = stats.npc.total + stats.items.total + stats.timeline.total + stats.memories.total;
            const el = document.querySelector('#bb_memory_count');
            if (el) el.textContent = total;
        } catch { /* ignore */ }
    };
    updateCount();
    setInterval(updateCount, 30000); // 30秒刷新
}

function updateSidebarHitList() {
    const result = lastRetrievalResult;
    const listEl = document.getElementById('bb_sidebar_hit_list');
    const tsEl = document.getElementById('bb_hit_timestamp');
    if (!listEl) return;

    if (!result || !result.hits || !result.hits.length) {
        listEl.innerHTML = '<div style="opacity:0.4;text-align:center;font-size:0.8em;">暂无命中</div>';
        return;
    }

    if (tsEl) {
        const d = new Date(result.timestamp);
        tsEl.textContent = d.toLocaleTimeString();
    }

    const typeIcons = { fact: 'fa-lightbulb', episode: 'fa-film', emotion: 'fa-heart', habit: 'fa-repeat' };
    const levelColors = { L4: '#ce93d8', L3: '#4fc3f7', L2: '#ffb74d', L1: '#9e9e9e' };

    listEl.innerHTML = result.hits.map(h => {
        const icon = typeIcons[h.cognitiveType] || 'fa-circle';
        const color = levelColors[h.level] || '#888';
        const scorePct = Math.round(h.score * 100);
        const shortTitle = (h.title || '').length > 18
            ? escapeHtml(h.title.slice(0, 18)) + '...'
            : escapeHtml(h.title);
        return `<div class="bb-hub-hit-item" title="${escapeHtml(h.title)}" style="cursor:default;">
            <i class="fa-solid ${icon}" style="color:${color};font-size:0.7em;"></i>
            <span class="bb-hub-hit-title">${shortTitle}</span>
            <span class="bb-hub-hit-level" style="color:${color}">${h.level}</span>
            <span class="bb-hub-hit-score">${scorePct}%</span>
        </div>`;
    }).join('');
}

// ═══════════════════════════════════════════════════════════
//  全局 API（调试/控制台用）
// ═══════════════════════════════════════════════════════════

globalThis.bbMemoryExpandEntityKeyword = function (keyword, limit = 12) {
    // v5 兼容 API
    return expandMemoriesForEntityKeyword([], keyword, { limit });
};

globalThis.bbMemoryDebug = {
    getMemoryStats,
    getNpcProfiles,
    getItems,
    getTimeline,
    getMemories,
    lastRetrievalResult: () => lastRetrievalResult,
};

// ═══ 启动 ═══
try {
    const ctx = SillyTavern.getContext();
    const evType = ctx.eventTypes?.APP_READY || ctx.event_types?.APP_READY;
    if (evType && ctx.eventSource) {
        ctx.eventSource.once(evType, init);
    } else {
        // 降级：DOM ready 后初始化
        if (document.readyState === 'complete') init();
        else window.addEventListener('load', init);
    }
} catch (e) {
    console.error('[BB-Memory] 启动失败:', e);
    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);
}
