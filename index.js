/**
 * index.js —— BB-Memory 的"大脑"（主入口）
 *
 * 职责：
 *   1. 初始化扩展（加载设置、渲染侧边栏 UI）
 *   2. 监听 SillyTavern 事件（如切换聊天）
 *   3. 在生成文本前，检索相关记忆并注入到 prompt
 *   4. 处理用户操作（添加、删除、搜索记忆）
 *
 * 所有与 SillyTavern 的交互都通过 SillyTavern.getContext() 完成，
 * 这是官方推荐的稳定 API。
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
} from './memory-store.js';

import { searchMemories } from './retriever.js';

// ═══════════════════════════════════════════════════════════
//  常量
// ═══════════════════════════════════════════════════════════

const DISPLAY_NAME = 'BB-Memory';
const INJECTION_KEY = 'bb_memory_injection';

// setExtensionPrompt 需要的位置和角色常量
// 这些值来自 SillyTavern 的 extension_prompt_types / extension_prompt_roles
// 我们在本地定义，避免直接 import SillyTavern 内部文件
const POSITION_IN_CHAT = 1;  // 插入到聊天历史中
const ROLE_SYSTEM = 0;       // 作为系统消息

// ═══════════════════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * 自动检测当前扩展的文件夹路径。
 * renderExtensionTemplateAsync 需要知道 HTML 模板在哪个文件夹。
 */
function getExtensionFolder() {
    try {
        const url = import.meta.url;
        const match = url.match(/\/scripts\/extensions\/(.*?)\/index\.js/);
        if (match) return match[1];
    } catch { /* 忽略 */ }
    return 'third-party/bb-memory';
}

/**
 * 获取当前聊天的唯一标识符。
 * SillyTavern 为每个聊天分配一个 chatId。
 */
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

/**
 * 获取最近 N 条用户消息文本（用于搜索上下文）。
 */
function getLastUserMessage(chat) {
    if (!chat || !chat.length) return '';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && chat[i].mes) {
            return chat[i].mes;
        }
    }
    return '';
}

// ═══════════════════════════════════════════════════════════
//  生成拦截器（核心功能）
// ═══════════════════════════════════════════════════════════

/**
 * generate_interceptor：SillyTavern 在每次生成文本前会调用此函数。
 *
 * 我们在这里做以下事情：
 *   1. 读取用户最新的消息
 *   2. 在记忆库中搜索相关记忆
 *   3. 把找到的记忆格式化后注入到 prompt 中
 *
 * 这个函数必须注册到全局作用域（globalThis），
 * 并在 manifest.json 的 generate_interceptor 字段中声明。
 *
 * @param {Array} chat - 当前聊天记录数组
 * @param {number} contextSize - 上下文窗口大小
 * @param {Function} abort - 调用它可以中止生成
 * @param {string} type - 生成类型（'normal', 'quiet', 'swipe' 等）
 */
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

    const memories = getMemories(chatId);
    if (!memories.length) {
        clearInjection();
        return;
    }

    const results = searchMemories(
        memories,
        userMessage,
        settings.maxResults || DEFAULT_SETTINGS.maxResults,
    );

    if (!results.length) {
        clearInjection();
        return;
    }

    const memoryLines = results
        .map((m, i) => `${i + 1}. ${m.content}`)
        .join('\n');

    const template = settings.injectionTemplate || DEFAULT_SETTINGS.injectionTemplate;
    const injectionText = template.replace('{{memories}}', memoryLines);

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

function refreshSidebar() {
    const chatId = getChatId();
    const memories = chatId ? getMemories(chatId) : [];

    const countEl = document.getElementById('bb_memory_count');
    if (countEl) countEl.textContent = String(memories.length);

    const enabledEl = document.getElementById('bb_memory_enabled');
    if (enabledEl) enabledEl.checked = getSettings().enabled;

    const depthEl = document.getElementById('bb_memory_depth');
    if (depthEl) depthEl.value = String(getSettings().injectionDepth ?? DEFAULT_SETTINGS.injectionDepth);

    const maxEl = document.getElementById('bb_memory_max_results');
    if (maxEl) maxEl.value = String(getSettings().maxResults ?? DEFAULT_SETTINGS.maxResults);
}

function bindSidebarEvents() {
    // 启用/禁用开关
    document.getElementById('bb_memory_enabled')?.addEventListener('change', (e) => {
        updateSettings({ enabled: e.target.checked });
        if (!e.target.checked) clearInjection();
        console.log(`[${DISPLAY_NAME}] ${e.target.checked ? '已启用' : '已禁用'}`);
    });

    // 注入深度
    document.getElementById('bb_memory_depth')?.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 0) updateSettings({ injectionDepth: val });
    });

    // 最大检索数
    document.getElementById('bb_memory_max_results')?.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 1) updateSettings({ maxResults: val });
    });

    // 注入模板
    document.getElementById('bb_memory_template')?.addEventListener('change', (e) => {
        updateSettings({ injectionTemplate: e.target.value });
    });

    // 快速添加记忆按钮
    document.getElementById('bb_memory_add_btn')?.addEventListener('click', () => {
        handleAddMemory();
    });

    // 打开记忆管理面板
    document.getElementById('bb_memory_manage_btn')?.addEventListener('click', () => {
        openMemoryManager();
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

    const content = await showInputPopup('添加新记忆', '输入你想让角色记住的内容：');
    if (!content) return;

    addMemory(chatId, content, 'manual');
    toastr.success('记忆已添加', DISPLAY_NAME);
    refreshSidebar();
}

// ═══════════════════════════════════════════════════════════
//  记忆管理弹窗（完整的 CRUD 界面）
// ═══════════════════════════════════════════════════════════

async function openMemoryManager() {
    const chatId = getChatId();
    if (!chatId) {
        toastr.warning('请先选择一个角色并开始聊天', DISPLAY_NAME);
        return;
    }

    const memories = getMemories(chatId);

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
                <button class="menu_button menu_button_danger" id="bb_mgr_clear"
                        title="清空所有记忆">
                    <i class="fa-solid fa-trash"></i> 清空全部
                </button>
            </div>
        </div>
    `;
}

function buildMemoryItemHTML(m) {
    const date = new Date(m.createdAt).toLocaleString('zh-CN');
    const source = m.source === 'manual' ? '手动' : m.source === 'import' ? '导入' : m.source;
    const keywordsHTML = (m.keywords || [])
        .slice(0, 8)
        .map(k => `<span class="bb-mem-tag">${escapeHtml(k)}</span>`)
        .join('');

    return `
        <div class="bb-mem-item" data-id="${m.id}">
            <div class="bb-mem-item-content">${escapeHtml(m.content)}</div>
            <div class="bb-mem-item-meta">
                <span class="bb-mem-item-date">${date}</span>
                <span class="bb-mem-item-source">${source}</span>
                ${keywordsHTML}
            </div>
            <div class="bb-mem-item-actions">
                <button class="menu_button bb-mem-btn-sm bb-mem-edit" data-id="${m.id}"
                        title="编辑">
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
    // 关闭按钮
    overlay.querySelector('.bb-mem-close')?.addEventListener('click', () => {
        overlay.remove();
        refreshSidebar();
    });

    // 点击遮罩层关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.remove();
            refreshSidebar();
        }
    });

    // 添加记忆
    overlay.querySelector('#bb_mgr_add')?.addEventListener('click', async () => {
        const content = await showInputPopup('添加新记忆', '输入记忆内容：');
        if (!content) return;
        addMemory(chatId, content, 'manual');
        toastr.success('记忆已添加', DISPLAY_NAME);
        rerenderManagerList(overlay, chatId);
    });

    // 搜索
    overlay.querySelector('#bb_mgr_search')?.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        const memories = getMemories(chatId);

        if (!query) {
            rerenderManagerList(overlay, chatId);
            return;
        }

        const results = searchMemories(memories, query, 100);
        const listEl = overlay.querySelector('#bb_mgr_list');
        if (listEl) {
            listEl.innerHTML = results.length
                ? results.map(m => buildMemoryItemHTML(m)).join('')
                : '<div class="bb-mem-empty">未找到匹配的记忆</div>';
        }
        rebindItemActions(overlay, chatId);
    });

    // 导出
    overlay.querySelector('#bb_mgr_export')?.addEventListener('click', () => {
        const json = exportMemories(chatId);
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
            reader.onload = (ev) => {
                try {
                    const count = importMemories(chatId, ev.target.result);
                    toastr.success(`成功导入 ${count} 条记忆`, DISPLAY_NAME);
                    rerenderManagerList(overlay, chatId);
                } catch (err) {
                    toastr.error(`导入失败：${err.message}`, DISPLAY_NAME);
                }
            };
            reader.readAsText(file);
        });
        input.click();
    });

    // 清空全部
    overlay.querySelector('#bb_mgr_clear')?.addEventListener('click', async () => {
        const ok = await showConfirmPopup('确认清空', '确定要删除所有记忆吗？此操作不可撤销。');
        if (!ok) return;
        clearMemories(chatId);
        toastr.info('所有记忆已清空', DISPLAY_NAME);
        rerenderManagerList(overlay, chatId);
    });

    rebindItemActions(overlay, chatId);
}

function rebindItemActions(overlay, chatId) {
    // 删除按钮（使用事件委托）
    overlay.querySelectorAll('.bb-mem-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const ok = await showConfirmPopup('确认删除', '确定要删除这条记忆吗？');
            if (!ok) return;
            removeMemory(chatId, id);
            toastr.info('记忆已删除', DISPLAY_NAME);
            rerenderManagerList(overlay, chatId);
        });
    });

    // 编辑按钮
    overlay.querySelectorAll('.bb-mem-edit').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const memories = getMemories(chatId);
            const memory = memories.find(m => m.id === id);
            if (!memory) return;

            const newContent = await showInputPopup('编辑记忆', '修改记忆内容：', memory.content);
            if (!newContent || newContent === memory.content) return;

            updateMemory(chatId, id, newContent);
            toastr.success('记忆已更新', DISPLAY_NAME);
            rerenderManagerList(overlay, chatId);
        });
    });
}

function rerenderManagerList(overlay, chatId) {
    const memories = getMemories(chatId);
    const listEl = overlay.querySelector('#bb_mgr_list');
    if (listEl) {
        listEl.innerHTML = memories.length
            ? memories.map(m => buildMemoryItemHTML(m)).join('')
            : '<div class="bb-mem-empty">暂无记忆</div>';
    }
    const statsEl = overlay.querySelector('.bb-mem-stats');
    if (statsEl) statsEl.innerHTML = `共 <strong>${memories.length}</strong> 条记忆`;
    rebindItemActions(overlay, chatId);
}

// ═══════════════════════════════════════════════════════════
//  通用 UI 工具
// ═══════════════════════════════════════════════════════════

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function showInputPopup(title, message, defaultValue = '') {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.Popup && ctx.POPUP_TYPE) {
            const popup = new ctx.Popup(
                `<h3>${title}</h3><p>${message}</p>`,
                ctx.POPUP_TYPE.INPUT,
                defaultValue,
                { okButton: '确定', cancelButton: '取消' },
            );
            const result = await popup.show();
            if (result === null || result === undefined) return null;
            return String(result).trim() || null;
        }
    } catch { /* Popup API 不可用，使用 fallback */ }

    const result = prompt(`${title}\n${message}`, defaultValue);
    return result?.trim() || null;
}

async function showConfirmPopup(title, message) {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.Popup && ctx.POPUP_TYPE) {
            const popup = new ctx.Popup(
                `<h3>${title}</h3><p>${message}</p>`,
                ctx.POPUP_TYPE.CONFIRM,
                '',
                { okButton: '确定', cancelButton: '取消' },
            );
            const result = await popup.show();
            return !!result;
        }
    } catch { /* fallback */ }

    return confirm(`${title}\n${message}`);
}

// ═══════════════════════════════════════════════════════════
//  事件处理
// ═══════════════════════════════════════════════════════════

function onChatChanged() {
    clearInjection();
    refreshSidebar();
    console.log(`[${DISPLAY_NAME}] 聊天已切换，记忆上下文已重置`);
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

    // 加载侧边栏 HTML 模板并添加到设置面板
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

    // 绑定侧边栏事件
    bindSidebarEvents();

    // 监听 SillyTavern 事件
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, onChatChanged);

    // 首次加载时刷新侧边栏
    refreshSidebar();

    console.log(`[${DISPLAY_NAME}] 初始化完成 ✓`);
}

// ═══ 启动 ═══
// 等待 SillyTavern 完全加载后再初始化
(function startup() {
    const ctx = SillyTavern.getContext();

    if (ctx.eventSource && ctx.eventTypes) {
        ctx.eventSource.on(ctx.eventTypes.APP_READY, () => init());
    } else {
        // APP_READY 可能已经触发过了（扩展后加载的情况）
        if (document.getElementById('extensions_settings2')) {
            init();
        } else {
            window.addEventListener('load', () => init());
        }
    }
})();
