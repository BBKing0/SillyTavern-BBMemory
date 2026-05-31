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
import { getItems, getSettings, updateSettings } from './memory-store.js';

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
    const topLevel = filtered.filter(l => !l.parentId || !locMap[l.parentId]);

    // 按区域分组
    const groups = new Map();
    for (const loc of topLevel) {
        const r = loc.region || '(未分区)';
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(loc);
    }

    let html = '';
    for (const [region, locs] of groups) {
        const rc = getRegionColor(region);
        html += `<div style="margin-bottom:16px;border:1px solid ${rc}33;border-radius:10px;overflow:hidden;">
            <div style="background:${rc}18;padding:6px 12px;font-size:0.78em;font-weight:600;color:${rc};border-bottom:1px solid ${rc}22;">${escapeHtml(region)}</div>
            <div style="padding:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;">`;

        for (const loc of locs) {
            const outEdges = (loc.edges || []).length;
            const locItems = items.filter(i => !i.archived && i.location === loc.name);

            // 地点方块
            html += `<div class="bb-map-node-box" data-loc-id="${loc.id}" style="background:var(--SmartThemeBlurTintColor,rgba(255,255,255,0.03));border:2px solid ${rc}55;border-radius:10px;padding:10px 14px;min-width:140px;max-width:220px;flex-shrink:0;position:relative;cursor:default;">
                <div style="font-weight:700;font-size:0.85em;margin-bottom:2px;">${escapeHtml(loc.name)}</div>
                ${loc.description ? `<div style="font-size:0.7em;opacity:0.55;margin-bottom:4px;line-height:1.3;">${escapeHtml(loc.description).slice(0, 60)}</div>` : ''}
                ${loc.realWorldRef ? `<div style="font-size:0.6em;opacity:0.3;">🌍${escapeHtml(loc.realWorldRef).slice(0, 20)}</div>` : ''}`;

            // 物品标签
            if (locItems.length > 0) {
                html += `<div style="margin-top:4px;font-size:0.65em;opacity:0.45;">📦${locItems.map(i => escapeHtml(i.name)).join(' ')}</div>`;
            }

            // 操作按钮
            html += `<div style="margin-top:6px;display:flex;gap:3px;font-size:0.6em;opacity:0;">
                <button class="bb-map-box-edit menu_button" data-loc-id="${loc.id}" style="font-size:inherit;padding:1px 5px;">✏️</button>
                <button class="bb-map-box-connect menu_button" data-loc-id="${loc.id}" style="font-size:inherit;padding:1px 5px;">🔗</button>
                <button class="bb-map-box-additem menu_button" data-loc-id="${loc.id}" data-loc-name="${escapeHtml(loc.name)}" style="font-size:inherit;padding:1px 5px;">📦</button>
                <button class="bb-map-box-del menu_button" data-loc-id="${loc.id}" style="font-size:inherit;padding:1px 5px;color:#f44336;">🗑</button>
            </div></div>`;

            // 连线箭头（在方块后显示）
            if (outEdges > 0) {
                for (const edge of (loc.edges || [])) {
                    const target = locMap[edge.toId];
                    if (!target) continue;
                    const isOneWay = !(target.edges || []).some(e => e.toId === loc.id);
                    const arrowHTML = isOneWay
                        ? `<span style="font-size:0.68em;color:#ff9800;font-weight:700;">────→</span>`
                        : `<span style="font-size:0.68em;color:#4fc3f7;font-weight:700;">←───→</span>`;
                    html += `<div style="display:flex;flex-direction:column;align-items:center;gap:1px;flex-shrink:0;align-self:center;">
                        <span style="font-size:0.6em;opacity:0.5;white-space:nowrap;">${escapeHtml(edge.distance)} ${escapeHtml(edge.pathType)}</span>
                        ${arrowHTML}
                    </div>`;

                    // 目标地点方块
                    const tItems = items.filter(i => !i.archived && i.location === target.name);
                    html += `<div class="bb-map-node-box" data-loc-id="${target.id}" style="background:var(--SmartThemeBlurTintColor,rgba(255,255,255,0.03));border:2px solid ${getRegionColor(target.region)}55;border-radius:10px;padding:10px 14px;min-width:140px;max-width:220px;flex-shrink:0;">
                        <div style="font-weight:700;font-size:0.85em;margin-bottom:2px;">${escapeHtml(target.name)}</div>
                        ${target.description ? `<div style="font-size:0.7em;opacity:0.55;margin-bottom:4px;line-height:1.3;">${escapeHtml(target.description).slice(0, 60)}</div>` : ''}
                        ${tItems.length > 0 ? `<div style="margin-top:4px;font-size:0.65em;opacity:0.45;">📦${tItems.map(i => escapeHtml(i.name)).join(' ')}</div>` : ''}
                    </div>`;
                }
            }
        }

        html += `</div></div>`;
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

function showItemPicker(locationName, items, onSave) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const unplacedItems = items.filter(i => !i.archived && i.location !== locationName);
    const alreadyPlaced = items.filter(i => !i.archived && i.location === locationName);

    const form = document.createElement('div');
    form.style.cssText = 'background:var(--SmartThemeChatTintColor,#1e1e2e);color:var(--SmartThemeBodyColor,#e0e0e0);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:12px;padding:20px 24px;width:min(480px,92vw);max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

    const placedHTML = alreadyPlaced.length > 0
        ? `<div style="font-size:0.78em;opacity:0.5;margin-bottom:10px;">已在「${escapeHtml(locationName)}」: ${alreadyPlaced.map(i => escapeHtml(i.name)).join('、')}</div>`
        : '';

    form.innerHTML = `
        <div style="font-weight:bold;margin-bottom:6px;">📦 为「${escapeHtml(locationName)}」选择物品</div>
        ${placedHTML}
        <div style="flex:1;overflow-y:auto;max-height:50vh;margin-bottom:12px;">
            ${unplacedItems.length === 0
                ? '<div style="opacity:0.4;text-align:center;padding:20px;">所有物品已放置在此地点</div>'
                : unplacedItems.map(i => `<label style="display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;border-bottom:1px solid var(--SmartThemeBorderColor,#3333);font-size:0.85em;">
                    <input type="checkbox" class="bb-map-item-cb" data-id="${i.id}" />
                    <span style="flex:1;">${escapeHtml(i.name)}</span>
                    <span style="font-size:0.7em;opacity:0.4;">${i.location ? '📍' + escapeHtml(i.location) : ''}</span>
                </label>`).join('')}
        </div>
        <div style="font-size:0.7em;opacity:0.4;margin-bottom:8px;">勾选物品后点击"放置"，物品将移动到「${escapeHtml(locationName)}」</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="bb_map_pi_cancel" class="menu_button" style="opacity:0.6;">取消</button>
            <button id="bb_map_pi_save" class="menu_button" style="background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;">放置选中</button>
        </div>`;
    overlay.appendChild(form);
    document.body.appendChild(overlay);

    form.querySelector('#bb_map_pi_save').addEventListener('click', () => {
        const checked = form.querySelectorAll('.bb-map-item-cb:checked');
        const ids = [...checked].map(cb => cb.dataset.id);
        overlay.remove();
        if (ids.length > 0) onSave(ids);
    });
    form.querySelector('#bb_map_pi_cancel').addEventListener('click', () => overlay.remove());
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
        // hover显示操作按钮
        body.querySelectorAll('.bb-map-node-box').forEach(box => {
            box.addEventListener('mouseenter', () => {
                const btns = box.querySelector('div:last-child');
                if (btns) btns.style.opacity = '1';
            });
            box.addEventListener('mouseleave', () => {
                const btns = box.querySelector('div:last-child');
                if (btns) btns.style.opacity = '0';
            });
        });

        // 编辑
        body.querySelectorAll('.bb-map-box-edit').forEach(btn => {
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
        body.querySelectorAll('.bb-map-box-connect').forEach(btn => {
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
        body.querySelectorAll('.bb-map-box-additem').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const locName = btn.dataset.locName;
                const { updateItem } = await import('./memory-store.js');
                showItemPicker(locName, items, async (selectedIds) => {
                    for (const id of selectedIds) {
                        await updateItem(chatId, id, { location: locName });
                    }
                    items = await getItems(chatId);
                    refresh();
                    showToast(`${selectedIds.length}个物品已放置到「${locName}」`, 'success');
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
        body.querySelectorAll('.bb-map-box-del').forEach(btn => {
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
