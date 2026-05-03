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
    clearMemories,
    exportMemories,
    importMemories,
    decayMemories,
    reinforceMemories,
    migrateFromSettings,
    getMemoryStats,
} from './memory-store.js';

import { searchMemories, simpleSearch } from './retriever.js';
import { MEMORY_TYPES, formatMemoriesForInjection, getTypeDefinition } from './memory-types.js';
import { initAutoGenerator, stopAutoGenerator } from './auto-generator.js';
import { syncMessageVisibility } from './message-state.js';

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

function getExtensionFolder() {
    try {
        const url = import.meta.url;
        const match = url.match(/\/scripts\/extensions\/(.*?)\/index\.js/);
        if (match) return match[1];
    } catch { /* 忽略 */ }
    return 'third-party/bb-memory';
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
    if (type === 'quiet') return;

    const settings = getSettings();
    if (!settings.enabled) {
        clearInjection();
        return;
    }

    const chatId = getChatId();
    if (!chatId) return;

    const userMessage = getLastUserMessage(chat);
    if (!userMessage) return;

    const memories = await getMemories(chatId);
    if (!memories.length) {
        clearInjection();
        return;
    }

    // 触发记忆衰减（每隔N条消息）
    settings.messageCountSinceDecay = (settings.messageCountSinceDecay || 0) + 1;
    if (settings.messageCountSinceDecay >= (settings.decayInterval || 10)) {
        settings.messageCountSinceDecay = 0;
        updateSettings({ messageCountSinceDecay: 0 });
        decayMemories(chatId);
    }

    // 智能检索相关记忆
    const results = searchMemories(memories, userMessage, {
        maxResults: settings.maxResults || DEFAULT_SETTINGS.maxResults,
        minStrength: settings.minStrength || 0,
    });

    if (!results.length) {
        clearInjection();
        return;
    }

    // 巩固被检索到的记忆
    const resultIds = results.map(m => m.id);
    reinforceMemories(chatId, resultIds);

    // 按类型格式化注入文本
    const formattedMemories = formatMemoriesForInjection(results, settings.typeEnabled);

    const template = settings.injectionTemplate || DEFAULT_SETTINGS.injectionTemplate;
    const injectionText = template.replace('{{memories}}', formattedMemories);

    const ctx = SillyTavern.getContext();
    ctx.setExtensionPrompt(
        INJECTION_KEY,
        injectionText,
        POSITION_IN_CHAT,
        settings.injectionDepth ?? DEFAULT_SETTINGS.injectionDepth,
        false,
        ROLE_SYSTEM,
    );

    console.log(`[${DISPLAY_NAME}] 注入了 ${results.length} 条相关记忆`);
};

function clearInjection() {
    try {
        const ctx = SillyTavern.getContext();
        ctx.setExtensionPrompt(INJECTION_KEY, '', POSITION_IN_CHAT, 0);
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

    await addMemory(chatId, content, 'event', 'manual');
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
    const typeDef = getTypeDefinition(m.type || 'event');
    const sourceLabel = { manual: '手动', auto: 'AI', import: '导入', worldbook: '世界书' }[m.source] || m.source;

    const tagsHTML = (m.tags || [])
        .slice(0, 6)
        .map(t => `<span class="bb-mem-tag">${escapeHtml(typeof t === 'string' ? t : t.name)}</span>`)
        .join('');

    const strengthBar = `<div class="bb-mem-strength-bar">
        <div class="bb-mem-strength-fill" style="width: ${((m.strength || 1) * 100).toFixed(0)}%"></div>
    </div>`;

    return `
        <div class="bb-mem-item" data-id="${m.id}" data-type="${m.type || 'event'}">
            <div class="bb-mem-item-header">
                <span class="bb-mem-item-type" style="color: ${typeDef.color}">
                    <i class="${typeDef.icon}"></i> ${typeDef.label}
                </span>
                ${strengthBar}
            </div>
            <div class="bb-mem-item-content">${escapeHtml(m.content)}</div>
            <div class="bb-mem-item-meta">
                <span class="bb-mem-item-date">${date}</span>
                <span class="bb-mem-item-source">${sourceLabel}</span>
                ${tagsHTML}
            </div>
            <div class="bb-mem-item-actions">
                <button class="menu_button bb-mem-btn-sm bb-mem-edit" data-id="${m.id}" title="编辑">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="menu_button bb-mem-btn-sm bb-mem-delete menu_button_danger"
                        data-id="${m.id}" title="删除">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
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
            const filtered = type === 'all' ? memories : memories.filter(m => m.type === type);
            renderMemoryList(overlay, filtered, chatId);
        });
    });

    // 添加记忆
    overlay.querySelector('#bb_mgr_add')?.addEventListener('click', async () => {
        const ctx = SillyTavern.getContext();
        const content = await ctx.Popup.show.input('添加新记忆', '输入记忆内容：');
        if (!content) return;
        await addMemory(chatId, content, 'event', 'manual');
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
        if (!ok) return;
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
    overlay.querySelectorAll('.bb-mem-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const ctx = SillyTavern.getContext();
            const ok = await ctx.Popup.show.confirm('确认删除', '确定要删除这条记忆吗？');
            if (!ok) return;
            await removeMemory(chatId, id);
            toastr.info('记忆已删除', DISPLAY_NAME);
            await rerenderManagerList(overlay, chatId);
        });
    });

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
}

// ═══════════════════════════════════════════════════════════
//  斜杠命令注册
// ═══════════════════════════════════════════════════════════

function registerSlashCommands() {
    const ctx = SillyTavern.getContext();

    // /memory add <内容> — 快速添加记忆
    ctx.registerSlashCommand('memory', async (namedArgs, unnamedArgs) => {
        const subCommand = String(unnamedArgs).trim().split(/\s+/);
        const action = subCommand[0];
        const content = subCommand.slice(1).join(' ');

        const chatId = getChatId();
        if (!chatId) return '请先打开一个聊天';

        switch (action) {
            case 'add': {
                if (!content) return '用法: /memory add <记忆内容>';
                const type = namedArgs.type || 'event';
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
                const memories = await getMemories(chatId);
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
    }, [], '管理BB-Memory记忆 (add/search/count/clear)', true, true);
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

    // 加载侧边栏 HTML 模板
    try {
        const settingsHtml = await ctx.renderExtensionTemplateAsync(extensionFolder, 'settings');
        const container = document.getElementById('extensions_settings2');
        if (container) {
            container.insertAdjacentHTML('beforeend', settingsHtml);
        }
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

    // 监听 SillyTavern 事件
    ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, onChatChanged);
    ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, onNewMessage);

    // 首次刷新侧边栏
    refreshSidebar();

    console.log(`[${DISPLAY_NAME}] v2.1 初始化完成`);
}

// ═══ 启动 ═══

(function startup() {
    const ctx = SillyTavern.getContext();

    if (ctx.eventSource && ctx.event_types) {
        ctx.eventSource.on(ctx.event_types.APP_READY, () => init());
    } else {
        if (document.getElementById('extensions_settings2')) {
            init();
        } else {
            window.addEventListener('load', () => init());
        }
    }
})();
