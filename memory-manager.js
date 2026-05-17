/**
 * memory-manager.js —— BB-Memory v5.5 记忆管理器
 *
 * 全屏覆盖弹窗，3 标签页：记忆 / 存档 / 常驻档案。
 * 从 v4.4.2 移植，适配 v5.5 四柱数据架构。
 */

import {
    getNpcProfiles, addNpcProfile, updateNpcProfile, removeNpcProfile,
    getItems, addItem, updateItem, removeItem,
    getTimeline, addTimelineEntry, updateTimelineEntry, removeTimelineEntry,
    getTimelineThreads, upsertTimelineThread, removeTimelineThread,
    getMemories, addMemory, updateMemory, removeMemory,
    clearAllData, deleteByExchange, getMemoryStats, getSettings, updateSettings,
    exportMemories, importMemories, updateFactContent, addHiddenNote, removeHiddenNote,
} from './memory-store.js';
import { getCharacterId, listSlots, saveToSlot, loadFromSlot, createEmptySlot, deleteSlot } from './memory-slots.js';
import { simpleSearch } from './retriever.js';
import { MEMORY_TYPES, TRUTH_STATUS, HIDDEN_NOTE_TYPES, TIMELINE_STATUS, ITEM_STATUS } from './memory-types.js';
import { NPC_TIERS, ITEM_TIERS, normalizeNpcTier, normalizeItemTier } from './entity-tiers.js';
import { extractFromContext, saveExtractedMemories } from './auto-generator.js';
import { markExchangeExtracted, hideExchange, unmarkExchangeProcessed } from './message-state.js';
import { fuzzyMemory, archiveMemory, restoreMemory } from './memory-maintainer.js';

// ═══ 全局状态 ═══
let activeFilter = 'all';

// ═══ 入口 ═══

export async function openMemoryManager(chatId) {
    const existing = document.querySelector('.bb-mem-overlay');
    if (existing) existing.remove();

    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);

    const overlay = document.createElement('div');
    overlay.className = 'bb-mem-overlay';
    overlay.innerHTML = buildManagerHTML(npc, items, timeline, memories, chatId);
    document.body.appendChild(overlay);

    bindManagerEvents(overlay, chatId);
    updateCurrentSlotBar(overlay, chatId);
}

// ═══ HTML 构建 ═══

function buildManagerHTML(npc, items, timeline, memories, chatId) {
    const totalCount = npc.length + items.length + timeline.length + memories.length;
    const allEntries = [
        ...npc.map(e => ({ ...e, _pillar: 'npc' })),
        ...items.map(e => ({ ...e, _pillar: 'item' })),
        ...timeline.map(e => ({ ...e, _pillar: 'timeline' })),
        ...memories.map(e => ({ ...e, _pillar: 'mem' })),
    ];

    const listHTML = allEntries.length
        ? allEntries.map(e => buildEntryItemHTML(e)).join('')
        : '<div class="bb-mem-empty">暂无记忆，点击上方按钮添加第一条记忆吧</div>';

    return `
    <div class="bb-mem-popup">
        <div class="bb-mem-popup-header">
            <h3><i class="fa-solid fa-brain"></i> BB-Memory 记忆管家</h3>
            <span class="bb-mem-close" title="关闭">&times;</span>
        </div>

        <div class="bb-mgr-tabs">
            <button class="bb-mgr-tab active" data-tab="memories">
                <i class="fa-solid fa-list"></i> 记忆
            </button>
            <button class="bb-mgr-tab" data-tab="slots">
                <i class="fa-solid fa-floppy-disk"></i> 存档
            </button>
            <button class="bb-mgr-tab" data-tab="threads">
                <i class="fa-solid fa-timeline"></i> 时间线
            </button>
            <button class="bb-mgr-tab" data-tab="dashboard">
                <i class="fa-solid fa-gauge-high"></i> 仪表盘
            </button>
            <button class="bb-mgr-tab" data-tab="warehouse">
                <i class="fa-solid fa-box-archive"></i> 归档仓库
            </button>
        </div>

        <!-- 记忆标签页 -->
        <div class="bb-mgr-panel" data-panel="memories">
            <div class="bb-current-slot-bar">
                <span><i class="fa-solid fa-floppy-disk"></i> 存档: <strong id="bb_current_slot_name">default</strong></span>
                <span>条目: <strong id="bb_current_slot_count">0</strong> 条</span>
            </div>

            <div class="bb-mem-toolbar">
                <input type="text" class="bb-mem-search text_pole" placeholder="搜索..." id="bb_mgr_search" />
                <select id="bb_mgr_sort" class="text_pole" style="width:auto;min-width:120px;">
                    <option value="created_desc" selected>创建时间 ↓</option>
                    <option value="created_asc">创建时间 ↑</option>
                    <option value="updated_desc">修改时间 ↓</option>
                    <option value="updated_asc">修改时间 ↑</option>
                    <option value="floor_desc">楼层 ↓</option>
                    <option value="floor_asc">楼层 ↑</option>
                </select>
                <button class="menu_button bb-mem-toolbar-btn" id="bb_mgr_add">
                    <i class="fa-solid fa-plus"></i> 添加
                </button>
                <button class="menu_button bb-mem-toolbar-btn" id="bb_mgr_ai_extract">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> AI提取
                </button>
            </div>

            <div class="bb-mem-type-filters" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                <button class="menu_button bb-mem-type-filter active" data-type="all">
                    <i class="fa-solid fa-layer-group"></i> 全部
                </button>
                <button class="menu_button bb-mem-type-filter" data-type="mem">
                    <i class="fa-solid fa-brain"></i> 记忆
                </button>
                <button class="menu_button bb-mem-type-filter" data-type="npc">
                    <i class="fa-solid fa-user"></i> NPC
                </button>
                <button class="menu_button bb-mem-type-filter" data-type="item">
                    <i class="fa-solid fa-box"></i> 物品
                </button>
                <button class="menu_button bb-mem-type-filter" data-type="timeline">
                    <i class="fa-solid fa-clock"></i> 时间条目
                </button>
                <span style="flex:1;"></span>
                <span class="bb-batch-count" id="bb_batch_count_label" style="display:none;font-size:0.8em;opacity:0.7;">已选 <strong id="bb_batch_count">0</strong> 条</span>
                <div id="bb_batch_menu" class="bb-batch-dropdown" style="position:relative;display:inline-block;">
                    <button class="menu_button" id="bb_batch_toggle" disabled>
                        <i class="fa-solid fa-list-check"></i> 批量编辑 ▾
                    </button>
                    <div class="bb-batch-dropdown-content" style="display:none;position:absolute;right:0;top:100%;z-index:10;background:var(--SmartThemeChatTintColor,#1e1e2e);border:1px solid var(--SmartThemeBorderColor,#444);border-radius:8px;padding:4px;min-width:140px;box-shadow:0 4px 12px rgba(0,0,0,0.3);">
                        <button class="menu_button" id="bb_batch_select_all" style="display:block;width:100%;text-align:left;margin:1px 0;">全选</button>
                        <button class="menu_button" id="bb_batch_deselect_all" style="display:block;width:100%;text-align:left;margin:1px 0;">取消全选</button>
                        <hr style="margin:2px 0;border-color:var(--SmartThemeBorderColor,#444);" />
                        <button class="menu_button" id="bb_batch_delete" style="display:block;width:100%;text-align:left;color:#f44336;margin:1px 0;" disabled>
                            <i class="fa-solid fa-trash"></i> 删除选中
                        </button>
                        <button class="menu_button" id="bb_batch_archive" style="display:block;width:100%;text-align:left;margin:1px 0;" disabled>
                            <i class="fa-solid fa-box-archive"></i> 归档选中
                        </button>
                        <button class="menu_button" id="bb_batch_fuzzy" style="display:block;width:100%;text-align:left;margin:1px 0;" disabled>
                            <i class="fa-solid fa-cloud"></i> 模糊化选中
                        </button>
                    </div>
                </div>
            </div>

            <div class="bb-mem-stats">
                共 <strong>${totalCount}</strong> 条（NPC ${npc.length} / 物品 ${items.length} / 时间线 ${timeline.length} / 记忆 ${memories.length}）
            </div>

            <div class="bb-mem-list" id="bb_mgr_list">${listHTML}</div>

            <div class="bb-mem-footer">
                <button class="menu_button" id="bb_mgr_export" title="导出记忆到JSON文件">
                    <i class="fa-solid fa-download"></i> 导出
                </button>
                <button class="menu_button" id="bb_mgr_import" title="从JSON文件导入">
                    <i class="fa-solid fa-upload"></i> 导入
                </button>
                <button class="menu_button" id="bb_mgr_import_wb" title="从世界书导入">
                    <i class="fa-solid fa-book-atlas"></i> 世界书
                </button>
                <button class="menu_button menu_button_danger" id="bb_mgr_clear" title="清空全部数据">
                    <i class="fa-solid fa-trash"></i> 清空
                </button>
            </div>
        </div>

        <!-- 存档标签页 -->
        <div class="bb-mgr-panel" data-panel="slots" style="display:none;">
            <div class="bb-slots-panel" id="bb_mgr_slots">
                <div class="bb-mem-empty"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>
            </div>
        </div>

        <!-- 时间线标签页 -->
        <div class="bb-mgr-panel" data-panel="threads" style="display:none;">
            <div id="bb_thread_panel_content">
                <div class="bb-mem-empty"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>
            </div>
        </div>

        <!-- 仪表盘标签页 -->
        <div class="bb-mgr-panel" data-panel="dashboard" style="display:none;">
            <div id="bb_dashboard_content">
                <div class="bb-mem-empty"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>
            </div>
        </div>
        <!-- v7.5.0 归档仓库标签页 -->
        <div class="bb-mgr-panel" data-panel="warehouse" style="display:none;">
            <div id="bb_warehouse_content">
                <div class="bb-mem-empty"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>
            </div>
        </div>
    </div>`;
}

// ═══ 条目渲染 ═══

// ═══ 批量编辑模式 ═══
let batchMode = false;

function buildEntryItemHTML(e) {
    const pillar = e._pillar;
    const pillarConfig = {
        npc:      { icon: 'fa-user',        label: 'NPC',   color: '#ba68c8' },
        item:     { icon: 'fa-box',          label: '物品',  color: '#4fc3f7' },
        timeline: { icon: 'fa-clock',        label: '时间线', color: '#ffb74d' },
        mem:      { icon: 'fa-brain',        label: '记忆',  color: '#81c784' },
    }[pillar] || { icon: 'fa-circle', label: pillar, color: '#888' };

    const title = e.title || e.name || (e.content || e.description || '').slice(0, 40) || '(无标题)';
    // 模糊记忆默认显示 summary，其他显示 content
    const isFuzzy = pillar === 'mem' && e.memoryTier === 'transient';
    const desc = isFuzzy
        ? (e.summary || (e.content || e.description || e.event || '').slice(0, 50)).trim()
        : (e.content || e.description || e.event || '').trim();

    // 状态标签
    let statusBadges = '';
    if (pillar === 'npc') {
        const tier = NPC_TIERS[e.npcTier];
        if (tier) statusBadges += `<span class="bb-item-badge" style="background:${pillarConfig.color}22;color:${pillarConfig.color};border:1px solid ${pillarConfig.color}44;">${tier.label}</span>`;
        if (e.role) statusBadges += `<span style="font-size:0.75em;opacity:0.5;">${escapeHtml(e.role)}</span>`;
    } else if (pillar === 'item') {
        const tier = ITEM_TIERS[e.itemTier];
        if (tier) statusBadges += `<span class="bb-item-badge" style="background:${pillarConfig.color}22;color:${pillarConfig.color};border:1px solid ${pillarConfig.color}44;">${tier.label}</span>`;
        if (e.status) statusBadges += `<span class="bb-item-badge" style="font-size:0.7em;">${escapeHtml(e.status)}</span>`;
        if (e.owner) statusBadges += `<span style="font-size:0.75em;opacity:0.5;">持有: ${escapeHtml(e.owner)}</span>`;
    } else if (pillar === 'timeline') {
        statusBadges += `<span class="bb-item-badge" style="background:${e.isActive ? '#4caf5022' : '#ff980022'};color:${e.isActive ? '#4caf50' : '#ff9800'};border:1px solid ${e.isActive ? '#4caf5044' : '#ff980044'};">${e.isActive ? '进行中' : '已结束'}</span>`;
        if (e.storyTime) statusBadges += `<span style="font-size:0.75em;opacity:0.5;">${escapeHtml(e.storyTime)}</span>`;
    } else if (pillar === 'mem') {
        const tierOrder = ['transient', 'stable', 'core', 'eternal'];
        const currentTierIdx = tierOrder.indexOf(e.memoryTier || 'transient');
        if (!e.memoryTier || e.memoryTier === 'transient') {
            statusBadges += '<span class="bb-mem-fuzzy-tag">模糊</span>';
            // 升格按钮（从模糊恢复到稳定）
            statusBadges += `<button class="bb-mem-tier-btn bb-mem-tier-up" data-id="${escapeHtml(e.id)}" title="升格为稳固" style="font-size:0.65em;padding:0 4px;line-height:1.4;cursor:pointer;opacity:0.5;"><i class="fa-solid fa-arrow-up"></i></button>`;
        } else {
            const tierColors = { stable: '#4caf50', core: '#ba68c8', eternal: '#ff9800', archived: '#888' };
            const tierLabels = { stable: '稳固', core: '核心', eternal: '永恒', archived: '归档' };
            const c = tierColors[e.memoryTier] || '#888';
            statusBadges += `<span class="bb-item-badge" style="background:${c}22;color:${c};border:1px solid ${c}44;">${tierLabels[e.memoryTier] || e.memoryTier}</span>`;
            // 非永恒可升格
            if (e.memoryTier !== 'eternal' && currentTierIdx < tierOrder.length - 1) {
                statusBadges += `<button class="bb-mem-tier-btn bb-mem-tier-up" data-id="${escapeHtml(e.id)}" title="升格" style="font-size:0.65em;padding:0 4px;line-height:1.4;cursor:pointer;opacity:0.5;"><i class="fa-solid fa-chevron-up"></i></button>`;
            }
            // 非transient可降格（stable/core/eternal 均可降）
            if (currentTierIdx > 0) {
                statusBadges += `<button class="bb-mem-tier-btn bb-mem-tier-down" data-id="${escapeHtml(e.id)}" title="降格" style="font-size:0.65em;padding:0 4px;line-height:1.4;cursor:pointer;opacity:0.5;"><i class="fa-solid fa-chevron-down"></i></button>`;
            }
        }
        const typeDef = MEMORY_TYPES[e.type];
        if (typeDef) statusBadges += `<span class="bb-item-badge" style="font-size:0.7em;">${typeDef.label}</span>`;
    }

    // 时间行
    const createdDate = e.createdAt ? new Date(e.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const updatedDate = (e.updatedAt && e.updatedAt !== e.createdAt) ? new Date(e.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

    // 来源楼层
    let sourceFloorHTML = '';
    if (typeof e.sourceFloor === 'number') {
        if (e.sourceFloor >= 0) sourceFloorHTML = `<span style="opacity:0.6;"><i class="fa-solid fa-layer-group"></i> 第 ${e.sourceFloor} 层</span>`;
        else sourceFloorHTML = `<span style="opacity:0.4;font-size:0.75em;"><i class="fa-solid fa-clock-rotate-left"></i> 旧聊天记忆</span>`;
    }

    // 故事时间行（使用故事内时间，非系统时间戳）
    let storyTimeHTML = '';
    if (e.storyTime) {
        if (pillar === 'mem') {
            storyTimeHTML = `<span><i class="fa-solid fa-clock"></i> ${escapeHtml(e.storyTime)}</span>`;
        } else if (pillar === 'npc') {
            storyTimeHTML = `<span><i class="fa-solid fa-handshake"></i> 初见: ${escapeHtml(e.storyTime)}</span>`;
        } else if (pillar === 'item') {
            storyTimeHTML = `<span><i class="fa-solid fa-gift"></i> 获得: ${escapeHtml(e.storyTime)}</span>`;
        }
    }

    // 标签（仅记忆条目）
    let tagRow = '';
    if (pillar === 'mem' && Array.isArray(e.tags) && e.tags.length) {
        tagRow = `<div style="margin-top:4px;display:flex;gap:3px;flex-wrap:wrap;">${e.tags.map(t => `<span class="bb-item-badge" style="font-size:0.7em;background:rgba(129,199,132,0.12);border:1px solid rgba(129,199,132,0.25);">${escapeHtml(typeof t === 'string' ? t : t.name || t)}</span>`).join('')}</div>`;
    }

    // 复选框（批量模式才显示）
    const cbStyle = batchMode ? '' : 'display:none;';
    const cbHTML = `<input type="checkbox" class="bb-mem-batch-cb" data-id="${escapeHtml(e.id)}" data-pillar="${pillar}" style="margin-right:8px;width:15px;height:15px;cursor:pointer;flex-shrink:0;${cbStyle}" />`;

    // 描述内容
    let descContent;
    if (pillar === 'npc') {
        descContent = (e.personality ? `性格: ${escapeHtml(e.personality).slice(0, 60)}<br>` : '') + (e.appearance ? `外貌: ${escapeHtml(e.appearance).slice(0, 60)}` : '') + (e.location ? `<br>位置: ${escapeHtml(e.location)}` : '');
    } else if (pillar === 'timeline') {
        descContent = (e.participants?.length ? `参与者: ${escapeHtml(e.participants.join(', '))}<br>` : '') + (e.location ? `地点: ${escapeHtml(e.location)}<br>` : '') + (e.impact ? `影响: ${escapeHtml(e.impact)}` : '');
    } else {
        descContent = escapeHtml(desc.slice(0, 200));
    }

    // 模糊记忆：有完整 content 时显示展开/收起按钮
    let fuzzyToggleHTML = '';
    if (isFuzzy && e.content && e.content.length > (e.summary || '').length) {
        fuzzyToggleHTML = `<button class="bb-mem-fuzzy-toggle" data-id="${escapeHtml(e.id)}" title="展开查看完整内容" style="font-size:0.7em;margin-left:4px;cursor:pointer;opacity:0.5;background:none;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:4px;color:inherit;padding:0 6px;"><i class="fa-solid fa-chevron-down"></i> 展开</button>`;
    }
    // 隐藏的完整内容（默认不显示）
    const fuzzyFullHTML = (isFuzzy && e.content) ? `<div class="bb-mem-fuzzy-full" data-id="${escapeHtml(e.id)}" style="display:none;margin-top:4px;padding:8px;background:rgba(255,152,0,0.06);border:1px dashed var(--SmartThemeBorderColor,#555);border-radius:6px;font-size:0.85em;line-height:1.5;color:var(--SmartThemeTextColor,#ddd);opacity:0.75;">${escapeHtml(e.content.slice(0, 500))}</div>` : '';

    // 命中次数
    const hitCountHTML = pillar === 'mem'
        ? `<span title="命中次数"><i class="fa-solid fa-bullseye"></i> ${e.hitCount || 0}</span>`
        : (e.hitCount ? `<span title="命中次数"><i class="fa-solid fa-bullseye"></i> ${e.hitCount}</span>` : '');

    return `
    <div class="bb-mem-item" data-id="${escapeHtml(e.id)}" data-pillar="${pillar}">
        <div style="display:flex;align-items:center;margin-bottom:6px;">
            ${cbHTML}
            <strong style="flex:1;font-size:0.95em;">${escapeHtml(title)}</strong>
            <span style="display:flex;align-items:center;gap:4px;flex-shrink:0;">${statusBadges}</span>
            <span class="bb-mem-item-type" style="color:${pillarConfig.color};margin-left:6px;font-size:0.75em;">
                <i class="fa-solid ${pillarConfig.icon}"></i> ${pillarConfig.label}
            </span>
        </div>
        ${descContent ? `
        <div style="margin:4px 0;padding:8px;background:var(--SmartThemeBlurTintColor, rgba(0,0,0,0.08));border:1px solid var(--SmartThemeBorderColor, #444);border-radius:6px;font-size:0.85em;line-height:1.5;">
            ${descContent}${fuzzyToggleHTML}
            ${fuzzyFullHTML}
            ${tagRow}
        </div>` : ''}
        <div style="display:flex;align-items:center;font-size:0.75em;opacity:0.5;gap:12px;">
            ${storyTimeHTML}
            ${sourceFloorHTML}
            ${hitCountHTML}
            ${createdDate ? `<span><i class="fa-regular fa-calendar-plus"></i> ${escapeHtml(createdDate)}</span>` : ''}
            ${updatedDate ? `<span><i class="fa-solid fa-pen"></i> ${escapeHtml(updatedDate)}</span>` : ''}
            <span style="flex:1;"></span>
            ${typeof e.sourceFloor === 'number' && e.sourceFloor >= 0 ? `
            <button class="menu_button bb-mem-btn-sm bb-mem-re-extract" data-floor="${e.sourceFloor}" title="重新提取该楼层记忆" style="font-size:0.75em;opacity:0.6;">
                <i class="fa-solid fa-rotate"></i>
            </button>` : ''}
            <button class="menu_button bb-mem-btn-sm bb-mem-edit" data-id="${escapeHtml(e.id)}" data-pillar="${pillar}" title="编辑" style="font-size:0.85em;">
                <i class="fa-solid fa-pen"></i>
            </button>
            <button class="menu_button bb-mem-btn-sm bb-mem-delete menu_button_danger" data-id="${escapeHtml(e.id)}" data-pillar="${pillar}" title="删除" style="font-size:0.85em;">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    </div>`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
}

// ═══ 事件绑定 ═══

function bindManagerEvents(overlay, chatId) {
    // 关闭
    overlay.querySelector('.bb-mem-close')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // 标签页切换
    overlay.querySelectorAll('.bb-mgr-tabs > .bb-mgr-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            const panelName = tab.dataset.tab;
            if (!panelName) return;
            overlay.querySelectorAll('.bb-mgr-tabs > .bb-mgr-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            overlay.querySelectorAll('.bb-mgr-panel').forEach(p => {
                p.style.display = p.dataset.panel === panelName ? 'flex' : 'none';
            });
            if (panelName === 'slots') {
                await renderSlotsPanel(overlay, chatId);
            } else if (panelName === 'dashboard') {
                await renderDashboardPanel(overlay, chatId);
            } else if (panelName === 'threads') {
                await renderThreadPanel(overlay, chatId);
            } else if (panelName === 'warehouse') {
                await renderArchiveWarehouse(overlay, chatId);
            }
        });
    });

    // 类型过滤
    overlay.querySelectorAll('.bb-mem-type-filter').forEach(btn => {
        btn.addEventListener('click', async () => {
            overlay.querySelectorAll('.bb-mem-type-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.dataset.type;
            await rerenderManagerList(overlay, chatId);
        });
    });

    // 搜索
    overlay.querySelector('#bb_mgr_search')?.addEventListener('input', async (e) => {
        const query = e.target.value.trim();
        if (!query) {
            activeFilter = overlay.querySelector('.bb-mem-type-filter.active')?.dataset?.type || 'all';
            await rerenderManagerList(overlay, chatId);
        } else {
            const results = simpleSearch(await getMemories(chatId), query, 100);
            const listEl = overlay.querySelector('#bb_mgr_list');
            if (listEl) {
                listEl.innerHTML = results.length
                    ? results.map(m => buildEntryItemHTML({ ...m, _pillar: 'mem' })).join('')
                    : '<div class="bb-mem-empty">未找到匹配的记忆</div>';
            }
        }
    });

    // 排序
    overlay.querySelector('#bb_mgr_sort')?.addEventListener('change', async () => {
        await rerenderManagerList(overlay, chatId);
    });

    // 添加
    overlay.querySelector('#bb_mgr_add')?.addEventListener('click', () => {
        showQuickAddForm(overlay, chatId);
    });

    // AI 提取
    overlay.querySelector('#bb_mgr_ai_extract')?.addEventListener('click', async () => {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const recent = chat.filter(m => m.mes?.trim()).slice(-12);
        if (!recent.length) { showToast('对话不足，无法提取'); return; }
        const contextText = recent.map(m => `${m.is_user ? '用户' : m.name || '角色'}: ${m.mes}`).join('\n');
        try {
            const results = await extractFromContext(chatId, contextText);
            showToast(`提取完成！NPC ${results.npc}/物品 ${results.items}/时间线 ${results.timeline}/记忆 ${results.memories}`, 'success');
            await rerenderManagerList(overlay, chatId);
        } catch (e) {
            showToast(`提取失败: ${e.message}`, 'error');
        }
    });

    // 导出
    overlay.querySelector('#bb_mgr_export')?.addEventListener('click', async () => {
        const json = await exportMemories(chatId);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `bb-memory-${chatId}-${Date.now()}.json`; a.click();
        URL.revokeObjectURL(url);
        showToast('已导出', 'success');
    });

    // 导入
    overlay.querySelector('#bb_mgr_import')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    const count = await importMemories(chatId, ev.target.result);
                    showToast(`成功导入 ${count} 条`, 'success');
                    await rerenderManagerList(overlay, chatId);
                } catch (err) { showToast(`导入失败: ${err.message}`, 'error'); }
            };
            reader.readAsText(file);
        });
        input.click();
    });

    // 世界书导入
    overlay.querySelector('#bb_mgr_import_wb')?.addEventListener('click', async () => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    const { importWorldBook } = await import('./world-book-importer.js');
                    const count = await importWorldBook(chatId, ev.target.result);
                    showToast(`世界书导入 ${count} 条`, 'success');
                    await rerenderManagerList(overlay, chatId);
                } catch (err) { showToast(`导入失败: ${err.message}`, 'error'); }
            };
            reader.readAsText(file);
        });
        input.click();
    });

    // 清空
    overlay.querySelector('#bb_mgr_clear')?.addEventListener('click', async () => {
        const ctx = SillyTavern.getContext();
        const ok = await ctx.Popup?.show?.confirm('确认清空', '确定要删除所有记忆数据吗？此操作不可撤销。');
        if (!ok) return;
        await clearAllData(chatId);
        showToast('所有记忆已清空', 'warning');
        await rerenderManagerList(overlay, chatId);
    });

    // 批量操作
    bindBatchEvents(overlay, chatId);

    // 条目操作
    rebindItemActions(overlay, chatId);
}

// ═══ 批量操作 ═══

function bindBatchEvents(overlay, chatId) {
    const updateUI = () => {
        const checked = overlay.querySelectorAll('.bb-mem-batch-cb:checked');
        const count = checked.length;
        const countEl = overlay.querySelector('#bb_batch_count');
        const labelEl = overlay.querySelector('#bb_batch_count_label');
        const menuEl = overlay.querySelector('#bb_batch_menu');
        const toggleBtn = overlay.querySelector('#bb_batch_toggle');
        if (countEl) countEl.textContent = String(count);
        if (labelEl) labelEl.style.display = batchMode && count > 0 ? '' : 'none';
        const hasSelection = count > 0;
        if (toggleBtn) {
            toggleBtn.disabled = false; // always enabled in batch mode
            toggleBtn.textContent = batchMode ? '退出批量编辑' : '批量编辑';
        }
        ['bb_batch_delete', 'bb_batch_archive', 'bb_batch_fuzzy'].forEach(id => {
            const btn = overlay.querySelector('#' + id);
            if (btn) btn.disabled = !hasSelection;
        });
    };

    // 批量编辑开关
    overlay.querySelector('#bb_batch_toggle')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        batchMode = !batchMode;
        // 退出时取消所有勾选
        if (!batchMode) {
            overlay.querySelectorAll('.bb-mem-batch-cb').forEach(cb => { cb.checked = false; });
        }
        await rerenderManagerList(overlay, chatId);
        updateUI();
    });

    overlay.addEventListener('change', (e) => {
        if (e.target.classList.contains('bb-mem-batch-cb')) updateUI();
    });

    overlay.querySelector('#bb_batch_select_all')?.addEventListener('click', (e) => {
        e.stopPropagation();
        overlay.querySelectorAll('.bb-mem-batch-cb').forEach(cb => { cb.checked = true; });
        updateUI();
    });

    overlay.querySelector('#bb_batch_deselect_all')?.addEventListener('click', (e) => {
        e.stopPropagation();
        overlay.querySelectorAll('.bb-mem-batch-cb').forEach(cb => { cb.checked = false; });
        updateUI();
    });

    overlay.querySelector('#bb_batch_delete')?.addEventListener('click', async () => {
        const checked = overlay.querySelectorAll('.bb-mem-batch-cb:checked');
        if (!checked.length) return;
        const ctx = SillyTavern.getContext();
        const ok = await ctx.Popup?.show?.confirm('批量删除', `确定删除选中的 ${checked.length} 条吗？`);
        if (!ok) return;
        for (const cb of checked) {
            const id = cb.dataset.id;
            const pillar = cb.dataset.pillar;
            if (pillar === 'npc') await removeNpcProfile(chatId, id);
            else if (pillar === 'item') await removeItem(chatId, id);
            else if (pillar === 'timeline') await removeTimelineEntry(chatId, id);
            else await removeMemory(chatId, id);
        }
        showToast(`已删除 ${checked.length} 条`, 'success');
        batchMode = false;
        await rerenderManagerList(overlay, chatId);
    });

    overlay.querySelector('#bb_batch_archive')?.addEventListener('click', async () => {
        const checked = overlay.querySelectorAll('.bb-mem-batch-cb:checked');
        if (!checked.length) return;
        for (const cb of checked) {
            if (cb.dataset.pillar === 'mem') {
                await archiveMemory(chatId, cb.dataset.id);
            }
        }
        showToast(`已归档 ${checked.length} 条`, 'success');
        batchMode = false;
        await rerenderManagerList(overlay, chatId);
    });

    overlay.querySelector('#bb_batch_fuzzy')?.addEventListener('click', async () => {
        const checked = overlay.querySelectorAll('.bb-mem-batch-cb:checked');
        if (!checked.length) return;
        for (const cb of checked) {
            if (cb.dataset.pillar === 'mem') {
                await fuzzyMemory(chatId, cb.dataset.id);
            }
        }
        showToast(`已模糊化 ${checked.length} 条`, 'success');
        batchMode = false;
        await rerenderManagerList(overlay, chatId);
    });
}

// ═══ 条目操作 ═══

function rebindItemActions(overlay, chatId) {
    // 删除
    overlay.querySelectorAll('.bb-mem-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const pillar = btn.dataset.pillar;
            const ok = confirm('确定删除这条记录吗？');
            if (!ok) return;
            if (pillar === 'npc') await removeNpcProfile(chatId, id);
            else if (pillar === 'item') await removeItem(chatId, id);
            else if (pillar === 'timeline') await removeTimelineEntry(chatId, id);
            else await removeMemory(chatId, id);
            showToast('已删除', 'info');
            await rerenderManagerList(overlay, chatId);
        });
    });

    // 编辑
    overlay.querySelectorAll('.bb-mem-re-extract').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const floor = parseInt(btn.dataset.floor, 10);
            if (isNaN(floor)) return;
            btn.disabled = true;
            const origHTML = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            try {
                const ctx2 = SillyTavern.getContext();
                const chat = ctx2.chat || [];
                if (floor < 0 || floor >= chat.length) throw new Error('楼层不存在');
                const aiMsg = chat[floor];
                if (!aiMsg || aiMsg.is_user) throw new Error('不是AI消息');
                let userMsg = '';
                for (let j = floor - 1; j >= 0; j--) {
                    if (chat[j].is_user && chat[j].mes) { userMsg = chat[j].mes; break; }
                }
                const { computeExchangeHash } = await import('./message-state.js');
                const exchangeHash = computeExchangeHash(userMsg, aiMsg.mes || '');
                await deleteByExchange(chatId, exchangeHash);
                await unmarkExchangeProcessed(chatId, exchangeHash); // v6.1.6
                aiMsg._bbmem_extracted = false;
                aiMsg._bbmem_pendingExtraction = true;
                try { ctx2.saveChatDebounced(); } catch {}
                showToast('已清理，将自动重新提取', 'success');
            } catch (err) {
                showToast('重提失败: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                btn.innerHTML = origHTML;
            }
        });
    });

    overlay.querySelectorAll('.bb-mem-edit').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const pillar = btn.dataset.pillar;
            showQuickEditForm(overlay, chatId, id, pillar);
        });
    });

    // 升降格按钮
    overlay.querySelectorAll('.bb-mem-tier-up').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const mems = await getMemories(chatId);
            const mem = mems.find(m => m.id === id);
            if (!mem) return;
            const tiers = ['transient', 'stable', 'core', 'eternal'];
            const idx = tiers.indexOf(mem.memoryTier || 'transient');
            const newTier = tiers[Math.min(idx + 1, 3)];
            await updateMemory(chatId, id, { memoryTier: newTier, updatedAt: Date.now() });
            showToast(`已升格为 ${newTier === 'transient' ? '模糊' : newTier}`, 'info');
            await rerenderManagerList(overlay, chatId);
        });
    });
    overlay.querySelectorAll('.bb-mem-tier-down').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const mems = await getMemories(chatId);
            const mem = mems.find(m => m.id === id);
            if (!mem) return;
            const tiers = ['transient', 'stable', 'core', 'eternal'];
            const idx = tiers.indexOf(mem.memoryTier || 'transient');
            const newTier = tiers[Math.max(idx - 1, 0)];
            await updateMemory(chatId, id, { memoryTier: newTier, updatedAt: Date.now() });
            showToast(`已降格为 ${newTier === 'transient' ? '模糊' : newTier}`, 'info');
            await rerenderManagerList(overlay, chatId);
        });
    });

    // 模糊记忆展开/收起
    overlay.querySelectorAll('.bb-mem-fuzzy-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const fullEl = overlay.querySelector(`.bb-mem-fuzzy-full[data-id="${id}"]`);
            if (fullEl) {
                const isVisible = fullEl.style.display !== 'none';
                fullEl.style.display = isVisible ? 'none' : 'block';
                btn.innerHTML = isVisible
                    ? '<i class="fa-solid fa-chevron-down"></i> 展开'
                    : '<i class="fa-solid fa-chevron-up"></i> 收起';
            }
        });
    });
}

// ═══ 详细添加表单 ═══

function showQuickAddForm(overlay, chatId) {
    const existing = document.querySelector('.bb-form-overlay');
    if (existing) existing.remove();

    let currentPillar = 'mem';
    const pillarOpts = { mem: '记忆条目', npc: 'NPC档案', item: '物品', timeline: '时间线事件' };

    const formOverlay = document.createElement('div');
    formOverlay.className = 'bb-form-overlay';
    formOverlay.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    document.body.appendChild(formOverlay);

    function buildFormHTML(pillar) {
        const p = pillar;
        return `
        <div class="bb-mem-form-popup" style="background:var(--SmartThemeChatTintColor,#1e1e2e);border:1px solid var(--SmartThemeBorderColor,#444);border-radius:12px;width:100%;max-width:600px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
            <div style="display:flex;align-items:center;padding:14px 18px;border-bottom:1px solid var(--SmartThemeBorderColor,#444);">
                <h3 style="margin:0;"><i class="fa-solid fa-plus"></i> 添加条目</h3>
                <span style="flex:1;"></span>
                <button class="bb-form-close" style="background:none;border:none;color:inherit;font-size:22px;cursor:pointer;opacity:0.6;">&times;</button>
            </div>
            <div style="display:flex;gap:4px;padding:8px 18px;border-bottom:1px solid var(--SmartThemeBorderColor,#444);">
                ${Object.entries(pillarOpts).map(([k,v]) =>
                    `<button class="menu_button bb-form-pillar-tab" data-pillar="${k}" style="${k === p ? 'background:#ba68c8;color:#fff;' : ''}font-size:0.85em;">${v}</button>`
                ).join('')}
            </div>
            <div style="flex:1;overflow-y:auto;padding:14px 18px;">
                ${buildPillarFormFields(p)}
            </div>
            <div style="display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--SmartThemeBorderColor,#444);">
                <button class="menu_button bb-form-cancel" style="flex:1;">取消</button>
                <button class="menu_button bb-form-save" style="flex:1;background:#4caf50;color:#fff;">保存</button>
            </div>
        </div>`;
    }

    function buildPillarFormFields(p) {
        switch (p) {
            case 'npc': return `
                <label style="font-size:0.85em;">姓名 <span style="color:#f44336;">*</span></label>
                <input class="text_pole bb-f-name" placeholder="角色姓名" style="width:100%;margin-bottom:8px;" />
                <div style="display:flex;gap:8px;">
                    <div style="flex:1;"><label style="font-size:0.85em;">身份</label><input class="text_pole bb-f-role" placeholder="如：王国骑士" style="width:100%;margin-bottom:8px;" /></div>
                    <div style="flex:1;"><label style="font-size:0.85em;">位置</label><input class="text_pole bb-f-location" placeholder="所在地点" style="width:100%;margin-bottom:8px;" /></div>
                </div>
                <label style="font-size:0.85em;">性格</label>
                <textarea class="text_pole bb-f-personality" placeholder="性格特点..." rows="2" style="width:100%;margin-bottom:8px;"></textarea>
                <label style="font-size:0.85em;">外貌</label>
                <textarea class="text_pole bb-f-appearance" placeholder="外貌描述..." rows="2" style="width:100%;margin-bottom:8px;"></textarea>
                <label style="font-size:0.85em;">关系</label>
                <input class="text_pole bb-f-relationships" placeholder="与其他人物的关系，逗号分隔" style="width:100%;margin-bottom:8px;" />
                <div style="display:flex;gap:8px;">
                    <div style="flex:1;"><label style="font-size:0.85em;">NPC等级</label><select class="text_pole bb-f-npcTier" style="width:100%;margin-bottom:8px;">${Object.values(NPC_TIERS).map(t => `<option value="${t.id}" ${t.id === 'minor' ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>
                    <div style="flex:1;"><label style="font-size:0.85em;">标签</label><input class="text_pole bb-f-tags" placeholder="逗号分隔" style="width:100%;margin-bottom:8px;" /></div>
                </div>`;
            case 'item': return `
                <label style="font-size:0.85em;">名称 <span style="color:#f44336;">*</span></label>
                <input class="text_pole bb-f-name" placeholder="物品名称" style="width:100%;margin-bottom:8px;" />
                <div style="display:flex;gap:8px;">
                    <div style="flex:1;"><label style="font-size:0.85em;">持有者</label><input class="text_pole bb-f-owner" placeholder="当前持有者" style="width:100%;margin-bottom:8px;" /></div>
                    <div style="flex:1;"><label style="font-size:0.85em;">状态</label><select class="text_pole bb-f-status" style="width:100%;margin-bottom:8px;"><option value="held">持有中</option><option value="used">已使用</option><option value="lost">已丢失</option><option value="destroyed">已销毁</option></select></div>
                </div>
                <label style="font-size:0.85em;">重要性</label>
                <input class="text_pole bb-f-significance" placeholder="对剧情的重要性" style="width:100%;margin-bottom:8px;" />
                <div style="display:flex;gap:8px;">
                    <div style="flex:1;"><label style="font-size:0.85em;">物品等级</label><select class="text_pole bb-f-itemTier" style="width:100%;margin-bottom:8px;">${Object.values(ITEM_TIERS).map(t => `<option value="${t.id}" ${t.id === 'consumable' ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>
                    <div style="flex:1;display:flex;align-items:flex-end;padding-bottom:8px;"><label style="font-size:0.85em;display:flex;align-items:center;gap:4px;"><input type="checkbox" class="bb-f-keepPermanent" /> 永久保留</label></div>
                </div>
                <label style="font-size:0.85em;">标签</label>
                <input class="text_pole bb-f-tags" placeholder="逗号分隔" style="width:100%;margin-bottom:8px;" />`;
            case 'timeline': return `
                <label style="font-size:0.85em;">标题 <span style="color:#f44336;">*</span></label>
                <input class="text_pole bb-f-title" placeholder="事件标题" style="width:100%;margin-bottom:8px;" />
                <div style="display:flex;gap:8px;">
                    <div style="flex:1;"><label style="font-size:0.85em;">故事时间</label><input class="text_pole bb-f-storyTime" placeholder="如：第三天清晨" style="width:100%;margin-bottom:8px;" /></div>
                    <div style="flex:1;"><label style="font-size:0.85em;">状态</label><select class="text_pole bb-f-status" style="width:100%;margin-bottom:8px;"><option value="ongoing" selected>进行中</option><option value="ended">已结束</option><option value="foreshadow">伏笔</option></select></div>
                </div>
                <label style="font-size:0.85em;">事件描述</label>
                <textarea class="text_pole bb-f-event" placeholder="事件内容..." rows="3" style="width:100%;margin-bottom:8px;"></textarea>
                <div style="display:flex;gap:8px;">
                    <div style="flex:1;"><label style="font-size:0.85em;">参与者</label><input class="text_pole bb-f-participants" placeholder="逗号分隔" style="width:100%;margin-bottom:8px;" /></div>
                    <div style="flex:1;"><label style="font-size:0.85em;">地点</label><input class="text_pole bb-f-location" placeholder="事件地点" style="width:100%;margin-bottom:8px;" /></div>
                </div>
                <label style="font-size:0.85em;">影响</label>
                <input class="text_pole bb-f-impact" placeholder="对剧情的影响" style="width:100%;margin-bottom:8px;" />
                <label style="font-size:0.85em;">标签</label>
                <input class="text_pole bb-f-tags" placeholder="逗号分隔" style="width:100%;margin-bottom:8px;" />`;
            case 'mem': default: return `
                <label style="font-size:0.85em;">标题 <span style="color:#f44336;">*</span></label>
                <input class="text_pole bb-f-title" placeholder="记忆标题（3-8字）" style="width:100%;margin-bottom:8px;" />
                <div style="display:flex;gap:8px;">
                    <div style="flex:1;"><label style="font-size:0.85em;">类型</label><select class="text_pole bb-f-type" style="width:100%;margin-bottom:8px;">${Object.values(MEMORY_TYPES).map(t => `<option value="${t.id}" ${t.id === 'event' ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>
                    <div style="flex:1;"><label style="font-size:0.85em;">等级</label><select class="text_pole bb-f-memoryTier" style="width:100%;margin-bottom:8px;"><option value="transient">模糊</option><option value="stable" selected>稳固</option><option value="core">核心</option><option value="eternal">永恒</option><option value="archived">归档</option></select></div>
                </div>
                <div style="display:flex;gap:8px;">
                    <div style="flex:1;"><label style="font-size:0.85em;">真值状态</label><select class="text_pole bb-f-truthStatus" style="width:100%;margin-bottom:8px;">${Object.entries(TRUTH_STATUS).map(([k,v]) => `<option value="${k}" ${k === 'true' ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
                    <div style="flex:1;"></div>
                </div>
                <label style="font-size:0.85em;">内容</label>
                <textarea class="text_pole bb-f-content" placeholder="记忆内容..." rows="3" style="width:100%;margin-bottom:8px;"></textarea>
                <div style="display:flex;gap:8px;">
                    <div style="flex:1;"><label style="font-size:0.85em;">主体</label><input class="text_pole bb-f-subject" placeholder="记忆主体" style="width:100%;margin-bottom:8px;" /></div>
                    <div style="flex:1;"><label style="font-size:0.85em;">对象</label><input class="text_pole bb-f-target" placeholder="记忆对象" style="width:100%;margin-bottom:8px;" /></div>
                </div>
                <label style="font-size:0.85em;">摘要</label>
                <textarea class="text_pole bb-f-summary" placeholder="一句话摘要" rows="1" style="width:100%;margin-bottom:8px;"></textarea>
                <label style="font-size:0.85em;">原话</label>
                <textarea class="text_pole bb-f-verbatim" placeholder="角色原话（可选）" rows="1" style="width:100%;margin-bottom:8px;"></textarea>
                <div style="display:flex;gap:8px;">
                    <div style="flex:1;"><label style="font-size:0.85em;">重要性: <span class="bb-f-importance-val">50</span>%</label><input type="range" class="bb-f-importance" min="0" max="100" value="50" style="width:100%;" /></div>
                    <div style="flex:1;"><label style="font-size:0.85em;">情感权重: <span class="bb-f-emotional-val">0</span>%</label><input type="range" class="bb-f-emotional" min="0" max="100" value="0" style="width:100%;" /></div>
                </div>
                <label style="font-size:0.85em;">标签</label>
                <input class="text_pole bb-f-tags" placeholder="逗号分隔" style="width:100%;margin-bottom:8px;" />`;
        }
    }

    const render = (pillar) => {
        formOverlay.innerHTML = buildFormHTML(pillar);
        bindFormEvents(formOverlay, chatId, pillar);
    };

    render(currentPillar);
    formOverlay.addEventListener('click', (e) => { if (e.target === formOverlay) formOverlay.remove(); });
}

function bindFormEvents(formOverlay, chatId, initialPillar) {
    let currentPillar = initialPillar;

    formOverlay.querySelector('.bb-form-close')?.addEventListener('click', () => formOverlay.remove());
    formOverlay.querySelector('.bb-form-cancel')?.addEventListener('click', () => formOverlay.remove());

    formOverlay.querySelectorAll('.bb-form-pillar-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            currentPillar = tab.dataset.pillar;
            formOverlay.innerHTML = buildFormHTML_inner(currentPillar);
            bindFormEvents(formOverlay, chatId, currentPillar);
        });
    });

    // Slider sync
    formOverlay.querySelector('.bb-f-importance')?.addEventListener('input', function() {
        const val = formOverlay.querySelector('.bb-f-importance-val');
        if (val) val.textContent = this.value;
    });
    formOverlay.querySelector('.bb-f-emotional')?.addEventListener('input', function() {
        const val = formOverlay.querySelector('.bb-f-emotional-val');
        if (val) val.textContent = this.value;
    });

    formOverlay.querySelector('.bb-form-save')?.addEventListener('click', async () => {
        const btn = formOverlay.querySelector('.bb-form-save');
        const origHTML = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 保存中...';
        try {
            const data = collectFormData(formOverlay, currentPillar);
            if (!data.name && !data.title) { showToast('请至少填写标题/名称', 'warning'); btn.disabled = false; btn.innerHTML = origHTML; return; }
            switch (currentPillar) {
                case 'npc': await addNpcProfile(chatId, data); break;
                case 'item': await addItem(chatId, data); break;
                case 'timeline': await addTimelineEntry(chatId, data); break;
                default: await addMemory(chatId, data); break;
            }
            showToast('已添加', 'success');
            formOverlay.remove();
            const managerOverlay = document.querySelector('.bb-mem-overlay');
            if (managerOverlay) { await rerenderManagerList(managerOverlay, chatId); updateCurrentSlotBar(managerOverlay, chatId); }
        } catch (e) { showToast(`保存失败: ${e.message}`, 'error'); btn.disabled = false; btn.innerHTML = origHTML; }
    });
}

function buildFormHTML_inner(pillar) {
    const pillarOpts = { mem: '记忆条目', npc: 'NPC档案', item: '物品', timeline: '时间线事件' };
    return `
    <div class="bb-mem-form-popup" style="background:var(--SmartThemeChatTintColor,#1e1e2e);border:1px solid var(--SmartThemeBorderColor,#444);border-radius:12px;width:100%;max-width:600px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
        <div style="display:flex;align-items:center;padding:14px 18px;border-bottom:1px solid var(--SmartThemeBorderColor,#444);">
            <h3 style="margin:0;"><i class="fa-solid fa-plus"></i> 添加条目</h3>
            <span style="flex:1;"></span>
            <button class="bb-form-close" style="background:none;border:none;color:inherit;font-size:22px;cursor:pointer;opacity:0.6;">&times;</button>
        </div>
        <div style="display:flex;gap:4px;padding:8px 18px;border-bottom:1px solid var(--SmartThemeBorderColor,#444);">
            ${Object.entries(pillarOpts).map(([k,v]) =>
                `<button class="menu_button bb-form-pillar-tab" data-pillar="${k}" style="${k === pillar ? 'background:#ba68c8;color:#fff;' : ''}font-size:0.85em;">${v}</button>`
            ).join('')}
        </div>
        <div style="flex:1;overflow-y:auto;padding:14px 18px;">
            ${buildPillarFormFields_inner(pillar)}
        </div>
        <div style="display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--SmartThemeBorderColor,#444);">
            <button class="menu_button bb-form-cancel" style="flex:1;">取消</button>
            <button class="menu_button bb-form-save" style="flex:1;background:#4caf50;color:#fff;">保存</button>
        </div>
    </div>`;
}

function buildPillarFormFields_inner(p) {
    switch (p) {
        case 'npc': return `
            <label style="font-size:0.85em;">姓名 <span style="color:#f44336;">*</span></label><input class="text_pole bb-f-name" placeholder="角色姓名" style="width:100%;margin-bottom:8px;" />
            <div style="display:flex;gap:8px;"><div style="flex:1;"><label style="font-size:0.85em;">身份</label><input class="text_pole bb-f-role" placeholder="如：王国骑士" style="width:100%;margin-bottom:8px;" /></div><div style="flex:1;"><label style="font-size:0.85em;">位置</label><input class="text_pole bb-f-location" placeholder="所在地点" style="width:100%;margin-bottom:8px;" /></div></div>
            <label style="font-size:0.85em;">性格</label><textarea class="text_pole bb-f-personality" placeholder="性格特点..." rows="2" style="width:100%;margin-bottom:8px;"></textarea>
            <label style="font-size:0.85em;">外貌</label><textarea class="text_pole bb-f-appearance" placeholder="外貌描述..." rows="2" style="width:100%;margin-bottom:8px;"></textarea>
            <label style="font-size:0.85em;">关系</label><input class="text_pole bb-f-relationships" placeholder="逗号分隔" style="width:100%;margin-bottom:8px;" />
            <div style="display:flex;gap:8px;"><div style="flex:1;"><label style="font-size:0.85em;">NPC等级</label><select class="text_pole bb-f-npcTier" style="width:100%;margin-bottom:8px;">${Object.values(NPC_TIERS).map(t => `<option value="${t.id}" ${t.id === 'minor' ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div><div style="flex:1;"><label style="font-size:0.85em;">标签</label><input class="text_pole bb-f-tags" placeholder="逗号分隔" style="width:100%;margin-bottom:8px;" /></div></div>`;
        case 'item': return `
            <label style="font-size:0.85em;">名称 <span style="color:#f44336;">*</span></label><input class="text_pole bb-f-name" placeholder="物品名称" style="width:100%;margin-bottom:8px;" />
            <div style="display:flex;gap:8px;"><div style="flex:1;"><label style="font-size:0.85em;">持有者</label><input class="text_pole bb-f-owner" placeholder="当前持有者" style="width:100%;margin-bottom:8px;" /></div><div style="flex:1;"><label style="font-size:0.85em;">状态</label><select class="text_pole bb-f-status" style="width:100%;margin-bottom:8px;"><option value="held">持有中</option><option value="used">已使用</option><option value="lost">已丢失</option><option value="destroyed">已销毁</option></select></div></div>
            <label style="font-size:0.85em;">重要性</label><input class="text_pole bb-f-significance" placeholder="对剧情的重要性" style="width:100%;margin-bottom:8px;" />
            <div style="display:flex;gap:8px;"><div style="flex:1;"><label style="font-size:0.85em;">物品等级</label><select class="text_pole bb-f-itemTier" style="width:100%;margin-bottom:8px;">${Object.values(ITEM_TIERS).map(t => `<option value="${t.id}" ${t.id === 'consumable' ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div><div style="flex:1;display:flex;align-items:flex-end;padding-bottom:8px;"><label style="font-size:0.85em;display:flex;align-items:center;gap:4px;"><input type="checkbox" class="bb-f-keepPermanent" /> 永久保留</label></div></div>
            <label style="font-size:0.85em;">标签</label><input class="text_pole bb-f-tags" placeholder="逗号分隔" style="width:100%;margin-bottom:8px;" />`;
        case 'timeline': return `
            <label style="font-size:0.85em;">标题 <span style="color:#f44336;">*</span></label><input class="text_pole bb-f-title" placeholder="事件标题" style="width:100%;margin-bottom:8px;" />
            <div style="display:flex;gap:8px;"><div style="flex:1;"><label style="font-size:0.85em;">故事时间</label><input class="text_pole bb-f-storyTime" placeholder="如：第三天清晨" style="width:100%;margin-bottom:8px;" /></div><div style="flex:1;"><label style="font-size:0.85em;">状态</label><select class="text_pole bb-f-status" style="width:100%;margin-bottom:8px;"><option value="ongoing" selected>进行中</option><option value="ended">已结束</option><option value="foreshadow">伏笔</option></select></div></div>
            <label style="font-size:0.85em;">事件描述</label><textarea class="text_pole bb-f-event" placeholder="事件内容..." rows="3" style="width:100%;margin-bottom:8px;"></textarea>
            <div style="display:flex;gap:8px;"><div style="flex:1;"><label style="font-size:0.85em;">参与者</label><input class="text_pole bb-f-participants" placeholder="逗号分隔" style="width:100%;margin-bottom:8px;" /></div><div style="flex:1;"><label style="font-size:0.85em;">地点</label><input class="text_pole bb-f-location" placeholder="事件地点" style="width:100%;margin-bottom:8px;" /></div></div>
            <label style="font-size:0.85em;">影响</label><input class="text_pole bb-f-impact" placeholder="对剧情的影响" style="width:100%;margin-bottom:8px;" />
            <label style="font-size:0.85em;">标签</label><input class="text_pole bb-f-tags" placeholder="逗号分隔" style="width:100%;margin-bottom:8px;" />`;
        case 'mem': default: return `
            <label style="font-size:0.85em;">标题 <span style="color:#f44336;">*</span></label><input class="text_pole bb-f-title" placeholder="记忆标题（3-8字）" style="width:100%;margin-bottom:8px;" />
            <div style="display:flex;gap:8px;"><div style="flex:1;"><label style="font-size:0.85em;">类型</label><select class="text_pole bb-f-type" style="width:100%;margin-bottom:8px;">${Object.values(MEMORY_TYPES).map(t => `<option value="${t.id}" ${t.id === 'event' ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div><div style="flex:1;"><label style="font-size:0.85em;">真值状态</label><select class="text_pole bb-f-truthStatus" style="width:100%;margin-bottom:8px;">${Object.entries(TRUTH_STATUS).map(([k,v]) => `<option value="${k}" ${k === 'true' ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div></div>
            <label style="font-size:0.85em;">内容</label><textarea class="text_pole bb-f-content" placeholder="记忆内容..." rows="3" style="width:100%;margin-bottom:8px;"></textarea>
            <div style="display:flex;gap:8px;"><div style="flex:1;"><label style="font-size:0.85em;">主体</label><input class="text_pole bb-f-subject" placeholder="记忆主体" style="width:100%;margin-bottom:8px;" /></div><div style="flex:1;"><label style="font-size:0.85em;">对象</label><input class="text_pole bb-f-target" placeholder="记忆对象" style="width:100%;margin-bottom:8px;" /></div></div>
            <label style="font-size:0.85em;">摘要</label><textarea class="text_pole bb-f-summary" placeholder="一句话摘要" rows="1" style="width:100%;margin-bottom:8px;"></textarea>
            <label style="font-size:0.85em;">原话</label><textarea class="text_pole bb-f-verbatim" placeholder="角色原话（可选）" rows="1" style="width:100%;margin-bottom:8px;"></textarea>
            <div style="display:flex;gap:8px;"><div style="flex:1;"><label style="font-size:0.85em;">重要性: <span class="bb-f-importance-val">50</span>%</label><input type="range" class="bb-f-importance" min="0" max="100" value="50" style="width:100%;" /></div><div style="flex:1;"><label style="font-size:0.85em;">情感权重: <span class="bb-f-emotional-val">0</span>%</label><input type="range" class="bb-f-emotional" min="0" max="100" value="0" style="width:100%;" /></div></div>
            <label style="font-size:0.85em;">标签</label><input class="text_pole bb-f-tags" placeholder="逗号分隔" style="width:100%;margin-bottom:8px;" />`;
    }
}

function collectFormData(formEl, pillar) {
    const g = (cls) => formEl.querySelector('.' + cls)?.value?.trim() || '';
    const tagsStr = g('bb-f-tags');
    const tags = tagsStr ? tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean) : [];
    switch (pillar) {
        case 'npc': return {
            name: g('bb-f-name'), role: g('bb-f-role'), personality: g('bb-f-personality'),
            appearance: g('bb-f-appearance'), location: g('bb-f-location'),
            relationships: g('bb-f-relationships').split(/[,，]/).map(s => s.trim()).filter(Boolean),
            npcTier: formEl.querySelector('.bb-f-npcTier')?.value || 'minor', tags, source: 'manual',
        };
        case 'item': return {
            name: g('bb-f-name'), owner: g('bb-f-owner'),
            status: formEl.querySelector('.bb-f-status')?.value || 'held',
            significance: g('bb-f-significance'),
            itemTier: formEl.querySelector('.bb-f-itemTier')?.value || 'consumable',
            keepPermanent: formEl.querySelector('.bb-f-keepPermanent')?.checked || false,
            tags, source: 'manual',
        };
        case 'timeline': return {
            title: g('bb-f-title'), storyTime: g('bb-f-storyTime'),
            status: formEl.querySelector('.bb-f-status')?.value || 'ongoing',
            event: g('bb-f-event'), content: g('bb-f-event'),
            participants: g('bb-f-participants').split(/[,，]/).map(s => s.trim()).filter(Boolean),
            location: g('bb-f-location'), impact: g('bb-f-impact'),
            isActive: (formEl.querySelector('.bb-f-status')?.value || 'ongoing') === 'ongoing',
            tags, source: 'manual',
        };
        case 'mem': default: return {
            title: g('bb-f-title'), type: formEl.querySelector('.bb-f-type')?.value || 'event',
            content: g('bb-f-content'), summary: g('bb-f-summary'), verbatim: g('bb-f-verbatim'),
            subject: g('bb-f-subject'), target: g('bb-f-target'),
            memoryTier: formEl.querySelector('.bb-f-memoryTier')?.value || 'stable',
            truthStatus: formEl.querySelector('.bb-f-truthStatus')?.value || 'true',
            importance: parseInt(formEl.querySelector('.bb-f-importance')?.value || '50', 10) / 100,
            emotionalWeight: parseInt(formEl.querySelector('.bb-f-emotional')?.value || '0', 10) / 100,
            tags, source: 'manual',
        };
    }
}

// ═══ 快速编辑 ═══

async function showQuickEditForm(overlay, chatId, id, pillar) {
    // 加载已有数据
    let entry;
    const lists = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);
    if (pillar === 'npc') entry = lists[0].find(e => e.id === id);
    else if (pillar === 'item') entry = lists[1].find(e => e.id === id);
    else if (pillar === 'timeline') entry = lists[2].find(e => e.id === id);
    else entry = lists[3].find(e => e.id === id);

    if (!entry) { showToast('未找到该条目', 'error'); return; }

    // 复用添加表单的弹出层，预填数据
    _showQuickFormPopup(overlay, chatId, { mode: 'edit', id, pillar, prefill: entry });
}

// ═══ 通用弹出表单（添加/编辑共用） ═══

function _showQuickFormPopup(managerOverlay, chatId, { mode, id, pillar, prefill }) {
    const existing = document.querySelector('.bb-form-overlay');
    if (existing) existing.remove();

    const isEdit = mode === 'edit';
    const titleText = isEdit ? '编辑条目' : '添加条目';
    const titleIcon = isEdit ? 'fa-pen-to-square' : 'fa-plus';

    const formOverlay = document.createElement('div');
    formOverlay.className = 'bb-form-overlay';
    formOverlay.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    document.body.appendChild(formOverlay);

    const render = () => {
        formOverlay.innerHTML = `
        <div class="bb-mem-form-popup" style="background:var(--SmartThemeChatTintColor,#1e1e2e);border:1px solid var(--SmartThemeBorderColor,#444);border-radius:12px;width:100%;max-width:600px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
            <div style="display:flex;align-items:center;padding:14px 18px;border-bottom:1px solid var(--SmartThemeBorderColor,#444);">
                <h3 style="margin:0;"><i class="fa-solid ${titleIcon}"></i> ${titleText}</h3>
                <span style="flex:1;"></span>
                ${!isEdit ? '' : `<span style="font-size:0.8em;opacity:0.5;margin-right:8px;">${escapeHtml(pillar)}</span>`}
                <button class="bb-form-close" style="background:none;border:none;color:inherit;font-size:22px;cursor:pointer;opacity:0.6;">&times;</button>
            </div>
            <div style="flex:1;overflow-y:auto;padding:14px 18px;">
                ${buildPillarFormFields_inner(pillar)}
            </div>
            <div style="display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--SmartThemeBorderColor,#444);">
                <button class="menu_button bb-form-cancel" style="flex:1;">取消</button>
                <button class="menu_button bb-form-save" style="flex:1;background:#4caf50;color:#fff;">${isEdit ? '更新' : '保存'}</button>
            </div>
        </div>`;

        // 预填数据
        if (prefill) {
            const setVal = (cls, val) => { const el = formOverlay.querySelector('.' + cls); if (el) el.value = val || ''; };
            const setCheck = (cls, val) => { const el = formOverlay.querySelector('.' + cls); if (el) el.checked = !!val; };
            const tagsStr = Array.isArray(prefill.tags)
                ? prefill.tags.map(t => typeof t === 'string' ? t : t.name || t).filter(Boolean).join(', ')
                : '';

            switch (pillar) {
                case 'npc':
                    setVal('bb-f-name', prefill.name);
                    setVal('bb-f-role', prefill.role);
                    setVal('bb-f-personality', prefill.personality);
                    setVal('bb-f-appearance', prefill.appearance);
                    setVal('bb-f-location', prefill.location);
                    setVal('bb-f-relationships', Array.isArray(prefill.relationships) ? prefill.relationships.map(r => typeof r === 'string' ? r : r.name || '').filter(Boolean).join(', ') : '');
                    if (prefill.npcTier) { const el = formOverlay.querySelector('.bb-f-npcTier'); if (el) el.value = prefill.npcTier; }
                    setVal('bb-f-tags', tagsStr);
                    break;
                case 'item':
                    setVal('bb-f-name', prefill.name);
                    setVal('bb-f-owner', prefill.owner);
                    if (prefill.status) { const el = formOverlay.querySelector('.bb-f-status'); if (el) el.value = prefill.status; }
                    setVal('bb-f-significance', prefill.significance);
                    if (prefill.itemTier) { const el = formOverlay.querySelector('.bb-f-itemTier'); if (el) el.value = prefill.itemTier; }
                    setCheck('bb-f-keepPermanent', prefill.keepPermanent);
                    setVal('bb-f-tags', tagsStr);
                    break;
                case 'timeline':
                    setVal('bb-f-title', prefill.title || prefill.event);
                    setVal('bb-f-storyTime', prefill.storyTime);
                    if (prefill.status) { const el = formOverlay.querySelector('.bb-f-status'); if (el) el.value = prefill.status; }
                    else if (prefill.isActive) { const el = formOverlay.querySelector('.bb-f-status'); if (el) el.value = 'ongoing'; }
                    setVal('bb-f-event', prefill.event || prefill.summary || '');
                    setVal('bb-f-participants', Array.isArray(prefill.participants) ? prefill.participants.join(', ') : '');
                    setVal('bb-f-location', prefill.location);
                    setVal('bb-f-impact', prefill.impact);
                    setVal('bb-f-tags', tagsStr);
                    break;
                case 'mem':
                    setVal('bb-f-title', prefill.title);
                    if (prefill.type) { const el = formOverlay.querySelector('.bb-f-type'); if (el) el.value = prefill.type; }
                    if (prefill.memoryTier) { const el = formOverlay.querySelector('.bb-f-memoryTier'); if (el) el.value = prefill.memoryTier; }
                    if (prefill.truthStatus) { const el = formOverlay.querySelector('.bb-f-truthStatus'); if (el) el.value = prefill.truthStatus; }
                    setVal('bb-f-content', prefill.content);
                    setVal('bb-f-subject', prefill.subject);
                    setVal('bb-f-target', prefill.target);
                    setVal('bb-f-summary', prefill.summary);
                    setVal('bb-f-verbatim', prefill.verbatim);
                    { const el = formOverlay.querySelector('.bb-f-importance'); if (el) { el.value = Math.round((prefill.importance || 0.5) * 100); el.dispatchEvent(new Event('input')); } }
                    { const el = formOverlay.querySelector('.bb-f-emotional'); if (el) { el.value = Math.round((prefill.emotionalWeight || 0) * 100); el.dispatchEvent(new Event('input')); } }
                    setVal('bb-f-tags', tagsStr);
                    break;
            }
        }

        bindFormEvents_inner(formOverlay, chatId, pillar, isEdit ? { id } : null);
    };

    render();

    const close = () => { document.removeEventListener('keydown', onEsc); formOverlay.remove(); };
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc);
    formOverlay.addEventListener('click', (e) => { if (e.target === formOverlay) close(); });
}

// ═══ 编辑模式事件绑定 ═══

function bindFormEvents_inner(formOverlay, chatId, pillar, editInfo) {
    const isEdit = !!editInfo;

    formOverlay.querySelector('.bb-form-close')?.addEventListener('click', () => formOverlay.remove());
    formOverlay.querySelector('.bb-form-cancel')?.addEventListener('click', () => formOverlay.remove());

    // Slider sync
    formOverlay.querySelector('.bb-f-importance')?.addEventListener('input', function () {
        const val = formOverlay.querySelector('.bb-f-importance-val');
        if (val) val.textContent = this.value;
    });
    formOverlay.querySelector('.bb-f-emotional')?.addEventListener('input', function () {
        const val = formOverlay.querySelector('.bb-f-emotional-val');
        if (val) val.textContent = this.value;
    });

    formOverlay.querySelector('.bb-form-save')?.addEventListener('click', async () => {
        const btn = formOverlay.querySelector('.bb-form-save');
        const origHTML = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 保存中...';
        try {
            const data = collectFormData(formOverlay, pillar);
            if (!data.name && !data.title) { showToast('请至少填写标题/名称', 'warning'); btn.disabled = false; btn.innerHTML = origHTML; return; }

            if (isEdit) {
                // 更新时间线的 isActive 字段
                if (pillar === 'timeline') {
                    data.isActive = data.status === 'ongoing';
                }
                switch (pillar) {
                    case 'npc': await updateNpcProfile(chatId, editInfo.id, data); break;
                    case 'item': await updateItem(chatId, editInfo.id, data); break;
                    case 'timeline': await updateTimelineEntry(chatId, editInfo.id, data); break;
                    default: await updateMemory(chatId, editInfo.id, data); break;
                }
            } else {
                switch (pillar) {
                    case 'npc': await addNpcProfile(chatId, data); break;
                    case 'item': await addItem(chatId, data); break;
                    case 'timeline': await addTimelineEntry(chatId, data); break;
                    default: await addMemory(chatId, data); break;
                }
            }

            showToast(isEdit ? '已更新' : '已添加', 'success');
            formOverlay.remove();
            const managerOverlay = document.querySelector('.bb-mem-overlay');
            if (managerOverlay) { await rerenderManagerList(managerOverlay, chatId); updateCurrentSlotBar(managerOverlay, chatId); }
        } catch (e) { showToast(`保存失败: ${e.message}`, 'error'); btn.disabled = false; btn.innerHTML = origHTML; }
    });
}

// ═══ 存档标签页 ═══

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
        const [npc, items, timeline, memories] = await Promise.all([
            getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
        ]);
        const totalCount = npc.length + items.length + timeline.length + memories.length;

        // Sort slots
        const sortMode = slotsEl.dataset.slotSort || 'name_asc';
        slots.sort((a, b) => {
            switch (sortMode) {
                case 'name_asc': return a.name.localeCompare(b.name);
                case 'name_desc': return b.name.localeCompare(a.name);
                case 'count_desc': return (b.count || 0) - (a.count || 0);
                case 'count_asc': return (a.count || 0) - (b.count || 0);
                case 'created_desc': return (b.createdAt || 0) - (a.createdAt || 0);
                case 'created_asc': return (a.createdAt || 0) - (b.createdAt || 0);
                case 'updated_desc': return (b.updatedAt || 0) - (a.updatedAt || 0);
                case 'updated_asc': return (a.updatedAt || 0) - (b.updatedAt || 0);
                default: return 0;
            }
        });
        // 当前使用的槽置顶
        const settings = getSettings();
        const currentSlot = settings.currentSlotName || 'default';
        const currentIdx = slots.findIndex(s => s.name === currentSlot);
        if (currentIdx > 0) {
            const [current] = slots.splice(currentIdx, 1);
            slots.unshift(current);
        }

        slotsEl.innerHTML = `
            <div class="bb-slots-info">
                <i class="fa-solid fa-circle-info"></i>
                当前聊天 <strong>${totalCount}</strong> 条数据 · 角色ID: ${escapeHtml(charId)}
            </div>

            <div class="bb-slots-create" style="margin-bottom:10px;">
                <input type="text" class="text_pole" id="bb_slot_new_name" placeholder="新存档名称（如：if线A、主线）" />
                <button class="menu_button" id="bb_slot_create_btn">
                    <i class="fa-solid fa-plus"></i> 新建存档
                </button>
            </div>

            <div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;">
                <span style="font-size:0.8em;opacity:0.6;">排序:</span>
                <select id="bb_slot_sort" class="text_pole" style="font-size:0.8em;width:auto;">
                    <option value="name_asc" ${sortMode === 'name_asc' ? 'selected' : ''}>名称 A-Z</option>
                    <option value="name_desc" ${sortMode === 'name_desc' ? 'selected' : ''}>名称 Z-A</option>
                    <option value="count_desc" ${sortMode === 'count_desc' ? 'selected' : ''}>条数 ↓</option>
                    <option value="count_asc" ${sortMode === 'count_asc' ? 'selected' : ''}>条数 ↑</option>
                    <option value="created_desc" ${sortMode === 'created_desc' ? 'selected' : ''}>创建时间 ↓</option>
                    <option value="created_asc" ${sortMode === 'created_asc' ? 'selected' : ''}>创建时间 ↑</option>
                    <option value="updated_desc" ${sortMode === 'updated_desc' ? 'selected' : ''}>更新时间 ↓</option>
                    <option value="updated_asc" ${sortMode === 'updated_asc' ? 'selected' : ''}>更新时间 ↑</option>
                </select>
            </div>

            <div class="bb-slots-list">
                ${slots.map(s => `
                    <div class="bb-slot-item">
                        <div class="bb-slot-info">
                            <span class="bb-slot-name">
                                <i class="fa-solid fa-floppy-disk"></i> ${escapeHtml(s.name)}
                                ${s.name === 'default' ? '<span class="bb-slot-default-badge">当前</span>' : ''}
                            </span>
                            <span class="bb-slot-count">${s.count} 条记忆</span>
                        </div>
                        <div class="bb-slot-actions">
                            <button class="menu_button bb-slot-btn-save" data-slot="${escapeHtml(s.name)}" title="将当前数据保存到此槽">
                                <i class="fa-solid fa-arrow-up"></i> 保存
                            </button>
                            <button class="menu_button bb-slot-btn-load" data-slot="${escapeHtml(s.name)}" title="从此槽加载数据（覆盖当前）">
                                <i class="fa-solid fa-arrow-down"></i> 加载
                            </button>
                            ${s.name !== 'default' ? `
                            <button class="menu_button menu_button_danger bb-slot-btn-delete" data-slot="${escapeHtml(s.name)}" title="删除此存档槽">
                                <i class="fa-solid fa-trash"></i>
                            </button>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;

        bindSlotEvents(overlay, chatId, charId, slotsEl);
    } catch (err) {
        slotsEl.innerHTML = `<div class="bb-mem-empty">加载失败：${escapeHtml(err.message)}</div>`;
    }
}

function bindSlotEvents(overlay, chatId, charId, slotsEl) {
    // Slot sort
    slotsEl.querySelector('#bb_slot_sort')?.addEventListener('change', async (e) => {
        slotsEl.dataset.slotSort = e.target.value;
        await renderSlotsPanel(overlay, chatId);
    });

    slotsEl.querySelectorAll('.bb-slot-btn-save').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slotName = btn.dataset.slot;
            try {
                const count = await saveToSlot(charId, chatId, slotName);
                showToast(`已保存 ${count} 条到「${slotName}」`, 'success');
                updateSettings({ currentSlotName: slotName });
                await renderSlotsPanel(overlay, chatId);
                updateCurrentSlotBar(overlay, chatId);
            } catch (err) { showToast(`保存失败: ${err.message}`, 'error'); }
        });
    });

    slotsEl.querySelectorAll('.bb-slot-btn-load').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slotName = btn.dataset.slot;
            const ok = confirm(`确定从「${slotName}」加载吗？当前数据将被覆盖！`);
            if (!ok) return;
            try {
                const count = await loadFromSlot(charId, chatId, slotName);
                showToast(`已从「${slotName}」加载 ${count} 条`, 'success');
                updateSettings({ currentSlotName: slotName });
                await renderSlotsPanel(overlay, chatId);
                updateCurrentSlotBar(overlay, chatId);
                await rerenderManagerList(overlay, chatId);
                // v7.5.0 清除面板缓存，强制下次切换时重新加载
                const dashContent = overlay.querySelector('#bb_dashboard_content');
                if (dashContent) dashContent.innerHTML = '<div class="bb-mem-empty"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>';
                const threadContent = overlay.querySelector('#bb_thread_panel_content');
                if (threadContent) threadContent.innerHTML = '<div class="bb-mem-empty"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>';
            } catch (err) { showToast(`加载失败: ${err.message}`, 'error'); }
        });
    });

    slotsEl.querySelectorAll('.bb-slot-btn-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slotName = btn.dataset.slot;
            const ok = confirm(`确定删除存档「${slotName}」吗？此操作不可撤销！`);
            if (!ok) return;
            try {
                await deleteSlot(charId, slotName);
                showToast(`已删除存档「${slotName}」`, 'info');
                await renderSlotsPanel(overlay, chatId);
            } catch (err) { showToast(`删除失败: ${err.message}`, 'error'); }
        });
    });

    slotsEl.querySelector('#bb_slot_create_btn')?.addEventListener('click', async () => {
        const input = slotsEl.querySelector('#bb_slot_new_name');
        const name = input?.value?.trim();
        if (!name) { showToast('请输入存档名称', 'warning'); return; }
        try {
            await createEmptySlot(charId, name);
            showToast(`已创建存档「${name}」`, 'success');
            input.value = '';
            await renderSlotsPanel(overlay, chatId);
        } catch (err) { showToast(`创建失败: ${err.message}`, 'error'); }
    });
}

// ═══ 仪表盘标签页 ═══

async function renderDashboardPanel(overlay, chatId) {
    const contentEl = overlay.querySelector('#bb_dashboard_content');
    if (!contentEl) return;

    try {
        const [npc, items, timeline, memories] = await Promise.all([
            getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
        ]);
        const stats = await getMemoryStats(chatId);

        // Collect all entries for "recent" lists
        const allEntries = [
            ...npc.map(e => ({ ...e, _pillar: 'npc' })),
            ...items.map(e => ({ ...e, _pillar: 'item' })),
            ...timeline.map(e => ({ ...e, _pillar: 'timeline' })),
            ...memories.map(e => ({ ...e, _pillar: 'mem' })),
        ];

        // Recent additions (last 10)
        const recentAdditions = [...allEntries]
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, 10);

        // Top hits
        const topHits = [...allEntries]
            .filter(e => (e.hitCount || 0) > 0)
            .sort((a, b) => (b.hitCount || 0) - (a.hitCount || 0))
            .slice(0, 5);

        // Last injection info
        let injectionInfo = null;
        try {
            const lastResult = globalThis.bbMemoryDebug?.lastRetrievalResult?.();
            if (lastResult?.stats) injectionInfo = lastResult.stats;
        } catch { /* ignore */ }

        // Maintenance check
        let maintInfo = null;
        try {
            const { checkMaintenanceNeeded } = await import('./memory-maintainer.js');
            const result = await checkMaintenanceNeeded(chatId);
            if (result.needed) maintInfo = result;
        } catch { /* ignore */ }

        const pillarConfig = {
            npc: { icon: 'fa-user', label: 'NPC', color: '#ba68c8' },
            item: { icon: 'fa-box', label: '物品', color: '#4fc3f7' },
            timeline: { icon: 'fa-clock', label: '时间线', color: '#ffb74d' },
            mem: { icon: 'fa-brain', label: '记忆', color: '#81c784' },
        };

        const timeAgo = (ts) => {
            if (!ts) return '';
            const diff = Date.now() - ts;
            if (diff < 60000) return '刚刚';
            if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
            if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
            return `${Math.floor(diff / 86400000)}天前`;
        };

        contentEl.innerHTML = `
            <div style="padding:12px 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:12px;">
                <div class="bb-dash-stat-card" style="background:var(--SmartThemeBlurTintColor, rgba(255,255,255,0.04));border-radius:8px;padding:10px;text-align:center;border-left:3px solid #ba68c8;">
                    <div style="font-size:1.4em;font-weight:bold;">${npc.length}</div>
                    <div style="font-size:0.8em;opacity:0.7;">NPC档案</div>
                    <div style="font-size:0.7em;opacity:0.5;">核心${stats.npc?.byTier?.core || 0} / 重要${stats.npc?.byTier?.important || 0}</div>
                </div>
                <div class="bb-dash-stat-card" style="background:var(--SmartThemeBlurTintColor, rgba(255,255,255,0.04));border-radius:8px;padding:10px;text-align:center;border-left:3px solid #4fc3f7;">
                    <div style="font-size:1.4em;font-weight:bold;">${items.length}</div>
                    <div style="font-size:0.8em;opacity:0.7;">物品</div>
                    <div style="font-size:0.7em;opacity:0.5;">关键${stats.items?.byTier?.key || 0} / 线索${stats.items?.byTier?.clue || 0}</div>
                </div>
                <div class="bb-dash-stat-card" style="background:var(--SmartThemeBlurTintColor, rgba(255,255,255,0.04));border-radius:8px;padding:10px;text-align:center;border-left:3px solid #ffb74d;">
                    <div style="font-size:1.4em;font-weight:bold;">${timeline.length}</div>
                    <div style="font-size:0.8em;opacity:0.7;">时间线</div>
                    <div style="font-size:0.7em;opacity:0.5;">进行中${timeline.filter(t => t.isActive).length}</div>
                </div>
                <div class="bb-dash-stat-card" style="background:var(--SmartThemeBlurTintColor, rgba(255,255,255,0.04));border-radius:8px;padding:10px;text-align:center;border-left:3px solid #81c784;">
                    <div style="font-size:1.4em;font-weight:bold;">${memories.length}</div>
                    <div style="font-size:0.8em;opacity:0.7;">记忆条目</div>
                    <div style="font-size:0.7em;opacity:0.5;">核心${stats.memories?.byTier?.core || 0} / 稳固${stats.memories?.byTier?.stable || 0}</div>
                </div>
            </div>

            <div style="padding:0 18px;">
                <h4 style="margin:0 0 8px;font-size:0.9em;"><i class="fa-solid fa-clock"></i> 最近新增</h4>
                ${recentAdditions.length ? recentAdditions.map(e => {
                    const pc = pillarConfig[e._pillar];
                    return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:0.82em;border-bottom:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.05));">
                        <span style="color:${pc.color};font-size:0.75em;"><i class="fa-solid ${pc.icon}"></i> ${pc.label}</span>
                        <span style="flex:1;">${escapeHtml(e.title || e.name || (e.content || '').slice(0, 25))}</span>
                        <span style="opacity:0.4;font-size:0.8em;">${timeAgo(e.createdAt)}</span>
                    </div>`;
                }).join('') : '<div style="opacity:0.4;font-size:0.8em;">暂无数据</div>'}
            </div>

            <div style="padding:0 18px;margin-top:12px;">
                <h4 style="margin:0 0 8px;font-size:0.9em;"><i class="fa-solid fa-bullseye"></i> 最近命中</h4>
                ${topHits.length ? topHits.map(e => {
                    const pc = pillarConfig[e._pillar];
                    return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:0.82em;border-bottom:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.05));">
                        <span style="color:${pc.color};font-size:0.75em;"><i class="fa-solid ${pc.icon}"></i> ${pc.label}</span>
                        <span style="flex:1;">${escapeHtml(e.title || e.name || (e.content || '').slice(0, 25))}</span>
                        <span style="color:#4caf50;font-size:0.8em;">命中 ${e.hitCount}次</span>
                    </div>`;
                }).join('') : '<div style="opacity:0.4;font-size:0.8em;">暂无命中记录</div>'}
            </div>

            ${injectionInfo ? `
            <div style="padding:0 18px;margin-top:12px;">
                <h4 style="margin:0 0 8px;font-size:0.9em;"><i class="fa-solid fa-syringe"></i> 上次注入</h4>
                <div style="font-size:0.82em;opacity:0.7;">
                    NPC ${injectionInfo.npcCount || 0} 个 · 物品 ${injectionInfo.itemCount || 0} 个 · 时间线 ${injectionInfo.timelineCount || 0} 条 · 记忆 ${injectionInfo.memoryCount || 0} 条
                    ${injectionInfo.tokenEstimate != null ? ` · ~${injectionInfo.tokenEstimate} tokens` : ''}
                </div>
            </div>` : ''}

            ${maintInfo ? `
            <div style="margin:12px 18px;padding:10px;background:rgba(255,152,0,0.1);border:1px solid rgba(255,152,0,0.3);border-radius:8px;display:flex;align-items:center;gap:8px;">
                <i class="fa-solid fa-triangle-exclamation" style="color:#ff9800;"></i>
                <span style="font-size:0.85em;">${maintInfo.issueCount} 条记忆需要维护</span>
                <button class="menu_button" id="bb_dash_do_maint" style="margin-left:auto;font-size:0.8em;">去维护</button>
            </div>` : `
            <div style="margin:12px 18px;padding:10px;background:rgba(76,175,80,0.1);border:1px solid rgba(76,175,80,0.3);border-radius:8px;display:flex;align-items:center;gap:8px;">
                <i class="fa-solid fa-circle-check" style="color:#4caf50;"></i>
                <span style="font-size:0.85em;">记忆状态良好，无需维护</span>
            </div>`}
        `;

        // Bind maintenance button
        contentEl.querySelector('#bb_dash_do_maint')?.addEventListener('click', () => {
            overlay.remove();
            // Trigger maintenance
            const maintBtn = document.querySelector('#bb_memory_maintenance_btn');
            if (maintBtn) maintBtn.click();
        });
    } catch (err) {
        contentEl.innerHTML = `<div class="bb-mem-empty">加载失败：${escapeHtml(err.message)}</div>`;
    }
}

// ═══ 工具函数 ═══

async function updateCurrentSlotBar(overlay, chatId) {
    const nameEl = overlay.querySelector('#bb_current_slot_name');
    const countEl = overlay.querySelector('#bb_current_slot_count');
    if (!nameEl && !countEl) return;

    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);
    const totalCount = npc.length + items.length + timeline.length + memories.length;
    const settings = getSettings();
    const currentSlot = settings.currentSlotName || 'default';

    if (nameEl) nameEl.textContent = currentSlot;
    if (countEl) countEl.textContent = String(totalCount);
}

// ═══════════════════════════════════════════════════════════
//  v6.8.0 时间线线程面板
// ═══════════════════════════════════════════════════════════

async function renderThreadPanel(overlay, chatId) {
    const panel = overlay.querySelector('#bb_thread_panel_content');
    if (!panel) return;

    const threads = await getTimelineThreads(chatId);
    const timeline = await getTimeline(chatId);

    if (!threads.length) {
        panel.innerHTML = `
            <div class="bb-thread-empty">
                <i class="fa-solid fa-timeline" style="font-size:2em;opacity:0.3;"></i>
                <p>暂无时间线线程</p>
                <button class="menu_button" id="bb_thread_refresh_empty" style="margin-top:8px;">
                    <i class="fa-solid fa-rotate"></i> 刷新时间线总结
                </button>
            </div>`;
        // v7.5.0 空状态内联刷新按钮
        panel.querySelector('#bb_thread_refresh_empty')?.addEventListener('click', async () => {
            const btn = panel.querySelector('#bb_thread_refresh_empty');
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 生成中...';
            try {
                const { regenerateThreadSummary } = await import('./memory-maintainer.js');
                await regenerateThreadSummary(chatId);
                await renderThreadPanel(overlay, chatId);
            } catch (e) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-rotate"></i> 刷新时间线总结';
            }
        });
        return;
    }

    const statusLabel = { ongoing: '进行中', ended: '已结束', paused: '暂停', resident: '★常驻', archived: '已归档' };
    const statusIcon = { ongoing: '●', ended: '✓', paused: '⏸', resident: '★', archived: '📦' };
    const entryStatusIcon = { ongoing: '→', ended: '✓', milestone: '◆', paused: '⏸' };
    const typeLabel = { plot: '', emotional: '[感情]', side: '[支线]', world: '[世界]' };

    let html = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <span style="font-weight:bold;">${threads.length} 条线程</span>
            <button class="menu_button" id="bb_thread_refresh_inline" style="font-size:0.85em;">
                <i class="fa-solid fa-rotate"></i> 刷新总结
            </button>
        </div>`;

    for (let ti = 0; ti < threads.length; ti++) {
        const thread = threads[ti];
        const st = thread.status || 'ongoing';
        const entries = thread.entries || [];

        // 状态切换按钮
        const statusBtns = [];
        if (st === 'ongoing') {
            statusBtns.push(`<button class="menu_button bb-thread-btn-pause" data-thread-idx="${ti}" title="暂停">⏸</button>`);
            statusBtns.push(`<button class="menu_button bb-thread-btn-end" data-thread-idx="${ti}" title="结束">✓</button>`);
        } else if (st === 'paused') {
            statusBtns.push(`<button class="menu_button bb-thread-btn-resume" data-thread-idx="${ti}" title="继续">▶</button>`);
            statusBtns.push(`<button class="menu_button bb-thread-btn-end" data-thread-idx="${ti}" title="结束">✓</button>`);
        } else if (st === 'ended') {
            statusBtns.push(`<button class="menu_button bb-thread-btn-resume" data-thread-idx="${ti}" title="重新激活">▶</button>`);
        }
        if (st !== 'resident') {
            statusBtns.push(`<button class="menu_button bb-thread-btn-resident" data-thread-idx="${ti}" title="设为常驻">★</button>`);
        } else {
            statusBtns.push(`<button class="menu_button bb-thread-btn-unresident" data-thread-idx="${ti}" title="取消常驻">☆</button>`);
        }

        const hasOngoing = entries.some(e => e.status === 'ongoing');
        const cardId = `bb_thread_card_${ti}`;

        html += `
        <div class="bb-thread-card">
            <div class="bb-thread-header bb-thread-collapse-toggle" data-card-id="${cardId}">
                <i class="fa-solid ${hasOngoing ? 'fa-chevron-down' : 'fa-chevron-right'} bb-thread-chevron"></i>
                <span class="bb-thread-status" data-status="${st}">${statusIcon[st] || '●'} ${statusLabel[st] || st}</span>
                <span class="bb-thread-type">${typeLabel[thread.type] || ''}</span>
                <strong class="bb-thread-name">${escapeHtml(thread.name)}</strong>
                ${thread.summary ? `<span class="bb-thread-summary">— ${escapeHtml(thread.summary)}</span>` : ''}
                <div class="bb-thread-actions">
                    ${statusBtns.join('')}
                    <button class="menu_button bb-thread-btn-edit" data-thread-idx="${ti}" title="编辑线程"><i class="fa-solid fa-pen"></i></button>
                    <button class="menu_button bb-thread-btn-delete" data-thread-idx="${ti}" title="删除线程"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div class="bb-thread-entries" id="${cardId}_entries" style="${hasOngoing ? '' : 'display:none;'}">`;

        if (entries.length) {
            for (let ei = 0; ei < entries.length; ei++) {
                const entry = entries[ei];
                html += `
                <div class="bb-thread-entry">
                    <span class="bb-thread-entry-status">${entryStatusIcon[entry.status] || '·'}</span>
                    <span class="bb-thread-entry-period">${escapeHtml(entry.period || '')}</span>
                    <span class="bb-thread-entry-event">${escapeHtml(entry.event || '')}</span>
                    ${entry.status === 'ongoing' ? '<span class="bb-thread-entry-ongoing">进行中</span>' : ''}
                    <button class="bb-thread-entry-edit menu_button" data-thread-idx="${ti}" data-entry-idx="${ei}" title="编辑"><i class="fa-solid fa-pen"></i></button>
                    <button class="bb-thread-entry-del menu_button" data-thread-idx="${ti}" data-entry-idx="${ei}" title="删除"><i class="fa-solid fa-xmark"></i></button>
                </div>`;
            }
        } else {
            html += '<div style="font-size:0.75em;opacity:0.3;padding:4px 24px;">无条目</div>';
        }

        html += '</div></div>';
    }

    // v7.5.0 详细时间线条目（折叠区，仅显示进行中条目）
    const tlId = 'bb_thread_detail_timeline';
    const activeTimelineEntries = timeline.filter(t => t.isActive);
    if (activeTimelineEntries.length) {
        html += `
        <div class="bb-thread-detail-section">
            <button class="bb-thread-detail-toggle" id="${tlId}_toggle" data-collapsed="true">
                <i class="fa-solid fa-chevron-right"></i>
                详细时间线条目 (${activeTimelineEntries.length}条) — 点击展开
            </button>
            <div class="bb-thread-detail-list" id="${tlId}_list" style="display:none;">
                ${activeTimelineEntries.sort((a, b) => (a.storyTimeSort ?? 0) - (b.storyTimeSort ?? 0)).map(t => {
                    const tStatus = t.status === 'ongoing' ? '进行中' : t.status === 'ended' ? '已结束' : t.status === 'foreshadow' ? '伏笔' : t.status || '';
                    return `
                    <div class="bb-thread-detail-item">
                        <span class="bb-thread-detail-time">${escapeHtml(t.storyTime || '?')}</span>
                        <span class="bb-thread-detail-event">${escapeHtml(t.event || t.summary || '')}</span>
                        ${tStatus ? `<span class="bb-thread-detail-status">${tStatus}</span>` : ''}
                        <span style="flex:1;"></span>
                        <button class="bb-thread-detail-edit menu_button" data-id="${t.id}" title="编辑"><i class="fa-solid fa-pen"></i></button>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }

    panel.innerHTML = html;

    // 绑定刷新按钮
    panel.querySelector('#bb_thread_refresh_inline')?.addEventListener('click', async () => {
        const btn = panel.querySelector('#bb_thread_refresh_inline');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 生成中...';
        try {
            const { regenerateThreadSummary } = await import('./memory-maintainer.js');
            const result = await regenerateThreadSummary(chatId);
            if (result.threadCount > 0) {
                await renderThreadPanel(overlay, chatId);
            } else {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-rotate"></i> 刷新总结';
            }
        } catch (e) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-rotate"></i> 刷新总结';
        }
    });

    // 绑定详细条目折叠
    const toggle = panel.querySelector(`#${tlId}_toggle`);
    const list = panel.querySelector(`#${tlId}_list`);
    if (toggle && list) {
        toggle.addEventListener('click', () => {
            const collapsed = toggle.dataset.collapsed === 'true';
            toggle.dataset.collapsed = collapsed ? 'false' : 'true';
            list.style.display = collapsed ? '' : 'none';
            toggle.querySelector('i').className = collapsed ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right';
            toggle.innerHTML = toggle.innerHTML.replace(collapsed ? '点击展开' : '点击收起', collapsed ? '点击收起' : '点击展开');
        });
    }

    // 绑定详细条目编辑按钮
    panel.querySelectorAll('.bb-thread-detail-edit').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const entry = timeline.find(t => t.id === id);
            if (entry) {
                showQuickEditForm(overlay, chatId, entry.id, 'timeline');
            }
        });
    });

    // ═══ v7.3.0 线程折叠/展开 ═══
    panel.querySelectorAll('.bb-thread-collapse-toggle').forEach(header => {
        header.addEventListener('click', (e) => {
            // 不拦截按钮点击
            if (e.target.closest('.menu_button')) return;
            const cardId = header.dataset.cardId;
            const entries = panel.querySelector(`#${cardId}_entries`);
            const chevron = header.querySelector('.bb-thread-chevron');
            if (entries) {
                const isHidden = entries.style.display === 'none';
                entries.style.display = isHidden ? '' : 'none';
                if (chevron) {
                    chevron.className = isHidden ? 'fa-solid fa-chevron-down bb-thread-chevron' : 'fa-solid fa-chevron-right bb-thread-chevron';
                }
            }
        });
    });

    // ═══ v7.0.0 线程管理按钮绑定 ═══

    const bindThreadBtn = (selector, handler) => {
        panel.querySelectorAll(selector).forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                    await handler(btn);
                } catch (err) {
                    console.error('[BB-Memory] 线程操作失败:', err.message || err);
                }
            });
        });
    };

    // 编辑线程
    bindThreadBtn('.bb-thread-btn-edit', async (btn) => {
        const idx = parseInt(btn.dataset.threadIdx);
        const thread = threads[idx];
        if (thread) showThreadEditForm(overlay, chatId, thread);
    });

    // 删除线程
    bindThreadBtn('.bb-thread-btn-delete', async (btn) => {
        const idx = parseInt(btn.dataset.threadIdx);
        const thread = threads[idx];
        if (thread && confirm(`确认删除线程「${thread.name}」？`)) {
            const result = await removeTimelineThread(chatId, thread.id);
            console.log('[BB-Memory] 删除线程结果:', result, 'chatId:', chatId, 'threadId:', thread.id);
            await renderThreadPanel(overlay, chatId);
        }
    });

    // 状态切换：暂停
    bindThreadBtn('.bb-thread-btn-pause', async (btn) => {
        const idx = parseInt(btn.dataset.threadIdx);
        const thread = threads[idx];
        if (thread) {
            console.log('[BB-Memory] 暂停线程:', thread.name, 'chatId:', chatId);
            await upsertTimelineThread(chatId, { ...thread, status: 'paused' });
            await renderThreadPanel(overlay, chatId);
        }
    });

    // 状态切换：继续/重新激活
    bindThreadBtn('.bb-thread-btn-resume', async (btn) => {
        const idx = parseInt(btn.dataset.threadIdx);
        const thread = threads[idx];
        if (thread) {
            await upsertTimelineThread(chatId, { ...thread, status: 'ongoing' });
            await renderThreadPanel(overlay, chatId);
        }
    });

    // 状态切换：结束
    bindThreadBtn('.bb-thread-btn-end', async (btn) => {
        const idx = parseInt(btn.dataset.threadIdx);
        const thread = threads[idx];
        if (thread) {
            await upsertTimelineThread(chatId, { ...thread, status: 'ended' });
            await renderThreadPanel(overlay, chatId);
        }
    });

    // 设为常驻
    bindThreadBtn('.bb-thread-btn-resident', async (btn) => {
        const idx = parseInt(btn.dataset.threadIdx);
        const thread = threads[idx];
        if (thread) {
            await upsertTimelineThread(chatId, { ...thread, status: 'resident', priority: 'high' });
            await renderThreadPanel(overlay, chatId);
        }
    });

    // 取消常驻
    bindThreadBtn('.bb-thread-btn-unresident', async (btn) => {
        const idx = parseInt(btn.dataset.threadIdx);
        const thread = threads[idx];
        if (thread) {
            await upsertTimelineThread(chatId, { ...thread, status: 'ongoing' });
            await renderThreadPanel(overlay, chatId);
        }
    });

    // 编辑线程条目
    bindThreadBtn('.bb-thread-entry-edit', async (btn) => {
        const ti = parseInt(btn.dataset.threadIdx);
        const ei = parseInt(btn.dataset.entryIdx);
        const thread = threads[ti];
        if (thread && thread.entries[ei]) {
            showThreadEntryEditForm(overlay, chatId, thread, ei);
        }
    });

    // 删除线程条目
    bindThreadBtn('.bb-thread-entry-del', async (btn) => {
        const ti = parseInt(btn.dataset.threadIdx);
        const ei = parseInt(btn.dataset.entryIdx);
        const thread = threads[ti];
        if (thread && thread.entries[ei] && confirm(`确认删除条目「${thread.entries[ei].event}」？`)) {
            thread.entries.splice(ei, 1);
            await upsertTimelineThread(chatId, thread);
            await renderThreadPanel(overlay, chatId);
        }
    });
}

// ═══════════════════════════════════════════════════════════
//  v7.0.0 线程编辑表单
// ═══════════════════════════════════════════════════════════

function showThreadEditForm(overlay, chatId, thread) {
    // 移除已有表单
    document.querySelector('.bb-thread-form-overlay')?.remove();

    const formOverlay = document.createElement('div');
    formOverlay.className = 'bb-mem-form-overlay bb-thread-form-overlay';
    formOverlay.innerHTML = `
    <div class="bb-mem-form-popup" style="max-width:480px;">
        <div class="bb-mem-form-header">
            <h3><i class="fa-solid fa-timeline"></i> 编辑线程</h3>
            <span class="bb-thread-form-close" style="cursor:pointer;font-size:1.2em;">&times;</span>
        </div>
        <div class="bb-mem-form-body">
            <div class="bb-mem-form-row">
                <label>线程名称</label>
                <input type="text" class="text_pole bb-thread-form-name" value="${escapeHtml(thread.name || '')}" />
            </div>
            <div class="bb-mem-form-row">
                <label>类型</label>
                <select class="text_pole bb-thread-form-type">
                    <option value="plot" ${thread.type === 'plot' ? 'selected' : ''}>主线剧情</option>
                    <option value="emotional" ${thread.type === 'emotional' ? 'selected' : ''}>感情线</option>
                    <option value="side" ${thread.type === 'side' ? 'selected' : ''}>支线</option>
                    <option value="world" ${thread.type === 'world' ? 'selected' : ''}>世界观</option>
                </select>
            </div>
            <div class="bb-mem-form-row">
                <label>优先级</label>
                <select class="text_pole bb-thread-form-priority">
                    <option value="high" ${thread.priority === 'high' ? 'selected' : ''}>高</option>
                    <option value="medium" ${thread.priority === 'medium' ? 'selected' : ''}>中</option>
                    <option value="low" ${thread.priority === 'low' ? 'selected' : ''}>低</option>
                </select>
            </div>
            <div class="bb-mem-form-row">
                <label>一句话总结 <small>注入时显示在AI上下文中</small></label>
                <textarea class="text_pole bb-thread-form-summary" rows="2" placeholder="如：从北境初遇到战后表白，经历三年分离与重逢">${escapeHtml(thread.summary || '')}</textarea>
            </div>
        </div>
        <div class="bb-mem-form-footer">
            <button class="menu_button bb-thread-form-save"><i class="fa-solid fa-check"></i> 保存</button>
            <button class="menu_button bb-thread-form-cancel">取消</button>
        </div>
    </div>`;
    document.body.appendChild(formOverlay);

    const close = () => formOverlay.remove();
    formOverlay.querySelector('.bb-thread-form-close')?.addEventListener('click', close);
    formOverlay.querySelector('.bb-thread-form-cancel')?.addEventListener('click', close);
    formOverlay.addEventListener('click', (e) => { if (e.target === formOverlay) close(); });

    formOverlay.querySelector('.bb-thread-form-save')?.addEventListener('click', async () => {
        try {
            const name = formOverlay.querySelector('.bb-thread-form-name')?.value?.trim();
            const type = formOverlay.querySelector('.bb-thread-form-type')?.value;
            const priority = formOverlay.querySelector('.bb-thread-form-priority')?.value;
            const summary = formOverlay.querySelector('.bb-thread-form-summary')?.value?.trim();
            if (!name) return;
            console.log('[BB-Memory] 保存线程编辑:', name, type, priority);
            await upsertTimelineThread(chatId, { ...thread, name, type, priority, summary: summary || '' });
            close();
            await renderThreadPanel(overlay, chatId);
        } catch (err) {
            console.error('[BB-Memory] 保存线程失败:', err.message || err);
        }
    });
}

function showThreadEntryEditForm(overlay, chatId, thread, entryIdx) {
    const entry = thread.entries[entryIdx];
    if (!entry) return;
    document.querySelector('.bb-thread-form-overlay')?.remove();

    const formOverlay = document.createElement('div');
    formOverlay.className = 'bb-mem-form-overlay bb-thread-form-overlay';
    formOverlay.innerHTML = `
    <div class="bb-mem-form-popup" style="max-width:480px;">
        <div class="bb-mem-form-header">
            <h3><i class="fa-solid fa-clock"></i> 编辑线程条目</h3>
            <span class="bb-thread-form-close" style="cursor:pointer;font-size:1.2em;">&times;</span>
        </div>
        <div class="bb-mem-form-body">
            <div class="bb-mem-form-row">
                <label>时间区间</label>
                <input type="text" class="text_pole bb-thread-form-period" value="${escapeHtml(entry.period || '')}" placeholder="如：123年1月-2月" />
            </div>
            <div class="bb-mem-form-row">
                <label>事件描述</label>
                <input type="text" class="text_pole bb-thread-form-event" value="${escapeHtml(entry.event || '')}" />
            </div>
            <div class="bb-mem-form-row">
                <label>状态</label>
                <select class="text_pole bb-thread-form-entry-status">
                    <option value="ongoing" ${entry.status === 'ongoing' ? 'selected' : ''}>进行中</option>
                    <option value="ended" ${entry.status === 'ended' ? 'selected' : ''}>已结束</option>
                    <option value="milestone" ${entry.status === 'milestone' ? 'selected' : ''}>里程碑</option>
                </select>
            </div>
        </div>
        <div class="bb-mem-form-footer">
            <button class="menu_button bb-thread-form-save"><i class="fa-solid fa-check"></i> 保存</button>
            <button class="menu_button bb-thread-form-cancel">取消</button>
        </div>
    </div>`;
    document.body.appendChild(formOverlay);

    const close = () => formOverlay.remove();
    formOverlay.querySelector('.bb-thread-form-close')?.addEventListener('click', close);
    formOverlay.querySelector('.bb-thread-form-cancel')?.addEventListener('click', close);
    formOverlay.addEventListener('click', (e) => { if (e.target === formOverlay) close(); });

    formOverlay.querySelector('.bb-thread-form-save')?.addEventListener('click', async () => {
        try {
            const period = formOverlay.querySelector('.bb-thread-form-period')?.value?.trim();
            const event = formOverlay.querySelector('.bb-thread-form-event')?.value?.trim();
            const status = formOverlay.querySelector('.bb-thread-form-entry-status')?.value;
            if (!event) return;
            thread.entries[entryIdx] = { period: period || '', event, status: status || 'ongoing' };
            await upsertTimelineThread(chatId, thread);
            close();
            await renderThreadPanel(overlay, chatId);
        } catch (err) {
            console.error('[BB-Memory] 保存条目失败:', err.message || err);
        }
    });
}

async function rerenderManagerList(overlay, chatId) {
    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);

    let allEntries = [
        ...npc.map(e => ({ ...e, _pillar: 'npc' })),
        ...items.map(e => ({ ...e, _pillar: 'item' })),
        ...timeline.map(e => ({ ...e, _pillar: 'timeline' })),
        ...memories.map(e => ({ ...e, _pillar: 'mem' })),
    ];

    // 应用筛选
    if (activeFilter && activeFilter !== 'all') {
        allEntries = allEntries.filter(e => e._pillar === activeFilter);
    }

    // 排序
    const sortEl = overlay.querySelector('#bb_mgr_sort');
    const sortMode = sortEl ? sortEl.value : 'created_desc';
    allEntries.sort((a, b) => {
        if (sortMode.startsWith('floor')) {
            // 楼层排序：无 sourceFloor 的排最后，旧聊天记忆(-1)在正序时排倒数第二
            const aFloor = typeof a.sourceFloor === 'number' ? a.sourceFloor : -999;
            const bFloor = typeof b.sourceFloor === 'number' ? b.sourceFloor : -999;
            return sortMode.endsWith('asc') ? aFloor - bFloor : bFloor - aFloor;
        }
        const aTime = sortMode.startsWith('updated') ? (a.updatedAt || 0) : (a.createdAt || 0);
        const bTime = sortMode.startsWith('updated') ? (b.updatedAt || 0) : (b.createdAt || 0);
        return sortMode.endsWith('asc') ? aTime - bTime : bTime - aTime;
    });

    const totalCount = npc.length + items.length + timeline.length + memories.length;
    const statsEl = overlay.querySelector('.bb-mem-stats');
    if (statsEl) {
        statsEl.innerHTML = `共 <strong>${totalCount}</strong> 条（NPC ${npc.length} / 物品 ${items.length} / 时间线 ${timeline.length} / 记忆 ${memories.length}）`;
    }

    const listEl = overlay.querySelector('#bb_mgr_list');
    if (listEl) {
        listEl.innerHTML = allEntries.length
            ? allEntries.map(e => buildEntryItemHTML(e)).join('')
            : '<div class="bb-mem-empty">暂无匹配的条目</div>';
    }

    rebindItemActions(overlay, chatId);
}

// ═══ v7.5.0 归档仓库 ═══

async function renderArchiveWarehouse(overlay, chatId) {
    const panel = overlay.querySelector('#bb_warehouse_content');
    if (!panel) return;

    try {
        const memories = await getMemories(chatId);
        const archived = memories.filter(m => m.status === 'archived');

        const tierLabels = { transient: '瞬时', stable: '稳固', core: '核心', eternal: '永恒' };

        panel.innerHTML = `
            <div style="padding:12px 18px;">
                <div style="display:flex;align-items:center;margin-bottom:12px;">
                    <h3 style="margin:0;"><i class="fa-solid fa-box-archive"></i> 归档仓库</h3>
                    <span style="flex:1;"></span>
                    <span style="font-size:0.85em;opacity:0.6;">${archived.length} 条归档</span>
                </div>
                <div id="bb_warehouse_list" style="max-height:calc(100vh - 200px);overflow-y:auto;">
                    ${archived.length ? archived.map(m => {
                        const preview = (m.content || m.summary || '').slice(0, 80);
                        const tier = m.memoryTier || 'transient';
                        return `
                        <div class="bb-mem-item" style="opacity:0.85;border-left:3px solid #9e9e9e;margin-bottom:6px;">
                            <div style="display:flex;align-items:center;padding:8px;">
                                <div style="flex:1;min-width:0;">
                                    <strong style="font-size:0.9em;">${escapeHtml(m.title || '(无标题)')}</strong>
                                    <span style="display:inline-block;margin-left:6px;padding:1px 6px;font-size:0.7em;background:rgba(158,158,158,0.15);color:#9e9e9e;border:1px solid rgba(158,158,158,0.25);border-radius:3px;">${tierLabels[tier] || tier}</span>
                                    ${preview ? `<div style="font-size:0.8em;opacity:0.55;margin-top:3px;">${escapeHtml(preview)}</div>` : ''}
                                </div>
                                <div style="display:flex;gap:4px;flex-shrink:0;">
                                    <button class="menu_button bb-warehouse-restore" data-id="${escapeHtml(m.id)}" style="font-size:0.75em;padding:2px 8px;">
                                        <i class="fa-solid fa-undo"></i> 恢复
                                    </button>
                                    <button class="menu_button menu_button_danger bb-warehouse-delete" data-id="${escapeHtml(m.id)}" style="font-size:0.75em;padding:2px 8px;">
                                        <i class="fa-solid fa-trash"></i> 删除
                                    </button>
                                </div>
                            </div>
                        </div>`;
                    }).join('') : '<div style="text-align:center;padding:24px;opacity:0.4;font-size:0.9em;"><i class="fa-solid fa-box-open" style="font-size:2em;display:block;margin-bottom:8px;"></i>暂无归档记忆</div>'}
                </div>
            </div>`;

        // 恢复按钮
        panel.querySelectorAll('.bb-warehouse-restore').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                await restoreMemory(chatId, id);
                showToast('已恢复记忆', 'success');
                await renderArchiveWarehouse(overlay, chatId);
                await rerenderManagerList(overlay, chatId);
            });
        });

        // 删除按钮
        panel.querySelectorAll('.bb-warehouse-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                if (!confirm('确定永久删除此归档记忆吗？')) return;
                await removeMemory(chatId, id);
                showToast('已删除归档记忆', 'info');
                await renderArchiveWarehouse(overlay, chatId);
                await rerenderManagerList(overlay, chatId);
            });
        });
    } catch (err) {
        panel.innerHTML = `<div class="bb-mem-empty">加载失败：${escapeHtml(err.message)}</div>`;
    }
}

function showToast(msg, type = 'info') {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.[type] === 'function') {
            ctx.toastr[type](msg, '', { timeOut: 3000 });
        }
    } catch { /* ignore */ }
}
