/**
 * map-view.js —— BB-Memory v8.7.1 地图视图面板
 *
 * 文字列表视图：地点卡片 + 连线箭头 + 物品列表 + 层级显示。
 * 可视化表单（非prompt）、单向/双向路径、全局现实参考。
 */

import {
    getMap, getLocations, addLocation, updateLocation, removeLocation,
    addEdge, addBidirectionalEdge, removeEdge, getRegions,
} from './map-store.js';
import { getItems, addItem, getSettings, updateSettings } from './memory-store.js';

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}
function showToast(msg, type) {
    try { const ctx = window.SillyTavern?.getContext?.(); if (ctx?.toastr?.[type || 'info']) ctx.toastr[type || 'info'](msg); } catch {}
}
function getChatId() {
    try { const ctx = window.SillyTavern?.getContext?.(); return ctx?.chatId || ''; } catch { return ''; }
}

const REGION_COLORS = ['#64b5f6','#81c784','#ffb74d','#ce93d8','#ef5350','#4fc3f7','#aed581','#ff8a65','#ba68c8'];
function getRegionColor(region) {
    if (!region) return '#888';
    let hash = 0; for (let i = 0; i < region.length; i++) hash = ((hash << 5) - hash) + region.charCodeAt(i);
    return REGION_COLORS[Math.abs(hash) % REGION_COLORS.length];
}

// ═══════════════════════════════════════════════════════════
//  渲染
// ═══════════════════════════════════════════════════════════

function buildMapBodyHTML(map, locations, items, activeRegion) {
    if (locations.length === 0) {
        return `<div style="text-align:center;padding:48px 20px;opacity:0.5;">
            <i class="fa-solid fa-map" style="font-size:2.5em;display:block;margin-bottom:16px;opacity:0.2;"></i>
            <div style="font-size:0.95em;">还没有地图地点</div></div>`;
    }
    const filtered = activeRegion ? locations.filter(l => l.region === activeRegion) : locations;
    if (filtered.length === 0) return '<div style="text-align:center;padding:40px;opacity:0.5;">该区域暂无地点</div>';

    const locMap = {}; for (const l of locations) locMap[l.id] = l;
    // 只渲染顶层地点，子地点跟随父地点显示
    const topLevel = filtered.filter(l => !l.parentId || !locMap[l.parentId]);

    let html = '';
    for (const loc of topLevel) {
        html += renderLocationCard(loc, locMap, locations, items, 0);
    }
    return html;
}

function renderLocationCard(loc, locMap, allLocs, items, depth) {
    const rc = getRegionColor(loc.region);
    const inEdges = allLocs.filter(l2 => (l2.edges || []).some(e => e.toId === loc.id)).length;
    const outEdges = (loc.edges || []).length;
    const children = allLocs.filter(l => l.parentId === loc.id);
    const locItems = items.filter(i => !i.archived && i.location === loc.name);
    const indent = depth * 16;

    let html = `<div class="bb-map-location-card" style="margin-bottom:8px;margin-left:${indent}px;background:var(--SmartThemeBlurTintColor,rgba(255,255,255,0.015));border:1px solid var(--SmartThemeBorderColor,#3a3a4a);border-left:4px solid ${rc};border-radius:6px;overflow:hidden;">
        <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;">
            ${depth > 0 ? '<span style="font-size:0.6em;opacity:0.3;">└</span>' : ''}
            <span style="background:${rc}22;border-radius:3px;padding:1px 6px;font-size:0.65em;color:${rc};">${loc.region ? escapeHtml(loc.region) : '未分区'}</span>
            <span style="flex:1;font-size:0.9em;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(loc.name)}</span>
            ${(inEdges > 0 || outEdges > 0) ? `<span style="font-size:0.65em;opacity:0.35;">${inEdges > 0 ? '←'+inEdges : ''}${inEdges>0&&outEdges>0?' ':''}${outEdges > 0 ? outEdges+'→' : ''}</span>` : ''}
            ${children.length > 0 ? `<span style="font-size:0.65em;opacity:0.35;">+${children.length}子</span>` : ''}
            <button class="bb-map-loc-menu menu_button" data-loc-id="${loc.id}" style="font-size:0.7em;padding:1px 4px;opacity:0.3;">···</button>
        </div>
        ${loc.description ? `<div style="padding:0 12px;font-size:0.76em;opacity:0.55;">${escapeHtml(loc.description).slice(0, 120)}</div>` : ''}
        ${loc.realWorldRef ? `<div style="padding:0 12px 4px;font-size:0.65em;opacity:0.3;">🌍 ${escapeHtml(loc.realWorldRef)}</div>` : ''}
        <div class="bb-map-loc-actions" data-loc-id="${loc.id}" style="display:none;padding:4px 12px 8px;gap:4px;font-size:0.7em;border-top:1px solid var(--SmartThemeBorderColor,#3a3a4a22);flex-wrap:wrap;">
            <button class="bb-map-loc-edit menu_button" data-loc-id="${loc.id}" style="font-size:0.85em;padding:2px 8px;">✏️ 编辑</button>
            <button class="bb-map-loc-connect menu_button" data-loc-id="${loc.id}" style="font-size:0.85em;padding:2px 8px;">🔗 连线</button>
            <button class="bb-map-loc-additem menu_button" data-loc-id="${loc.id}" data-loc-name="${escapeHtml(loc.name)}" style="font-size:0.85em;padding:2px 8px;">📦 添加物品</button>
            <button class="bb-map-loc-addchild menu_button" data-loc-id="${loc.id}" style="font-size:0.85em;padding:2px 8px;">📍 子地点</button>
            <button class="bb-map-loc-del menu_button" data-loc-id="${loc.id}" style="font-size:0.85em;padding:2px 8px;color:#f44336;">🗑 删除</button>
        </div>`;

    // 出边
    if (outEdges > 0) {
        html += `<div style="padding:0 12px 8px;margin-left:12px;">`;
        for (const edge of (loc.edges || [])) {
            const target = locMap[edge.toId];
            const targetName = target ? target.name : edge.toId;
            const isOneWay = !(target && (target.edges || []).some(e => e.toId === loc.id));
            const arrow = isOneWay ? '→' : '↔';
            html += `<div style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:0.75em;">
                <span style="color:${rc};font-size:0.8em;">${arrow}</span>
                <strong>${escapeHtml(targetName)}</strong>
                <span style="font-size:0.7em;opacity:0.5;">${escapeHtml(edge.distance)} ${escapeHtml(edge.pathType)}</span>
                ${isOneWay ? '<span style="font-size:0.6em;opacity:0.4;">单向</span>' : ''}
                <button class="bb-map-edge-del menu_button" data-from="${loc.id}" data-to="${edge.toId}" style="font-size:0.55em;padding:0 2px;opacity:0.2;margin-left:auto;">✕</button>
            </div>`;
        }
        html += `</div>`;
    }

    // 物品
    if (locItems.length > 0) {
        html += `<div style="padding:0 12px 6px;margin-left:12px;font-size:0.72em;opacity:0.5;">📦 ${locItems.map(i => escapeHtml(i.name)).join('、')}</div>`;
    }

    html += `</div>`;

    // 子地点（递归）
    for (const child of children) {
        html += renderLocationCard(child, locMap, allLocs, items, depth + 1);
    }
    return html;
}

// ═══════════════════════════════════════════════════════════
//  表单弹窗
// ═══════════════════════════════════════════════════════════

function showLocationForm(title, defaults, onSave) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const form = document.createElement('div');
    form.style.cssText = 'background:var(--SmartThemeChatTintColor,#1e1e2e);color:var(--SmartThemeBodyColor,#e0e0e0);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:12px;padding:20px 24px;width:min(480px,92vw);max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

    const d = defaults || {};
    form.innerHTML = `
        <div style="font-weight:bold;margin-bottom:14px;font-size:1.05em;">${escapeHtml(title)}</div>
        <label style="font-size:0.85em;">名称 <span style="color:#f44336;">*</span></label>
        <input id="bb_map_f_name" class="bb-input" value="${escapeHtml(d.name || '')}" style="width:100%;margin-bottom:10px;box-sizing:border-box;" placeholder="地点名称" />
        <label style="font-size:0.85em;">描述</label>
        <textarea id="bb_map_f_desc" class="bb-input" rows="3" style="width:100%;margin-bottom:10px;box-sizing:border-box;resize:vertical;" placeholder="地点描述">${escapeHtml(d.description || '')}</textarea>
        <div style="display:flex;gap:8px;">
            <div style="flex:1;"><label style="font-size:0.85em;">区域</label><input id="bb_map_f_region" class="bb-input" value="${escapeHtml(d.region || '')}" style="width:100%;margin-bottom:10px;box-sizing:border-box;" placeholder="如：中原" /></div>
            <div style="flex:1;"><label style="font-size:0.85em;">父地点</label><select id="bb_map_f_parent" class="bb-input" style="width:100%;margin-bottom:10px;"><option value="">(无)</option></select></div>
        </div>
        <label style="font-size:0.85em;">现实参考（覆盖全局设定）</label>
        <input id="bb_map_f_ref" class="bb-input" value="${escapeHtml(d.realWorldRef || '')}" style="width:100%;margin-bottom:14px;box-sizing:border-box;" placeholder="留空则使用全局设定" />
        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="bb_map_f_cancel" class="menu_button" style="opacity:0.6;">取消</button>
            <button id="bb_map_f_save" class="menu_button" style="background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;">保存</button>
        </div>`;
    overlay.appendChild(form);
    document.body.appendChild(overlay);

    // 填充父地点选项
    getLocations(getChatId()).then(locs => {
        const sel = form.querySelector('#bb_map_f_parent');
        if (!sel) return;
        for (const l of locs) {
            if (l.id !== d.id) sel.innerHTML += `<option value="${l.id}" ${d.parentId === l.id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`;
        }
    });

    const nameInput = form.querySelector('#bb_map_f_name');
    form.querySelector('#bb_map_f_save').addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (!name) { showToast('请输入名称', 'warning'); return; }
        overlay.remove();
        onSave({
            name,
            description: form.querySelector('#bb_map_f_desc').value.trim(),
            region: form.querySelector('#bb_map_f_region').value.trim(),
            parentId: form.querySelector('#bb_map_f_parent').value || null,
            realWorldRef: form.querySelector('#bb_map_f_ref').value.trim(),
        });
    });
    form.querySelector('#bb_map_f_cancel').addEventListener('click', () => overlay.remove());
    setTimeout(() => nameInput.focus(), 100);
}

function showConnectionForm(fromName, locations, onSave) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const form = document.createElement('div');
    form.style.cssText = 'background:var(--SmartThemeChatTintColor,#1e1e2e);color:var(--SmartThemeBodyColor,#e0e0e0);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:12px;padding:20px 24px;width:min(420px,92vw);box-shadow:0 8px 32px rgba(0,0,0,0.5);';

    form.innerHTML = `
        <div style="font-weight:bold;margin-bottom:14px;">🔗 从「${escapeHtml(fromName)}」连线到...</div>
        <label style="font-size:0.85em;">目标地点</label>
        <select id="bb_map_c_target" class="bb-input" style="width:100%;margin-bottom:10px;">
            ${locations.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}
        </select>
        <div style="display:flex;gap:8px;">
            <div style="flex:1;"><label style="font-size:0.85em;">距离</label><input id="bb_map_c_dist" class="bb-input" placeholder="如：半日路程" style="width:100%;margin-bottom:10px;box-sizing:border-box;" /></div>
            <div style="flex:1;"><label style="font-size:0.85em;">路径类型</label><input id="bb_map_c_type" class="bb-input" placeholder="如：大路" style="width:100%;margin-bottom:10px;box-sizing:border-box;" /></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;">
            <div style="flex:1;"><label style="font-size:0.85em;">难度</label><select id="bb_map_c_diff" class="bb-input" style="width:100%;"><option value="normal" selected>普通</option><option value="easy">容易</option><option value="hard">困难</option></select></div>
            <div style="flex:1;display:flex;align-items:flex-end;padding-bottom:2px;"><label style="font-size:0.85em;display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" id="bb_map_c_oneway" /> 单向通行</label></div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="bb_map_c_cancel" class="menu_button" style="opacity:0.6;">取消</button>
            <button id="bb_map_c_save" class="menu_button" style="background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;">创建连线</button>
        </div>`;
    overlay.appendChild(form);
    document.body.appendChild(overlay);

    form.querySelector('#bb_map_c_save').addEventListener('click', () => {
        const targetId = form.querySelector('#bb_map_c_target').value;
        const dist = form.querySelector('#bb_map_c_dist').value.trim();
        const pathType = form.querySelector('#bb_map_c_type').value.trim();
        const diff = form.querySelector('#bb_map_c_diff').value;
        const oneWay = form.querySelector('#bb_map_c_oneway').checked;
        overlay.remove();
        onSave({ targetId, distance: dist, pathType, difficulty: diff, oneWay });
    });
    form.querySelector('#bb_map_c_cancel').addEventListener('click', () => overlay.remove());
}

function showQuickItemForm(locationName, onSave) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const form = document.createElement('div');
    form.style.cssText = 'background:var(--SmartThemeChatTintColor,#1e1e2e);color:var(--SmartThemeBodyColor,#e0e0e0);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:12px;padding:20px 24px;width:min(400px,92vw);box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    form.innerHTML = `
        <div style="font-weight:bold;margin-bottom:14px;">📦 在「${escapeHtml(locationName)}」添加物品</div>
        <label style="font-size:0.85em;">物品名称 <span style="color:#f44336;">*</span></label>
        <input id="bb_map_qi_name" class="bb-input" style="width:100%;margin-bottom:10px;box-sizing:border-box;" placeholder="物品名称" />
        <label style="font-size:0.85em;">持有者</label>
        <input id="bb_map_qi_owner" class="bb-input" style="width:100%;margin-bottom:10px;box-sizing:border-box;" placeholder="当前持有者" />
        <label style="font-size:0.85em;">重要性</label>
        <input id="bb_map_qi_sig" class="bb-input" style="width:100%;margin-bottom:14px;box-sizing:border-box;" placeholder="对剧情的重要性" />
        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="bb_map_qi_cancel" class="menu_button" style="opacity:0.6;">取消</button>
            <button id="bb_map_qi_save" class="menu_button" style="background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;">添加</button>
        </div>`;
    overlay.appendChild(form);
    document.body.appendChild(overlay);

    form.querySelector('#bb_map_qi_save').addEventListener('click', () => {
        const name = form.querySelector('#bb_map_qi_name').value.trim();
        if (!name) { showToast('请输入物品名称', 'warning'); return; }
        overlay.remove();
        onSave({
            name,
            owner: form.querySelector('#bb_map_qi_owner').value.trim(),
            significance: form.querySelector('#bb_map_qi_sig').value.trim(),
            location: locationName,
        });
    });
    form.querySelector('#bb_map_qi_cancel').addEventListener('click', () => overlay.remove());
}

// ═══════════════════════════════════════════════════════════
//  主面板
// ═══════════════════════════════════════════════════════════

export async function openMapView(chatId) {
    const existing = document.querySelector('.bb-map-overlay');
    if (existing) existing.remove();

    const settings = getSettings();
    let map = await getMap(chatId);
    let items = await getItems(chatId);
    let regions = await getRegions(chatId);
    let activeRegion = '';
    let globalRef = settings.worldRealWorldRef || '';

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
        <div style="flex:1;"><strong>世界地图</strong><span class="bb-map-count" style="font-size:0.78em;opacity:0.5;margin-left:6px;"></span></div>
        <select class="bb-map-region-filter bb-input" style="width:auto;font-size:0.75em;padding:2px 6px;">
            <option value="">全部区域</option>${regions.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}</select>
        <button class="bb-map-close-btn" style="background:none;border:none;color:inherit;font-size:22px;cursor:pointer;opacity:0.6;line-height:1;padding:0 4px;">&times;</button>`;
    header.querySelector('.bb-map-close-btn').addEventListener('click', () => overlay.remove());
    panel.appendChild(header);

    // 全局现实参考栏
    const refBar = document.createElement('div');
    refBar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 18px;font-size:0.75em;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;';
    renderRefBar();
    panel.appendChild(refBar);

    function renderRefBar() {
        refBar.innerHTML = globalRef
            ? `<span style="opacity:0.5;">🌍 全局现实参考:</span><strong>${escapeHtml(globalRef)}</strong>
               <button class="bb-map-edit-ref menu_button" style="font-size:0.7em;padding:1px 5px;margin-left:auto;">编辑</button>`
            : `<span style="opacity:0.4;">🌍 未设置全局现实参考</span>
               <button class="bb-map-edit-ref menu_button" style="font-size:0.7em;padding:1px 5px;margin-left:auto;">设置</button>`;
        refBar.querySelector('.bb-map-edit-ref')?.addEventListener('click', () => {
            const val = prompt('全局现实参考（如"中世纪欧洲"、"江户时代京都"）：\n\nAI提取和注入时会参考此设定来保持地理一致性。', globalRef);
            if (val === null) return;
            globalRef = val.trim();
            updateSettings({ worldRealWorldRef: globalRef });
            renderRefBar();
            showToast(globalRef ? '全局现实参考已更新' : '全局现实参考已清除', 'success');
        });
    }

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

    async function refresh() {
        const locs = Object.values(map.locations || {});
        body.innerHTML = buildMapBodyHTML(map, locs, items, activeRegion);
        const edges = locs.reduce((s, l) => s + (l.edges || []).length, 0);
        const countEl = panel.querySelector('.bb-map-count');
        if (countEl) countEl.textContent = locs.length + ' 地点 · ' + edges + ' 连接';
        bindBodyEvents();
    }

    function bindBodyEvents() {
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
                showLocationForm('编辑地点', loc, async (data) => {
                    await updateLocation(chatId, id, data);
                    map = await getMap(chatId); items = await getItems(chatId);
                    refresh();
                });
            });
        });

        // 连线
        body.querySelectorAll('.bb-map-loc-connect').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const fromId = btn.dataset.locId;
                const loc = map.locations[fromId];
                if (!loc) return;
                const otherLocs = Object.values(map.locations || {}).filter(l => l.id !== fromId);
                if (otherLocs.length === 0) { showToast('没有其他地点可连接', 'warning'); return; }
                showConnectionForm(loc.name, otherLocs, async (data) => {
                    if (data.oneWay) {
                        await addEdge(chatId, fromId, { toId: data.targetId, distance: data.distance, pathType: data.pathType, difficulty: data.difficulty });
                    } else {
                        await addBidirectionalEdge(chatId, fromId, data.targetId, { distance: data.distance, pathType: data.pathType, difficulty: data.difficulty });
                    }
                    map = await getMap(chatId);
                    refresh();
                    showToast('连线已创建', 'success');
                });
            });
        });

        // 添加物品到地点
        body.querySelectorAll('.bb-map-loc-additem').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const locName = btn.dataset.locName;
                showQuickItemForm(locName, async (data) => {
                    await addItem(chatId, { ...data, source: 'manual' });
                    items = await getItems(chatId);
                    refresh();
                    showToast(`物品「${data.name}」已添加到「${locName}」`, 'success');
                });
            });
        });

        // 添加子地点
        body.querySelectorAll('.bb-map-loc-addchild').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const parentId = btn.dataset.locId;
                const parent = map.locations[parentId];
                showLocationForm('添加子地点（' + (parent?.name || '') + '）', { region: parent?.region, parentId }, async (data) => {
                    await addLocation(chatId, { ...data, source: 'manual' });
                    map = await getMap(chatId);
                    refresh();
                    showToast('子地点已添加', 'success');
                });
            });
        });

        // 删除
        body.querySelectorAll('.bb-map-loc-del').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.locId;
                const loc = map.locations[id];
                const children = Object.values(map.locations || {}).filter(l => l.parentId === id);
                const warn = children.length > 0 ? '\n⚠ 该地点有' + children.length + '个子地点，将一并删除。' : '';
                if (!confirm('确定删除"' + (loc?.name || id) + '"？' + warn)) return;
                // 递归删除子地点
                const delIds = [id];
                const queue = [id];
                while (queue.length) {
                    const pid = queue.shift();
                    const subs = Object.values(map.locations || {}).filter(l => l.parentId === pid);
                    for (const s of subs) { delIds.push(s.id); queue.push(s.id); }
                }
                for (const did of delIds) await removeLocation(chatId, did);
                map = await getMap(chatId);
                refresh();
                showToast('已删除', 'success');
            });
        });

        // 删除边
        body.querySelectorAll('.bb-map-edge-del').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await removeEdge(chatId, btn.dataset.from, btn.dataset.to);
                map = await getMap(chatId);
                refresh();
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
    footer.querySelector('#bb_map_add_loc').addEventListener('click', () => {
        showLocationForm('添加地点', {}, async (data) => {
            await addLocation(chatId, { ...data, source: 'manual' });
            map = await getMap(chatId); regions = await getRegions(chatId);
            const sel = header.querySelector('.bb-map-region-filter');
            if (sel) {
                const cv = sel.value;
                sel.innerHTML = '<option value="">全部区域</option>' + regions.map(r => '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>').join('');
                sel.value = cv;
            }
            refresh();
            showToast('地点已添加', 'success');
        });
    });

    // 帮助
    footer.querySelector('#bb_map_help').addEventListener('click', () => {
        alert('世界地图使用指南\n\n1. 添加地点 — 创建世界中的地点\n2. 连线 — 在两个地点间创建路径\n3. 单向 — 勾选后只能单向通行（RP中常见）\n4. 子地点 — 为地点创建子区域\n5. 添加物品 — 直接将物品放入地点\n6. 全局现实参考 — 为整个世界观设置现实原型');
    });

    document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
    });
}
