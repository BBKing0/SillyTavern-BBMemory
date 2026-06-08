/**
 * memory-assistant.js —— BB-Memory v5.0 记忆管家面板
 *
 * 四柱浏览：NPC档案 / 物品栏 / 时间线 / 记忆条目 + 仪表盘。
 */

import { MEMORY_TYPES } from './memory-types.js';
import { NPC_TIERS, ITEM_TIERS } from './entity-tiers.js';
import {
    getNpcProfiles, getItems, getTimeline, getMemories,
    removeNpcProfile, removeItem, removeTimelineEntry, removeMemory,
    updateNpcProfile, updateItem, updateTimelineEntry, updateMemory,
    addTimelineEntry, getMemoryStats, getSettings,
} from './memory-store.js';
import { simpleSearch } from './retriever.js';
import { getExtractionFloorStatus } from './message-state.js';

// ═══════════════════════════════════════════════════════════
//  窗口管理
// ═══════════════════════════════════════════════════════════

let currentWindow = null;
let currentChatId = null;
let currentTab = 'dashboard';

export async function openAssistant(chatId, initialTab = 'dashboard') {
    if (currentWindow) closeAssistant();
    if (!chatId) { console.warn('[BB-Memory] 无 chatId，无法打开记忆管家'); return; }
    currentChatId = chatId;
    currentTab = initialTab;

    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);

    currentWindow = document.createElement('div');
    currentWindow.className = 'bb-assistant-window';
    currentWindow.innerHTML = buildAssistantHTML(npc, items, timeline, memories);
    document.body.appendChild(currentWindow);

    initDrag(currentWindow);
    bindAssistantEvents(currentWindow, chatId);
    switchTab(currentWindow, initialTab);
}

export function closeAssistant() {
    if (currentWindow) { currentWindow.remove(); currentWindow = null; }
}

// ═══════════════════════════════════════════════════════════
//  主 HTML
// ═══════════════════════════════════════════════════════════

function buildAssistantHTML(npc, items, timeline, memories) {
    return `<div class="bb-assistant-header" id="bb_assistant_drag_handle">
        <span>记忆管家</span>
        <div class="bb-assistant-header-btns">
            <button id="bb_assistant_refresh" title="刷新">↻</button>
            <button id="bb_assistant_close" title="关闭">×</button>
        </div>
    </div>
    <div class="bb-assistant-tabs">
        <button class="bb-assistant-tab active" data-tab="dashboard">仪表盘</button>
        <button class="bb-assistant-tab" data-tab="npc">NPC档案 <span class="bb-tab-count">${npc.length}</span></button>
        <button class="bb-assistant-tab" data-tab="items">物品栏 <span class="bb-tab-count">${items.length}</span></button>
        <button class="bb-assistant-tab" data-tab="timeline">时间线 <span class="bb-tab-count">${timeline.length}</span></button>
        <button class="bb-assistant-tab" data-tab="memories">记忆条目 <span class="bb-tab-count">${memories.length}</span></button>
    </div>
    <div class="bb-assistant-panels">
        <div class="bb-assistant-panel" data-panel="dashboard" style="display:block">
            ${buildDashboardHTML(npc, items, timeline, memories)}
        </div>
        <div class="bb-assistant-panel" data-panel="npc" style="display:none">
            ${buildNpcBrowseHTML(npc)}
        </div>
        <div class="bb-assistant-panel" data-panel="items" style="display:none">
            ${buildItemsBrowseHTML(items)}
        </div>
        <div class="bb-assistant-panel" data-panel="timeline" style="display:none">
            ${buildTimelineBrowseHTML(timeline)}
        </div>
        <div class="bb-assistant-panel" data-panel="memories" style="display:none">
            ${buildMemoriesBrowseHTML(memories)}
        </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
//  仪表盘
// ═══════════════════════════════════════════════════════════

function buildDashboardHTML(npc, items, timeline, memories) {
    const byTier = (arr) => {
        const c = { transient: 0, stable: 0, core: 0, eternal: 0 };
        for (const e of arr) { const t = e.memoryTier || 'transient'; if (c[t] !== undefined) c[t]++; }
        return c;
    };
    const npcTiers = byTier(npc);
    const itemTiers = byTier(items);
    const tlTiers = byTier(timeline);
    const memTiers = byTier(memories);
    let floorStatus = null;
    try { floorStatus = getExtractionFloorStatus(); } catch { /* ignore */ }
    const activityLog = (getSettings().activityLog || []).slice(0, 5);
    const timeAgo = (ts) => {
        if (!ts) return '';
        const diff = Date.now() - ts;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
        return `${Math.floor(diff / 86400000)}天前`;
    };
    const activityColor = { error: '#f44336', warning: '#ff9800', success: '#4caf50', info: '#4fc3f7' };

    return `<div class="bb-dashboard">
        <div class="bb-dash-cards">
            <div class="bb-dash-card npc">
                <div class="bb-dash-num">${npc.length}</div><div>NPC档案</div>
                <div class="bb-dash-detail">核心:${npcTiers.core} 稳定:${npcTiers.stable} 瞬时:${npcTiers.transient}</div>
            </div>
            <div class="bb-dash-card items">
                <div class="bb-dash-num">${items.length}</div><div>物品</div>
                <div class="bb-dash-detail">核心:${itemTiers.core} 稳定:${itemTiers.stable} 瞬时:${itemTiers.transient}</div>
            </div>
            <div class="bb-dash-card timeline">
                <div class="bb-dash-num">${timeline.length}</div><div>时间线</div>
                <div class="bb-dash-detail">进行中:${timeline.filter(t=>t.isActive).length} 已结束:${timeline.filter(t=>!t.isActive).length}</div>
            </div>
            <div class="bb-dash-card memories">
                <div class="bb-dash-num">${memories.length}</div><div>记忆条目</div>
                <div class="bb-dash-detail">核心:${memTiers.core} 稳定:${memTiers.stable} 瞬时:${memTiers.transient}</div>
            </div>
        </div>
        <div class="bb-dash-recent">
            <h4>提取状态</h4>
            <div class="bb-dash-mem-item">
                <span>${escapeHtml(floorStatus?.summary || '暂无可统计楼层')}</span>
            </div>
        </div>
        <div class="bb-dash-recent">
            <h4>运行记录</h4>
            ${activityLog.length ? activityLog.map(e => `<div class="bb-dash-mem-item">
                <span style="color:${activityColor[e.type] || activityColor.info}">${escapeHtml(e.title || '记录')}</span>
                <span>${escapeHtml(e.message || '').slice(0, 80)}</span>
                <span class="bb-dash-mem-tier">${timeAgo(e.timestamp)}</span>
            </div>`).join('') : '<div class="bb-dash-mem-item"><span>暂无提醒或错误</span></div>'}
        </div>
        <div class="bb-dash-recent">
            <h4>最近记忆</h4>
            ${memories.slice(-5).reverse().map(m => `<div class="bb-dash-mem-item">
                <span class="bb-dash-mem-type" style="color:${MEMORY_TYPES[m.type]?.color||'#999'}">${MEMORY_TYPES[m.type]?.label||m.type}</span>
                <span>${escapeHtml((m.title || m.content || '').slice(0, 60))}</span>
                <span class="bb-dash-mem-tier">${m.memoryTier}</span>
            </div>`).join('')}
        </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
//  NPC 浏览
// ═══════════════════════════════════════════════════════════

function buildNpcBrowseHTML(npc) {
    const tierFilter = ['core', 'important', 'minor', 'background'];
    return `<div class="bb-browse-controls">
        <div class="bb-browse-filters">
            ${tierFilter.map(t => `<button class="bb-browse-filter-btn" data-filter="${t}">${NPC_TIERS[t]?.label || t}</button>`).join('')}
            <button class="bb-browse-filter-btn active" data-filter="all">全部</button>
        </div>
        <input type="text" class="bb-browse-search" placeholder="搜索NPC..." id="bb_npc_search">
    </div>
    <div class="bb-browse-list" id="bb_npc_list">
        ${npc.map(n => buildNpcItemHTML(n)).join('')}
    </div>`;
}

function buildNpcItemHTML(n) {
    return `<div class="bb-browse-item npc-item" data-id="${n.id}" data-tier="${n.npcTier}">
        <div class="bb-browse-item-header">
            <span class="bb-tier-badge" style="background:${NPC_TIERS[n.npcTier]?.color||'#999'}">${NPC_TIERS[n.npcTier]?.label||n.npcTier}</span>
            <strong>${escapeHtml(n.name)}</strong>
            <span class="bb-mtier-badge">${n.memoryTier}</span>
        </div>
        <div class="bb-browse-item-body">
            <div>身份：${escapeHtml(n.role || '?')} | 状态：${escapeHtml(n.status || '?')} | 位置：${escapeHtml(n.location || '?')}</div>
            <div>性格：${escapeHtml(n.personality || '?')}</div>
            <div>外貌：${escapeHtml(n.appearance || '?')}</div>
            ${n.relationships?.length ? `<div>关系：${n.relationships.map(r => `${r.name}(${r.type})`).join(', ')}</div>` : ''}
            ${n.indexCard ? `<div class="bb-index-card">索引卡：${escapeHtml(n.indexCard)}</div>` : ''}
        </div>
        <div class="bb-browse-item-actions">
            <button class="bb-item-btn edit" data-action="edit">编辑</button>
            <button class="bb-item-btn delete" data-action="delete">删除</button>
        </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
//  物品浏览
// ═══════════════════════════════════════════════════════════

function buildItemsBrowseHTML(items) {
    const tierFilter = ['key', 'equipped', 'clue', 'consumable', 'background'];
    return `<div class="bb-browse-controls">
        <div class="bb-browse-filters">
            ${tierFilter.map(t => `<button class="bb-browse-filter-btn" data-filter="${t}">${ITEM_TIERS[t]?.label || t}</button>`).join('')}
            <button class="bb-browse-filter-btn active" data-filter="all">全部</button>
        </div>
        <input type="text" class="bb-browse-search" placeholder="搜索物品..." id="bb_item_search">
    </div>
    <div class="bb-browse-list" id="bb_item_list">
        ${items.map(i => buildItemHTML(i)).join('')}
    </div>`;
}

function buildItemHTML(i) {
    const statusLabel = { held: '持有中', used: '已使用', lost: '已失去', destroyed: '已销毁' }[i.status] || i.status;
    return `<div class="bb-browse-item item-item" data-id="${i.id}" data-tier="${i.itemTier}">
        <div class="bb-browse-item-header">
            <span class="bb-tier-badge" style="background:${ITEM_TIERS[i.itemTier]?.color||'#999'}">${ITEM_TIERS[i.itemTier]?.label||i.itemTier}</span>
            <strong>${escapeHtml(i.name)}</strong>
            <span class="bb-status-badge">${statusLabel}</span>
            ${i.keepPermanent ? '<span class="bb-kp-badge">永久</span>' : ''}
            <span class="bb-mtier-badge">${i.memoryTier}</span>
        </div>
        <div class="bb-browse-item-body">
            <div>持有者：${escapeHtml(i.owner || '?')} | 意义：${escapeHtml((i.significance || '').slice(0, 60))}</div>
        </div>
        <div class="bb-browse-item-actions">
            <button class="bb-item-btn edit" data-action="edit">编辑</button>
            <button class="bb-item-btn delete" data-action="delete">删除</button>
        </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
//  时间线浏览
// ═══════════════════════════════════════════════════════════

function buildTimelineBrowseHTML(timeline) {
    const statuses = ['ongoing', 'ended', 'foreshadow'];
    const statusLabels = { ongoing: '进行中', ended: '已结束', foreshadow: '伏笔' };
    return `<div class="bb-browse-controls">
        <div class="bb-browse-filters">
            ${statuses.map(s => `<button class="bb-browse-filter-btn" data-filter="${s}">${statusLabels[s]}</button>`).join('')}
            <button class="bb-browse-filter-btn active" data-filter="all">全部</button>
        </div>
        <div style="display:flex;gap:4px;align-items:center;">
            <select class="bb-browse-sort" id="bb_timeline_sort">
                <option value="story_asc">按故事时间升序</option>
                <option value="story_desc">按故事时间降序</option>
                <option value="created_desc">按创建时间降序</option>
            </select>
            <button class="bb-item-btn" id="bb_btn_new_timeline" data-action="new-timeline" style="background:#4caf50;color:#fff;font-size:0.8em;padding:4px 10px;white-space:nowrap;">
                <i class="fa-solid fa-plus"></i> 新建
            </button>
        </div>
    </div>
    <div class="bb-browse-list" id="bb_timeline_list">
        ${timeline.map(t => buildTimelineItemHTML(t)).join('')}
    </div>
    <div id="bb_timeline_add_form" style="display:none;margin-top:8px;padding:10px;border:1px solid var(--SmartThemeBorderColor,#444);border-radius:8px;background:var(--SmartThemeBlurTintColor,rgba(0,0,0,0.2));"></div>`;
}

function buildTimelineItemHTML(t) {
    const statusLabel = { ongoing: '进行中', ended: '已结束', foreshadow: '伏笔' }[t.status] || t.status;
    return `<div class="bb-browse-item tl-item" data-id="${t.id}" data-status="${t.status}">
        <div class="bb-browse-item-header">
            <span class="bb-status-badge ${t.status}">${statusLabel}</span>
            <strong>${escapeHtml(t.event)}</strong>
            ${t.storyTime ? `<span class="bb-time-badge">${escapeHtml(t.storyTime)}</span>` : ''}
            <span class="bb-mtier-badge">${t.memoryTier}</span>
        </div>
        <div class="bb-browse-item-body">
            <div>${escapeHtml(t.summary)}</div>
            ${t.participants?.length ? `<div>参与者：${t.participants.join(', ')}</div>` : ''}
            ${t.location ? `<div>地点：${escapeHtml(t.location)}</div>` : ''}
            ${t.impact ? `<div>影响：${escapeHtml(t.impact)}</div>` : ''}
        </div>
        <div class="bb-browse-item-actions">
            <button class="bb-item-btn edit" data-action="edit">编辑</button>
            <button class="bb-item-btn toggle-active" data-action="toggle">${t.isActive ? '结束' : '恢复'}</button>
            <button class="bb-item-btn delete" data-action="delete">删除</button>
        </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
//  记忆条目浏览
// ═══════════════════════════════════════════════════════════

function buildMemoriesBrowseHTML(memories) {
    const types = Object.values(MEMORY_TYPES);
    return `<div class="bb-browse-controls">
        <div class="bb-browse-filters">
            ${types.map(t => `<button class="bb-browse-filter-btn" data-filter="${t.id}">${t.label}</button>`).join('')}
            <button class="bb-browse-filter-btn active" data-filter="all">全部</button>
        </div>
        <input type="text" class="bb-browse-search" placeholder="搜索记忆..." id="bb_mem_search">
        <select class="bb-browse-sort" id="bb_mem_sort">
            <option value="created_desc">创建时间↓</option>
            <option value="created_asc">创建时间↑</option>
            <option value="story_desc">故事时间↓</option>
            <option value="story_asc">故事时间↑</option>
            <option value="importance_desc">重要性↓</option>
        </select>
    </div>
    <div class="bb-browse-list" id="bb_mem_list">
        ${memories.map(m => buildMemoryItemHTML(m)).join('')}
    </div>`;
}

function buildMemoryItemHTML(m) {
    const typeDef = MEMORY_TYPES[m.type];
    return `<div class="bb-browse-item mem-item" data-id="${m.id}" data-type="${m.type}">
        <div class="bb-browse-item-header">
            <span class="bb-type-badge" style="color:${typeDef?.color||'#999'}">${typeDef?.label||m.type}</span>
            <strong>${escapeHtml(m.title || m.summary?.slice(0, 30) || '(无标题)')}</strong>
            <span class="bb-mtier-badge">${m.memoryTier}</span>
            <span class="bb-imp-badge">重要度:${(m.importance*100).toFixed(0)}%</span>
        </div>
        <div class="bb-browse-item-body">
            <div>${escapeHtml(m.summary || m.content?.slice(0, 100) || '')}</div>
            ${m.verbatim ? `<div class="bb-verbatim">原话：「${escapeHtml(m.verbatim)}」</div>` : ''}
            ${m.subject ? `<span class="bb-subject">主体:${escapeHtml(m.subject)}</span>` : ''}
            ${m.target ? `<span class="bb-target">→ ${escapeHtml(m.target)}</span>` : ''}
            ${m.storyTime ? `<span class="bb-time-badge">${escapeHtml(m.storyTime)}</span>` : ''}
        </div>
        <div class="bb-browse-item-actions">
            <button class="bb-item-btn edit" data-action="edit">编辑</button>
            <button class="bb-item-btn delete" data-action="delete">删除</button>
        </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
//  事件绑定
// ═══════════════════════════════════════════════════════════

function bindAssistantEvents(win, chatId) {
    win.querySelector('#bb_assistant_close')?.addEventListener('click', closeAssistant);
    win.querySelector('#bb_assistant_refresh')?.addEventListener('click', async () => {
        const [npc, items, timeline, memories] = await Promise.all([
            getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
        ]);
        const panels = win.querySelector('.bb-assistant-panels');
        panels.querySelector('[data-panel="dashboard"]').innerHTML = buildDashboardHTML(npc, items, timeline, memories);
        panels.querySelector('[data-panel="npc"]').innerHTML = buildNpcBrowseHTML(npc);
        panels.querySelector('[data-panel="items"]').innerHTML = buildItemsBrowseHTML(items);
        panels.querySelector('[data-panel="timeline"]').innerHTML = buildTimelineBrowseHTML(timeline);
        panels.querySelector('[data-panel="memories"]').innerHTML = buildMemoriesBrowseHTML(memories);
        // 更新 tab 计数
        const tabs = win.querySelectorAll('.bb-assistant-tab .bb-tab-count');
        if (tabs[0]) tabs[0].textContent = npc.length;
        if (tabs[1]) tabs[1].textContent = items.length;
        if (tabs[2]) tabs[2].textContent = timeline.length;
        if (tabs[3]) tabs[3].textContent = memories.length;
        bindBrowseEvents(win, chatId);
        switchTab(win, currentTab);
    });

    win.querySelectorAll('.bb-assistant-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            currentTab = tab.dataset.tab;
            switchTab(win, currentTab);
        });
    });

    bindBrowseEvents(win, chatId);
}

function bindBrowseEvents(win, chatId) {
    // Filter buttons
    win.querySelectorAll('.bb-browse-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const panel = btn.closest('.bb-assistant-panel');
            const filter = btn.dataset.filter;
            // Update active
            panel.querySelectorAll('.bb-browse-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Filter items
            const items = panel.querySelectorAll('.bb-browse-item');
            items.forEach(item => {
                if (filter === 'all') { item.style.display = ''; return; }
                const match = item.dataset.tier === filter || item.dataset.status === filter || item.dataset.type === filter;
                item.style.display = match ? '' : 'none';
            });
        });
    });

    // Search inputs
    ['bb_npc_search', 'bb_item_search', 'bb_mem_search'].forEach(id => {
        const input = win.querySelector('#' + id);
        if (!input) return;
        input.addEventListener('input', () => {
            const panel = input.closest('.bb-assistant-panel');
            const q = input.value.toLowerCase();
            panel.querySelectorAll('.bb-browse-item').forEach(item => {
                item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none';
            });
        });
    });

    // Sort
    win.querySelector('#bb_timeline_sort')?.addEventListener('change', (e) => {
        sortTimeline(win, e.target.value);
    });
    win.querySelector('#bb_mem_sort')?.addEventListener('change', (e) => {
        sortMemories(win, e.target.value);
    });

    // v7.8.0 新建时间线
    win.querySelector('#bb_btn_new_timeline')?.addEventListener('click', () => {
        const formEl = win.querySelector('#bb_timeline_add_form');
        if (!formEl) return;
        formEl.style.display = formEl.style.display === 'none' ? '' : 'none';
        formEl.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:6px;">
                <label style="font-size:0.85em;font-weight:bold;"><i class="fa-solid fa-plus"></i> 新建时间线</label>
                <input class="bb-input" id="bb_new_tl_event" placeholder="事件描述 *" style="font-size:0.85em;">
                <div style="display:flex;gap:6px;">
                    <input class="bb-input" id="bb_new_tl_storyTime" placeholder="故事时间（如：第三天清晨）" style="font-size:0.85em;flex:1;">
                    <select class="bb-input" id="bb_new_tl_status" style="font-size:0.85em;width:auto;">
                        <option value="ongoing">进行中</option>
                        <option value="ended">已结束</option>
                        <option value="foreshadow">伏笔</option>
                    </select>
                </div>
                <input class="bb-input" id="bb_new_tl_participants" placeholder="参与者（逗号分隔）" style="font-size:0.85em;">
                <input class="bb-input" id="bb_new_tl_location" placeholder="地点" style="font-size:0.85em;">
                <input class="bb-input" id="bb_new_tl_impact" placeholder="影响" style="font-size:0.85em;">
                <div style="display:flex;gap:6px;">
                    <button class="bb-item-btn" id="bb_new_tl_save" style="background:#4caf50;color:#fff;font-size:0.85em;">保存</button>
                    <button class="bb-item-btn" id="bb_new_tl_cancel" style="font-size:0.85em;">取消</button>
                </div>
            </div>`;
        // 保存
        formEl.querySelector('#bb_new_tl_save')?.addEventListener('click', async () => {
            const event = formEl.querySelector('#bb_new_tl_event')?.value?.trim();
            if (!event) { alert('请输入事件描述'); return; }
            const status = formEl.querySelector('#bb_new_tl_status')?.value || 'ongoing';
            await addTimelineEntry(chatId, {
                event, summary: event,
                storyTime: formEl.querySelector('#bb_new_tl_storyTime')?.value?.trim() || '',
                status, isActive: status === 'ongoing',
                participants: (formEl.querySelector('#bb_new_tl_participants')?.value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean),
                location: formEl.querySelector('#bb_new_tl_location')?.value?.trim() || '',
                impact: formEl.querySelector('#bb_new_tl_impact')?.value?.trim() || '',
                memoryTier: 'stable',
            });
            formEl.style.display = 'none';
            // 刷新时间线面板
            const timeline = await getTimeline(chatId);
            const panels = win.querySelector('.bb-assistant-panels');
            if (panels) panels.querySelector('[data-panel="timeline"]').innerHTML = buildTimelineBrowseHTML(timeline);
            if (win.querySelector('.bb-assistant-tab[data-tab="timeline"] .bb-tab-count')) {
                win.querySelector('.bb-assistant-tab[data-tab="timeline"] .bb-tab-count').textContent = timeline.length;
            }
            // v7.9.0 重新绑定浏览事件（避免递归累积）
            bindBrowseEvents(win, chatId);
        });
        // 取消
        formEl.querySelector('#bb_new_tl_cancel')?.addEventListener('click', () => {
            formEl.style.display = 'none';
        });
    });

    // Delete buttons
    win.querySelectorAll('.bb-item-btn.delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const item = btn.closest('.bb-browse-item');
            const id = item.dataset.id;
            const panelName = getPanelName(item);
            const removeFn = { npc: removeNpcProfile, items: removeItem, timeline: removeTimelineEntry, memories: removeMemory }[panelName];
            if (removeFn && confirm('确定删除？')) {
                await removeFn(chatId, id);
                item.remove();
            }
        });
    });

    // Toggle active (timeline)
    win.querySelectorAll('.bb-item-btn.toggle-active').forEach(btn => {
        btn.addEventListener('click', async () => {
            const item = btn.closest('.bb-browse-item');
            const id = item.dataset.id;
            const timeline = await getTimeline(chatId);
            const entry = timeline.find(t => t.id === id);
            if (entry) {
                await updateTimelineEntry(chatId, id, {
                    isActive: !entry.isActive,
                    status: entry.isActive ? 'ended' : 'ongoing',
                });
                btn.textContent = entry.isActive ? '恢复' : '结束';
            }
        });
    });
}

function getPanelName(item) {
    if (item.classList.contains('npc-item')) return 'npc';
    if (item.classList.contains('item-item')) return 'items';
    if (item.classList.contains('tl-item')) return 'timeline';
    if (item.classList.contains('mem-item')) return 'memories';
    return 'memories';
}

function sortTimeline(win, mode) {
    const list = win.querySelector('#bb_timeline_list');
    if (!list) return;
    const items = [...list.querySelectorAll('.bb-browse-item')];
    items.sort((a, b) => {
        const getVal = (el) => el.querySelector('.bb-time-badge')?.textContent || '';
        if (mode === 'story_asc') return getVal(a).localeCompare(getVal(b));
        if (mode === 'story_desc') return getVal(b).localeCompare(getVal(a));
        return 0;
    });
    items.forEach(item => list.appendChild(item));
}

function sortMemories(win, mode) {
    const list = win.querySelector('#bb_mem_list');
    if (!list) return;
    const items = [...list.querySelectorAll('.bb-browse-item')];
    items.sort((a, b) => {
        if (mode === 'importance_desc') {
            const ia = parseFloat(a.querySelector('.bb-imp-badge')?.textContent?.replace('重要度:', '')?.replace('%', '') || '0');
            const ib = parseFloat(b.querySelector('.bb-imp-badge')?.textContent?.replace('重要度:', '')?.replace('%', '') || '0');
            return ib - ia;
        }
        return 0;
    });
    items.forEach(item => list.appendChild(item));
}

// ═══════════════════════════════════════════════════════════
//  Tab 切换
// ═══════════════════════════════════════════════════════════

function switchTab(win, tabName) {
    win.querySelectorAll('.bb-assistant-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    win.querySelectorAll('.bb-assistant-panel').forEach(p => {
        p.style.display = p.dataset.panel === tabName ? 'block' : 'none';
    });
    currentTab = tabName;
}

// ═══════════════════════════════════════════════════════════
//  拖拽
// ═══════════════════════════════════════════════════════════

function initDrag(win) {
    const handle = win.querySelector('#bb_assistant_drag_handle');
    if (!handle) return;
    let isDragging = false, startX, startY, origLeft, origTop;

    handle.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        origLeft = parseInt(win.style.left || win.offsetLeft || 0);
        origTop = parseInt(win.style.top || win.offsetTop || 0);
        win.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        win.style.left = (origLeft + e.clientX - startX) + 'px';
        win.style.top = (origTop + e.clientY - startY) + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) { isDragging = false; win.style.cursor = ''; }
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
}
