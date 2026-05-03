/**
 * memory-assistant.js —— BB-Memory 的"记忆管家"
 *
 * ═══════════════════════════════════════════════════════════
 *  代码小课堂
 * ═══════════════════════════════════════════════════════════
 *
 * 这个文件是什么？
 *   想象一个专业的图书管理员，它有一个独立的工作台（悬浮窗），
 *   可以帮你分析、整理、优化所有的记忆。
 *   比如告诉你哪些记忆太旧了、哪些可能重复、哪些最重要。
 *
 * 用了哪些编程概念？
 *   - DOM 操作：创建和操控页面上的元素（悬浮窗、按钮等）
 *   - 拖拽(Drag)：让悬浮窗可以被鼠标拖动
 *   - Tab 切换：类似浏览器标签页，切换不同视图
 *   - 统计计算：遍历数据并汇总信息
 *   - 事件委托：在父元素上监听子元素的事件
 *
 * 功能：
 *   1. 仪表盘：记忆总览（数量、类型分布、平均强度等）
 *   2. 分类浏览：按类型（事件/NPC/物品等）分标签查看
 *   3. 健康分析：检测弱记忆、可能重复的记忆
 *   4. 批量操作：多选删除、批量调整
 *   5. AI 整理：一键让 AI 分析并建议优化
 *
 * ═══════════════════════════════════════════════════════════
 */

import { getMemories, removeMemory, getMemoryStats, updateMemory } from './memory-store.js';
import { MEMORY_TYPES, TRUTH_STATUS, HIDDEN_NOTE_TYPES, getTypeDefinition } from './memory-types.js';
import { simpleSearch } from './retriever.js';

// ═══ 状态 ═══
let assistantWindow = null;
let currentChatId = null;

// ═══ 公共接口 ═══

/**
 * 打开记忆管理助手（悬浮窗）
 */
export async function openAssistant(chatId) {
    if (assistantWindow) {
        assistantWindow.remove();
    }

    currentChatId = chatId;

    if (!chatId) {
        toastr.warning('请先选择一个角色并开始聊天', 'BB-Memory');
        return;
    }

    const memories = await getMemories(chatId);
    const stats = await getMemoryStats(chatId);

    assistantWindow = document.createElement('div');
    assistantWindow.className = 'bb-assistant-window';
    assistantWindow.innerHTML = buildAssistantHTML(memories, stats);
    document.body.appendChild(assistantWindow);

    initDrag(assistantWindow);
    bindAssistantEvents(assistantWindow, chatId);
    switchTab(assistantWindow, 'dashboard');
}

/**
 * 关闭助手窗口
 */
export function closeAssistant() {
    if (assistantWindow) {
        assistantWindow.remove();
        assistantWindow = null;
    }
}

// ═══ 构建 HTML ═══

function buildAssistantHTML(memories, stats) {
    return `
        <div class="bb-assistant-header" id="bb_assistant_drag_handle">
            <div class="bb-assistant-title">
                <i class="fa-solid fa-brain"></i> 记忆管家
            </div>
            <div class="bb-assistant-controls">
                <button class="bb-assistant-btn" id="bb_assistant_refresh" title="刷新">
                    <i class="fa-solid fa-refresh"></i>
                </button>
                <button class="bb-assistant-btn bb-assistant-close" id="bb_assistant_close" title="关闭">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>

        <div class="bb-assistant-tabs">
            <button class="bb-assistant-tab active" data-tab="dashboard">
                <i class="fa-solid fa-gauge"></i> 仪表盘
            </button>
            <button class="bb-assistant-tab" data-tab="browse">
                <i class="fa-solid fa-folder-open"></i> 浏览
            </button>
            <button class="bb-assistant-tab" data-tab="health">
                <i class="fa-solid fa-heart-pulse"></i> 健康
            </button>
            <button class="bb-assistant-tab" data-tab="batch">
                <i class="fa-solid fa-list-check"></i> 批量
            </button>
        </div>

        <div class="bb-assistant-body">
            <!-- 仪表盘 -->
            <div class="bb-assistant-panel" data-panel="dashboard">
                ${buildDashboardHTML(memories, stats)}
            </div>

            <!-- 分类浏览 -->
            <div class="bb-assistant-panel" data-panel="browse" style="display:none;">
                ${buildBrowseHTML(memories)}
            </div>

            <!-- 健康分析 -->
            <div class="bb-assistant-panel" data-panel="health" style="display:none;">
                ${buildHealthHTML(memories)}
            </div>

            <!-- 批量操作 -->
            <div class="bb-assistant-panel" data-panel="batch" style="display:none;">
                ${buildBatchHTML(memories)}
            </div>
        </div>
    `;
}

function buildDashboardHTML(memories, stats) {
    const typeCards = Object.entries(stats.byType || {}).map(([type, count]) => {
        const typeDef = getTypeDefinition(type);
        return `<div class="bb-dash-type-card" style="border-color: ${typeDef.color}">
            <i class="${typeDef.icon}" style="color: ${typeDef.color}"></i>
            <span class="bb-dash-type-count">${count}</span>
            <span class="bb-dash-type-label">${typeDef.label}</span>
        </div>`;
    }).join('');

    const strengthPercent = ((stats.avgStrength || 0) * 100).toFixed(0);
    const importancePercent = ((stats.avgImportance || 0) * 100).toFixed(0);

    return `
        <div class="bb-dash-summary">
            <div class="bb-dash-stat">
                <div class="bb-dash-stat-value">${stats.total}</div>
                <div class="bb-dash-stat-label">总记忆数</div>
            </div>
            <div class="bb-dash-stat">
                <div class="bb-dash-stat-value">${strengthPercent}%</div>
                <div class="bb-dash-stat-label">平均强度</div>
            </div>
            <div class="bb-dash-stat">
                <div class="bb-dash-stat-value">${importancePercent}%</div>
                <div class="bb-dash-stat-label">平均重要性</div>
            </div>
        </div>

        <div class="bb-dash-section-title">按类型分布</div>
        <div class="bb-dash-type-grid">
            ${typeCards || '<div class="bb-mem-empty">暂无记忆</div>'}
        </div>

        <div class="bb-dash-section-title">最近记忆</div>
        <div class="bb-dash-recent">
            ${memories.slice(-5).reverse().map(m => {
                const typeDef = getTypeDefinition(m.cognitiveType || m.type);
                return `<div class="bb-dash-recent-item">
                    <i class="${typeDef.icon}" style="color: ${typeDef.color}"></i>
                    <span>${escapeHtml(m.content.slice(0, 60))}${m.content.length > 60 ? '...' : ''}</span>
                </div>`;
            }).join('') || '<div class="bb-mem-empty">暂无记忆</div>'}
        </div>
    `;
}

function buildBrowseHTML(memories) {
    const typeButtons = Object.values(MEMORY_TYPES).map(t =>
        `<button class="bb-browse-type-btn" data-browse-type="${t.id}" style="color: ${t.color}">
            <i class="${t.icon}"></i> ${t.label}
            <span class="bb-browse-count">${memories.filter(m => (m.cognitiveType || m.type) === t.id).length}</span>
        </button>`
    ).join('');

    return `
        <div class="bb-browse-types">${typeButtons}</div>
        <div class="bb-browse-search">
            <input type="text" class="text_pole" id="bb_assistant_browse_search"
                   placeholder="搜索记忆内容..." />
        </div>
        <div class="bb-browse-list" id="bb_assistant_browse_list">
            <div class="bb-mem-empty">选择左侧类型查看记忆</div>
        </div>
    `;
}

function buildHealthHTML(memories) {
    // 分析记忆健康状况
    const weakMemories = memories.filter(m => (m.strength || 1) < 0.3);
    const oldMemories = memories.filter(m => {
        const age = Date.now() - (m.createdAt || 0);
        return age > 30 * 24 * 60 * 60 * 1000; // 超过30天
    });
    const lowImportance = memories.filter(m => (m.importance || 0.5) < 0.3);

    // 简单重复检测（内容相似度）
    const possibleDuplicates = findPossibleDuplicates(memories);

    return `
        <div class="bb-health-section">
            <div class="bb-health-card ${weakMemories.length ? 'bb-health-warning' : 'bb-health-ok'}">
                <i class="fa-solid fa-battery-quarter"></i>
                <div>
                    <strong>弱记忆</strong>
                    <p>${weakMemories.length} 条记忆强度低于 30%，可能即将被遗忘</p>
                </div>
            </div>

            <div class="bb-health-card ${possibleDuplicates.length ? 'bb-health-warning' : 'bb-health-ok'}">
                <i class="fa-solid fa-clone"></i>
                <div>
                    <strong>疑似重复</strong>
                    <p>发现 ${possibleDuplicates.length} 组可能重复的记忆</p>
                </div>
            </div>

            <div class="bb-health-card ${oldMemories.length > 10 ? 'bb-health-info' : 'bb-health-ok'}">
                <i class="fa-solid fa-clock"></i>
                <div>
                    <strong>老旧记忆</strong>
                    <p>${oldMemories.length} 条记忆超过 30 天未被访问</p>
                </div>
            </div>

            <div class="bb-health-card ${lowImportance.length > 5 ? 'bb-health-info' : 'bb-health-ok'}">
                <i class="fa-solid fa-circle-exclamation"></i>
                <div>
                    <strong>低重要性</strong>
                    <p>${lowImportance.length} 条记忆重要性较低</p>
                </div>
            </div>
        </div>

        ${weakMemories.length ? `
        <div class="bb-health-detail">
            <div class="bb-dash-section-title">弱记忆列表（可考虑删除或强化）</div>
            ${weakMemories.slice(0, 10).map(m => `
                <div class="bb-health-mem-item">
                    <span>${escapeHtml(m.content.slice(0, 50))}</span>
                    <span class="bb-health-strength">强度: ${((m.strength || 0) * 100).toFixed(0)}%</span>
                </div>
            `).join('')}
        </div>` : ''}
    `;
}

function buildBatchHTML(memories) {
    return `
        <div class="bb-batch-tools">
            <button class="menu_button" id="bb_batch_select_all">
                <i class="fa-solid fa-check-double"></i> 全选
            </button>
            <button class="menu_button" id="bb_batch_select_none">
                <i class="fa-solid fa-xmark"></i> 取消全选
            </button>
            <button class="menu_button" id="bb_batch_select_weak">
                <i class="fa-solid fa-filter"></i> 选择弱记忆
            </button>
            <button class="menu_button menu_button_danger" id="bb_batch_delete">
                <i class="fa-solid fa-trash"></i> 删除选中
            </button>
        </div>
        <div class="bb-batch-list" id="bb_batch_list">
            ${memories.map(m => {
                const typeDef = getTypeDefinition(m.cognitiveType || m.type);
                return `<label class="bb-batch-item">
                    <input type="checkbox" data-id="${m.id}" class="bb-batch-checkbox" />
                    <i class="${typeDef.icon}" style="color: ${typeDef.color}"></i>
                    <span class="bb-batch-content">${escapeHtml(m.content.slice(0, 60))}</span>
                    <span class="bb-batch-strength">${((m.strength || 1) * 100).toFixed(0)}%</span>
                </label>`;
            }).join('') || '<div class="bb-mem-empty">暂无记忆</div>'}
        </div>
    `;
}

// ═══ 事件绑定 ═══

function bindAssistantEvents(window, chatId) {
    // 关闭
    window.querySelector('#bb_assistant_close')?.addEventListener('click', closeAssistant);

    // 刷新
    window.querySelector('#bb_assistant_refresh')?.addEventListener('click', async () => {
        const memories = await getMemories(chatId);
        const stats = await getMemoryStats(chatId);
        const body = window.querySelector('.bb-assistant-body');
        if (body) {
            const panels = body.querySelectorAll('.bb-assistant-panel');
            panels.forEach(p => p.remove());
            body.innerHTML = `
                <div class="bb-assistant-panel" data-panel="dashboard">${buildDashboardHTML(memories, stats)}</div>
                <div class="bb-assistant-panel" data-panel="browse" style="display:none;">${buildBrowseHTML(memories)}</div>
                <div class="bb-assistant-panel" data-panel="health" style="display:none;">${buildHealthHTML(memories)}</div>
                <div class="bb-assistant-panel" data-panel="batch" style="display:none;">${buildBatchHTML(memories)}</div>
            `;
            bindBrowseEvents(window, chatId);
            bindBatchEvents(window, chatId);
        }
        const activeTab = window.querySelector('.bb-assistant-tab.active')?.dataset.tab || 'dashboard';
        switchTab(window, activeTab);
        toastr.info('已刷新', 'BB-Memory');
    });

    // Tab 切换
    window.querySelectorAll('.bb-assistant-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            window.querySelectorAll('.bb-assistant-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            switchTab(window, tab.dataset.tab);
        });
    });

    bindBrowseEvents(window, chatId);
    bindBatchEvents(window, chatId);
}

function bindBrowseEvents(window, chatId) {
    // 类型按钮
    window.querySelectorAll('.bb-browse-type-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const type = btn.dataset.browseType;
            const memories = await getMemories(chatId);
            const filtered = memories.filter(m => (m.cognitiveType || m.type) === type);
            const listEl = window.querySelector('#bb_assistant_browse_list');
            if (listEl) {
                listEl.innerHTML = filtered.length
                    ? filtered.map(m => buildBrowseItemHTML(m)).join('')
                    : '<div class="bb-mem-empty">该类型暂无记忆</div>';
            }
        });
    });

    // 搜索
    window.querySelector('#bb_assistant_browse_search')?.addEventListener('input', async (e) => {
        const query = e.target.value.trim();
        const memories = await getMemories(chatId);
        const results = query ? simpleSearch(memories, query, 50) : memories.slice(0, 50);
        const listEl = window.querySelector('#bb_assistant_browse_list');
        if (listEl) {
            listEl.innerHTML = results.length
                ? results.map(m => buildBrowseItemHTML(m)).join('')
                : '<div class="bb-mem-empty">未找到匹配记忆</div>';
        }
    });
}

function bindBatchEvents(window, chatId) {
    window.querySelector('#bb_batch_select_all')?.addEventListener('click', () => {
        window.querySelectorAll('.bb-batch-checkbox').forEach(cb => cb.checked = true);
    });

    window.querySelector('#bb_batch_select_none')?.addEventListener('click', () => {
        window.querySelectorAll('.bb-batch-checkbox').forEach(cb => cb.checked = false);
    });

    window.querySelector('#bb_batch_select_weak')?.addEventListener('click', async () => {
        const memories = await getMemories(chatId);
        const weakIds = new Set(memories.filter(m => (m.strength || 1) < 0.3).map(m => m.id));
        window.querySelectorAll('.bb-batch-checkbox').forEach(cb => {
            cb.checked = weakIds.has(cb.dataset.id);
        });
    });

    window.querySelector('#bb_batch_delete')?.addEventListener('click', async () => {
        const selected = [...window.querySelectorAll('.bb-batch-checkbox:checked')].map(cb => cb.dataset.id);
        if (!selected.length) {
            toastr.warning('未选择任何记忆', 'BB-Memory');
            return;
        }

        const ctx = SillyTavern.getContext();
        const ok = await ctx.Popup.show.confirm('批量删除', `确定删除选中的 ${selected.length} 条记忆吗？`);
        const affirmative = ctx.POPUP_RESULT?.AFFIRMATIVE ?? 1;
        if (ok !== affirmative) return;

        for (const id of selected) {
            await removeMemory(chatId, id);
        }

        toastr.success(`已删除 ${selected.length} 条记忆`, 'BB-Memory');

        // 刷新批量列表
        const memories = await getMemories(chatId);
        const batchList = window.querySelector('#bb_batch_list');
        if (batchList) {
            batchList.innerHTML = buildBatchHTML(memories).match(/<div class="bb-batch-list"[^>]*>([\s\S]*)<\/div>/)?.[1] || '';
        }
    });
}

function buildBrowseItemHTML(m) {
    const typeDef = getTypeDefinition(m.cognitiveType || m.type);
    const date = new Date(m.createdAt).toLocaleString('zh-CN');
    const tagsHTML = (m.tags || []).slice(0, 4)
        .map(t => `<span class="bb-mem-tag">${escapeHtml(typeof t === 'string' ? t : t.name)}</span>`)
        .join('');

    const tsDef = TRUTH_STATUS[m.truthStatus];
    const truthBadge = m.truthStatus && m.truthStatus !== 'true' && tsDef
        ? `<span class="bb-truth-badge" style="background: ${tsDef.color}">${tsDef.label}</span>`
        : '';

    const noteCount = Array.isArray(m.hiddenNotes) ? m.hiddenNotes.length : 0;
    const noteIcon = noteCount > 0
        ? `<span class="bb-browse-note-icon" title="${noteCount} 条隐藏备注"><i class="fa-solid fa-eye"></i> ${noteCount}</span>`
        : '';

    return `
        <div class="bb-browse-item">
            <div class="bb-browse-item-header">
                <span style="color: ${typeDef.color}"><i class="${typeDef.icon}"></i> ${typeDef.label}</span>
                ${truthBadge}
                ${noteIcon}
                <span class="bb-browse-item-date">${date}</span>
            </div>
            <div class="bb-browse-item-content">${escapeHtml(m.content)}</div>
            <div class="bb-browse-item-tags">${tagsHTML}</div>
        </div>
    `;
}

// ═══ Tab 切换 ═══

function switchTab(window, tabName) {
    window.querySelectorAll('.bb-assistant-panel').forEach(panel => {
        panel.style.display = panel.dataset.panel === tabName ? 'block' : 'none';
    });
}

// ═══ 拖拽功能 ═══

function initDrag(window) {
    const handle = window.querySelector('#bb_assistant_drag_handle');
    if (!handle) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = window.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        handle.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        window.style.left = `${startLeft + dx}px`;
        window.style.top = `${startTop + dy}px`;
        window.style.right = 'auto';
        window.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            handle.style.cursor = 'grab';
        }
    });
}

// ═══ 工具函数 ═══

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 简单的重复检测（基于文本相似度）
 */
function findPossibleDuplicates(memories) {
    const duplicates = [];
    const checked = new Set();

    for (let i = 0; i < memories.length; i++) {
        if (checked.has(i)) continue;
        const group = [i];

        for (let j = i + 1; j < memories.length; j++) {
            if (checked.has(j)) continue;
            if (isSimilar(memories[i].content, memories[j].content)) {
                group.push(j);
                checked.add(j);
            }
        }

        if (group.length > 1) {
            duplicates.push(group.map(idx => memories[idx]));
            checked.add(i);
        }
    }

    return duplicates;
}

function isSimilar(text1, text2) {
    if (!text1 || !text2) return false;
    const a = text1.toLowerCase().trim();
    const b = text2.toLowerCase().trim();

    // 完全包含
    if (a.includes(b) || b.includes(a)) return true;

    // 简单的 Jaccard 相似度
    const setA = new Set(a.split(/\s+/));
    const setB = new Set(b.split(/\s+/));
    const intersection = [...setA].filter(x => setB.has(x)).length;
    const union = new Set([...setA, ...setB]).size;

    return union > 0 && (intersection / union) > 0.7;
}
