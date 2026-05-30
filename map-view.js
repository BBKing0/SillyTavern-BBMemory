/**
 * map-view.js —— BB-Memory v8.7.0 地图视图面板
 *
 * 文字列表视图：地点卡片 + 连线箭头 + 物品列表 + 现实参考。
 * 参考 clue-board.js 的面板布局模式。
 */

import {
    getMap, getLocations, addLocation, updateLocation, removeLocation,
    addBidirectionalEdge, removeEdge, getRegions, getLocationsInRegion, getMapStats,
} from './map-store.js';
import { getItems, addItem, updateItem } from './memory-store.js';

// ═══════════════════════════════════════════════════════════
//  工具
// ═══════════════════════════════════════════════════════════

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function showToast(msg, type) {
    try {
        const ctx = window.SillyTavern?.getContext?.();
        if (ctx?.toastr?.[type || 'info']) ctx.toastr[type || 'info'](msg);
    } catch { /* ignore */ }
}

function getChatId() {
    try { const ctx = window.SillyTavern?.getContext?.(); return ctx?.chatId || ''; }
    catch { return ''; }
}

// ═══════════════════════════════════════════════════════════
//  渲染
// ═══════════════════════════════════════════════════════════

const REGION_COLORS = [
    '#64b5f6', '#81c784', '#ffb74d', '#ce93d8', '#ef5350',
    '#4fc3f7', '#aed581', '#ff8a65', '#ba68c8', '#e57373',
];

function getRegionColor(region, index) {
    if (!region) return '#888';
    let hash = 0;
    for (let i = 0; i < region.length; i++) hash = ((hash << 5) - hash) + region.charCodeAt(i);
    return REGION_COLORS[Math.abs(hash) % REGION_COLORS.length];
}

function buildMapBodyHTML(map, locations, items, activeRegion) {
    if (locations.length === 0) {
        return `<div style="text-align:center;padding:48px 20px;opacity:0.5;">
            <i class="fa-solid fa-map" style="font-size:2.5em;display:block;margin-bottom:16px;opacity:0.2;"></i>
            <div style="font-size:0.95em;">还没有地图地点</div>
            <div style="font-size:0.78em;margin-top:6px;">点击下方"添加地点"创建第一个地点</div>
        </div>`;
    }

    const filtered = activeRegion ? locations.filter(l => l.region === activeRegion) : locations;
    if (filtered.length === 0) {
        return `<div style="text-align:center;padding:40px;opacity:0.5;">该区域暂无地点</div>`;
    }

    const locMap = {};
    for (const l of locations) locMap[l.id] = l;

    let html = '';
    for (const loc of filtered) {
        const rc = getRegionColor(loc.region);
        const inEdges = locations.filter(l2 => (l2.edges || []).some(e => e.toId === loc.id)).length;
        const outEdges = (loc.edges || []).length;

        // 地点物品
        const locItems = items.filter(i => !i.archived && i.location === loc.name);

        html += `<div class="bb-map-location-card" style="margin-bottom:10px;background:var(--SmartThemeBlurTintColor,rgba(255,255,255,0.015));border:1px solid var(--SmartThemeBorderColor,#3a3a4a);border-left:4px solid ${rc};border-radius:6px;overflow:hidden;">
            <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;">
                <span style="background:${rc}22;border-radius:3px;padding:1px 6px;font-size:0.65em;color:${rc};flex-shrink:0;">${loc.region ? escapeHtml(loc.region) : '未分区'}</span>
                <span style="flex:1;font-size:0.9em;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(loc.name)}</span>
                ${(inEdges > 0 || outEdges > 0) ? `<span style="font-size:0.65em;opacity:0.35;">${inEdges > 0 ? '←'+inEdges : ''}${inEdges>0&&outEdges>0?' ':''}${outEdges > 0 ? outEdges+'→' : ''}</span>` : ''}
                ${loc.realWorldRef ? `<span style="font-size:0.62em;opacity:0.3;" title="现实参考: ${escapeHtml(loc.realWorldRef)}">🌍</span>` : ''}
                <button class="bb-map-loc-menu menu_button" data-loc-id="${loc.id}" style="font-size:0.7em;padding:1px 4px;opacity:0.3;">···</button>
            </div>
            ${loc.description ? `<div style="padding:0 12px;font-size:0.76em;opacity:0.55;margin-bottom:2px;">${escapeHtml(loc.description).slice(0, 120)}</div>` : ''}
            ${loc.realWorldRef ? `<div style="padding:0 12px 4px;font-size:0.65em;opacity:0.3;">🌍 现实参考: ${escapeHtml(loc.realWorldRef)}</div>` : ''}
            <div class="bb-map-loc-actions" data-loc-id="${loc.id}" style="display:none;padding:4px 12px 8px;gap:4px;font-size:0.7em;border-top:1px solid var(--SmartThemeBorderColor,#3a3a4a22);">
                <button class="bb-map-loc-edit menu_button" data-loc-id="${loc.id}" style="font-size:0.85em;padding:2px 8px;">✏️ 编辑</button>
                <button class="bb-map-loc-connect menu_button" data-loc-id="${loc.id}" style="font-size:0.85em;padding:2px 8px;">🔗 连线</button>
                <button class="bb-map-loc-del menu_button" data-loc-id="${loc.id}" style="font-size:0.85em;padding:2px 8px;color:#f44336;">🗑 删除</button>
            </div>`;

        // 出边列表
        if (outEdges > 0) {
            html += `<div style="padding:0 12px 8px;margin-left:12px;">`;
            for (const edge of (loc.edges || [])) {
                const target = locMap[edge.toId];
                const targetName = target ? target.name : edge.toId;
                const diffLabels = { easy: '容易', normal: '普通', hard: '困难' };
                html += `<div style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:0.75em;">
                    <span style="color:${rc};font-size:0.8em;">→</span>
                    <strong>${escapeHtml(targetName)}</strong>
                    <span style="font-size:0.7em;opacity:0.5;">${escapeHtml(edge.distance)} ${escapeHtml(edge.pathType)} ${diffLabels[edge.difficulty] || ''}</span>
                    <button class="bb-map-edge-del menu_button" data-from="${loc.id}" data-to="${edge.toId}" style="font-size:0.55em;padding:0 2px;opacity:0.2;margin-left:auto;">✕</button>
                </div>`;
            }
            html += `</div>`;
        }

        // 物品列表
        if (locItems.length > 0) {
            html += `<div style="padding:0 12px 6px;margin-left:12px;font-size:0.72em;opacity:0.5;">`;
            html += `<span>📦 物品: </span>`;
            html += locItems.map(i => `<span style="margin-right:6px;">${escapeHtml(i.name)}</span>`).join('');
            html += `</div>`;
        }

        html += `</div>`;
    }
    return html;
}

// ═══════════════════════════════════════════════════════════
//  面板
// ═══════════════════════════════════════════════════════════

export async function openMapView(chatId) {
    const existing = document.querySelector('.bb-map-overlay');
    if (existing) existing.remove();

    const map = await getMap(chatId);
    const locations = Object.values(map.locations || {});
    const items = await getItems(chatId);
    const regions = await getRegions(chatId);
    let activeRegion = '';

    const overlay = document.createElement('div');
    overlay.className = 'bb-map-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99991;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const panel = document.createElement('div');
    panel.className = 'bb-map-panel';
    panel.style.cssText = 'background:var(--SmartThemeChatTintColor,#1e1e2e);color:var(--SmartThemeBodyColor,#e0e0e0);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:14px;width:min(640px,94vw);max-height:85vh;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,0.5);';
    overlay.appendChild(panel);

    // 头部
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;';
    header.innerHTML = `
        <i class="fa-solid fa-map" style="color:#4fc3f7;"></i>
        <div style="flex:1;"><strong>世界地图</strong>
            <span class="bb-map-count" style="font-size:0.78em;opacity:0.5;margin-left:6px;"></span>
        </div>
        <select class="bb-map-region-filter bb-input" style="width:auto;font-size:0.75em;padding:2px 6px;">
            <option value="">全部区域</option>
            ${regions.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}
        </select>
        <button class="bb-map-close-btn" style="background:none;border:none;color:inherit;font-size:22px;cursor:pointer;opacity:0.6;line-height:1;padding:0 4px;">&times;</button>`;
    header.querySelector('.bb-map-close-btn').addEventListener('click', () => overlay.remove());
    panel.appendChild(header);

    // 主体
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 18px;min-height:0;';
    panel.appendChild(body);

    // 底部
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;padding:10px 18px;border-top:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;flex-wrap:wrap;';
    footer.innerHTML = `
        <button class="menu_button" id="bb_map_add_loc" style="font-size:0.85em;"><i class="fa-solid fa-plus"></i> 添加地点</button>
        <button class="menu_button" id="bb_map_help" style="font-size:0.85em;opacity:0.6;margin-left:auto;"><i class="fa-solid fa-question"></i> 帮助</button>`;
    panel.appendChild(footer);
    document.body.appendChild(overlay);

    // 渲染函数
    function refresh() {
        body.innerHTML = buildMapBodyHTML(map, Object.values(map.locations || {}), items, activeRegion);
        const stats = { locations: Object.keys(map.locations || {}).length, edges: 0 };
        for (const l of Object.values(map.locations || {})) stats.edges += (l.edges || []).length;
        const countEl = panel.querySelector('.bb-map-count');
        if (countEl) countEl.textContent = stats.locations + ' 地点 · ' + stats.edges + ' 连接';
        bindBodyEvents();
    }

    function bindBodyEvents() {
        // 地点菜单
        body.querySelectorAll('.bb-map-loc-menu').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const actions = body.querySelector('.bb-map-loc-actions[data-loc-id="' + btn.dataset.locId + '"]');
                if (actions) actions.style.display = actions.style.display === 'none' ? 'flex' : 'none';
            });
        });
        // 编辑
        body.querySelectorAll('.bb-map-loc-edit').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.locId;
                const loc = map.locations[id];
                if (!loc) return;
                const name = prompt('地点名称：', loc.name || '');
                if (name === null) return;
                const desc = prompt('描述：', loc.description || '');
                if (desc === null) return;
                const ref = prompt('现实参考（如"中世纪巴黎"）：', loc.realWorldRef || '');
                if (ref === null) return;
                const region = prompt('区域：', loc.region || '');
                if (region === null) return;
                await updateLocation(chatId, id, { name: name.trim(), description: desc.trim(), realWorldRef: ref.trim(), region: region.trim() });
                const newMap = await getMap(chatId);
                Object.assign(map, newMap);
                refresh();
                showToast('地点已更新', 'success');
            });
        });
        // 连线
        body.querySelectorAll('.bb-map-loc-connect').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const fromId = btn.dataset.locId;
                const locs = Object.values(map.locations || {}).filter(l => l.id !== fromId);
                if (locs.length === 0) { showToast('没有其他地点可连接', 'warning'); return; }
                const list = locs.map((l, i) => i + ': ' + l.name).join('\n');
                const choice = prompt('选择要连接的地点（输入序号）：\n' + list, '');
                if (choice === null) return;
                const idx = parseInt(choice, 10);
                if (isNaN(idx) || idx < 0 || idx >= locs.length) return;
                const target = locs[idx];
                const dist = prompt('距离（如"半日路程"）：', '') || '';
                const pathType = prompt('路径类型（如"大路"、"山路"）：', '') || '';
                const diff = prompt('难度（easy/normal/hard）：', 'normal') || 'normal';
                await addBidirectionalEdge(chatId, fromId, target.id, { distance: dist, pathType, difficulty: diff });
                const newMap = await getMap(chatId);
                Object.assign(map, newMap);
                refresh();
                showToast('连线已创建', 'success');
            });
        });
        // 删除地点
        body.querySelectorAll('.bb-map-loc-del').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.locId;
                const loc = map.locations[id];
                if (!confirm('确定删除地点"' + (loc?.name || id) + '"及其所有连线？')) return;
                await removeLocation(chatId, id);
                const newMap = await getMap(chatId);
                Object.assign(map, newMap);
                refresh();
                showToast('地点已删除', 'success');
            });
        });
        // 删除边
        body.querySelectorAll('.bb-map-edge-del').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await removeEdge(chatId, btn.dataset.from, btn.dataset.to);
                const newMap = await getMap(chatId);
                Object.assign(map, newMap);
                refresh();
                showToast('连线已删除', 'success');
            });
        });
    }

    refresh();

    // 区域筛选
    header.querySelector('.bb-map-region-filter').addEventListener('change', function () {
        activeRegion = this.value;
        refresh();
    });

    // 添加地点
    footer.querySelector('#bb_map_add_loc').addEventListener('click', async () => {
        const name = prompt('地点名称：', '');
        if (!name || !name.trim()) return;
        const desc = prompt('描述：', '') || '';
        const ref = prompt('现实参考（如"中世纪巴黎"）：', '') || '';
        const region = prompt('区域（如"中原"）：', '') || '';
        await addLocation(chatId, { name: name.trim(), description: desc.trim(), realWorldRef: ref.trim(), region: region.trim(), source: 'manual' });
        const newMap = await getMap(chatId);
        Object.assign(map, newMap);
        // 刷新区域筛选
        const newRegions = await getRegions(chatId);
        const sel = header.querySelector('.bb-map-region-filter');
        if (sel) {
            const curVal = sel.value;
            sel.innerHTML = '<option value="">全部区域</option>' + newRegions.map(r => '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>').join('');
            sel.value = curVal;
        }
        refresh();
        showToast('地点已添加', 'success');
    });

    // 帮助
    footer.querySelector('#bb_map_help').addEventListener('click', () => {
        alert([
            '世界地图使用指南',
            '',
            '1. 【添加地点】创建世界中的地点',
            '2. 【连线】点击地点菜单中的"连线"创建路径',
            '3. 【区域】为地点设置区域便于筛选',
            '4. 【现实参考】填写现实世界中的原型地点',
            '   帮助AI理解地理关系（如"中世纪巴黎"）',
            '5. 【物品】给物品设置 location 后，',
            '   会在地图上该地点显示物品列表',
        ].join('\n'));
    });

    document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
    });
}
