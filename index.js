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
    getMemories,
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
import { initAutoGenerator, stopAutoGenerator, extractFromContext, saveExtractedMemories, normalizeEndpoint, setAutoExtractProgressCallback, getPendingAutoCandidates, clearPendingAutoCandidates } from './auto-generator.js';
import { syncMessageVisibility, refreshExtractionMarkers, markExchangeExtracted, hideExchange } from './message-state.js';
import { getCharacterId, listSlots, saveToSlot, loadFromSlot, createEmptySlot, deleteSlot } from './memory-slots.js';
import { getPersistentMemories, addPersistentMemory, updatePersistentMemory, removePersistentMemory } from './persistent-memory.js';
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

// ST 核心模块 API 通过 SillyTavern.getContext() 获取，不使用静态导入
// 参见官方文档: https://docs.sillytavern.app/for-contributors/writing-extensions
// "Using imports from SillyTavern code is unreliable and can break at any time"

// ═══════════════════════════════════════════════════════════
//  常量
// ═══════════════════════════════════════════════════════════

const DISPLAY_NAME = 'BB-Memory';
const INJECTION_KEY = 'bb_memory_injection';

const POSITION_IN_CHAT = 1;
const ROLE_SYSTEM = 0;

// v2.9.5：命中追踪缓存
let lastRetrievalResult = { chatId: null, hits: [], timestamp: 0, stats: null };

// v2.9.8：管理面板当前类型筛选
let activeFilter = 'all';

// ═══════════════════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * SillyTavern 内部扩展目录键（传给 renderExtensionTemplateAsync 的第一个参数）。
 * 必须与磁盘上的扩展路径一致（通常为 third-party/<文件夹名>），参见官方文档：
 * https://docs.sillytavern.app/for-contributors/writing-extensions
 */
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

    // 常驻档案（NPC/物品/时间线）—— v2.9.5
    const persistentMemories = await getPersistentMemories(chatId);

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

    if (!persistentMemories.length && !residentMemories.length && !relevantResults.length) {
        clearInjection();
        return chat;
    }

    // 巩固被检索到的记忆
    const resultIds = relevantResults.map(r => r.memory.id);
    if (resultIds.length) reinforceMemories(chatId, resultIds);

    // 构建分区注入文本
    const { text: injectionText, tokenEstimate, stats } = buildMemoryInjectionPrompt({
        persistentMemories,
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
        `[${DISPLAY_NAME}] 注入: 档案${stats.persistentCount || 0} 常驻${stats.residentCount} L3×${stats.l3} L2×${stats.l2} L1×${stats.l1} ≈${tokenEstimate}tok`,
    );

    // v2.9.5：存储命中追踪数据
    lastRetrievalResult = {
        chatId,
        hits: relevantResults.map(r => ({
            id: r.memory.id,
            title: r.memory.title || r.memory.content.slice(0, 30),
            cognitiveType: r.memory.cognitiveType,
            score: r.score,
            level: r.level,
        })),
        timestamp: Date.now(),
        stats: { ...stats },
    };
    // 更新侧边栏命中显示
    renderHitDisplay();

    // v2.9.8: active+popup 模式，检查是否需要弹出浮动审核
    const confirmMode = settings.extractionConfirmMode || 'semi';
    const confirmStyle = settings.activeConfirmStyle || 'popup';
    if (confirmMode === 'active' && confirmStyle === 'popup') {
        const pending = getPendingAutoCandidates();
        if (pending.length > 0) {
            showFloatingReviewPanel(chatId, pending);
            clearPendingAutoCandidates();
        }
    }

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

    const debugLogEl = document.getElementById('bb_memory_debug_logging');
    if (debugLogEl) debugLogEl.checked = getSettings().debugLogging;

    const maxExchangesEl = document.getElementById('bb_memory_auto_max_exchanges');
    if (maxExchangesEl) maxExchangesEl.value = String(getSettings().autoGenMaxExchanges ?? 3);

    // v2.9.8: 确认模式
    const confirmModeEl = document.getElementById('bb_memory_extract_confirm_mode');
    if (confirmModeEl) confirmModeEl.value = getSettings().extractionConfirmMode || 'semi';

    const confirmStyleEl = document.getElementById('bb_memory_active_confirm_style');
    if (confirmStyleEl) confirmStyleEl.value = getSettings().activeConfirmStyle || 'popup';

    const confirmStyleSection = document.getElementById('bb_active_confirm_style_section');
    if (confirmStyleSection) {
        confirmStyleSection.style.display = (getSettings().extractionConfirmMode === 'active') ? 'block' : 'none';
    }

    const contextWindowEl = document.getElementById('bb_memory_context_window');
    if (contextWindowEl) contextWindowEl.value = String(getSettings().contextWindowExchanges ?? 5);

    // v2.9.9: 总结模式
    const summaryModeEl = document.getElementById('bb_memory_summary_mode');
    if (summaryModeEl) summaryModeEl.value = getSettings().summaryMode || 'roleplay';

    const excludedNpcsEl = document.getElementById('bb_memory_excluded_npcs');
    if (excludedNpcsEl) excludedNpcsEl.value = getSettings().excludedNpcs || '';

    // v3.0.0: 批量提取模式
    const extractionBatchModeEl = document.getElementById('bb_memory_extraction_batch_mode');
    if (extractionBatchModeEl) extractionBatchModeEl.value = getSettings().extractionBatchMode || 'single';

    restoreApiSettings(getSettings());

    // v2.9.5：刷新命中记忆显示
    renderHitDisplay();

    // v3.3: 同步侧边栏楼层可见按钮图标
    const visIcon = document.querySelector('#bb_memory_toggle_vis_btn i');
    if (visIcon) {
        const showing = document.body.classList.contains('bb-show-extracted');
        visIcon.className = showing ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
    }
}

/**
 * 恢复副 API 配置字段到 UI
 */
function restoreApiSettings(s) {
    const apiModeEl = document.getElementById('bb_memory_api_mode');
    if (apiModeEl) apiModeEl.value = s.autoGenMode || 'main';

    const endpointEl = document.getElementById('bb_memory_api_endpoint');
    if (endpointEl) endpointEl.value = s.autoGenEndpoint || '';

    const keyEl = document.getElementById('bb_memory_api_key');
    if (keyEl) keyEl.value = s.autoGenApiKey || '';

    const modelEl = document.getElementById('bb_memory_api_model');
    if (modelEl) modelEl.value = s.autoGenModel || '';

    const customSection = document.getElementById('bb_memory_custom_api_section');
    if (customSection) {
        customSection.style.display = s.autoGenMode === 'custom' ? 'block' : 'none';
    }
}

// v2.9.8：渲染命中记忆列表（支持点击展开）
function renderHitDisplay() {
    const listEl = document.getElementById('bb_hit_list');
    const tsEl = document.getElementById('bb_hit_timestamp');
    if (!listEl) return;

    const result = lastRetrievalResult;
    if (!result.hits || !result.hits.length) {
        listEl.innerHTML = '<div class="bb-mem-empty">等待下一次 AI 生成...</div>';
        if (tsEl) tsEl.textContent = '';
        return;
    }

    if (tsEl && result.timestamp) {
        tsEl.textContent = new Date(result.timestamp).toLocaleTimeString('zh-CN');
    }

    const typeIcons = { fact: 'fa-lightbulb', episode: 'fa-film', emotion: 'fa-heart', habit: 'fa-repeat' };
    const levelColors = { L4: '#ce93d8', L3: '#4fc3f7', L2: '#ffb74d', L1: '#9e9e9e' };

    listEl.innerHTML = result.hits.map(h => {
        const icon = typeIcons[h.cognitiveType] || 'fa-circle';
        const color = levelColors[h.level] || '#888';
        const scorePct = Math.round(h.score * 100);
        return `<div class="bb-hit-item" data-memory-id="${h.id}" title="点击查看完整记忆">
            <i class="fa-solid ${icon}" style="color:${color};font-size:0.8em;"></i>
            <span class="bb-hit-title">${escapeHtml(h.title)}</span>
            <span class="bb-hit-score">${scorePct}%</span>
            <span class="bb-hit-level" style="color:${color}">${h.level}</span>
            <i class="fa-solid fa-chevron-right bb-hit-expand-icon" style="font-size:0.7em;opacity:0.4;"></i>
        </div>
        <div class="bb-hit-detail" id="bb_hit_detail_${h.id}" style="display:none;"></div>`;
    }).join('');

    if (result.stats) {
        listEl.innerHTML += `<div class="bb-hit-stats">
            档案${result.stats.persistentCount || 0} 常驻${result.stats.residentCount || 0} L3×${result.stats.l3 || 0} L2×${result.stats.l2 || 0} L1×${result.stats.l1 || 0}
        </div>`;
    }

    bindHitItemClicks(listEl);
}

// v2.9.8：绑定命中记忆点击展开事件
async function bindHitItemClicks(listEl) {
    listEl.querySelectorAll('.bb-hit-item').forEach(item => {
        item.addEventListener('click', async () => {
            const memoryId = item.dataset.memoryId;
            if (!memoryId) return;

            const detailEl = document.getElementById(`bb_hit_detail_${memoryId}`);
            if (!detailEl) return;

            if (detailEl.style.display === 'none' || !detailEl.style.display) {
                try {
                    const chatId = getChatId();
                    if (!chatId) return;
                    const memories = await getMemories(chatId);
                    const mem = memories.find(m => m.id === memoryId);
                    if (!mem) {
                        detailEl.innerHTML = '<div class="bb-mem-empty" style="padding:6px;">记忆已不存在</div>';
                    } else {
                        const typeDef = getTypeDefinition(mem.cognitiveType || 'fact');
                        detailEl.innerHTML = `
                            <div class="bb-hit-detail-card">
                                <div class="bb-hit-detail-header">
                                    <span style="color:${typeDef.color}"><i class="${typeDef.icon}"></i> ${typeDef.label}</span>
                                    <span class="bb-hit-detail-date">${new Date(mem.createdAt).toLocaleString('zh-CN')}</span>
                                </div>
                                <div class="bb-hit-detail-title">${escapeHtml(mem.title || '(无标题)')}</div>
                                <div class="bb-hit-detail-content">${escapeHtml(mem.content)}</div>
                                ${mem.summary ? `<div class="bb-hit-detail-summary"><strong>摘要：</strong>${escapeHtml(mem.summary)}</div>` : ''}
                                ${mem.verbatim ? `<div class="bb-hit-detail-verbatim"><strong>原话：</strong>"${escapeHtml(mem.verbatim)}"</div>` : ''}
                                <div class="bb-hit-detail-meta">
                                    <span>强度: ${Math.round((mem.strength || 1) * 100)}%</span>
                                    <span>来源: ${mem.source || 'unknown'}</span>
                                    <span>${mem.status || 'active'}</span>
                                </div>
                            </div>
                        `;
                    }
                } catch (e) {
                    detailEl.innerHTML = '<div class="bb-mem-empty" style="padding:6px;">加载失败</div>';
                }
                detailEl.style.display = 'block';
                item.querySelector('.bb-hit-expand-icon')?.classList.replace('fa-chevron-right', 'fa-chevron-down');
                item.style.background = 'var(--SmartThemeBlurTintColor, rgba(255,255,255,0.08))';
            } else {
                detailEl.style.display = 'none';
                item.querySelector('.bb-hit-expand-icon')?.classList.replace('fa-chevron-down', 'fa-chevron-right');
                item.style.background = '';
            }
        });
        item.style.cursor = 'pointer';
    });
}

// v3.1: 渲染悬浮窗命中记忆列表（紧凑版）
// v3.3: 追加展示概率最高但未命中的 5 条记忆
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

    if (!result.hits || !result.hits.length) {
        listEl.innerHTML = '<div class="bb-hub-hit-item" style="opacity:0.5;justify-content:center;">暂无命中记忆</div>';
        return;
    }

    let html = result.hits.map(h => renderHubHitItem(h, typeIcons, levelColors, false)).join('');

    // v3.3: 追加概率最高但未命中的 5 条记忆
    try {
        const allMemories = await getMemories(chatId);
        const hitIds = new Set(result.hits.map(h => h.id));
        const nonHitMemories = allMemories.filter(m => !hitIds.has(m.id));
        nonHitMemories.sort((a, b) => (b.strength || 0) * (b.importance || 0) - (a.strength || 0) * (a.importance || 0));
        const top5 = nonHitMemories.slice(0, 5);
        if (top5.length > 0) {
            const typeHint = { fact: 'fact', episode: 'episode', emotion: 'emotion', habit: 'habit' };
            html += '<div class="bb-hub-hit-item" style="opacity:0.4;justify-content:center;font-size:0.7em;border-top:1px solid var(--SmartThemeBorderColor,#444);margin-top:2px;padding-top:4px;">— 未命中高分记忆 —</div>';
            html += top5.map(m => renderHubHitItem({
                id: m.id,
                title: m.title || m.content.slice(0, 30),
                cognitiveType: m.cognitiveType || typeHint[m.type] || 'fact',
                score: (m.strength || 0) * (m.importance || 0),
                level: m.resident ? 'L4' : 'L1',
            }, typeIcons, levelColors, true)).join('');
        }
    } catch (e) {
        // 获取全量记忆失败时忽略，不影响命中列表主流程
    }

    listEl.innerHTML = html;
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

    document.getElementById('bb_memory_debug_logging')?.addEventListener('change', (e) => {
        updateSettings({ debugLogging: e.target.checked });
    });

    // v2.9.5：每轮最大提取数
    document.getElementById('bb_memory_auto_max_exchanges')?.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 1 && val <= 20) updateSettings({ autoGenMaxExchanges: val });
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

    // 测试 API 连接
    document.getElementById('bb_memory_test_api')?.addEventListener('click', async () => {
        const resultEl = document.getElementById('bb_memory_test_result');
        const settings = getSettings();

        if (!settings.autoGenEndpoint) {
            if (resultEl) {
                resultEl.style.color = '#f44336';
                resultEl.innerHTML = '<i class="fa-solid fa-times-circle"></i> 请先填写 API 端点';
            }
            return;
        }

        if (resultEl) {
            resultEl.style.color = '';
            resultEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中...';
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            const testEndpoint = normalizeEndpoint(settings.autoGenEndpoint);

            const response = await fetch(testEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${settings.autoGenApiKey}`,
                },
                body: JSON.stringify({
                    model: settings.autoGenModel || 'gpt-3.5-turbo',
                    messages: [
                        { role: 'user', content: 'Hello, respond with just "OK".' }
                    ],
                    max_tokens: 5,
                    temperature: 0,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }

            if (resultEl) {
                resultEl.style.color = '#4caf50';
                resultEl.innerHTML = '<i class="fa-solid fa-check-circle"></i> 连接成功';
            }
            toastr.success('API 连接测试成功', DISPLAY_NAME);
        } catch (err) {
            if (resultEl) {
                resultEl.style.color = '#f44336';
                resultEl.innerHTML = `<i class="fa-solid fa-times-circle"></i> ${err.name === 'AbortError' ? '连接超时' : err.message}`;
            }
            toastr.error(`API 连接测试失败：${err.name === 'AbortError' ? '连接超时（10秒）' : err.message}`, DISPLAY_NAME);
        }
    });

    // 自定义提示词
    document.getElementById('bb_memory_auto_prompt')?.addEventListener('change', (e) => {
        updateSettings({ autoGenPrompt: e.target.value });
    });
    document.getElementById('bb_memory_context_prompt')?.addEventListener('change', (e) => {
        updateSettings({ autoGenContextPrompt: e.target.value });
    });
    document.getElementById('bb_memory_reset_auto_prompt')?.addEventListener('click', (e) => {
        e.preventDefault();
        const el = document.getElementById('bb_memory_auto_prompt');
        if (el) { el.value = ''; updateSettings({ autoGenPrompt: '' }); }
        toastr.info('已恢复默认对话提取提示词', DISPLAY_NAME);
    });
    document.getElementById('bb_memory_reset_context_prompt')?.addEventListener('click', (e) => {
        e.preventDefault();
        const el = document.getElementById('bb_memory_context_prompt');
        if (el) { el.value = ''; updateSettings({ autoGenContextPrompt: '' }); }
        toastr.info('已恢复默认上下文提取提示词', DISPLAY_NAME);
    });

    // v2.9.8: 确认模式
    document.getElementById('bb_memory_extract_confirm_mode')?.addEventListener('change', (e) => {
        updateSettings({ extractionConfirmMode: e.target.value });
        const styleSection = document.getElementById('bb_active_confirm_style_section');
        if (styleSection) {
            styleSection.style.display = e.target.value === 'active' ? 'block' : 'none';
        }
    });
    document.getElementById('bb_memory_active_confirm_style')?.addEventListener('change', (e) => {
        updateSettings({ activeConfirmStyle: e.target.value });
    });
    // v2.9.8: 上下文窗口
    document.getElementById('bb_memory_context_window')?.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 2 && val <= 20) updateSettings({ contextWindowExchanges: val });
    });

    // v2.9.9: 总结模式
    document.getElementById('bb_memory_summary_mode')?.addEventListener('change', (e) => {
        updateSettings({ summaryMode: e.target.value });
    });
    document.getElementById('bb_memory_excluded_npcs')?.addEventListener('change', (e) => {
        updateSettings({ excludedNpcs: e.target.value.trim() });
    });

    // v3.0.0: 批量提取模式
    document.getElementById('bb_memory_extraction_batch_mode')?.addEventListener('change', (e) => {
        updateSettings({ extractionBatchMode: e.target.value });
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

    // v3.3: 侧边栏手动提取
    document.getElementById('bb_memory_extract_btn')?.addEventListener('click', async () => {
        const chatId = getChatId();
        if (chatId) {
            try { await import('./auto-generator.js').then(m => m.autoExtractOnce?.(chatId)); } catch {}
        }
        if (typeof handleAiExtract === 'function') {
            handleAiExtract(chatId);
        } else {
            toastr.info('请使用管理面板中的"AI提取"按钮', DISPLAY_NAME);
        }
    });

    // v3.3: 侧边栏标记最后消息
    document.getElementById('bb_memory_meta_btn')?.addEventListener('click', () => {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat || chat.length < 2) {
            toastr.warning('聊天消息不足', DISPLAY_NAME);
            return;
        }
        let aiIdx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && !chat[i].is_system) { aiIdx = i; break; }
        }
        if (aiIdx === -1) { toastr.warning('未找到 AI 消息', DISPLAY_NAME); return; }
        chat[aiIdx]._bbmem_meta_marker = !chat[aiIdx]._bbmem_meta_marker;
        try { ctx.saveChatDebounced(); } catch {}
        setTimeout(() => { if (typeof refreshExtractionMarkers === 'function') refreshExtractionMarkers(); }, 100);
        const label = chat[aiIdx]._bbmem_meta_marker ? '🤖 已标记为元指令（不提取）' : '🗃️ 已标记为可提取';
        toastr.info(label, DISPLAY_NAME, { timeOut: 1500 });
    });

    // v3.3: 侧边栏切换楼层可见
    document.getElementById('bb_memory_toggle_vis_btn')?.addEventListener('click', () => {
        document.body.classList.toggle('bb-show-extracted');
        const showing = document.body.classList.contains('bb-show-extracted');
        toastr.info(showing ? '已显示被隐藏的楼层' : '已隐藏已提取的楼层', DISPLAY_NAME, { timeOut: 1500 });
        // 更新按钮图标
        const icon = document.querySelector('#bb_memory_toggle_vis_btn i');
        if (icon) {
            icon.className = showing ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
        }
    });

    // 世界书导入按钮
    document.getElementById('bb_memory_import_wb_btn')?.addEventListener('click', () => {
        handleWorldBookImport();
    });

    // AI摘要导入按钮
    document.getElementById('bb_memory_import_wb_ai_btn')?.addEventListener('click', () => {
        handleWorldBookImportWithAI();
    });
}

// ═══════════════════════════════════════════════════════════
//  手动添加记忆表单
// ═══════════════════════════════════════════════════════════

async function handleAddMemory() {
    const chatId = getChatId();
    if (!chatId) {
        toastr.warning('请先选择一个角色并开始聊天', DISPLAY_NAME);
        return;
    }
    openAddMemoryForm(chatId, () => refreshSidebar());
}

function openAddMemoryForm(chatId, onSaved) {
    // 避免重复弹窗
    if (document.querySelector('.bb-mem-form-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'bb-mem-form-overlay';
    overlay.innerHTML = buildAddMemoryFormHTML();
    document.body.appendChild(overlay);

    bindAddMemoryFormEvents(overlay, chatId, onSaved);
}

function buildAddMemoryFormHTML() {
    const cogTypes = [
        { id: 'episode', label: '情景' },
        { id: 'fact', label: '事实' },
        { id: 'emotion', label: '情感' },
        { id: 'habit', label: '习惯' },
    ];

    const truthStatuses = [
        { id: 'true', label: '已确认' },
        { id: 'unknown', label: '未知' },
        { id: 'rumor', label: '传闻' },
        { id: 'misleading', label: '误导' },
        { id: 'secret_true', label: '隐藏真相' },
        { id: 'false', label: '已否定' },
    ];

    return `
        <div class="bb-mem-form-popup">
            <div class="bb-mem-form-header">
                <h3><i class="fa-solid fa-plus"></i> 添加新记忆</h3>
                <span class="bb-mem-close" title="关闭">&times;</span>
            </div>
            <div class="bb-mem-form-body">
                <div class="bb-mem-form-group">
                    <label>记忆内容 <span class="bb-mem-form-hint">（必填）</span></label>
                    <textarea class="text_pole" id="bb_form_content" rows="3"
                              placeholder="输入记忆的完整内容..."></textarea>
                </div>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>认知类型</label>
                        <select class="text_pole" id="bb_form_cog_type">
                            ${cogTypes.map(t => `<option value="${t.id}">${t.label}</option>`).join('')}
                        </select>
                    </div>
                    <div class="bb-mem-form-group">
                        <label>分类路径</label>
                        <select class="text_pole" id="bb_form_cat_path"></select>
                    </div>
                </div>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>标题 <span class="bb-mem-form-hint">3-8字</span></label>
                        <input type="text" class="text_pole" id="bb_form_title" placeholder="简短标题" />
                    </div>
                    <div class="bb-mem-form-group">
                        <label>摘要 <span class="bb-mem-form-hint">一句话</span></label>
                        <input type="text" class="text_pole" id="bb_form_summary" placeholder="一句话总结" />
                    </div>
                </div>
                <div class="bb-mem-form-group">
                    <label>原话 <span class="bb-mem-form-hint">重要的角色原话/引用</span></label>
                    <input type="text" class="text_pole" id="bb_form_verbatim" placeholder="「...」" />
                </div>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>主体</label>
                        <input type="text" class="text_pole" id="bb_form_subject" placeholder="主要实体名，多个用逗号分隔" />
                    </div>
                    <div class="bb-mem-form-group">
                        <label>对象</label>
                        <input type="text" class="text_pole" id="bb_form_target" placeholder="关联对象名，多个用逗号分隔" />
                    </div>
                </div>
                <div class="bb-mem-form-group">
                    <label>地点</label>
                    <input type="text" class="text_pole" id="bb_form_location" placeholder="发生地点" />
                </div>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>重要性: <span id="bb_form_importance_val" class="bb-mem-form-slider-val">50</span></label>
                        <div class="bb-mem-form-slider-row">
                            <span>0</span>
                            <input type="range" min="0" max="100" value="50" id="bb_form_importance" />
                            <span>100</span>
                        </div>
                    </div>
                    <div class="bb-mem-form-group">
                        <label>情感强度: <span id="bb_form_emotion_val" class="bb-mem-form-slider-val">0</span></label>
                        <div class="bb-mem-form-slider-row">
                            <span>0</span>
                            <input type="range" min="0" max="100" value="0" id="bb_form_emotion" />
                            <span>100</span>
                        </div>
                    </div>
                </div>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>可信度</label>
                        <select class="text_pole" id="bb_form_truth">
                            ${truthStatuses.map(t => `<option value="${t.id}">${t.label}</option>`).join('')}
                        </select>
                    </div>
                    <div class="bb-mem-form-group">
                        <label>标签 <span class="bb-mem-form-hint">逗号分隔</span></label>
                        <input type="text" class="text_pole" id="bb_form_tags" placeholder="关键词1, 关键词2" />
                    </div>
                </div>
                <div class="bb-mem-form-row" id="bb_form_npc_row" style="display:none;">
                    <div class="bb-mem-form-group">
                        <label>NPC 分级</label>
                        <select class="text_pole" id="bb_form_npc_tier">
                            <option value="">— 不适用 —</option>
                            <option value="core">核心 (core)</option>
                            <option value="important">重要 (important)</option>
                            <option value="minor">普通 (minor)</option>
                            <option value="background">路人 (background)</option>
                        </select>
                    </div>
                </div>
                <div class="bb-mem-form-row" id="bb_form_item_row" style="display:none;">
                    <div class="bb-mem-form-group">
                        <label>物品分级</label>
                        <select class="text_pole" id="bb_form_item_tier">
                            <option value="">— 不适用 —</option>
                            <option value="key">关键 (key)</option>
                            <option value="equipped">持有 (equipped)</option>
                            <option value="clue">线索 (clue)</option>
                            <option value="consumable">消耗品 (consumable)</option>
                            <option value="background">背景 (background)</option>
                        </select>
                    </div>
                </div>
                <div class="bb-mem-form-group">
                    <label class="bb-mem-form-check">
                        <input type="checkbox" id="bb_form_resident" />
                        <span>常驻记忆（每轮自动注入索引卡）</span>
                    </label>
                </div>
            </div>
            <div class="bb-mem-form-footer">
                <button class="menu_button" id="bb_form_cancel">
                    <i class="fa-solid fa-times"></i> 取消
                </button>
                <button class="menu_button" id="bb_form_save" style="background:#4caf50;color:#fff;">
                    <i class="fa-solid fa-save"></i> 保存
                </button>
            </div>
        </div>
    `;
}

function bindAddMemoryFormEvents(overlay, chatId, onSaved) {
    const CATEGORY_PATHS = [
        { path: 'world.politics', label: '世界·政治', type: 'fact' },
        { path: 'world.lore', label: '世界·背景', type: 'fact' },
        { path: 'world.rules', label: '世界·规则', type: 'fact' },
        { path: 'npc.profile', label: 'NPC·档案', type: 'fact' },
        { path: 'npc.relationship', label: 'NPC·关系', type: 'fact' },
        { path: 'npc.emotion', label: 'NPC·情感线', type: 'emotion' },
        { path: 'npc.secret', label: 'NPC·秘密', type: 'episode' },
        { path: 'npc.goal', label: 'NPC·目标', type: 'fact' },
        { path: 'npc.attitude', label: 'NPC·态度', type: 'emotion' },
        { path: 'item.ownership', label: '物品·持有', type: 'fact' },
        { path: 'item.quest', label: '物品·任务', type: 'fact' },
        { path: 'item.key', label: '物品·关键', type: 'fact' },
        { path: 'item.clue', label: '物品·线索', type: 'fact' },
        { path: 'location.state', label: '地点·状态', type: 'fact' },
        { path: 'location.map', label: '地点·地图', type: 'fact' },
        { path: 'episode.event', label: '情景·事件', type: 'episode' },
        { path: 'episode.promise', label: '情景·承诺', type: 'episode' },
        { path: 'episode.secret', label: '情景·秘密', type: 'episode' },
        { path: 'episode.dialogue', label: '情景·对话', type: 'episode' },
        { path: 'episode.combat', label: '情景·战斗', type: 'episode' },
        { path: 'emotion.bond', label: '情感·羁绊', type: 'emotion' },
        { path: 'emotion.trauma', label: '情感·创伤', type: 'emotion' },
        { path: 'emotion.desire', label: '情感·愿望', type: 'emotion' },
        { path: 'habit.routine', label: '习惯·日常', type: 'habit' },
        { path: 'habit.preference', label: '习惯·偏好', type: 'habit' },
        { path: 'habit.speech', label: '习惯·语言', type: 'habit' },
    ];

    function updateCategoryPathSelect(cognitiveType) {
        const select = overlay.querySelector('#bb_form_cat_path');
        if (!select) return;
        const filtered = CATEGORY_PATHS.filter(p => p.type === cognitiveType);
        select.innerHTML = filtered.map(p =>
            `<option value="${p.path}">${p.label}</option>`
        ).join('');

        // 条件显示 NPC/物品分级行
        const npcRow = overlay.querySelector('#bb_form_npc_row');
        const itemRow = overlay.querySelector('#bb_form_item_row');
        const firstPath = filtered[0]?.path || '';
        if (npcRow) npcRow.style.display = firstPath.startsWith('npc.') ? 'flex' : 'none';
        if (itemRow) itemRow.style.display = firstPath.startsWith('item.') ? 'flex' : 'none';
    }

    // 初始化分类路径下拉
    updateCategoryPathSelect('episode');

    // 认知类型变化 → 更新分类路径 + 条件行
    overlay.querySelector('#bb_form_cog_type')?.addEventListener('change', (e) => {
        updateCategoryPathSelect(e.target.value);
    });

    // 分类路径变化 → 条件行
    overlay.querySelector('#bb_form_cat_path')?.addEventListener('change', (e) => {
        const npcRow = overlay.querySelector('#bb_form_npc_row');
        const itemRow = overlay.querySelector('#bb_form_item_row');
        const val = e.target.value;
        if (npcRow) npcRow.style.display = val.startsWith('npc.') ? 'flex' : 'none';
        if (itemRow) itemRow.style.display = val.startsWith('item.') ? 'flex' : 'none';
    });

    // 滑块实时更新
    overlay.querySelector('#bb_form_importance')?.addEventListener('input', (e) => {
        const valEl = overlay.querySelector('#bb_form_importance_val');
        if (valEl) valEl.textContent = e.target.value;
    });
    overlay.querySelector('#bb_form_emotion')?.addEventListener('input', (e) => {
        const valEl = overlay.querySelector('#bb_form_emotion_val');
        if (valEl) valEl.textContent = e.target.value;
    });

    // 关闭
    function closeForm() {
        overlay.remove();
    }

    overlay.querySelector('.bb-mem-close')?.addEventListener('click', closeForm);
    overlay.querySelector('#bb_form_cancel')?.addEventListener('click', closeForm);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeForm();
    });

    // 保存
    overlay.querySelector('#bb_form_save')?.addEventListener('click', async () => {
        const content = overlay.querySelector('#bb_form_content')?.value?.trim();
        if (!content) {
            toastr.warning('请输入记忆内容', DISPLAY_NAME);
            return;
        }

        const cognitiveType = overlay.querySelector('#bb_form_cog_type')?.value || 'episode';
        const categoryPath = overlay.querySelector('#bb_form_cat_path')?.value || '';
        const title = overlay.querySelector('#bb_form_title')?.value?.trim() || '';
        const summary = overlay.querySelector('#bb_form_summary')?.value?.trim() || '';
        const verbatim = overlay.querySelector('#bb_form_verbatim')?.value?.trim() || '';
        const subjectRaw = overlay.querySelector('#bb_form_subject')?.value?.trim() || '';
        const targetRaw = overlay.querySelector('#bb_form_target')?.value?.trim() || '';
        const subject = subjectRaw ? subjectRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean).join(', ') : '';
        const target = targetRaw ? targetRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean).join(', ') : '';
        const location = overlay.querySelector('#bb_form_location')?.value?.trim() || '';
        const importance = parseInt(overlay.querySelector('#bb_form_importance')?.value || '50', 10) / 100;
        const emotionalWeight = parseInt(overlay.querySelector('#bb_form_emotion')?.value || '0', 10) / 100;
        const truthStatus = overlay.querySelector('#bb_form_truth')?.value || 'true';
        const tagsRaw = overlay.querySelector('#bb_form_tags')?.value?.trim() || '';
        const npcTier = overlay.querySelector('#bb_form_npc_tier')?.value || '';
        const itemTier = overlay.querySelector('#bb_form_item_tier')?.value || '';
        const resident = overlay.querySelector('#bb_form_resident')?.checked || false;

        const tags = tagsRaw
            ? tagsRaw.split(/[,，]/).map(t => t.trim()).filter(Boolean).map(t => ({ name: t, weight: 0.6 }))
            : [];

        await addMemory(chatId, content, cognitiveType, 'manual', {
            categoryPath,
            title,
            summary,
            verbatim,
            subject,
            target,
            location,
            importance,
            emotionalWeight,
            truthStatus,
            tags,
            npcTier: npcTier || undefined,
            itemTier: itemTier || undefined,
            resident,
        });

        toastr.success('记忆已添加', DISPLAY_NAME);
        closeForm();
        if (onSaved) onSaved();
    });
}

// ═══════════════════════════════════════════════════════════
//  编辑记忆表单
// ═══════════════════════════════════════════════════════════

function openEditMemoryForm(chatId, memory, onSaved) {
    if (document.querySelector('.bb-mem-form-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'bb-mem-form-overlay';
    overlay.innerHTML = buildEditMemoryFormHTML(memory);
    document.body.appendChild(overlay);

    bindEditMemoryFormEvents(overlay, chatId, memory, onSaved);
}

function buildEditMemoryFormHTML(memory) {
    const cogTypes = [
        { id: 'episode', label: '情景' },
        { id: 'fact', label: '事实' },
        { id: 'emotion', label: '情感' },
        { id: 'habit', label: '习惯' },
    ];

    const truthStatuses = [
        { id: 'true', label: '已确认' },
        { id: 'unknown', label: '未知' },
        { id: 'rumor', label: '传闻' },
        { id: 'misleading', label: '误导' },
        { id: 'secret_true', label: '隐藏真相' },
        { id: 'false', label: '已否定' },
    ];

    const cogType = memory.cognitiveType || 'episode';
    const importanceVal = Math.round((memory.importance || 0.5) * 100);
    const emotionVal = Math.round((memory.emotionalWeight || 0) * 100);
    const tagsStr = (memory.tags || []).map(t => typeof t === 'string' ? t : t.name).join(', ');

    return `
        <div class="bb-mem-form-popup">
            <div class="bb-mem-form-header">
                <h3><i class="fa-solid fa-pen-to-square"></i> 编辑记忆</h3>
                <span class="bb-mem-close" title="关闭">&times;</span>
            </div>
            <div class="bb-mem-form-body">
                <div class="bb-mem-form-group">
                    <label>记忆内容 <span class="bb-mem-form-hint">（必填）</span></label>
                    <textarea class="text_pole" id="bb_edit_form_content" rows="3">${escapeHtml(memory.content)}</textarea>
                </div>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>认知类型</label>
                        <select class="text_pole" id="bb_edit_form_cog_type">
                            ${cogTypes.map(t => `<option value="${t.id}" ${cogType === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}
                        </select>
                    </div>
                    <div class="bb-mem-form-group">
                        <label>分类路径</label>
                        <select class="text_pole" id="bb_edit_form_cat_path"></select>
                    </div>
                </div>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>标题 <span class="bb-mem-form-hint">3-8字</span></label>
                        <input type="text" class="text_pole" id="bb_edit_form_title" value="${escapeHtml(memory.title || '')}" placeholder="简短标题" />
                    </div>
                    <div class="bb-mem-form-group">
                        <label>摘要 <span class="bb-mem-form-hint">一句话</span></label>
                        <input type="text" class="text_pole" id="bb_edit_form_summary" value="${escapeHtml(memory.summary || '')}" placeholder="一句话总结" />
                    </div>
                </div>
                <div class="bb-mem-form-group">
                    <label>原话 <span class="bb-mem-form-hint">重要的角色原话/引用</span></label>
                    <input type="text" class="text_pole" id="bb_edit_form_verbatim" value="${escapeHtml(memory.verbatim || '')}" placeholder="「...」" />
                </div>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>主体</label>
                        <input type="text" class="text_pole" id="bb_edit_form_subject" value="${escapeHtml(memory.subject || '')}" placeholder="主要实体名，多个用逗号分隔" />
                    </div>
                    <div class="bb-mem-form-group">
                        <label>对象</label>
                        <input type="text" class="text_pole" id="bb_edit_form_target" value="${escapeHtml(memory.target || '')}" placeholder="关联对象名，多个用逗号分隔" />
                    </div>
                </div>
                <div class="bb-mem-form-group">
                    <label>地点</label>
                    <input type="text" class="text_pole" id="bb_edit_form_location" value="${escapeHtml(memory.location || '')}" placeholder="发生地点" />
                </div>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>重要性: <span id="bb_edit_form_importance_val" class="bb-mem-form-slider-val">${importanceVal}</span></label>
                        <div class="bb-mem-form-slider-row">
                            <span>0</span>
                            <input type="range" min="0" max="100" value="${importanceVal}" id="bb_edit_form_importance" />
                            <span>100</span>
                        </div>
                    </div>
                    <div class="bb-mem-form-group">
                        <label>情感强度: <span id="bb_edit_form_emotion_val" class="bb-mem-form-slider-val">${emotionVal}</span></label>
                        <div class="bb-mem-form-slider-row">
                            <span>0</span>
                            <input type="range" min="0" max="100" value="${emotionVal}" id="bb_edit_form_emotion" />
                            <span>100</span>
                        </div>
                    </div>
                </div>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>可信度</label>
                        <select class="text_pole" id="bb_edit_form_truth">
                            ${truthStatuses.map(t => `<option value="${t.id}" ${(memory.truthStatus || 'true') === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}
                        </select>
                    </div>
                    <div class="bb-mem-form-group">
                        <label>标签 <span class="bb-mem-form-hint">逗号分隔</span></label>
                        <input type="text" class="text_pole" id="bb_edit_form_tags" value="${escapeHtml(tagsStr)}" placeholder="关键词1, 关键词2" />
                    </div>
                </div>
                <div class="bb-mem-form-row" id="bb_edit_form_npc_row" style="display:none;">
                    <div class="bb-mem-form-group">
                        <label>NPC 分级</label>
                        <select class="text_pole" id="bb_edit_form_npc_tier">
                            <option value="">— 不适用 —</option>
                            <option value="core" ${memory.npcTier === 'core' ? 'selected' : ''}>核心 (core)</option>
                            <option value="important" ${memory.npcTier === 'important' ? 'selected' : ''}>重要 (important)</option>
                            <option value="minor" ${memory.npcTier === 'minor' ? 'selected' : ''}>普通 (minor)</option>
                            <option value="background" ${memory.npcTier === 'background' ? 'selected' : ''}>路人 (background)</option>
                        </select>
                    </div>
                </div>
                <div class="bb-mem-form-row" id="bb_edit_form_item_row" style="display:none;">
                    <div class="bb-mem-form-group">
                        <label>物品分级</label>
                        <select class="text_pole" id="bb_edit_form_item_tier">
                            <option value="">— 不适用 —</option>
                            <option value="key" ${memory.itemTier === 'key' ? 'selected' : ''}>关键 (key)</option>
                            <option value="equipped" ${memory.itemTier === 'equipped' ? 'selected' : ''}>持有 (equipped)</option>
                            <option value="clue" ${memory.itemTier === 'clue' ? 'selected' : ''}>线索 (clue)</option>
                            <option value="consumable" ${memory.itemTier === 'consumable' ? 'selected' : ''}>消耗品 (consumable)</option>
                            <option value="background" ${memory.itemTier === 'background' ? 'selected' : ''}>背景 (background)</option>
                        </select>
                    </div>
                </div>
                <div class="bb-mem-form-group">
                    <label class="bb-mem-form-check">
                        <input type="checkbox" id="bb_edit_form_resident" ${memory.resident ? 'checked' : ''} />
                        <span>常驻记忆（每轮自动注入索引卡）</span>
                    </label>
                </div>
            </div>
            <div class="bb-mem-form-footer">
                <button class="menu_button" id="bb_edit_form_cancel">
                    <i class="fa-solid fa-times"></i> 取消
                </button>
                <button class="menu_button" id="bb_edit_form_save" style="background:#4caf50;color:#fff;">
                    <i class="fa-solid fa-save"></i> 保存
                </button>
            </div>
        </div>
    `;
}

function bindEditMemoryFormEvents(overlay, chatId, memory, onSaved) {
    const CATEGORY_PATHS = [
        { path: 'world.politics', label: '世界·政治', type: 'fact' },
        { path: 'world.lore', label: '世界·背景', type: 'fact' },
        { path: 'world.rules', label: '世界·规则', type: 'fact' },
        { path: 'npc.profile', label: 'NPC·档案', type: 'fact' },
        { path: 'npc.relationship', label: 'NPC·关系', type: 'fact' },
        { path: 'npc.emotion', label: 'NPC·情感线', type: 'emotion' },
        { path: 'npc.secret', label: 'NPC·秘密', type: 'episode' },
        { path: 'npc.goal', label: 'NPC·目标', type: 'fact' },
        { path: 'npc.attitude', label: 'NPC·态度', type: 'emotion' },
        { path: 'item.ownership', label: '物品·持有', type: 'fact' },
        { path: 'item.quest', label: '物品·任务', type: 'fact' },
        { path: 'item.key', label: '物品·关键', type: 'fact' },
        { path: 'item.clue', label: '物品·线索', type: 'fact' },
        { path: 'location.state', label: '地点·状态', type: 'fact' },
        { path: 'location.map', label: '地点·地图', type: 'fact' },
        { path: 'episode.event', label: '情景·事件', type: 'episode' },
        { path: 'episode.promise', label: '情景·承诺', type: 'episode' },
        { path: 'episode.secret', label: '情景·秘密', type: 'episode' },
        { path: 'episode.dialogue', label: '情景·对话', type: 'episode' },
        { path: 'episode.combat', label: '情景·战斗', type: 'episode' },
        { path: 'emotion.bond', label: '情感·羁绊', type: 'emotion' },
        { path: 'emotion.trauma', label: '情感·创伤', type: 'emotion' },
        { path: 'emotion.desire', label: '情感·愿望', type: 'emotion' },
        { path: 'habit.routine', label: '习惯·日常', type: 'habit' },
        { path: 'habit.preference', label: '习惯·偏好', type: 'habit' },
        { path: 'habit.speech', label: '习惯·语言', type: 'habit' },
    ];

    function updateCategoryPathSelect(cognitiveType, currentPath) {
        const select = overlay.querySelector('#bb_edit_form_cat_path');
        if (!select) return;
        const filtered = CATEGORY_PATHS.filter(p => p.type === cognitiveType);
        select.innerHTML = filtered.map(p =>
            `<option value="${p.path}" ${p.path === currentPath ? 'selected' : ''}>${p.label}</option>`
        ).join('');

        const npcRow = overlay.querySelector('#bb_edit_form_npc_row');
        const itemRow = overlay.querySelector('#bb_edit_form_item_row');
        const firstPath = filtered[0]?.path || '';
        if (npcRow) npcRow.style.display = firstPath.startsWith('npc.') ? 'flex' : 'none';
        if (itemRow) itemRow.style.display = firstPath.startsWith('item.') ? 'flex' : 'none';
    }

    const cogType = memory.cognitiveType || 'episode';
    const catPath = memory.categoryPath || '';
    updateCategoryPathSelect(cogType, catPath);

    // Show tier rows based on current path
    if (catPath.startsWith('npc.')) {
        const npcRow = overlay.querySelector('#bb_edit_form_npc_row');
        if (npcRow) npcRow.style.display = 'flex';
    }
    if (catPath.startsWith('item.')) {
        const itemRow = overlay.querySelector('#bb_edit_form_item_row');
        if (itemRow) itemRow.style.display = 'flex';
    }

    overlay.querySelector('#bb_edit_form_cog_type')?.addEventListener('change', (e) => {
        updateCategoryPathSelect(e.target.value, '');
    });

    overlay.querySelector('#bb_edit_form_cat_path')?.addEventListener('change', (e) => {
        const npcRow = overlay.querySelector('#bb_edit_form_npc_row');
        const itemRow = overlay.querySelector('#bb_edit_form_item_row');
        const val = e.target.value;
        if (npcRow) npcRow.style.display = val.startsWith('npc.') ? 'flex' : 'none';
        if (itemRow) itemRow.style.display = val.startsWith('item.') ? 'flex' : 'none';
    });

    overlay.querySelector('#bb_edit_form_importance')?.addEventListener('input', (e) => {
        const valEl = overlay.querySelector('#bb_edit_form_importance_val');
        if (valEl) valEl.textContent = e.target.value;
    });
    overlay.querySelector('#bb_edit_form_emotion')?.addEventListener('input', (e) => {
        const valEl = overlay.querySelector('#bb_edit_form_emotion_val');
        if (valEl) valEl.textContent = e.target.value;
    });

    function closeForm() { overlay.remove(); }

    overlay.querySelector('.bb-mem-close')?.addEventListener('click', closeForm);
    overlay.querySelector('#bb_edit_form_cancel')?.addEventListener('click', closeForm);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeForm();
    });

    overlay.querySelector('#bb_edit_form_save')?.addEventListener('click', async () => {
        const content = overlay.querySelector('#bb_edit_form_content')?.value?.trim();
        if (!content) {
            toastr.warning('请输入记忆内容', DISPLAY_NAME);
            return;
        }

        const updates = {
            cognitiveType: overlay.querySelector('#bb_edit_form_cog_type')?.value || 'episode',
            categoryPath: overlay.querySelector('#bb_edit_form_cat_path')?.value || '',
            title: overlay.querySelector('#bb_edit_form_title')?.value?.trim() || '',
            summary: overlay.querySelector('#bb_edit_form_summary')?.value?.trim() || '',
            verbatim: overlay.querySelector('#bb_edit_form_verbatim')?.value?.trim() || '',
            subject: (() => { const v = overlay.querySelector('#bb_edit_form_subject')?.value?.trim() || ''; return v ? v.split(/[,，]/).map(s => s.trim()).filter(Boolean).join(', ') : ''; })(),
            target: (() => { const v = overlay.querySelector('#bb_edit_form_target')?.value?.trim() || ''; return v ? v.split(/[,，]/).map(s => s.trim()).filter(Boolean).join(', ') : ''; })(),
            location: overlay.querySelector('#bb_edit_form_location')?.value?.trim() || '',
            importance: parseInt(overlay.querySelector('#bb_edit_form_importance')?.value || '50', 10) / 100,
            emotionalWeight: parseInt(overlay.querySelector('#bb_edit_form_emotion')?.value || '0', 10) / 100,
            truthStatus: overlay.querySelector('#bb_edit_form_truth')?.value || 'true',
            npcTier: overlay.querySelector('#bb_edit_form_npc_tier')?.value || '',
            itemTier: overlay.querySelector('#bb_edit_form_item_tier')?.value || '',
            resident: overlay.querySelector('#bb_edit_form_resident')?.checked || false,
        };

        const tagsRaw = overlay.querySelector('#bb_edit_form_tags')?.value?.trim() || '';
        if (tagsRaw) {
            updates.tags = tagsRaw.split(/[,，]/).map(t => t.trim()).filter(Boolean).map(t => ({ name: t, weight: 0.6 }));
        }

        await updateMemory(chatId, memory.id, updates);
        toastr.success('记忆已更新', DISPLAY_NAME);
        closeForm();
        if (onSaved) onSaved();
    });
}

// ═══════════════════════════════════════════════════════════
//  事实更新弹窗
// ═══════════════════════════════════════════════════════════

function openFactUpdateForm(chatId, memory, onSaved) {
    if (document.querySelector('.bb-fact-update-overlay')) return;

    const truthOptions = Object.values(TRUTH_STATUS).map(t =>
        `<option value="${t.id}" ${memory.truthStatus === t.id ? 'selected' : ''}>${t.label}</option>`
    ).join('');

    const overlay = document.createElement('div');
    overlay.className = 'bb-fact-update-overlay';
    overlay.innerHTML = `
        <div class="bb-mem-form-popup" style="max-width:520px;">
            <div class="bb-mem-form-header">
                <h3><i class="fa-solid fa-pen-to-square"></i> 更新记忆内容</h3>
                <span class="bb-mem-close" title="关闭">&times;</span>
            </div>
            <div class="bb-mem-form-body">
                <div class="bb-mem-form-group">
                    <label>当前内容</label>
                    <div style="padding:8px 10px;background:var(--SmartThemeBlurTintColor,rgba(255,255,255,0.04));border-radius:6px;font-size:0.9em;opacity:0.8;white-space:pre-wrap;max-height:100px;overflow-y:auto;margin-bottom:4px;">${escapeHtml(memory.content)}</div>
                </div>
                <div class="bb-mem-form-group">
                    <label>新内容 <span class="bb-mem-form-hint">旧版本将自动保存到历史</span></label>
                    <textarea class="text_pole" id="bb_fact_form_content" rows="4">${escapeHtml(memory.content)}</textarea>
                </div>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>真理状态</label>
                        <select class="text_pole" id="bb_fact_form_truth">
                            ${truthOptions}
                        </select>
                    </div>
                    <div class="bb-mem-form-group">
                        <label>变更原因 <span class="bb-mem-form-hint">可选</span></label>
                        <input type="text" class="text_pole" id="bb_fact_form_reason"
                               placeholder="剧情推进 / 新线索 / 玩家提供" />
                    </div>
                </div>
                <div class="bb-mem-form-group">
                    <label class="bb-mem-form-check">
                        <input type="checkbox" id="bb_fact_form_minor" />
                        <span>小修改（不记录历史）</span>
                    </label>
                </div>
            </div>
            <div class="bb-mem-form-footer">
                <button class="menu_button" id="bb_fact_form_cancel">
                    <i class="fa-solid fa-times"></i> 取消
                </button>
                <button class="menu_button" id="bb_fact_form_save" style="background:#2196f3;color:#fff;">
                    <i class="fa-solid fa-check"></i> 更新
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const closeForm = () => overlay.remove();
    overlay.querySelector('.bb-mem-close')?.addEventListener('click', closeForm);
    overlay.querySelector('#bb_fact_form_cancel')?.addEventListener('click', closeForm);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeForm(); });

    overlay.querySelector('#bb_fact_form_save')?.addEventListener('click', async () => {
        const newContent = overlay.querySelector('#bb_fact_form_content')?.value?.trim();
        if (!newContent) {
            toastr.warning('请输入新内容', DISPLAY_NAME);
            return;
        }
        const truthStatus = overlay.querySelector('#bb_fact_form_truth')?.value || memory.truthStatus;
        const reason = overlay.querySelector('#bb_fact_form_reason')?.value?.trim() || '';
        const minor = overlay.querySelector('#bb_fact_form_minor')?.checked || false;

        if (minor) {
            await updateMemory(chatId, memory.id, { content: newContent, truthStatus });
        } else {
            await updateFactContent(chatId, memory.id, newContent, { truthStatus, reason });
        }

        toastr.success('记忆已更新', DISPLAY_NAME);
        closeForm();
        if (onSaved) onSaved();
    });
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

async function handleWorldBookImportWithAI() {
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
                toastr.info('正在调用 AI 整理世界书内容...', DISPLAY_NAME);
                const { importWorldBookWithAI } = await import('./world-book-importer.js');
                const count = await importWorldBookWithAI(chatId, ev.target.result);
                toastr.success(`AI 从世界书整理出 ${count} 条记忆`, DISPLAY_NAME);
                refreshSidebar();
            } catch (err) {
                toastr.error(`AI 摘要导入失败：${err.message}`, DISPLAY_NAME);
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

    // v2.9.9: 刷新当前存档状态栏
    updateCurrentSlotBar(overlay, chatId);

    // v2.9.8: 检查是否有待审核的自动提取候选
    const pending = getPendingAutoCandidates();
    if (pending.length > 0) {
        setTimeout(() => {
            showExtractReviewPanel(overlay, chatId, pending, 0);
            clearPendingAutoCandidates();
        }, 300);
    }
}

// ═══════════════════════════════════════════════════════════
//  AI 上下文提取 & 审核面板
// ═══════════════════════════════════════════════════════════

function showFloorSelectionDialog(chatId, callback) {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    const totalMessages = chat ? chat.length : 0;

    if (totalMessages < 2) {
        toastr.warning('对话消息不足，无法提取', DISPLAY_NAME);
        return;
    }

    const defaultStart = Math.max(0, totalMessages - 12);
    const defaultEnd = totalMessages - 1;

    const overlay = document.createElement('div');
    overlay.className = 'bb-floor-select-overlay';
    overlay.innerHTML = `
        <div class="bb-mem-form-popup" style="max-width:480px;">
            <div class="bb-mem-form-header">
                <h3><i class="fa-solid fa-layer-group"></i> 选择提取范围</h3>
                <span class="bb-mem-close" title="关闭">&times;</span>
            </div>
            <div class="bb-mem-form-body">
                <p style="font-size:0.9em;opacity:0.7;margin-bottom:12px;">
                    当前对话共 <strong>${totalMessages}</strong> 条消息（楼层 0 ~ ${totalMessages - 1}）
                </p>
                <div class="bb-mem-form-row">
                    <div class="bb-mem-form-group">
                        <label>起始楼层</label>
                        <input type="number" class="text_pole" id="bb_floor_start"
                               min="0" max="${totalMessages - 2}" value="${defaultStart}" />
                    </div>
                    <div class="bb-mem-form-group">
                        <label>结束楼层</label>
                        <input type="number" class="text_pole" id="bb_floor_end"
                               min="1" max="${totalMessages - 1}" value="${defaultEnd}" />
                    </div>
                </div>
                <div class="bb-mem-form-group">
                    <label>消息数：<span id="bb_floor_count">${defaultEnd - defaultStart + 1}</span></label>
                    <small class="bb-mem-hint" style="display:block;margin-top:2px;">
                        建议每次提取不超过 20 条消息
                    </small>
                </div>
                <div class="bb-floor-status" id="bb_floor_status">
                    已提取：<strong id="bb_floor_extracted">-</strong> 个交换 &nbsp;
                    未提取：<strong id="bb_floor_unextracted">-</strong> 个交换
                </div>
            </div>
            <div class="bb-mem-form-footer">
                <button class="menu_button" id="bb_floor_cancel">
                    <i class="fa-solid fa-times"></i> 取消
                </button>
                <button class="menu_button" id="bb_floor_confirm" style="background:#ba68c8;color:#fff;">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> 开始提取
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const startInput = overlay.querySelector('#bb_floor_start');
    const endInput = overlay.querySelector('#bb_floor_end');
    const countEl = overlay.querySelector('#bb_floor_count');
    const extractedEl = overlay.querySelector('#bb_floor_extracted');
    const unextractedEl = overlay.querySelector('#bb_floor_unextracted');

    const updateCount = () => {
        const start = parseInt(startInput.value, 10);
        const end = parseInt(endInput.value, 10);
        if (!isNaN(start) && !isNaN(end) && end >= start) {
            countEl.textContent = String(end - start + 1);

            // 统计提取状态
            let extracted = 0;
            let unextracted = 0;
            for (let i = start; i <= end && i < chat.length; i++) {
                const msg = chat[i];
                if (msg.is_system || msg.is_user) continue;
                if (msg._bbmem_extracted) extracted++;
                else {
                    // 尝试找到前面最近的一个 user 消息来确定是 exchange 的 AI 部分
                    let hasUser = false;
                    for (let j = i - 1; j >= start && j >= 0; j--) {
                        if (chat[j].is_user) { hasUser = true; break; }
                        if (chat[j].is_system) continue;
                    }
                    if (hasUser) unextracted++;
                }
            }
            if (extractedEl) extractedEl.textContent = String(extracted);
            if (unextractedEl) unextractedEl.textContent = String(unextracted);
        }
    };
    startInput?.addEventListener('input', updateCount);
    endInput?.addEventListener('input', updateCount);
    // 初始化提取状态
    updateCount();

    const closeDialog = () => overlay.remove();
    overlay.querySelector('.bb-mem-close')?.addEventListener('click', closeDialog);
    overlay.querySelector('#bb_floor_cancel')?.addEventListener('click', closeDialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });

    overlay.querySelector('#bb_floor_confirm')?.addEventListener('click', () => {
        const start = parseInt(startInput?.value, 10);
        const end = parseInt(endInput?.value, 10);
        if (isNaN(start) || isNaN(end) || start < 0 || end >= totalMessages || start > end) {
            toastr.warning('请输入有效的楼层范围', DISPLAY_NAME);
            return;
        }
        closeDialog();
        callback(start, end - start + 1);
    });
}

async function handleAiExtract(managerOverlay, chatId) {
    const ctx = SillyTavern.getContext();
    const totalMessages = ctx.chat ? ctx.chat.length : 0;

    showFloorSelectionDialog(chatId, async (startFloor, count) => {
        const listEl = managerOverlay.querySelector('#bb_mgr_list');
        const oldHTML = listEl?.innerHTML || '';
        if (listEl) {
            listEl.innerHTML = `<div class="bb-mem-empty">
                <i class="fa-solid fa-spinner fa-spin" style="font-size:2em;display:block;margin-bottom:12px;"></i>
                正在分析第 ${startFloor}~${startFloor + count - 1} 条消息...
            </div>`;
        }

        try {
            const {
                memories: candidates,
                skippedCount,
                processedExchanges,
                _directSaved,
            } = await extractFromContext(chatId, count, startFloor);

            // v3.0.0: 逐层提取模式 — 已直接保存，无需审核
            if (_directSaved !== undefined) {
                if (listEl) listEl.innerHTML = oldHTML;
                await rerenderManagerList(managerOverlay, chatId);
                if (_directSaved > 0) {
                    toastr.success(`逐层提取完成，新增 ${_directSaved} 条记忆`, DISPLAY_NAME);
                } else {
                    const skipMsg = skippedCount > 0 ? `（跳过 ${skippedCount} 个已提取交换）` : '';
                    toastr.info(`AI 未发现新记忆${skipMsg}`, DISPLAY_NAME);
                }
                return;
            }

            if (!candidates || !candidates.length) {
                const skipMsg = skippedCount > 0 ? `（跳过 ${skippedCount} 个已提取交换）` : '';
                if (listEl) listEl.innerHTML = `<div class="bb-mem-empty">AI 未发现值得记忆的内容${skipMsg}</div>`;
                setTimeout(() => { if (listEl) listEl.innerHTML = oldHTML; }, 2000);
                await rerenderManagerList(managerOverlay, chatId);
                if (skippedCount > 0) {
                    toastr.info(`AI 未发现新记忆（已跳过 ${skippedCount} 个已提取交换）`, DISPLAY_NAME);
                } else {
                    toastr.info('AI 未发现值得记忆的内容', DISPLAY_NAME);
                }
                return;
            }

            // v2.9.8: 检查确认模式
            const settings = getSettings();
            const confirmMode = settings.extractionConfirmMode || 'semi';

            // v3.0.0: 保存后标记/隐藏 exchange 的辅助函数
            const markAndHideExchanges = async () => {
                if (processedExchanges && processedExchanges.length > 0) {
                    for (const ex of processedExchanges) {
                        await markExchangeExtracted(ex.aiIndex, ex.hash);
                        hideExchange(ex.userIndex, ex.aiIndex);
                    }
                }
            };

            if (confirmMode === 'auto') {
                // 自动模式：直接保存，跳过审核
                const selected = candidates.map(m => ({ ...m, _selected: true }));
                const savedCount = await saveExtractedMemories(chatId, selected, null);
                toastr.success(`自动保存了 ${savedCount} 条记忆`, DISPLAY_NAME);
                await markAndHideExchanges();
                await restoreManagerUI(managerOverlay, chatId);
            } else {
                // semi 或 active 模式：显示审核面板
                showExtractReviewPanel(managerOverlay, chatId, candidates, skippedCount, processedExchanges);
            }
        } catch (err) {
            console.error('[BB-Memory] AI提取失败:', err);
            if (listEl) listEl.innerHTML = oldHTML;
            toastr.error(`AI提取失败：${err.message}`, DISPLAY_NAME);
        }
    });
}

function showExtractReviewPanel(managerOverlay, chatId, candidates, skippedCount = 0, processedExchanges = []) {
    const listEl = managerOverlay.querySelector('#bb_mgr_list');
    const statsEl = managerOverlay.querySelector('.bb-mem-stats');
    const toolbarEl = managerOverlay.querySelector('.bb-mem-toolbar');
    const filterEl = managerOverlay.querySelector('.bb-mem-type-filters');

    // 隐藏普通工具栏和过滤器，显示审核工具栏
    if (toolbarEl) toolbarEl.style.display = 'none';
    if (filterEl) filterEl.style.display = 'none';
    const skipNote = skippedCount > 0 ? `（跳过 ${skippedCount} 个已提取交换）` : '';
    if (statsEl) statsEl.innerHTML = `AI 提取到 <strong>${candidates.length}</strong> 条候选记忆，请审核${skipNote}`;

    // 渲染候选列表
    if (listEl) {
        listEl.innerHTML = candidates.map((mem, i) => buildCandidateItemHTML(mem, i)).join('');
        bindCandidateItemEvents(listEl);
    }

    // 显示审核操作栏
    const footerEl = managerOverlay.querySelector('.bb-mem-footer');
    if (footerEl) {
        footerEl.innerHTML = `
            <button class="menu_button" id="bb_review_select_all">
                <i class="fa-solid fa-check-double"></i> 全选
            </button>
            <button class="menu_button" id="bb_review_deselect_all">
                <i class="fa-solid fa-times"></i> 取消全选
            </button>
            <button class="menu_button" id="bb_review_save" style="background:#4caf50;color:#fff;">
                <i class="fa-solid fa-save"></i> 保存选中 (<span id="bb_review_count">0</span>)
            </button>
            <button class="menu_button menu_button_danger" id="bb_review_cancel">
                <i class="fa-solid fa-ban"></i> 取消
            </button>
        `;
        bindReviewFooterEvents(footerEl, managerOverlay, chatId, candidates, processedExchanges);
    }
}

// v2.9.8: 浮动审核弹窗（active 模式 popup 风格，不依赖管理面板）
async function showFloatingReviewPanel(chatId, candidates) {
    const existing = document.querySelector('.bb-floating-review-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'bb-mem-overlay bb-floating-review-overlay';
    overlay.innerHTML = `
        <div class="bb-mem-popup" style="max-width:650px;">
            <div class="bb-mem-popup-header">
                <h3><i class="fa-solid fa-clipboard-check"></i> 记忆审核</h3>
                <button class="bb-mem-close menu_button menu_button_danger" style="padding:2px 8px;">×</button>
            </div>
            <div class="bb-mem-stats" style="padding:6px 18px;">
                AI 自动提取到 <strong>${candidates.length}</strong> 条候选记忆，请审核
            </div>
            <div class="bb-mem-list" id="bb_floating_review_list" style="max-height:50vh;">
                ${candidates.map((mem, i) => buildCandidateItemHTML(mem, i)).join('')}
            </div>
            <div class="bb-mem-footer" id="bb_floating_review_footer">
                <button class="menu_button" id="bb_fr_select_all">
                    <i class="fa-solid fa-check-double"></i> 全选
                </button>
                <button class="menu_button" id="bb_fr_deselect_all">
                    <i class="fa-solid fa-times"></i> 取消全选
                </button>
                <button class="menu_button" id="bb_fr_save" style="background:#4caf50;color:#fff;">
                    <i class="fa-solid fa-save"></i> 保存选中 (<span id="bb_fr_count">0</span>)
                </button>
                <button class="menu_button menu_button_danger" id="bb_fr_cancel">
                    <i class="fa-solid fa-ban"></i> 取消
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector('#bb_floating_review_list');
    if (listEl) bindCandidateItemEvents(listEl);

    // 绑定底部按钮
    const footerEl = overlay.querySelector('#bb_floating_review_footer');
    if (footerEl) {
        footerEl.querySelector('#bb_fr_select_all')?.addEventListener('click', () => {
            overlay.querySelectorAll('.bb-candidate-cb').forEach(cb => { cb.checked = true; });
            updateFloatingReviewCount(overlay);
        });
        footerEl.querySelector('#bb_fr_deselect_all')?.addEventListener('click', () => {
            overlay.querySelectorAll('.bb-candidate-cb').forEach(cb => { cb.checked = false; });
            updateFloatingReviewCount(overlay);
        });
        footerEl.querySelector('#bb_fr_save')?.addEventListener('click', async () => {
            const data = collectCandidateData(overlay);
            const selected = data.filter(d => d._selected);
            if (!selected.length) { toastr.info('未选择任何记忆', DISPLAY_NAME); return; }
            const savedCount = await saveExtractedMemories(chatId, selected, null);
            toastr.success(`保存了 ${savedCount} 条记忆`, DISPLAY_NAME);
            overlay.remove();
            refreshSidebar();
        });
        footerEl.querySelector('#bb_fr_cancel')?.addEventListener('click', () => overlay.remove());
    }

    // 关闭按钮
    overlay.querySelector('.bb-mem-close')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // 初始计数
    updateFloatingReviewCount(overlay);
}

function updateFloatingReviewCount(overlay) {
    const count = overlay.querySelectorAll('.bb-candidate-cb:checked').length;
    const el = overlay.querySelector('#bb_fr_count');
    if (el) el.textContent = String(count);
}

function buildCandidateItemHTML(mem, index) {
    const typeColors = { fact: '#4fc3f7', episode: '#ba68c8', emotion: '#f06292', habit: '#81c784' };
    const typeLabels = { fact: '事实', episode: '情景', emotion: '情感', habit: '习惯' };
    const color = typeColors[mem.cognitiveType] || '#888';
    const label = typeLabels[mem.cognitiveType] || mem.cognitiveType;
    const importance = Math.round((mem.importance || 0.5) * 100);

    return `
        <div class="bb-candidate-item" data-index="${index}">
            <label class="bb-candidate-check">
                <input type="checkbox" class="bb-candidate-cb" data-index="${index}" checked />
                <span class="bb-candidate-type" style="color:${color}">[${label}]</span>
            </label>
            <div class="bb-candidate-body">
                <div class="bb-candidate-row">
                    <input type="text" class="text_pole bb-candidate-title" data-index="${index}" data-field="title"
                           value="${escapeHtml(mem.title || '')}" placeholder="标题（3-8字）" />
                    <select class="text_pole bb-candidate-path" data-index="${index}" data-field="categoryPath"
                            style="max-width:150px;font-size:0.85em;">
                        ${buildCategoryPathOptions(mem.cognitiveType, mem.categoryPath)}
                    </select>
                    <span class="bb-candidate-importance">
                        重要度: <input type="range" min="0" max="100" value="${importance}"
                               class="bb-candidate-importance-slider" data-index="${index}" />
                        <span class="bb-candidate-importance-val">${importance}</span>
                    </span>
                </div>
                <textarea class="text_pole bb-candidate-content" data-index="${index}" data-field="content"
                          rows="2" placeholder="记忆内容">${escapeHtml(mem.content || '')}</textarea>
                <div class="bb-candidate-row">
                    <input type="text" class="text_pole bb-candidate-summary" data-index="${index}" data-field="summary"
                           value="${escapeHtml(mem.summary || '')}" placeholder="摘要" style="flex:2;" />
                    <input type="text" class="text_pole bb-candidate-verbatim" data-index="${index}" data-field="verbatim"
                           value="${escapeHtml(mem.verbatim || '')}" placeholder="原话（可选）" style="flex:2;" />
                </div>
                <div class="bb-candidate-row">
                    <input type="text" class="text_pole bb-candidate-subject" data-index="${index}" data-field="subject"
                           value="${escapeHtml(mem.subject || '')}" placeholder="主体" style="flex:1;" />
                    <input type="text" class="text_pole bb-candidate-target" data-index="${index}" data-field="target"
                           value="${escapeHtml(mem.target || '')}" placeholder="对象" style="flex:1;" />
                    <input type="text" class="text_pole bb-candidate-tags" data-index="${index}" data-field="tags"
                           value="${(mem.tags || []).map(t => typeof t === 'string' ? t : t.name).join(', ')}"
                           placeholder="标签（逗号分隔）" style="flex:1.5;" />
                </div>
            </div>
        </div>
    `;
}

function buildCategoryPathOptions(cognitiveType, selectedPath) {
    // 动态路径列表（与 memory-types.js CATEGORY_PATHS 保持一致）
    const allPaths = [
        { path: 'world.politics', label: '世界·政治', type: 'fact' },
        { path: 'world.lore', label: '世界·背景', type: 'fact' },
        { path: 'world.rules', label: '世界·规则', type: 'fact' },
        { path: 'npc.profile', label: 'NPC·档案', type: 'fact' },
        { path: 'npc.relationship', label: 'NPC·关系', type: 'fact' },
        { path: 'npc.emotion', label: 'NPC·情感线', type: 'emotion' },
        { path: 'npc.secret', label: 'NPC·秘密', type: 'episode' },
        { path: 'npc.goal', label: 'NPC·目标', type: 'fact' },
        { path: 'npc.attitude', label: 'NPC·态度', type: 'emotion' },
        { path: 'item.ownership', label: '物品·持有', type: 'fact' },
        { path: 'item.quest', label: '物品·任务', type: 'fact' },
        { path: 'item.key', label: '物品·关键', type: 'fact' },
        { path: 'item.clue', label: '物品·线索', type: 'fact' },
        { path: 'location.state', label: '地点·状态', type: 'fact' },
        { path: 'location.map', label: '地点·地图', type: 'fact' },
        { path: 'episode.event', label: '情景·事件', type: 'episode' },
        { path: 'episode.promise', label: '情景·承诺', type: 'episode' },
        { path: 'episode.secret', label: '情景·秘密', type: 'episode' },
        { path: 'episode.dialogue', label: '情景·对话', type: 'episode' },
        { path: 'episode.combat', label: '情景·战斗', type: 'episode' },
        { path: 'emotion.bond', label: '情感·羁绊', type: 'emotion' },
        { path: 'emotion.trauma', label: '情感·创伤', type: 'emotion' },
        { path: 'emotion.desire', label: '情感·愿望', type: 'emotion' },
        { path: 'habit.routine', label: '习惯·日常', type: 'habit' },
        { path: 'habit.preference', label: '习惯·偏好', type: 'habit' },
        { path: 'habit.speech', label: '习惯·语言', type: 'habit' },
    ];

    const filtered = allPaths.filter(p => p.type === cognitiveType);
    if (!filtered.length) return allPaths.map(p => `<option value="${p.path}" ${p.path === selectedPath ? 'selected' : ''}>${p.label}</option>`).join('');

    return filtered.map(p =>
        `<option value="${p.path}" ${p.path === selectedPath ? 'selected' : ''}>${p.label}</option>`
    ).join('');
}

function bindCandidateItemEvents(listEl) {
    // 复选框变化 → 更新计数
    listEl.querySelectorAll('.bb-candidate-cb').forEach(cb => {
        cb.addEventListener('change', () => updateReviewCount(listEl));
    });

    // 重要性滑块
    listEl.querySelectorAll('.bb-candidate-importance-slider').forEach(slider => {
        slider.addEventListener('input', () => {
            const valEl = slider.nextElementSibling;
            if (valEl) valEl.textContent = slider.value;
        });
    });

    // 任何输入变化 → 更新 candidates 数组
    listEl.querySelectorAll('[data-field]').forEach(el => {
        el.addEventListener('change', () => updateReviewCount(listEl));
        el.addEventListener('input', () => updateReviewCount(listEl));
    });
}

function updateReviewCount(listEl) {
    const count = listEl.querySelectorAll('.bb-candidate-cb:checked').length;
    const countEl = document.getElementById('bb_review_count');
    if (countEl) countEl.textContent = String(count);
}

function collectCandidateData(listEl, candidates) {
    const results = [];
    listEl.querySelectorAll('.bb-candidate-item').forEach(item => {
        const index = parseInt(item.dataset.index, 10);
        const mem = { ...candidates[index] };
        mem._selected = item.querySelector('.bb-candidate-cb')?.checked || false;

        // 收集编辑后的字段
        item.querySelectorAll('[data-field]').forEach(el => {
            const field = el.dataset.field;
            if (field === 'importance') {
                mem.importance = parseInt(el.value, 10) / 100;
            } else if (field === 'tags') {
                mem.tags = el.value.split(/[,，]/).map(t => t.trim()).filter(Boolean)
                    .map(t => ({ name: t, weight: 0.6 }));
            } else if (field === 'emotionalWeight') {
                mem.emotionalWeight = parseInt(el.value, 10) / 100;
            } else {
                mem[field] = el.value.trim();
            }
        });
        results.push(mem);
    });
    return results;
}

function bindReviewFooterEvents(footerEl, managerOverlay, chatId, candidates, processedExchanges = []) {
    const listEl = managerOverlay.querySelector('#bb_mgr_list');

    footerEl.querySelector('#bb_review_select_all')?.addEventListener('click', () => {
        listEl.querySelectorAll('.bb-candidate-cb').forEach(cb => { cb.checked = true; });
        updateReviewCount(listEl);
    });

    footerEl.querySelector('#bb_review_deselect_all')?.addEventListener('click', () => {
        listEl.querySelectorAll('.bb-candidate-cb').forEach(cb => { cb.checked = false; });
        updateReviewCount(listEl);
    });

    footerEl.querySelector('#bb_review_save')?.addEventListener('click', async () => {
        const updated = collectCandidateData(listEl, candidates);
        const selected = updated.filter(m => m._selected);
        if (!selected.length) {
            toastr.info('未选择任何记忆', DISPLAY_NAME);
            return;
        }
        try {
            const count = await saveExtractedMemories(chatId, updated, null);
            if (count > 0) {
                toastr.success(`已保存 ${count} 条记忆`, DISPLAY_NAME);
            }
            // v3.0.0: 保存后标记/隐藏对应 exchange
            if (processedExchanges.length > 0) {
                for (const ex of processedExchanges) {
                    await markExchangeExtracted(ex.aiIndex, ex.hash);
                    hideExchange(ex.userIndex, ex.aiIndex);
                }
            }
        } catch (err) {
            console.error('[BB-Memory] 保存记忆失败:', err);
        }
        await restoreManagerUI(managerOverlay, chatId);
    });

    footerEl.querySelector('#bb_review_cancel')?.addEventListener('click', async () => {
        await restoreManagerUI(managerOverlay, chatId);
    });
}

async function restoreManagerUI(managerOverlay, chatId) {
    const toolbarEl = managerOverlay.querySelector('.bb-mem-toolbar');
    const filterEl = managerOverlay.querySelector('.bb-mem-type-filters');
    const footerEl = managerOverlay.querySelector('.bb-mem-footer');

    if (toolbarEl) toolbarEl.style.display = '';
    if (filterEl) filterEl.style.display = '';

    // 恢复原始 footer
    if (footerEl) {
        footerEl.innerHTML = `
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
        `;
    }

    await rerenderManagerList(managerOverlay, chatId);

    // 重新绑定 footer 事件
    bindManagerFooterEvents(managerOverlay, chatId);
}

function bindManagerFooterEvents(managerOverlay, chatId) {
    managerOverlay.querySelector('#bb_mgr_export')?.addEventListener('click', async () => {
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

    managerOverlay.querySelector('#bb_mgr_import')?.addEventListener('click', () => {
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
                    await rerenderManagerList(managerOverlay, chatId);
                } catch (err) {
                    toastr.error(`导入失败：${err.message}`, DISPLAY_NAME);
                }
            };
            reader.readAsText(file);
        });
        input.click();
    });

    managerOverlay.querySelector('#bb_mgr_import_wb')?.addEventListener('click', async () => {
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
                    await rerenderManagerList(managerOverlay, chatId);
                } catch (err) {
                    toastr.error(`世界书导入失败：${err.message}`, DISPLAY_NAME);
                }
            };
            reader.readAsText(file);
        });
        input.click();
    });

    managerOverlay.querySelector('#bb_mgr_clear')?.addEventListener('click', async () => {
        const ctx = SillyTavern.getContext();
        const ok = await ctx.Popup.show.confirm('确认清空', '确定要删除所有记忆吗？此操作不可撤销。');
        if (!isPopupAffirmative(ctx, ok)) return;
        await clearMemories(chatId);
        toastr.info('所有记忆已清空', DISPLAY_NAME);
        await rerenderManagerList(managerOverlay, chatId);
    });
}

// ═══ 存档槽面板 ═══

// v2.9.9: 刷新记忆面板顶部的当前存档状态栏
async function updateCurrentSlotBar(overlay, chatId) {
    const nameEl = overlay.querySelector('#bb_current_slot_name');
    const countEl = overlay.querySelector('#bb_current_slot_count');
    if (!nameEl && !countEl) return;

    const mems = await getMemories(chatId);
    const currentCount = mems.length;
    const settings = getSettings();
    const currentSlot = settings.currentSlotName || 'default';

    if (nameEl) nameEl.textContent = currentSlot;
    if (countEl) countEl.textContent = String(currentCount);
}

async function renderSlotsPanel(overlay, chatId) {
    const slotsEl = overlay.querySelector('#bb_mgr_slots');
    if (!slotsEl) return;

    const charId = getCharacterId();
    if (!charId) {
        slotsEl.innerHTML = '<div class="bb-mem-empty">请先选择角色开始聊天</div>';
        return;
    }

    try {
        const slots = await listSlots(charId);
        const mems = await getMemories(chatId);
        const currentCount = mems.length;

        slotsEl.innerHTML = `
            <div class="bb-slots-info">
                <i class="fa-solid fa-circle-info"></i>
                当前聊天 <strong>${currentCount}</strong> 条记忆 · 角色ID: ${charId}
            </div>

            <div class="bb-slots-list">
                ${slots.map(s => `
                    <div class="bb-slot-item">
                        <div class="bb-slot-info">
                            <span class="bb-slot-name">
                                <i class="fa-solid fa-floppy-disk"></i> ${escapeHtml(s.name)}
                                ${s.name === 'default' ? '<span class="bb-slot-default-badge">默认</span>' : ''}
                            </span>
                            <span class="bb-slot-count">${s.count} 条记忆</span>
                        </div>
                        <div class="bb-slot-actions">
                            <button class="menu_button bb-slot-btn-save" data-slot="${escapeHtml(s.name)}"
                                    title="将当前记忆保存到此槽">
                                <i class="fa-solid fa-arrow-up"></i> 保存
                            </button>
                            <button class="menu_button bb-slot-btn-load" data-slot="${escapeHtml(s.name)}"
                                    title="从此槽加载记忆（会覆盖当前）">
                                <i class="fa-solid fa-arrow-down"></i> 加载
                            </button>
                            ${s.name !== 'default' ? `
                            <button class="menu_button menu_button_danger bb-slot-btn-delete" data-slot="${escapeHtml(s.name)}"
                                    title="删除此存档槽">
                                <i class="fa-solid fa-trash"></i>
                            </button>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>

            <div class="bb-slots-create">
                <input type="text" class="text_pole" id="bb_slot_new_name"
                       placeholder="新存档名称（如：if线A、主线）" />
                <button class="menu_button" id="bb_slot_create_btn">
                    <i class="fa-solid fa-plus"></i> 新建存档
                </button>
            </div>
        `;

        bindSlotEvents(overlay, chatId, charId, slotsEl);
    } catch (err) {
        slotsEl.innerHTML = `<div class="bb-mem-empty">加载失败：${escapeHtml(err.message)}</div>`;
    }
}

function bindSlotEvents(overlay, chatId, charId, slotsEl) {
    // 保存到槽
    slotsEl.querySelectorAll('.bb-slot-btn-save').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slotName = btn.dataset.slot;
            try {
                const count = await saveToSlot(charId, chatId, slotName);
                toastr.success(`已保存 ${count} 条记忆到「${slotName}」`, DISPLAY_NAME);
                updateSettings({ currentSlotName: slotName });
                await renderSlotsPanel(overlay, chatId);
                updateCurrentSlotBar(overlay, chatId);
            } catch (err) {
                toastr.error(`保存失败：${err.message}`, DISPLAY_NAME);
            }
        });
    });

    // 从槽加载
    slotsEl.querySelectorAll('.bb-slot-btn-load').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slotName = btn.dataset.slot;
            const ctx = SillyTavern.getContext();
            const ok = await ctx.Popup.show.confirm(
                '加载存档',
                `确定从「${slotName}」加载记忆吗？当前聊天的记忆将被覆盖！`
            );
            if (!isPopupAffirmative(ctx, ok)) return;

            try {
                const count = await loadFromSlot(charId, chatId, slotName);
                toastr.success(`已从「${slotName}」加载 ${count} 条记忆`, DISPLAY_NAME);
                updateSettings({ currentSlotName: slotName });
                await renderSlotsPanel(overlay, chatId);
                updateCurrentSlotBar(overlay, chatId);
                // 也刷新记忆列表
                await rerenderManagerList(overlay, chatId);
            } catch (err) {
                toastr.error(`加载失败：${err.message}`, DISPLAY_NAME);
            }
        });
    });

    // 删除槽
    slotsEl.querySelectorAll('.bb-slot-btn-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slotName = btn.dataset.slot;
            const ctx = SillyTavern.getContext();
            const ok = await ctx.Popup.show.confirm(
                '删除存档',
                `确定删除存档「${slotName}」吗？此操作不可撤销！`
            );
            if (!isPopupAffirmative(ctx, ok)) return;

            try {
                await deleteSlot(charId, slotName);
                toastr.success(`已删除存档「${slotName}」`, DISPLAY_NAME);
                await renderSlotsPanel(overlay, chatId);
            } catch (err) {
                toastr.error(`删除失败：${err.message}`, DISPLAY_NAME);
            }
        });
    });

    // 新建槽
    slotsEl.querySelector('#bb_slot_create_btn')?.addEventListener('click', async () => {
        const input = slotsEl.querySelector('#bb_slot_new_name');
        const name = input?.value?.trim();
        if (!name) {
            toastr.warning('请输入存档名称', DISPLAY_NAME);
            return;
        }
        try {
            await createEmptySlot(charId, name);
            toastr.success(`已创建存档「${name}」`, DISPLAY_NAME);
            input.value = '';
            await renderSlotsPanel(overlay, chatId);
        } catch (err) {
            toastr.error(`创建失败：${err.message}`, DISPLAY_NAME);
        }
    });
}

// ═══ v2.9.5：常驻记忆面板 ═══

async function renderPersistentPanel(overlay, chatId, category = 'npc') {
    const listEl = overlay.querySelector('#bb_persistent_list');
    if (!listEl) return;

    try {
        const all = await getPersistentMemories(chatId);
        const items = all.filter(e => e.category === category);
        if (!items.length) {
            const catLabels = { npc: 'NPC', item: '物品', timeline: '时间线' };
            listEl.innerHTML = `<div class="bb-mem-empty">暂无${catLabels[category] || ''}档案，点击上方"添加"按钮创建</div>`;
        } else {
            listEl.innerHTML = items.map(item => `
                <div class="bb-persistent-item" data-id="${item.id}">
                    <div class="bb-persistent-item-info">
                        <div class="bb-persistent-item-name">${escapeHtml(item.name)}</div>
                        <div class="bb-persistent-item-content">${escapeHtml(item.content)}</div>
                    </div>
                    <div class="bb-persistent-item-actions">
                        <button class="menu_button bb-persistent-edit" data-id="${item.id}" title="编辑">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="menu_button bb-persistent-delete" data-id="${item.id}" title="删除">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            `).join('');
        }
        bindPersistentEvents(overlay, chatId);
    } catch (err) {
        listEl.innerHTML = `<div class="bb-mem-empty">加载失败：${escapeHtml(err.message)}</div>`;
    }
}

function bindPersistentEvents(overlay, chatId) {
    let currentCategory = 'npc';

    // 子标签切换
    overlay.querySelectorAll('.bb-persistent-tabs .bb-mgr-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            overlay.querySelectorAll('.bb-persistent-tabs .bb-mgr-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentCategory = tab.dataset.pcat;
            await renderPersistentPanel(overlay, chatId, currentCategory);
        });
    });

    // 添加按钮
    const addBtn = overlay.querySelector('#bb_persistent_add');
    const formEl = overlay.querySelector('#bb_persistent_form');
    const nameInput = overlay.querySelector('#bb_persistent_name');
    const contentInput = overlay.querySelector('#bb_persistent_content');
    let editingId = null;

    addBtn?.addEventListener('click', () => {
        editingId = null;
        if (nameInput) nameInput.value = '';
        if (contentInput) contentInput.value = '';
        if (formEl) formEl.style.display = 'flex';
    });

    // 取消编辑
    overlay.querySelector('#bb_persistent_cancel')?.addEventListener('click', () => {
        editingId = null;
        if (formEl) formEl.style.display = 'none';
    });

    // 保存
    overlay.querySelector('#bb_persistent_save')?.addEventListener('click', async () => {
        const name = nameInput?.value?.trim();
        const content = contentInput?.value?.trim();
        if (!name || !content) {
            toastr.warning('名称和内容不能为空', DISPLAY_NAME);
            return;
        }
        try {
            if (editingId) {
                await updatePersistentMemory(chatId, editingId, { name, content });
                toastr.success('档案已更新', DISPLAY_NAME);
            } else {
                await addPersistentMemory(chatId, currentCategory, name, content);
                toastr.success('档案已添加', DISPLAY_NAME);
            }
            editingId = null;
            if (formEl) formEl.style.display = 'none';
            await renderPersistentPanel(overlay, chatId, currentCategory);
        } catch (err) {
            toastr.error(`保存失败：${err.message}`, DISPLAY_NAME);
        }
    });

    // 编辑按钮
    overlay.querySelectorAll('.bb-persistent-edit').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const all = await getPersistentMemories(chatId);
            const item = all.find(e => e.id === id);
            if (!item) return;
            editingId = id;
            if (nameInput) nameInput.value = item.name;
            if (contentInput) contentInput.value = item.content;
            if (formEl) formEl.style.display = 'flex';
        });
    });

    // 删除按钮
    overlay.querySelectorAll('.bb-persistent-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const ctx = SillyTavern.getContext();
            const ok = await ctx.Popup.show.confirm('删除档案', '确定删除此常驻档案吗？');
            if (!isPopupAffirmative(ctx, ok)) return;
            try {
                await removePersistentMemory(chatId, id);
                toastr.success('档案已删除', DISPLAY_NAME);
                await renderPersistentPanel(overlay, chatId, currentCategory);
            } catch (err) {
                toastr.error(`删除失败：${err.message}`, DISPLAY_NAME);
            }
        });
    });
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
                <select id="bb_mgr_sort" class="text_pole" style="width:auto;min-width:120px;">
                    <option value="created_desc" selected>创建时间 ↓</option>
                    <option value="created_asc">创建时间 ↑</option>
                    <option value="updated_desc">修改时间 ↓</option>
                    <option value="updated_asc">修改时间 ↑</option>
                </select>
                <button class="menu_button bb-mem-toolbar-btn" id="bb_mgr_add">
                    <i class="fa-solid fa-plus"></i> 添加
                </button>
                <button class="menu_button bb-mem-toolbar-btn" id="bb_mgr_ai_extract">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> AI提取
                </button>
            </div>

            <div class="bb-mgr-tabs">
                <button class="bb-mgr-tab active" data-tab="memories">
                    <i class="fa-solid fa-list"></i> 记忆
                </button>
                <button class="bb-mgr-tab" data-tab="slots">
                    <i class="fa-solid fa-floppy-disk"></i> 存档
                </button>
                <button class="bb-mgr-tab" data-tab="persistent">
                    <i class="fa-solid fa-archive"></i> 常驻档案
                </button>
            </div>

            <div class="bb-mgr-panel" data-panel="memories">
                <!-- v2.9.9: 当前存档状态栏 -->
                <div class="bb-current-slot-bar">
                    <span><i class="fa-solid fa-floppy-disk"></i> 存档: <strong id="bb_current_slot_name">default</strong></span>
                    <span>记忆: <strong id="bb_current_slot_count">0</strong> 条</span>
                </div>

                <div class="bb-mem-type-filters">
                    <button class="menu_button bb-mem-type-filter active" data-type="all">
                        <i class="fa-solid fa-layer-group"></i> 全部
                    </button>
                    ${typeFilterHTML}
                </div>

                <!-- v2.9.9: 批量操作栏（始终可见，无选择时按钮 disabled） -->
                <div class="bb-mem-batch-bar" id="bb_batch_bar">
                    <span class="bb-batch-count">已选 <strong id="bb_batch_count">0</strong> 条</span>
                    <button class="menu_button" id="bb_batch_select_all">全选</button>
                    <button class="menu_button" id="bb_batch_deselect_all">取消全选</button>
                    <button class="menu_button" id="bb_batch_delete" style="color:#f44336;" disabled>
                        <i class="fa-solid fa-trash"></i> 删除
                    </button>
                    <button class="menu_button" id="bb_batch_archive" disabled>
                        <i class="fa-solid fa-box-archive"></i> 归档
                    </button>
                    <button class="menu_button" id="bb_batch_fuzzy" disabled>
                        <i class="fa-solid fa-cloud"></i> 模糊化
                    </button>
                    <button class="menu_button" id="bb_batch_pin" disabled>
                        <i class="fa-solid fa-thumbtack"></i> 固定
                    </button>
                    <span class="bb-batch-hint">勾选左侧复选框以启用</span>
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

            <div class="bb-mgr-panel" data-panel="slots" style="display:none;">
                <div class="bb-slots-panel" id="bb_mgr_slots">
                    <div class="bb-mem-empty"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>
                </div>
            </div>

            <div class="bb-mgr-panel" data-panel="persistent" style="display:none;">
                <div class="bb-persistent-tabs">
                    <button class="bb-mgr-tab active" data-pcat="npc">
                        <i class="fa-solid fa-user"></i> NPC
                    </button>
                    <button class="bb-mgr-tab" data-pcat="item">
                        <i class="fa-solid fa-box"></i> 物品
                    </button>
                    <button class="bb-mgr-tab" data-pcat="timeline">
                        <i class="fa-solid fa-clock"></i> 时间线
                    </button>
                </div>
                <div class="bb-persistent-toolbar">
                    <button class="menu_button" id="bb_persistent_add">
                        <i class="fa-solid fa-plus"></i> 添加
                    </button>
                </div>
                <div class="bb-persistent-list" id="bb_persistent_list">
                    <div class="bb-mem-empty">加载中...</div>
                </div>
                <div class="bb-persistent-form" id="bb_persistent_form" style="display:none;">
                    <input type="text" id="bb_persistent_name" placeholder="名称（必填）" />
                    <textarea id="bb_persistent_content" placeholder="内容（必填）" rows="3"></textarea>
                    <div class="bb-persistent-form-actions">
                        <button class="menu_button" id="bb_persistent_cancel">取消</button>
                        <button class="menu_button" id="bb_persistent_save" style="background:#4caf50;color:#fff;">保存</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function buildMemoryItemHTML(m) {
    const createdDate = new Date(m.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const updatedStr = (m.updatedAt && m.updatedAt !== m.createdAt)
        ? ` <span class="bb-mem-item-date" title="最后编辑"><i class="fa-solid fa-pen" style="font-size:0.85em;"></i> ${new Date(m.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`
        : '';
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
                <input type="checkbox" class="bb-mem-batch-cb" data-id="${m.id}" style="margin-right:8px;width:15px;height:15px;cursor:pointer;flex-shrink:0;" />
                <span class="bb-mem-item-type" style="color: ${typeDef.color}">
                    <i class="${typeDef.icon}"></i> ${typeDef.label}
                </span>
                ${truthBadge}
                ${statusBadge}
                ${strengthBar}
            </div>
            <div class="bb-mem-item-content">${escapeHtml(m.content)}</div>
            <div class="bb-mem-item-meta">
                <span class="bb-mem-item-date" title="首次记录"><i class="fa-solid fa-calendar-plus" style="font-size:0.85em;"></i> ${createdDate}</span>${updatedStr}
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

    // Tab 切换（记忆 / 存档 / 常驻档案）
    overlay.querySelectorAll('.bb-mgr-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            const panelName = tab.dataset.tab;
            // 仅处理顶层 tab（排除常驻子 tab）
            if (!panelName) return;
            overlay.querySelectorAll('.bb-mgr-tabs > .bb-mgr-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            overlay.querySelectorAll('.bb-mgr-panel').forEach(p => {
                p.style.display = p.dataset.panel === panelName ? 'block' : 'none';
            });
            if (panelName === 'slots') {
                await renderSlotsPanel(overlay, chatId);
            } else if (panelName === 'persistent') {
                await renderPersistentPanel(overlay, chatId, 'npc');
            }
        });
    });

    // 类型过滤（v2.9.8: 追踪 activeFilter）
    overlay.querySelectorAll('.bb-mem-type-filter').forEach(btn => {
        btn.addEventListener('click', async () => {
            overlay.querySelectorAll('.bb-mem-type-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            activeFilter = btn.dataset.type;
            const memories = await getMemories(chatId);
            const filtered = activeFilter === 'all' ? memories : memories.filter(m => (m.cognitiveType || m.type) === activeFilter);
            renderMemoryList(overlay, filtered, chatId);
        });
    });

    // 添加记忆
    overlay.querySelector('#bb_mgr_add')?.addEventListener('click', () => {
        openAddMemoryForm(chatId, () => rerenderManagerList(overlay, chatId));
    });

    // AI提取
    overlay.querySelector('#bb_mgr_ai_extract')?.addEventListener('click', async () => {
        await handleAiExtract(overlay, chatId);
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

    // v3.3: 排序切换
    overlay.querySelector('#bb_mgr_sort')?.addEventListener('change', async () => {
        const memories = await getMemories(chatId);
        const searchQuery = overlay.querySelector('#bb_mgr_search')?.value?.trim() || '';
        if (searchQuery) {
            const results = simpleSearch(memories, searchQuery, 100);
            renderMemoryList(overlay, results, chatId);
        } else {
            renderMemoryList(overlay, memories, chatId);
        }
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
    bindBatchEvents(overlay, chatId);
}

// v2.9.8: 批量操作事件绑定
function bindBatchEvents(overlay, chatId) {
    const updateUI = () => updateBatchUI(overlay);

    // checkbox 变化时更新 UI
    overlay.addEventListener('change', (e) => {
        if (e.target.classList.contains('bb-mem-batch-cb')) {
            updateUI();
        }
    });

    overlay.querySelector('#bb_batch_select_all')?.addEventListener('click', () => {
        overlay.querySelectorAll('.bb-mem-batch-cb').forEach(cb => { cb.checked = true; });
        updateUI();
    });

    overlay.querySelector('#bb_batch_deselect_all')?.addEventListener('click', () => {
        overlay.querySelectorAll('.bb-mem-batch-cb').forEach(cb => { cb.checked = false; });
        updateUI();
    });

    async function batchAction(action, confirmMsg) {
        const checked = overlay.querySelectorAll('.bb-mem-batch-cb:checked');
        const ids = [...checked].map(cb => cb.dataset.id).filter(Boolean);
        if (!ids.length) {
            toastr.info('未选择任何记忆', DISPLAY_NAME);
            return;
        }
        const ctx = SillyTavern.getContext();
        const ok = await ctx.Popup.show.confirm(confirmMsg.title, `${confirmMsg.body} (${ids.length} 条)`);
        if (!isPopupAffirmative(ctx, ok)) return;

        for (const id of ids) {
            switch (action) {
                case 'delete': await removeMemory(chatId, id); break;
                case 'archive': await updateMemory(chatId, id, { status: 'archived' }); break;
                case 'fuzzy': {
                    const { fuzzyMemory } = await import('./memory-maintainer.js');
                    await fuzzyMemory(chatId, id);
                    break;
                }
                case 'pin': await updateMemory(chatId, id, { pinned: true }); break;
            }
        }
        toastr.success(confirmMsg.success, DISPLAY_NAME);
        // 保持当前的类型筛选
        const memories = await getMemories(chatId);
        const filtered = activeFilter === 'all' ? memories : memories.filter(m => (m.cognitiveType || m.type) === activeFilter);
        renderMemoryList(overlay, filtered, chatId);
        updateUI();
    }

    overlay.querySelector('#bb_batch_delete')?.addEventListener('click', () =>
        batchAction('delete', { title: '批量删除', body: '确定要删除选中的记忆吗？', success: '已批量删除' }));
    overlay.querySelector('#bb_batch_archive')?.addEventListener('click', () =>
        batchAction('archive', { title: '批量归档', body: '确定要归档选中的记忆吗？', success: '已批量归档' }));
    overlay.querySelector('#bb_batch_fuzzy')?.addEventListener('click', () =>
        batchAction('fuzzy', { title: '批量模糊化', body: '确定要模糊化选中的记忆吗？', success: '已批量模糊化' }));
    overlay.querySelector('#bb_batch_pin')?.addEventListener('click', () =>
        batchAction('pin', { title: '批量固定', body: '确定要固定选中的记忆吗？', success: '已批量固定' }));
}

function updateBatchUI(overlay) {
    const countEl = overlay.querySelector('#bb_batch_count');
    const checked = overlay.querySelectorAll('.bb-mem-batch-cb:checked');
    const count = checked.length;
    if (countEl) countEl.textContent = String(count);
    // v2.9.9: 始终显示批量栏，用 disabled 控制按钮
    ['bb_batch_delete', 'bb_batch_archive', 'bb_batch_fuzzy', 'bb_batch_pin'].forEach(id => {
        const btn = overlay.querySelector('#' + id);
        if (btn) btn.disabled = (count === 0);
    });
}

function sortMemories(memories, sortMode) {
    const sorted = [...memories];
    switch (sortMode) {
        case 'created_asc':  sorted.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); break;
        case 'updated_desc': sorted.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); break;
        case 'updated_asc':  sorted.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)); break;
        default:             sorted.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); break; // created_desc
    }
    return sorted;
}

function renderMemoryList(overlay, memories, chatId) {
    const sortEl = overlay.querySelector('#bb_mgr_sort');
    const sortMode = sortEl ? sortEl.value : 'created_desc';
    const sorted = sortMemories(memories, sortMode);
    const listEl = overlay.querySelector('#bb_mgr_list');
    if (listEl) {
        listEl.innerHTML = sorted.length
            ? sorted.map(m => buildMemoryItemHTML(m)).join('')
            : '<div class="bb-mem-empty">未找到匹配的记忆</div>';
    }
    const statsEl = overlay.querySelector('.bb-mem-stats');
    if (statsEl) statsEl.innerHTML = `共 <strong>${sorted.length}</strong> 条记忆`;
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

    // 编辑记忆
    overlay.querySelectorAll('.bb-mem-edit').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const memories = await getMemories(chatId);
            const memory = memories.find(m => m.id === id);
            if (!memory) return;
            openEditMemoryForm(chatId, memory, () => rerenderManagerList(overlay, chatId));
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
            openFactUpdateForm(chatId, memory, () => rerenderManagerList(overlay, chatId));
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
            case 'meta': {
                // v2.9.8: 标记/取消最后一条 AI 消息为元指令
                const ct = SillyTavern.getContext().chat;
                if (!ct || ct.length < 2) return '聊天消息不足';
                // 找最后一条 AI 消息
                let aiIdx = -1;
                for (let i = ct.length - 1; i >= 0; i--) {
                    if (!ct[i].is_user && !ct[i].is_system) { aiIdx = i; break; }
                }
                if (aiIdx === -1) return '未找到 AI 消息';
                ct[aiIdx]._bbmem_meta_marker = !ct[aiIdx]._bbmem_meta_marker;
                try { SillyTavern.getContext().saveChatDebounced(); } catch {}
                setTimeout(() => refreshExtractionMarkers(), 100);
                return ct[aiIdx]._bbmem_meta_marker ? '已标记为元指令 🤖（不会提取）' : '已取消元指令标记';
            }
            default:
                return '可用命令: /memory add|search|count|clear|meta\n示例: /memory add 角色喜欢喝咖啡';
        }
    };

    // 优先使用官方推荐的 SlashCommandParser（与新版酒馆命令浏览器兼容）
    // 所有 ST API 均通过 SillyTavern.getContext() 获取，不依赖静态导入
    try {
        if (typeof ctx.SlashCommandParser?.addCommandObject === 'function' && typeof ctx.SlashCommand?.fromProps === 'function') {
            ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
                name: 'memory',
                callback: memorySlashCallback,
                aliases: [],
                helpString: '管理 BB-Memory 记忆 (add/search/count/clear/meta)。示例: /memory add 角色喜欢喝咖啡',
            }));
        } else if (typeof ctx.registerSlashCommand === 'function') {
            ctx.registerSlashCommand('memory', memorySlashCallback, [], '管理BB-Memory记忆 (add/search/count/clear)');
        }
    } catch (err) {
        console.warn(`[${DISPLAY_NAME}] SlashCommandParser 注册失败，尝试旧版 registerSlashCommand`, err);
        if (typeof ctx.registerSlashCommand === 'function') {
            ctx.registerSlashCommand('memory', memorySlashCallback, [], '管理BB-Memory记忆 (add/search/count/clear)');
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  v2.9.8: 隐藏消息切换按钮
// ═══════════════════════════════════════════════════════════

// v2.9.9: 可拖拽悬浮球（Floating Action Hub）
function injectFloatingHub() {
    if (document.getElementById('bb_floating_hub')) return;

    const hub = document.createElement('div');
    hub.id = 'bb_floating_hub';
    hub.className = 'bb-floating-hub';
    hub.innerHTML = '<i class="fa-solid fa-brain"></i><span class="bb-hub-badge" id="bb_hub_badge" style="display:none;">0</span>';

    // 菜单面板（内嵌于 hub 内，position:absolute 跟随拖拽）
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

    // 点击/触摸结束 → 如果没有移动则展开菜单（但不包括菜单内的点击）
    hub.addEventListener('click', (e) => {
        if (hasMoved) { e.preventDefault(); e.stopPropagation(); return; }
        if (menu.contains(e.target)) return; // 菜单内的点击由菜单自己处理
        toggleFloatingMenu();
    });

    // 菜单项点击
    menu.addEventListener('click', async (e) => {
        const actionItem = e.target.closest('.bb-floating-menu-action');
        if (!actionItem) return;
        const action = actionItem.dataset.action;
        await handleFloatingMenuAction(action);
        // 折叠/展开类操作不关闭菜单
        if (action !== 'toggle_hit_list') {
            menu.style.display = 'none';
        }
    });

    // 点击其他区域关闭菜单
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== hub && !hub.contains(e.target)) {
            menu.style.display = 'none';
        }
    });

    // 定期更新徽章和状态
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
        const menuWidth = 268;   // CSS width 260 + some padding
        const menuMaxHeight = 320;
        const gap = 56;          // distance from hub center to menu edge
        const edgeMargin = 16;   // min distance from viewport edge

        // 水平方向：右侧空间不足 → 菜单向左展开；空间足够 → 向右展开
        if (hubRect.right + menuWidth > window.innerWidth - edgeMargin) {
            // 右侧空间不足，菜单向左展开
            menu.style.left = 'auto';
            menu.style.right = '0';
        } else {
            // 右侧空间足够，菜单向右展开
            menu.style.right = 'auto';
            menu.style.left = '0';
        }

        // 垂直方向：悬浮球靠上 → 菜单向下展开
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
    // 更新命中数徽章
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

    // 更新可见性按钮图标
    const toggleItem = document.querySelector('.bb-floating-menu-action[data-action="toggle_visibility"] i');
    if (toggleItem) {
        const showing = document.body.classList.contains('bb-show-extracted');
        toggleItem.className = showing ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
    }

    // v3.1: 命中列表展开时同步刷新
    const hitList = document.getElementById('bb_hub_hit_list');
    if (hitList && hitList.style.display !== 'none') {
        const chatId = getChatId();
        if (chatId) renderHubHitList(hitList, chatId);
    }
}

async function handleFloatingMenuAction(action) {
    const chatId = getChatId();
    switch (action) {
        case 'toggle_visibility': {
            document.body.classList.toggle('bb-show-extracted');
            const showing = document.body.classList.contains('bb-show-extracted');
            toastr.info(showing ? '已显示被隐藏的楼层' : '已隐藏已提取的楼层', DISPLAY_NAME, { timeOut: 1500 });
            break;
        }
        case 'meta_last': {
            const ctx = SillyTavern.getContext();
            const chat = ctx.chat;
            if (!chat || chat.length < 2) {
                toastr.warning('聊天消息不足', DISPLAY_NAME);
                return;
            }
            let aiIdx = -1;
            for (let i = chat.length - 1; i >= 0; i--) {
                if (!chat[i].is_user && !chat[i].is_system) { aiIdx = i; break; }
            }
            if (aiIdx === -1) { toastr.warning('未找到 AI 消息', DISPLAY_NAME); return; }
            chat[aiIdx]._bbmem_meta_marker = !chat[aiIdx]._bbmem_meta_marker;
            try { ctx.saveChatDebounced(); } catch {}
            setTimeout(() => refreshExtractionMarkers(), 100);
            const label = chat[aiIdx]._bbmem_meta_marker ? '🤖 已标记为元指令（不提取）' : '🗃️ 已标记为可提取';
            toastr.info(label, DISPLAY_NAME, { timeOut: 1500 });
            break;
        }
        case 'manual_extract': {
            if (chatId) {
                try { await import('./auto-generator.js').then(m => m.autoExtractOnce?.(chatId)); } catch {}
            }
            if (typeof handleAiExtract === 'function') {
                handleAiExtract(chatId);
            } else {
                toastr.info('请使用管理面板中的"AI提取"按钮', DISPLAY_NAME);
            }
            break;
        }
        case 'open_manager': {
            await openMemoryManager();
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

        // 延迟检查维护需求和刷新提取标记，避免阻塞聊天切换
        setTimeout(() => triggerMaintenanceCheck(), 3000);
        setTimeout(() => refreshExtractionMarkers(), 800);
    }
}

async function onNewMessage() {
    const settings = getSettings();
    if (!settings.enabled) return;
    try {
        // v3.0.0: 仅当 autoGen 关闭时由本函数管理窗口。
        // autoGen 启用时由 onMessageReceived 的提取+hideExchange 管理，
        // 避免 syncMessageVisibility 在提取定时器之前截断可见 exchange。
        if (!settings.autoGenEnabled) {
            await syncMessageVisibility();
        }
        setTimeout(() => refreshExtractionMarkers(), 300);
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

    // 关闭按钮
    overlay.querySelector('.bb-maint-close')?.addEventListener('click', () => overlay.remove());

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

// v2.9.5：初始化折叠设置面板
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

    // 恢复自定义提示词
    const autoPromptEl = document.getElementById('bb_memory_auto_prompt');
    if (autoPromptEl) autoPromptEl.value = getSettings().autoGenPrompt || '';
    const ctxPromptEl = document.getElementById('bb_memory_context_prompt');
    if (ctxPromptEl) ctxPromptEl.value = getSettings().autoGenContextPrompt || '';

    // 初始化自定义API区域显示状态
    const settings = getSettings();
    const customSection = document.getElementById('bb_memory_custom_api_section');
    if (customSection) {
        customSection.style.display = settings.autoGenMode === 'custom' ? 'block' : 'none';
    }

    // 恢复副API字段值到UI
    restoreApiSettings(settings);

    // 绑定侧边栏事件
    bindSidebarEvents();

    // v2.9.5：初始化折叠设置
    initCollapsibleSettings();

    // 初始化 AI 自动生成模块
    if (settings.autoGenEnabled) {
        initAutoGenerator();
    }

    // 设置自动提取进度回调（v3.0.0: 同步更新悬浮菜单进度行；v3.3: 同步侧边栏）
    setAutoExtractProgressCallback((phase, current, total) => {
        const updateUI = (rowId, pctId) => {
            const progRow = document.getElementById(rowId);
            if (!progRow) return;
            const pctEl = document.getElementById(pctId);
            const icon = progRow.querySelector('i');

            if (phase === 'done') {
                if (icon) { icon.className = 'fa-solid fa-check-circle'; icon.style.color = '#4caf50'; }
                if (pctEl) pctEl.textContent = '完成';
            } else if (phase === 'idle') {
                if (icon) { icon.className = 'fa-solid fa-moon'; icon.style.color = ''; }
                if (pctEl) pctEl.textContent = '';
            } else {
                if (icon) { icon.className = 'fa-solid fa-spinner fa-spin'; icon.style.color = ''; }
                const pct = total > 0 ? Math.round((current / total) * 100) : 0;
                if (pctEl) pctEl.textContent = pct + '%';
            }
        };
        updateUI('bb_hub_extract_progress', 'bb_hub_extract_pct');
        // v3.3: 同步侧边栏进度
        const sidebarRow = document.getElementById('bb_sidebar_extract_progress');
        if (sidebarRow) {
            const icon = sidebarRow.querySelector('i');
            const strong = sidebarRow.querySelector('strong');
            if (phase === 'done') {
                if (icon) { icon.className = 'fa-solid fa-check-circle'; icon.style.color = '#4caf50'; }
                if (strong) strong.textContent = '完成';
            } else if (phase === 'idle') {
                if (icon) { icon.className = 'fa-solid fa-moon'; icon.style.color = ''; }
                if (strong) strong.textContent = '空闲';
            } else {
                if (icon) { icon.className = 'fa-solid fa-spinner fa-spin'; icon.style.color = ''; }
                const pct = total > 0 ? Math.round((current / total) * 100) : 0;
                if (strong) strong.textContent = pct + '%';
            }
        }
    });

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

    // v2.9.9: 注入可拖拽悬浮球
    injectFloatingHub();

    // v2.9.9: 修复元标记按钮 — 全局委托点击事件
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.bb-meta-toggle-btn');
        if (!btn) return;
        const mesBlock = btn.closest('.mes');
        const mesId = mesBlock?.getAttribute('mesid');
        const currentChat = SillyTavern.getContext().chat;
        if (mesId == null || !currentChat) return;
        const idx = parseInt(mesId, 10);
        if (isNaN(idx) || idx < 0 || idx >= currentChat.length) return;
        currentChat[idx]._bbmem_meta_marker = !currentChat[idx]._bbmem_meta_marker;
        try { SillyTavern.getContext().saveChatDebounced(); } catch {}
        refreshExtractionMarkers();
        const newLabel = currentChat[idx]._bbmem_meta_marker ? '🤖 已标记为元指令（不提取）' : '🗃️ 已标记为可提取';
        toastr.info(newLabel, DISPLAY_NAME, { timeOut: 1500 });
    });

    console.log(`[${DISPLAY_NAME}] v3.0.0 初始化完成`);
}

// ═══ 启动 ═══

(function startup() {
    const ctx = SillyTavern.getContext();
    const ev = ctx.event_types ?? ctx.eventTypes;

    if (ctx.eventSource && ev?.APP_READY) {
        // 首选：监听 APP_READY 事件（最可靠的初始化时机）
        ctx.eventSource.on(ev.APP_READY, () => init());
    } else if (document.readyState === 'complete' || document.readyState === 'interactive') {
        // DOM 已就绪，直接初始化
        init();
    } else {
        // DOM 尚未就绪，等待 load 事件
        window.addEventListener('load', () => init());
    }
})();
