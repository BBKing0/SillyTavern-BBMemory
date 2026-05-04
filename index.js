/**
 * index.js —— BB-Memory 的"大脑"（主入口 & 总指挥）
 *
 * ═══════════════════════════════════════════════════════════
 *  代码小课堂
 * ═══════════════════════════════════════════════════════════
 *
 * 这个文件是什么？
 *   这是整个插件的"总指挥"。就像交响乐团的指挥家，
 *   它不亲自演奏每个乐器，但负责协调所有人一起工作。
 *
 * 它做了什么？
 *   1. 启动时初始化所有模块（记忆库、AI生成器、助手面板等）
 *   2. 在 AI 生成回复前，检索相关记忆并注入到 prompt
 *   3. 处理用户在界面上的操作（添加、管理记忆等）
 *   4. 注册 /memory 斜杠命令，让用户在聊天框直接操作
 *
 * 用了哪些编程概念？
 *   - import/export：模块化，不同文件各司其职
 *   - async/await：等待异步操作完成
 *   - 事件监听：响应"聊天切换""消息接收"等事件
 *   - generate_interceptor：SillyTavern 的钩子，在生成前介入
 *   - DOM操作：动态修改页面内容
 *
 * ═══════════════════════════════════════════════════════════
 */

import {
    MODULE_NAME,
    DEFAULT_SETTINGS,
    getSettings,
    updateSettings,
    getMemories,
    addMemory,
    removeMemory,
    updateMemory,
    updateFactContent,
    addHiddenNote,
    removeHiddenNote,
    clearMemories,
    exportMemories,
    importMemories,
    decayMemories,
    reinforceMemories,
    migrateFromSettings,
    getMemoryStats,
} from './memory-store.js';

import {
    searchMemories,
    simpleSearch,
    getRelevantMemories,
    getResidentMemories,
    buildMemoryInjectionPrompt,
    mergeExpandedRelevantResults,
} from './retriever.js';
import {
    MEMORY_TYPES,
    TRUTH_STATUS,
    HIDDEN_NOTE_TYPES,
    formatMemoriesForInjection,
    getTypeDefinition,
} from './memory-types.js';
import {
    NPC_TIERS,
    ITEM_TIERS,
    normalizeNpcTier,
    normalizeItemTier,
    expandMemoriesForEntityKeyword,
} from './entity-tiers.js';
import { initAutoGenerator, stopAutoGenerator } from './auto-generator.js';
import { syncMessageVisibility } from './message-state.js';
import {
    MEMORY_STATUS,
    checkMaintenanceNeeded,
    dismissMaintenanceRemind,
    autoMaintain,
    fuzzyMemory,
    archiveMemory,
    restoreMemory,
    buildMaintenanceHTML,
} from './memory-maintainer.js';

import { findExtension } from '../../../extensions.js';
import { registerSlashCommand } from '../../../slash-commands.js';

// ═══════════════════════════════════════════════════════════
//  常量
// ═══════════════════════════════════════════════════════════

const DISPLAY_NAME = 'BB-Memory';
const INJECTION_KEY = 'bb_memory_injection';

const POSITION_IN_CHAT = 1;
const ROLE_SYSTEM = 0;

// ═══════════════════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * SillyTavern 内部扩展目录键（传给 renderExtensionTemplateAsync 的第一个参数）。
 * 必须与磁盘上的扩展路径一致（通常为 third-party/<文件夹名>），参见官方文档：
 * https://docs.sillytavern.app/for-contributors/writing-extensions
 */
function getExtensionFolder() {
    try {
        const hit = findExtension('BB-Memory');
        if (hit?.name) return hit.name;
    } catch (e) {
        console.warn(`[${DISPLAY_NAME}] findExtension 失败，将尝试从脚本 URL 解析`, e);
    }
    try {
        const url = String(import.meta.url);
        let m = url.match(/\/scripts\/extensions\/(.+?)\/index\.mjs(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/index\.js(?:\?|[#]|$)/i);
        if (!m) m = url.match(/\/scripts\/extensions\/(.+?)\/[^/]+\.(?:js|mjs)(?:\?|[#]|$)/i);
        if (m?.[1]) return m[1];
    } catch { /* 忽略 */ }
    return 'third-party/BB-Memory';
}

/** 扩展设置面板容器有时延迟插入 DOM，需短暂重试（与官方示例挂载时机差异兼容）。 */
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
    console.error(`[${DISPLAY_NAME}] 未找到扩展设置容器 (#extensions_settings / #extensions_settings2)，无法在酒馆界面显示设置`);
    return false;
}

/** 新版斜杠命令解析器可能传入字符串或片段数组，统一成单行文本。 */
function normalizeSlashUnnamed(unnamedArgs) {
    if (unnamedArgs == null) return '';
    if (typeof unnamedArgs === 'string') return unnamedArgs.trim();
    if (Array.isArray(unnamedArgs)) {
        return unnamedArgs.map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object' && 'value' in part) return String(part.value);
            return String(part);
        }).join(' ').trim();
    }
    return String(unnamedArgs).trim();
}

function isPopupAffirmative(ctx, result) {
    const affirmative = ctx.POPUP_RESULT?.AFFIRMATIVE ?? 1;
    return result === affirmative;
}

function getChatId() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.chatId) return String(ctx.chatId);
        if (ctx.characters && ctx.characterId !== undefined) {
            const char = ctx.characters[ctx.characterId];
            if (char?.chat) return String(char.chat);
        }
    } catch { /* 忽略 */ }
    return null;
}

function getLastUserMessage(chat) {
    if (!chat || !chat.length) return '';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && chat[i].mes) {
            return chat[i].mes;
        }
    }
    return '';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════
//  生成拦截器（核心功能）
// ═══════════════════════════════════════════════════════════

globalThis.bbMemoryInterceptor = async function (chat, contextSize, abort, type) {
    if (type === 'quiet') return chat;

    const settings = getSettings();
    if (!settings.enabled) {
        clearInjection();
        return chat;
    }

    const chatId = getChatId();
    if (!chatId) return chat;

    const userMessage = getLastUserMessage(chat);
    if (!userMessage) return chat;

    const memories = await getMemories(chatId);
    if (!memories.length) {
        clearInjection();
        return chat;
    }

    // 触发记忆衰减（每隔N条消息）
    settings.messageCountSinceDecay = (settings.messageCountSinceDecay || 0) + 1;
    if (settings.messageCountSinceDecay >= (settings.decayInterval || 10)) {
        settings.messageCountSinceDecay = 0;
        updateSettings({ messageCountSinceDecay: 0 });
        decayMemories(chatId);
    }

    // 提取近期角色和地点作为检索上下文
    const context = extractRecentContext(chat);

    // 常驻记忆（L4）
    const residentMemories = getResidentMemories(memories);

    // 相关记忆（L1~L3）+ 按需展开实体关联记忆
    let relevantResults = getRelevantMemories(memories, userMessage, {
        maxResults: settings.maxResults || DEFAULT_SETTINGS.maxResults,
        minStrength: settings.minStrength || 0,
        enabledTypes: settings.typeEnabled,
        context,
    });
    relevantResults = mergeExpandedRelevantResults(
        memories,
        userMessage,
        relevantResults,
        residentMemories,
        context,
        12,
    );

    if (!residentMemories.length && !relevantResults.length) {
        clearInjection();
        return chat;
    }

    // 巩固被检索到的记忆
    const resultIds = relevantResults.map(r => r.memory.id);
    if (resultIds.length) reinforceMemories(chatId, resultIds);

    // 构建分区注入文本
    const { text: injectionText, tokenEstimate, stats } = buildMemoryInjectionPrompt({
        residentMemories,
        relevantResults,
        settings,
    });

    const ctx = SillyTavern.getContext();
    ctx.setExtensionPrompt(
        INJECTION_KEY,
        injectionText,
        POSITION_IN_CHAT,
        settings.injectionDepth ?? DEFAULT_SETTINGS.injectionDepth,
        ROLE_SYSTEM,
    );

    console.log(
        `[${DISPLAY_NAME}] 注入: 常驻${stats.residentCount} L3×${stats.l3} L2×${stats.l2} L1×${stats.l1} ≈${tokenEstimate}tok`,
    );

    return chat;
};

/**
 * 从近期聊天中提取角色名和地点，用于提升场景/关系评分。
 */
function extractRecentContext(chat) {
    const recentActors = [];
    const recentLocations = [];

    if (!chat?.length) return { recentActors, recentLocations };

    const recent = chat.slice(-6);
    for (const msg of recent) {
        if (!msg.mes) continue;
        const text = msg.mes;
        // 简单提取：引号中的名字、「」中的对话
        const nameMatches = text.match(/(?:「|")([^「」""]{1,10})(?:」|")/g);
        if (nameMatches) {
            for (const m of nameMatches) {
                const name = m.replace(/[「」""]/g, '').trim();
                if (name.length >= 2 && name.length <= 8) recentActors.push(name);
            }
        }
    }

    return { recentActors: [...new Set(recentActors)], recentLocations };
}

function clearInjection() {
    try {
        const ctx = SillyTavern.getContext();
        ctx.setExtensionPrompt(INJECTION_KEY, '', POSITION_IN_CHAT, 0, ROLE_SYSTEM);
    } catch { /* 忽略 */ }
}

// ═══════════════════════════════════════════════════════════
//  侧边栏 UI 交互
// ═══════════════════════════════════════════════════════════

async function refreshSidebar() {
    const chatId = getChatId();
    const memories = chatId ? await getMemories(chatId) : [];

    const countEl = document.getElementById('bb_memory_count');
    if (countEl) countEl.textContent = String(memories.length);

    const enabledEl = document.getElementById('bb_memory_enabled');
    if (enabledEl) enabledEl.checked = getSettings().enabled;

    const depthEl = document.getElementById('bb_memory_depth');
    if (depthEl) depthEl.value = String(getSettings().injectionDepth ?? DEFAULT_SETTINGS.injectionDepth);

    const maxEl = document.getElementById('bb_memory_max_results');
    if (maxEl) maxEl.value = String(getSettings().maxResults ?? DEFAULT_SETTINGS.maxResults);

    const tokenBudgetEl = document.getElementById('bb_memory_token_budget');
    if (tokenBudgetEl) tokenBudgetEl.value = String(getSettings().tokenBudget ?? DEFAULT_SETTINGS.tokenBudget);

    const maintThresholdEl = document.getElementById('bb_memory_maint_threshold');
    if (maintThresholdEl) maintThresholdEl.value = String(getSettings().maintenanceThreshold ?? DEFAULT_SETTINGS.maintenanceThreshold);

    const autoGenEl = document.getElementById('bb_memory_auto_gen');
    if (autoGenEl) autoGenEl.checked = getSettings().autoGenEnabled;
}

function bindSidebarEvents() {
    document.getElementById('bb_memory_enabled')?.addEventListener('change', (e) => {
        updateSettings({ enabled: e.target.checked });
        if (!e.target.checked) clearInjection();
    });

    document.getElementById('bb_memory_depth')?.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 0) updateSettings({ injectionDepth: val });
    });

    document.getElementById('bb_memory_max_results')?.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 1) updateSettings({ maxResults: val });
    });

    document.getElementById('bb_memory_token_budget')?.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 100) updateSettings({ tokenBudget: val });
    });

    document.getElementById('bb_memory_maint_threshold')?.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 10) updateSettings({ maintenanceThreshold: val });
    });

    document.getElementById('bb_memory_template')?.addEventListener('change', (e) => {
        updateSettings({ injectionTemplate: e.target.value });
    });

    document.getElementById('bb_memory_auto_gen')?.addEventListener('change', (e) => {
        updateSettings({ autoGenEnabled: e.target.checked });
        if (e.target.checked) {
            initAutoGenerator();
        } else {
            stopAutoGenerator();
        }
    });

    // 副API模式切换
    document.getElementById('bb_memory_api_mode')?.addEventListener('change', (e) => {
        updateSettings({ autoGenMode: e.target.value });
        const customSection = document.getElementById('bb_memory_custom_api_section');
        if (customSection) {
            customSection.style.display = e.target.value === 'custom' ? 'block' : 'none';
        }
    });

    // 自定义API设置
    document.getElementById('bb_memory_api_endpoint')?.addEventListener('change', (e) => {
        updateSettings({ autoGenEndpoint: e.target.value.trim() });
    });
    document.getElementById('bb_memory_api_key')?.addEventListener('change', (e) => {
        updateSettings({ autoGenApiKey: e.target.value.trim() });
    });
    document.getElementById('bb_memory_api_model')?.addEventListener('change', (e) => {
        updateSettings({ autoGenModel: e.target.value.trim() });
    });

    // 衰减设置
    document.getElementById('bb_memory_decay_enabled')?.addEventListener('change', (e) => {
        updateSettings({ decayEnabled: e.target.checked });
    });
    document.getElementById('bb_memory_decay_rate')?.addEventListener('change', (e) => {
        const val = parseFloat(e.target.value);
        if (!isNaN(val) && val > 0 && val < 1) updateSettings({ decayRate: val });
    });

    // 快速添加记忆按钮
    document.getElementById('bb_memory_add_btn')?.addEventListener('click', () => {
        handleAddMemory();
    });

    // 打开记忆管理助手
    document.getElementById('bb_memory_manage_btn')?.addEventListener('click', () => {
        openMemoryManager();
    });

    // 世界书导入按钮
    document.getElementById('bb_memory_import_wb_btn')?.addEventListener('click', () => {
        handleWorldBookImport();
    });
}

// ═══════════════════════════════════════════════════════════
//  添加记忆
// ═══════════════════════════════════════════════════════════

async function handleAddMemory() {
    const chatId = getChatId();
    if (!chatId) {
        toastr.warning('请先选择一个角色并开始聊天', DISPLAY_NAME);
        return;
    }

    const ctx = SillyTavern.getContext();
    const content = await ctx.Popup.show.input('添加新记忆', '输入你想让角色记住的内容：');
    if (!content) return;

    await addMemory(chatId, content, 'episode', 'manual');
    toastr.success('记忆已添加', DISPLAY_NAME);
    refreshSidebar();
}

// ═══════════════════════════════════════════════════════════
//  世界书导入
// ═══════════════════════════════════════════════════════════

async function handleWorldBookImport() {
    const chatId = getChatId();
    if (!chatId) {
        toastr.warning('请先选择一个角色并开始聊天', DISPLAY_NAME);
        return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const { importWorldBook } = await import('./world-book-importer.js');
                const count = await importWorldBook(chatId, ev.target.result);
                toastr.success(`成功从世界书导入 ${count} 条记忆`, DISPLAY_NAME);
                refreshSidebar();
            } catch (err) {
                toastr.error(`世界书导入失败：${err.message}`, DISPLAY_NAME);
            }
        };
        reader.readAsText(file);
    });
    input.click();
}

// ═══════════════════════════════════════════════════════════
//  记忆管理弹窗
// ═══════════════════════════════════════════════════════════

async function openMemoryManager() {
    const chatId = getChatId();
    if (!chatId) {
        toastr.warning('请先选择一个角色并开始聊天', DISPLAY_NAME);
        return;
    }

    const memories = await getMemories(chatId);

    const overlay = document.createElement('div');
    overlay.className = 'bb-mem-overlay';
    overlay.innerHTML = buildManagerHTML(memories, chatId);
    document.body.appendChild(overlay);

    bindManagerEvents(overlay, chatId);
}

function buildManagerHTML(memories, chatId) {
    const memoryListHTML = memories.length
        ? memories.map(m => buildMemoryItemHTML(m)).join('')
        : '<div class="bb-mem-empty">暂无记忆，点击上方按钮添加第一条记忆吧</div>';

    const typeFilterHTML = Object.values(MEMORY_TYPES).map(t =>
        `<button class="menu_button bb-mem-type-filter" data-type="${t.id}" title="${t.description}">
            <i class="${t.icon}"></i> ${t.label}
        </button>`
    ).join('');

    return `
        <div class="bb-mem-popup">
            <div class="bb-mem-popup-header">
                <h3>BB-Memory 记忆管理</h3>
                <span class="bb-mem-close" title="关闭">&times;</span>
            </div>

            <div class="bb-mem-toolbar">
                <input type="text" class="bb-mem-search text_pole"
                       placeholder="搜索记忆..." id="bb_mgr_search" />
                <button class="menu_button bb-mem-toolbar-btn" id="bb_mgr_add">
                    <i class="fa-solid fa-plus"></i> 添加
                </button>
            </div>

            <div class="bb-mem-type-filters">
                <button class="menu_button bb-mem-type-filter active" data-type="all">
                    <i class="fa-solid fa-layer-group"></i> 全部
                </button>
                ${typeFilterHTML}
            </div>

            <div class="bb-mem-stats">
                共 <strong>${memories.length}</strong> 条记忆
            </div>

            <div class="bb-mem-list" id="bb_mgr_list">
                ${memoryListHTML}
            </div>

            <div class="bb-mem-footer">
                <button class="menu_button" id="bb_mgr_export" title="导出记忆到文件">
                    <i class="fa-solid fa-download"></i> 导出
                </button>
                <button class="menu_button" id="bb_mgr_import" title="从文件导入记忆">
                    <i class="fa-solid fa-upload"></i> 导入
                </button>
                <button class="menu_button" id="bb_mgr_import_wb" title="从世界书导入">
                    <i class="fa-solid fa-book-atlas"></i> 世界书
                </button>
                <button class="menu_button menu_button_danger" id="bb_mgr_clear" title="清空所有记忆">
                    <i class="fa-solid fa-trash"></i> 清空
                </button>
            </div>
        </div>
    `;
}

function buildMemoryItemHTML(m) {
    const date = new Date(m.createdAt).toLocaleString('zh-CN');
    const typeDef = getTypeDefinition(m.cognitiveType || m.type || 'fact');
    const sourceLabel = { manual: '手动', auto: 'AI', import: '导入', worldbook: '世界书' }[m.source] || m.source;

    const tagsHTML = (m.tags || [])
        .slice(0, 6)
        .map(t => `<span class="bb-mem-tag">${escapeHtml(typeof t === 'string' ? t : t.name)}</span>`)
        .join('');

    const strengthBar = `<div class="bb-mem-strength-bar">
        <div class="bb-mem-strength-fill" style="width: ${((m.strength || 1) * 100).toFixed(0)}%"></div>
    </div>`;

    // truthStatus badge
    const tsDef = TRUTH_STATUS[m.truthStatus];
    const truthBadge = m.truthStatus && m.truthStatus !== 'true' && tsDef
        ? `<span class="bb-truth-badge" style="background: ${tsDef.color}" title="${tsDef.label}">${tsDef.label}</span>`
        : '';

    // status badge (v2.5)
    const statusDef = MEMORY_STATUS[m.status] || MEMORY_STATUS.active;
    const statusBadge = m.status && m.status !== 'active'
        ? `<span class="bb-status-badge" style="background: ${statusDef.color}" title="${statusDef.label}"><i class="fa-solid ${statusDef.icon}"></i> ${statusDef.label}</span>`
        : '';

    // hiddenNotes 面板
    const notes = Array.isArray(m.hiddenNotes) ? m.hiddenNotes : [];
    const hasNotes = notes.length > 0;
    const notesListHTML = hasNotes
        ? notes.map(n => {
            const ntDef = HIDDEN_NOTE_TYPES[n.type] || HIDDEN_NOTE_TYPES.note;
            const injIcon = n.allowInjection !== false ? '💉' : '🚫';
            return `<div class="bb-hn-item">
                <span class="bb-hn-type">[${ntDef.label}]</span>
                <span class="bb-hn-content">${escapeHtml(n.content)}</span>
                <span class="bb-hn-inj" title="${n.allowInjection !== false ? '允许注入' : '禁止注入'}">${injIcon}</span>
                <button class="bb-hn-remove" data-mem-id="${m.id}" data-note-id="${n.id}" title="删除备注">&times;</button>
            </div>`;
        }).join('')
        : '<div class="bb-mem-empty" style="font-size:0.8em;">暂无隐藏备注</div>';

    // history 面板
    const history = Array.isArray(m.history) ? m.history : [];
    const hasHistory = history.length > 0;
    const historyHTML = hasHistory
        ? history.slice().reverse().map(h => {
            const ts = TRUTH_STATUS[h.truthStatus];
            const tsLabel = ts ? ` [${ts.label}]` : '';
            return `<div class="bb-hist-item">
                <div class="bb-hist-date">${new Date(h.changedAt).toLocaleString('zh-CN')}${tsLabel}</div>
                <div class="bb-hist-content">${escapeHtml(h.content)}</div>
                ${h.reason ? `<div class="bb-hist-reason">原因: ${escapeHtml(h.reason)}</div>` : ''}
            </div>`;
        }).join('')
        : '';

    const showNpcTier = (m.categoryPath || '').startsWith('npc.') || !!normalizeNpcTier(m.npcTier);
    const showItemTier = (m.categoryPath || '').startsWith('item.') || !!normalizeItemTier(m.itemTier);
    const showEntityTools = m.resident || showNpcTier || showItemTier;
    const ntVal = normalizeNpcTier(m.npcTier);
    const itVal = normalizeItemTier(m.itemTier);

    let tierRow = '';
    if (showEntityTools) {
        tierRow = '<div class="bb-entity-meta-row">';
        if (showNpcTier) {
            tierRow += `<label class="bb-tier-label">NPC分级</label><select class="text_pole bb-tier-select" data-field="npcTier" data-id="${m.id}">`;
            tierRow += '<option value="">—</option>';
            tierRow += Object.values(NPC_TIERS).map(t =>
                `<option value="${t.id}" ${ntVal === t.id ? 'selected' : ''}>${t.label}</option>`,
            ).join('');
            tierRow += '</select>';
        }
        if (showItemTier) {
            tierRow += `<label class="bb-tier-label">物品分级</label><select class="text_pole bb-tier-select" data-field="itemTier" data-id="${m.id}">`;
            tierRow += '<option value="">—</option>';
            tierRow += Object.values(ITEM_TIERS).map(t =>
                `<option value="${t.id}" ${itVal === t.id ? 'selected' : ''}>${t.label}</option>`,
            ).join('');
            tierRow += '</select>';
        }
        tierRow += `<input type="text" class="text_pole bb-index-card-input" data-id="${m.id}" placeholder="常驻索引卡（短摘要/状态，不写完整史）" value="${escapeHtml(m.indexCard || '')}" />`;
        tierRow += '</div>';
    }

    return `
        <div class="bb-mem-item" data-id="${m.id}" data-type="${m.cognitiveType || m.type || 'fact'}">
            <div class="bb-mem-item-header">
                <span class="bb-mem-item-type" style="color: ${typeDef.color}">
                    <i class="${typeDef.icon}"></i> ${typeDef.label}
                </span>
                ${truthBadge}
                ${statusBadge}
                ${strengthBar}
            </div>
            <div class="bb-mem-item-content">${escapeHtml(m.content)}</div>
            <div class="bb-mem-item-meta">
                <span class="bb-mem-item-date">${date}</span>
                <span class="bb-mem-item-source">${sourceLabel}</span>
                ${tagsHTML}
            </div>
            ${tierRow}
            <div class="bb-mem-item-actions">
                <button class="menu_button bb-mem-btn-sm bb-mem-eye ${hasNotes ? 'has-notes' : ''}"
                        data-id="${m.id}" title="隐藏备注 (${notes.length})">
                    <i class="fa-solid fa-eye"></i>
                </button>
                ${hasHistory ? `<button class="menu_button bb-mem-btn-sm bb-mem-history"
                    data-id="${m.id}" title="版本历史 (${history.length})">
                    <i class="fa-solid fa-clock-rotate-left"></i>
                </button>` : ''}
                <button class="menu_button bb-mem-btn-sm bb-mem-fact-update" data-id="${m.id}" title="更新内容（保留历史）">
                    <i class="fa-solid fa-pen-to-square"></i>
                </button>
                <button class="menu_button bb-mem-btn-sm bb-mem-resident ${m.resident ? 'active' : ''}"
                        data-id="${m.id}" title="${m.resident ? '取消常驻' : '设为常驻记忆'}">
                    <i class="fa-solid fa-thumbtack"></i>
                </button>
                ${m.status === 'archived' || m.status === 'fuzzy'
                    ? `<button class="menu_button bb-mem-btn-sm bb-mem-restore" data-id="${m.id}" title="恢复为活跃">
                        <i class="fa-solid fa-rotate-left"></i>
                    </button>`
                    : `<button class="menu_button bb-mem-btn-sm bb-mem-fuzzy" data-id="${m.id}" title="模糊化（压缩保留）">
                        <i class="fa-solid fa-cloud"></i>
                    </button>
                    <button class="menu_button bb-mem-btn-sm bb-mem-archive" data-id="${m.id}" title="归档">
                        <i class="fa-solid fa-box-archive"></i>
                    </button>`}
                <button class="menu_button bb-mem-btn-sm bb-mem-edit" data-id="${m.id}" title="快速编辑">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="menu_button bb-mem-btn-sm bb-mem-delete menu_button_danger"
                        data-id="${m.id}" title="删除">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>

            <div class="bb-hn-panel" style="display:none;" data-panel-for="${m.id}">
                <div class="bb-hn-header">
                    <span>隐藏备注</span>
                    <button class="menu_button bb-mem-btn-sm bb-hn-add" data-id="${m.id}">
                        <i class="fa-solid fa-plus"></i> 添加
                    </button>
                </div>
                <div class="bb-hn-list">${notesListHTML}</div>
            </div>

            ${hasHistory ? `<div class="bb-hist-panel" style="display:none;" data-hist-for="${m.id}">
                <div class="bb-hn-header"><span>版本历史</span></div>
                ${historyHTML}
            </div>` : ''}
        </div>
    `;
}

function bindManagerEvents(overlay, chatId) {
    overlay.querySelector('.bb-mem-close')?.addEventListener('click', () => {
        overlay.remove();
        refreshSidebar();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.remove();
            refreshSidebar();
        }
    });

    // 类型过滤
    overlay.querySelectorAll('.bb-mem-type-filter').forEach(btn => {
        btn.addEventListener('click', async () => {
            overlay.querySelectorAll('.bb-mem-type-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const type = btn.dataset.type;
            const memories = await getMemories(chatId);
            const filtered = type === 'all' ? memories : memories.filter(m => (m.cognitiveType || m.type) === type);
            renderMemoryList(overlay, filtered, chatId);
        });
    });

    // 添加记忆
    overlay.querySelector('#bb_mgr_add')?.addEventListener('click', async () => {
        const ctx = SillyTavern.getContext();
        const content = await ctx.Popup.show.input('添加新记忆', '输入记忆内容：');
        if (!content) return;
        await addMemory(chatId, content, 'episode', 'manual');
        toastr.success('记忆已添加', DISPLAY_NAME);
        await rerenderManagerList(overlay, chatId);
    });

    // 搜索
    overlay.querySelector('#bb_mgr_search')?.addEventListener('input', async (e) => {
        const query = e.target.value.trim();
        const memories = await getMemories(chatId);

        if (!query) {
            renderMemoryList(overlay, memories, chatId);
            return;
        }

        const results = simpleSearch(memories, query, 100);
        renderMemoryList(overlay, results, chatId);
    });

    // 导出
    overlay.querySelector('#bb_mgr_export')?.addEventListener('click', async () => {
        const json = await exportMemories(chatId);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bb-memory-${chatId}-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('记忆已导出', DISPLAY_NAME);
    });

    // 导入
    overlay.querySelector('#bb_mgr_import')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    const count = await importMemories(chatId, ev.target.result);
                    toastr.success(`成功导入 ${count} 条记忆`, DISPLAY_NAME);
                    await rerenderManagerList(overlay, chatId);
                } catch (err) {
                    toastr.error(`导入失败：${err.message}`, DISPLAY_NAME);
                }
            };
            reader.readAsText(file);
        });
        input.click();
    });

    // 世界书导入
    overlay.querySelector('#bb_mgr_import_wb')?.addEventListener('click', async () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    const { importWorldBook } = await import('./world-book-importer.js');
                    const count = await importWorldBook(chatId, ev.target.result);
                    toastr.success(`成功从世界书导入 ${count} 条记忆`, DISPLAY_NAME);
                    await rerenderManagerList(overlay, chatId);
                } catch (err) {
                    toastr.error(`世界书导入失败：${err.message}`, DISPLAY_NAME);
                }
            };
            reader.readAsText(file);
        });
        input.click();
    });

    // 清空全部
    overlay.querySelector('#bb_mgr_clear')?.addEventListener('click', async () => {
        const ctx = SillyTavern.getContext();
        const ok = await ctx.Popup.show.confirm('确认清空', '确定要删除所有记忆吗？此操作不可撤销。');
        if (!isPopupAffirmative(ctx, ok)) return;
        await clearMemories(chatId);
        toastr.info('所有记忆已清空', DISPLAY_NAME);
        await rerenderManagerList(overlay, chatId);
    });

    rebindItemActions(overlay, chatId);
}

function renderMemoryList(overlay, memories, chatId) {
    const listEl = overlay.querySelector('#bb_mgr_list');
    if (listEl) {
        listEl.innerHTML = memories.length
            ? memories.map(m => buildMemoryItemHTML(m)).join('')
            : '<div class="bb-mem-empty">未找到匹配的记忆</div>';
    }
    const statsEl = overlay.querySelector('.bb-mem-stats');
    if (statsEl) statsEl.innerHTML = `共 <strong>${memories.length}</strong> 条记忆`;
    rebindItemActions(overlay, chatId);
}

async function rerenderManagerList(overlay, chatId) {
    const memories = await getMemories(chatId);
    renderMemoryList(overlay, memories, chatId);
}

function rebindItemActions(overlay, chatId) {
    // 删除
    overlay.querySelectorAll('.bb-mem-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const ctx = SillyTavern.getContext();
            const ok = await ctx.Popup.show.confirm('确认删除', '确定要删除这条记忆吗？');
            if (!isPopupAffirmative(ctx, ok)) return;
            await removeMemory(chatId, id);
            toastr.info('记忆已删除', DISPLAY_NAME);
            await rerenderManagerList(overlay, chatId);
        });
    });

    // 快速编辑
    overlay.querySelectorAll('.bb-mem-edit').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const memories = await getMemories(chatId);
            const memory = memories.find(m => m.id === id);
            if (!memory) return;

            const ctx = SillyTavern.getContext();
            const newContent = await ctx.Popup.show.input('编辑记忆', '修改记忆内容：', memory.content);
            if (!newContent || newContent === memory.content) return;

            await updateMemory(chatId, id, newContent);
            toastr.success('记忆已更新', DISPLAY_NAME);
            await rerenderManagerList(overlay, chatId);
        });
    });

    // 👁 小眼睛：切换隐藏备注面板
    overlay.querySelectorAll('.bb-mem-eye').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const panel = overlay.querySelector(`.bb-hn-panel[data-panel-for="${id}"]`);
            if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });
    });

    // 📜 版本历史面板切换
    overlay.querySelectorAll('.bb-mem-history').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const panel = overlay.querySelector(`.bb-hist-panel[data-hist-for="${id}"]`);
            if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });
    });

    // ➕ 添加隐藏备注
    overlay.querySelectorAll('.bb-hn-add').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const memId = btn.dataset.id;
            const ctx = SillyTavern.getContext();

            const noteTypesHTML = Object.values(HIDDEN_NOTE_TYPES).map(t =>
                `<option value="${t.id}">${t.label}</option>`
            ).join('');

            const content = await ctx.Popup.show.input(
                '添加隐藏备注',
                `<div style="margin-bottom:8px;">
                    <label>备注类型：</label>
                    <select id="bb_hn_type_select" class="text_pole" style="width:100%;margin-top:4px;">
                        ${noteTypesHTML}
                    </select>
                </div>
                <label>备注内容：</label>`,
            );
            if (!content) return;

            const typeSelect = document.getElementById('bb_hn_type_select');
            const noteType = typeSelect?.value || 'note';

            await addHiddenNote(chatId, memId, {
                type: noteType,
                content,
                allowInjection: true,
                revealPolicy: 'never',
            });
            toastr.success('隐藏备注已添加', DISPLAY_NAME);
            await rerenderManagerList(overlay, chatId);
        });
    });

    // ✖ 删除隐藏备注
    overlay.querySelectorAll('.bb-hn-remove').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const memId = btn.dataset.memId;
            const noteId = btn.dataset.noteId;
            await removeHiddenNote(chatId, memId, noteId);
            toastr.info('备注已删除', DISPLAY_NAME);
            await rerenderManagerList(overlay, chatId);
        });
    });

    overlay.querySelectorAll('.bb-tier-select').forEach(sel => {
        sel.addEventListener('change', async (e) => {
            e.stopPropagation();
            const field = sel.dataset.field;
            const val = sel.value;
            await updateMemory(chatId, sel.dataset.id, { [field]: val });
            toastr.success('分级已保存', DISPLAY_NAME);
            await rerenderManagerList(overlay, chatId);
        });
    });

    overlay.querySelectorAll('.bb-index-card-input').forEach(inp => {
        inp.addEventListener('change', async (e) => {
            e.stopPropagation();
            await updateMemory(chatId, inp.dataset.id, { indexCard: inp.value.trim() });
            toastr.info('索引卡已保存', DISPLAY_NAME);
        });
    });

    // 📌 常驻记忆切换
    overlay.querySelectorAll('.bb-mem-resident').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const memories = await getMemories(chatId);
            const memory = memories.find(m => m.id === id);
            if (!memory) return;
            const newVal = !memory.resident;
            await updateMemory(chatId, id, { resident: newVal });
            toastr.success(newVal ? '已设为常驻记忆' : '已取消常驻', DISPLAY_NAME);
            await rerenderManagerList(overlay, chatId);
        });
    });

    // 📝 事实更新（保留历史版本）
    overlay.querySelectorAll('.bb-mem-fact-update').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const memories = await getMemories(chatId);
            const memory = memories.find(m => m.id === id);
            if (!memory) return;

            const ctx = SillyTavern.getContext();

            const truthOptions = Object.values(TRUTH_STATUS).map(t =>
                `<option value="${t.id}" ${memory.truthStatus === t.id ? 'selected' : ''}>${t.label}</option>`
            ).join('');

            const newContent = await ctx.Popup.show.input(
                '更新记忆（旧版本将保存到历史）',
                `<div style="margin-bottom:8px;">
                    <label>真假状态：</label>
                    <select id="bb_fact_truth_select" class="text_pole" style="width:100%;margin-top:4px;">
                        ${truthOptions}
                    </select>
                </div>
                <div style="margin-bottom:8px;">
                    <label>变更原因（可选）：</label>
                    <input id="bb_fact_reason" class="text_pole" style="width:100%;margin-top:4px;"
                           placeholder="例如：剧情推进 / 新线索" />
                </div>
                <label>新内容：</label>`,
                memory.content,
            );
            if (!newContent) return;

            const truthSelect = document.getElementById('bb_fact_truth_select');
            const reasonInput = document.getElementById('bb_fact_reason');

            await updateFactContent(chatId, id, newContent, {
                truthStatus: truthSelect?.value || memory.truthStatus,
                reason: reasonInput?.value || '',
            });
            toastr.success('记忆已更新，旧版本已保存到历史', DISPLAY_NAME);
            await rerenderManagerList(overlay, chatId);
        });
    });

    // ☁️ 模糊化
    overlay.querySelectorAll('.bb-mem-fuzzy').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            await fuzzyMemory(chatId, id);
            toastr.success('记忆已模糊化（原文保留在 compressed 字段）', DISPLAY_NAME);
            await rerenderManagerList(overlay, chatId);
        });
    });

    // 📦 归档
    overlay.querySelectorAll('.bb-mem-archive').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            await archiveMemory(chatId, id);
            toastr.success('记忆已归档（可随时恢复）', DISPLAY_NAME);
            await rerenderManagerList(overlay, chatId);
        });
    });

    // 🔄 恢复
    overlay.querySelectorAll('.bb-mem-restore').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            await restoreMemory(chatId, id);
            toastr.success('记忆已恢复为活跃状态', DISPLAY_NAME);
            await rerenderManagerList(overlay, chatId);
        });
    });
}

// ═══════════════════════════════════════════════════════════
//  斜杠命令注册
// ═══════════════════════════════════════════════════════════

function registerSlashCommands() {
    const ctx = SillyTavern.getContext();

    const memorySlashCallback = async (namedArgs, unnamedArgs) => {
        const line = normalizeSlashUnnamed(unnamedArgs);
        const subCommand = line.split(/\s+/).filter(Boolean);
        const action = subCommand[0];
        const content = subCommand.slice(1).join(' ');

        const chatId = getChatId();
        if (!chatId) return '请先打开一个聊天';

        switch (action) {
            case 'add': {
                if (!content) return '用法: /memory add <记忆内容>';
                const type = namedArgs.type || 'episode';
                await addMemory(chatId, content, type, 'manual');
                return `已添加记忆: ${content}`;
            }
            case 'search': {
                if (!content) return '用法: /memory search <搜索词>';
                const memories = await getMemories(chatId);
                const results = searchMemories(memories, content, { maxResults: 5 });
                if (!results.length) return '未找到相关记忆';
                return results.map((m, i) => `${i + 1}. [${m.type}] ${m.content}`).join('\n');
            }
            case 'count': {
                const stats = await getMemoryStats(chatId);
                let info = `共 ${stats.total} 条记忆`;
                for (const [type, count] of Object.entries(stats.byType)) {
                    const typeDef = getTypeDefinition(type);
                    info += `\n  ${typeDef.label}: ${count}`;
                }
                return info;
            }
            case 'clear': {
                await clearMemories(chatId);
                return '所有记忆已清空';
            }
            default:
                return '可用命令: /memory add|search|count|clear\n示例: /memory add 角色喜欢喝咖啡';
        }
    };

    // 优先使用官方推荐的 SlashCommandParser（与新版酒馆命令浏览器兼容）
    try {
        if (typeof ctx.SlashCommandParser?.addCommandObject === 'function' && typeof ctx.SlashCommand?.fromProps === 'function') {
            ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
                name: 'memory',
                callback: memorySlashCallback,
                aliases: [],
                helpString: '管理 BB-Memory 记忆 (add/search/count/clear)。示例: /memory add 角色喜欢喝咖啡',
            }));
        } else {
            registerSlashCommand('memory', memorySlashCallback, [], '管理BB-Memory记忆 (add/search/count/clear)');
        }
    } catch (err) {
        console.warn(`[${DISPLAY_NAME}] SlashCommandParser 注册失败，使用 registerSlashCommand`, err);
        registerSlashCommand('memory', memorySlashCallback, [], '管理BB-Memory记忆 (add/search/count/clear)');
    }
}

// ═══════════════════════════════════════════════════════════
//  事件处理
// ═══════════════════════════════════════════════════════════

function onChatChanged() {
    clearInjection();
    refreshSidebar();

    const settings = getSettings();
    if (settings.enabled) {
        syncMessageVisibility().catch(e => {
            console.warn(`[${DISPLAY_NAME}] 聊天切换时消息同步失败:`, e);
        });

        // 延迟检查维护需求，避免阻塞聊天切换
        setTimeout(() => triggerMaintenanceCheck(), 3000);
    }
}

async function onNewMessage() {
    const settings = getSettings();
    if (!settings.enabled) return;
    try {
        await syncMessageVisibility();
    } catch (e) {
        console.warn(`[${DISPLAY_NAME}] 消息可见性同步失败:`, e);
    }
}

// ═══════════════════════════════════════════════════════════
//  维护检查与弹窗
// ═══════════════════════════════════════════════════════════

async function triggerMaintenanceCheck() {
    const chatId = getChatId();
    if (!chatId) return;

    try {
        const result = await checkMaintenanceNeeded(chatId);
        if (!result) return;
        showMaintenancePopup(chatId, result);
    } catch (e) {
        console.warn(`[${DISPLAY_NAME}] 维护检查失败:`, e);
    }
}

function showMaintenancePopup(chatId, result) {
    // 避免重复弹窗
    if (document.querySelector('.bb-maint-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'bb-maint-overlay';
    overlay.innerHTML = buildMaintenanceHTML(result);
    document.body.appendChild(overlay);

    // 点背景关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    // 自动整理
    overlay.querySelector('.bb-maint-btn-auto')?.addEventListener('click', async () => {
        const checkedIds = new Set();
        overlay.querySelectorAll('.bb-maint-checkbox:checked').forEach(cb => checkedIds.add(cb.dataset.id));
        const selectedIssues = result.issues.filter(i => checkedIds.has(i.memory.id));

        if (!selectedIssues.length) {
            toastr.info('没有勾选任何记忆', DISPLAY_NAME);
            return;
        }

        const count = await autoMaintain(chatId, selectedIssues);
        toastr.success(`已自动整理 ${count} 条记忆（模糊化/归档）`, DISPLAY_NAME);
        overlay.remove();
        refreshSidebar();
    });

    // 手动查看
    overlay.querySelector('.bb-maint-btn-manual')?.addEventListener('click', () => {
        overlay.remove();
        openMemoryManager();
    });

    // 稍后提醒
    overlay.querySelector('.bb-maint-btn-later')?.addEventListener('click', () => {
        dismissMaintenanceRemind();
        toastr.info('24 小时内不再提醒', DISPLAY_NAME);
        overlay.remove();
    });
}

// ═══════════════════════════════════════════════════════════
//  初始化
// ═══════════════════════════════════════════════════════════

async function init() {
    console.log(`[${DISPLAY_NAME}] 初始化中...`);

    const ctx = SillyTavern.getContext();
    const extensionFolder = getExtensionFolder();

    // 确保设置已初始化
    getSettings();

    // v1 -> v2 数据迁移
    try {
        const migrated = await migrateFromSettings();
        if (migrated > 0) {
            toastr.info(`已从旧版迁移 ${migrated} 条记忆`, DISPLAY_NAME);
        }
    } catch (err) {
        console.error(`[${DISPLAY_NAME}] 数据迁移失败:`, err);
    }

    // 加载侧边栏 HTML 模板（目录键必须与 findExtension / 实际安装路径一致）
    try {
        const settingsHtml = await ctx.renderExtensionTemplateAsync(extensionFolder, 'settings');
        await mountExtensionSettingsHtml(settingsHtml);
    } catch (err) {
        console.error(`[${DISPLAY_NAME}] 加载设置模板失败:`, err);
    }

    // 加载注入模板到 UI
    const templateEl = document.getElementById('bb_memory_template');
    if (templateEl) {
        const s = getSettings();
        templateEl.value = s.injectionTemplate || DEFAULT_SETTINGS.injectionTemplate;
    }

    // 初始化自定义API区域显示状态
    const settings = getSettings();
    const customSection = document.getElementById('bb_memory_custom_api_section');
    if (customSection) {
        customSection.style.display = settings.autoGenMode === 'custom' ? 'block' : 'none';
    }

    // 绑定侧边栏事件
    bindSidebarEvents();

    // 初始化 AI 自动生成模块
    if (settings.autoGenEnabled) {
        initAutoGenerator();
    }

    // 注册斜杠命令
    try {
        registerSlashCommands();
    } catch (err) {
        console.warn(`[${DISPLAY_NAME}] 斜杠命令注册失败:`, err);
    }

    // 监听 SillyTavern 事件（兼容 event_types / eventTypes 命名）
    const ev = ctx.event_types ?? ctx.eventTypes;
    if (ev && ctx.eventSource) {
        ctx.eventSource.on(ev.CHAT_CHANGED, onChatChanged);
        ctx.eventSource.on(ev.MESSAGE_RECEIVED, onNewMessage);
    }

    // 首次刷新侧边栏
    refreshSidebar();

    /** 控制台 / 脚本按需展开某关键词相关的记忆条目 */
    globalThis.bbMemoryExpandEntityKeyword = async function (keyword, limit = 12) {
        const cid = getChatId();
        if (!cid || !keyword) return [];
        const list = await getMemories(cid);
        return expandMemoriesForEntityKeyword(list, String(keyword), { limit });
    };

    console.log(`[${DISPLAY_NAME}] v2.6.1 初始化完成`);
}

// ═══ 启动 ═══

(function startup() {
    const ctx = SillyTavern.getContext();
    const ev = ctx.event_types ?? ctx.eventTypes;

    if (ctx.eventSource && ev?.APP_READY) {
        ctx.eventSource.on(ev.APP_READY, () => init());
    } else if (document.getElementById('extensions_settings2') || document.getElementById('extensions_settings')) {
        init();
    } else {
        window.addEventListener('load', () => init());
    }
})();
