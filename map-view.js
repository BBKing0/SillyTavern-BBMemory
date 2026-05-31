/**
 * map-view.js —— BB-Memory v8.8.0 地图视图
 * 双模式：2D空间视图(Canvas+CSS) + 列表视图
 * 跨区域标签页、缩放拖动、物品选择器
 */

import {
    getMap, getLocations, addLocation, updateLocation, removeLocation,
    addEdge, addBidirectionalEdge, removeEdge, getRegions, autoLayout,
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

const REGION_COLORS = ['#64b5f6','#81c784','#ffb74d','#ce93d8','#ef5350','#4fc3f7','#aed581','#ff8a65'];
function getRegionColor(region) {
    if (!region) return '#888';
    let hash = 0; for (let i = 0; i < region.length; i++) hash = ((hash << 5) - hash) + region.charCodeAt(i);
    return REGION_COLORS[Math.abs(hash) % REGION_COLORS.length];
}

// ═══════════════════════════════════════════════════════════
//  列表视图（保留原有的区域分组+流程图式）
// ═══════════════════════════════════════════════════════════

function buildListHTML(locations, items, activeRegion) {
    if (locations.length === 0) {
        return `<div style="text-align:center;padding:48px 20px;opacity:0.5;"><i class="fa-solid fa-map" style="font-size:2.5em;display:block;margin-bottom:16px;opacity:0.2;"></i><div style="font-size:0.95em;">还没有地图地点</div></div>`;
    }
    const filtered = (activeRegion ? locations.filter(l => l.region === activeRegion) : locations).filter(l => !l.archived);
    if (filtered.length === 0) return '<div style="text-align:center;padding:40px;opacity:0.5;">该区域暂无地点</div>';

    const locMap = {}; for (const l of locations) locMap[l.id] = l;
    const topLevel = filtered.filter(l => !l.parentId || !locMap[l.parentId]);
    const groups = new Map();
    for (const loc of topLevel) {
        const r = loc.region || '(未分区)';
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(loc);
    }

    let html = '';
    for (const [region, locs] of groups) {
        const rc = getRegionColor(region);
        html += `<div style="margin-bottom:12px;border:1px solid ${rc}33;border-radius:8px;overflow:hidden;">
            <div style="background:${rc}18;padding:5px 12px;font-size:0.75em;font-weight:600;color:${rc};">${escapeHtml(region)}</div>
            <div style="padding:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;">`;

        for (const loc of locs) {
            const locItems = items.filter(i => !i.archived && i.location === loc.name);
            html += `<div class="bb-map-node-box" data-loc-id="${loc.id}" style="background:var(--SmartThemeBlurTintColor,rgba(255,255,255,0.03));border:2px solid ${rc}44;border-radius:8px;padding:8px 12px;min-width:130px;max-width:200px;flex-shrink:0;">
                <div style="font-weight:700;font-size:0.82em;">${escapeHtml(loc.name)}</div>
                ${loc.description ? `<div style="font-size:0.68em;opacity:0.5;line-height:1.3;">${escapeHtml(loc.description).slice(0, 50)}</div>` : ''}
                ${locItems.length > 0 ? `<div style="margin-top:3px;font-size:0.62em;opacity:0.4;">📦${locItems.length}件</div>` : ''}
                <div class="bb-map-node-actions" style="margin-top:4px;font-size:0.55em;opacity:0;display:flex;gap:2px;">
                    <button class="bb-map-box-edit menu_button" data-loc-id="${loc.id}" style="font-size:inherit;padding:1px 4px;">✏️</button>
                    <button class="bb-map-box-connect menu_button" data-loc-id="${loc.id}" style="font-size:inherit;padding:1px 4px;">🔗</button>
                    <button class="bb-map-box-additem menu_button" data-loc-id="${loc.id}" data-loc-name="${escapeHtml(loc.name)}" style="font-size:inherit;padding:1px 4px;">📦</button>
                    <button class="bb-map-box-del menu_button" data-loc-id="${loc.id}" style="font-size:inherit;padding:1px 4px;color:#f44336;">🗑</button>
                </div></div>`;
            // 连线箭头
            for (const loc of locs) {
                for (const edge of (loc.edges || [])) {
                    const target = locMap[edge.toId];
                    if (!target || target.region === loc.region) continue; // 同区域跳过（已在方块后）
                    const crossRegion = target.region !== loc.region;
                    html += `<div style="display:flex;flex-direction:column;align-items:center;gap:1px;flex-shrink:0;align-self:center;cursor:pointer;" class="bb-map-cross-link" data-region="${escapeHtml(target.region || '')}">
                        <span style="font-size:0.55em;opacity:0.5;">${escapeHtml(edge.distance)}</span>
                        <span style="font-size:0.6em;color:#ff9800;">──🌉──</span>
                        <span style="font-size:0.55em;opacity:0.5;">${escapeHtml(target.name)}</span>
                    </div>`;
                }
            }
        }
        html += `</div></div>`;
    }
    return html;
}

// ═══════════════════════════════════════════════════════════
//  2D 空间视图（Canvas连线 + CSS卡片）
// ═══════════════════════════════════════════════════════════

function renderSpatialView(body, locations, items, activeRegion, editMode, onEdit, onConnect, onAddItem, onDelete) {
    const filtered = (activeRegion ? locations.filter(l => l.region === activeRegion) : locations).filter(l => !l.archived);
    const locMap = {}; for (const l of locations) locMap[l.id] = l;
    // 父子关系
    const children = {}; for (const l of filtered) { const pid = l.parentId || ''; if (!children[pid]) children[pid] = []; children[pid].push(l); }

    body.innerHTML = '';
    body.style.cssText = 'position:relative;overflow:hidden;min-height:400px;flex:1;';

    // Canvas连线层
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;z-index:4;pointer-events:none;';
    body.appendChild(canvas);

    // 地点卡片层
    const cardLayer = document.createElement('div');
    cardLayer.style.cssText = 'position:absolute;inset:0;z-index:2;pointer-events:none;';
    body.appendChild(cardLayer);

    // 缩放/平移状态
    let scale = 1, panX = 0, panY = 0;
    let isDragging = false, dragStartX = 0, dragStartY = 0;

    function drawCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const w = body.clientWidth;
        const h = Math.max(body.clientHeight, 400);
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        // 区域背景
        const regions = new Map();
        for (const loc of filtered) {
            const r = loc.region || '';
            if (!regions.has(r)) regions.set(r, []);
            regions.get(r).push(loc);
        }
        for (const [r, rLocs] of regions) {
            if (!r) continue;
            const minX = Math.min(...rLocs.map(l => l.x)) * w * scale + panX;
            const minY = Math.min(...rLocs.map(l => l.y)) * h * scale + panY;
            const maxX = Math.max(...rLocs.map(l => l.x)) * w * scale + panX + 120 * scale;
            const maxY = Math.max(...rLocs.map(l => l.y)) * h * scale + panY + 60 * scale;
            const rc = getRegionColor(r);
            ctx.fillStyle = rc + '08';
            ctx.strokeStyle = rc + '22';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(minX - 20, minY - 20, maxX - minX + 40, maxY - minY + 40, 12);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = rc + '66';
            ctx.font = '11px sans-serif';
            ctx.fillText(r, minX - 10, minY - 6);
        }

        // 连线
        for (const loc of filtered) {
            const fromX = loc.x * w * scale + panX + 60 * scale;
            const fromY = loc.y * h * scale + panY + 20 * scale;
            for (const edge of (loc.edges || [])) {
                const target = locMap[edge.toId];
                if (!target) continue;
                const toX = target.x * w * scale + panX + 60 * scale;
                const toY = target.y * h * scale + panY + 20 * scale;
                const crossRegion = target.region !== loc.region;
                const isOneWay = !(target.edges || []).some(e => e.toId === loc.id);

                ctx.strokeStyle = crossRegion ? '#ff980088' : '#4fc3f744';
                ctx.lineWidth = crossRegion ? 2 : 1.2;
                ctx.setLineDash(crossRegion ? [6, 4] : (isOneWay ? [] : []));
                if (isOneWay && !crossRegion) ctx.setLineDash([]);

                const midX = (fromX + toX) / 2;
                ctx.beginPath();
                ctx.moveTo(fromX, fromY);
                ctx.quadraticCurveTo(midX, fromY - 10, toX, toY);
                ctx.stroke();
                ctx.setLineDash([]);

                // 距离标签
                if (edge.distance) {
                    ctx.fillStyle = '#888';
                    ctx.font = '9px sans-serif';
                    ctx.fillText(edge.distance, midX - 10, (fromY + toY) / 2 - 4);
                }
            }
        }
    }

    function renderCards() {
        cardLayer.innerHTML = '';
        cardLayer.style.transform = `scale(${scale})`;
        cardLayer.style.transformOrigin = '0 0';
        const rendered = new Set();

        for (const loc of filtered) {
            if (rendered.has(loc.id)) continue;
            const subLocs = (children[loc.id] || []).filter(l => !l.archived);
            const locItems = items.filter(i => !i.archived && i.location === loc.name);
            const rc = getRegionColor(loc.region);

            if (subLocs.length > 0) {
                // 父地点：大容器包裹子节点
                rendered.add(loc.id);
                const minX = Math.min(loc.x, ...subLocs.map(l => l.x));
                const minY = Math.min(loc.y, ...subLocs.map(l => l.y));
                const maxX = Math.max(loc.x, ...subLocs.map(l => l.x));
                const maxY = Math.max(loc.y, ...subLocs.map(l => l.y));

                const container = document.createElement('div');
                container.style.cssText = `position:absolute;left:${minX * 100}%;top:${minY * 100}%;width:${(maxX - minX) * 100 + 16}%;height:${(maxY - minY) * 100 + 10}%;background:${rc}08;border:2px solid ${rc}44;border-radius:12px;pointer-events:none;z-index:2;`;
                // 标签
                const label = document.createElement('div');
                label.style.cssText = `position:absolute;top:-10px;left:12px;background:var(--SmartThemeChatTintColor,#1e1e2e);padding:1px 8px;border-radius:3px;font-size:0.65em;font-weight:700;color:${rc};white-space:nowrap;`;
                label.textContent = '📁 ' + loc.name;
                container.appendChild(label);
                cardLayer.appendChild(container);

                // 父地点卡片（在容器内）
                const pCard = makeCard(loc, locItems, rc, loc.x, loc.y, true);
                if (editMode) makeDraggable(pCard, loc);
                cardLayer.appendChild(pCard);
                rendered.add(loc.id);

                // 子地点卡片（在容器内，位置相对于父容器）
                for (const sub of subLocs) {
                    rendered.add(sub.id);
                    const subItems = items.filter(i => !i.archived && i.location === sub.name);
                    const src = getRegionColor(sub.region);
                    const relX = (sub.x - minX) / (maxX - minX + 0.01);
                    const relY = (sub.y - minY) / (maxY - minY + 0.01);
                    const sCard = makeCard(sub, subItems, src, relX, relY, false);
                    if (editMode) makeDraggable(sCard, sub);
                    cardLayer.appendChild(sCard);
                }
            } else if (!loc.parentId || !locMap[loc.parentId]) {
                // 无父的普通节点
                const card = makeCard(loc, locItems, rc, loc.x, loc.y, false);
                if (editMode) makeDraggable(card, loc);
                cardLayer.appendChild(card);
                rendered.add(loc.id);
            }
            // 有 parentId 的节点在上面子地点循环中已处理
        }

        function makeCard(loc, locItems, rc, posX, posY, isParent) {
            const card = document.createElement('div');
            card.className = 'bb-map-spatial-card';
            card.style.cssText = `position:absolute;left:${posX * 100}%;top:${posY * 100}%;transform:translate(-50%,-50%);background:var(--SmartThemeChatTintColor,#1e1e2e);border:${isParent ? '2.5px' : '2px'} solid ${rc}${isParent ? '88' : '66'};border-radius:${isParent ? '10px' : '8px'};padding:${isParent ? '10px 14px' : '6px 10px'};min-width:${isParent ? '110px' : '80px'};max-width:${isParent ? '180px' : '140px'};pointer-events:auto;cursor:pointer;z-index:3;box-shadow:0 2px 8px rgba(0,0,0,0.3);font-size:${isParent ? '0.8em' : '0.7em'};`;
            card.innerHTML = `
                <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:${isParent ? '0.9em' : '0.85em'};">${isParent ? '📁 ' : ''}${escapeHtml(loc.name)}</div>
                ${loc.description ? `<div style="font-size:${isParent ? '0.7em' : '0.65em'};opacity:0.5;line-height:1.2;max-height:2.4em;overflow:hidden;">${escapeHtml(loc.description).slice(0, isParent ? 70 : 40)}</div>` : ''}
                ${locItems.length > 0 ? `<div style="font-size:0.6em;opacity:0.35;">📦${locItems.length}件</div>` : ''}`;
            card.addEventListener('mouseenter', () => card.style.boxShadow = '0 4px 16px rgba(0,0,0,0.5)');
            card.addEventListener('mouseleave', () => card.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)');
            card.addEventListener('dblclick', () => onEdit(loc.id));
            bindCardMenu(card, loc);
            return card;
        }

        function makeDraggable(card, loc) {
            card.style.cursor = 'grab';
            card.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const startX = e.clientX, startY = e.clientY;
                const origX = loc.x, origY = loc.y;
                card.style.cursor = 'grabbing'; card.style.zIndex = '10';
                function onMove(ev) {
                    loc.x = Math.max(0, Math.min(1, origX + (ev.clientX - startX) / (body.clientWidth * scale)));
                    loc.y = Math.max(0, Math.min(1, origY + (ev.clientY - startY) / (body.clientHeight * scale)));
                    card.style.left = loc.x * 100 + '%';
                    card.style.top = loc.y * 100 + '%';
                    drawCanvas();
                }
                function onUp() {
                    card.style.cursor = 'grab'; card.style.zIndex = '3';
                    window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
                }
                window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
            });
        }

        function bindCardMenu(card, loc) {
            card.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const menu = document.createElement('div');
                menu.style.cssText = 'position:fixed;z-index:99999;background:var(--SmartThemeChatTintColor,#1e1e2e);border:1px solid var(--SmartThemeBorderColor,#444);border-radius:8px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
                menu.innerHTML = `
                    <button class="menu_button" style="display:block;width:100%;text-align:left;margin:1px 0;font-size:0.8em;">✏️ 编辑</button>
                    <button class="menu_button" style="display:block;width:100%;text-align:left;margin:1px 0;font-size:0.8em;">🔗 连线</button>
                    <button class="menu_button" style="display:block;width:100%;text-align:left;margin:1px 0;font-size:0.8em;">📦 物品</button>
                    <button class="menu_button" style="display:block;width:100%;text-align:left;margin:1px 0;font-size:0.8em;color:#f44336;">🗑 删除</button>`;
                menu.style.left = e.clientX + 'px';
                menu.style.top = e.clientY + 'px';
                document.body.appendChild(menu);
                menu.querySelectorAll('button')[0].addEventListener('click', () => { menu.remove(); onEdit(loc.id); });
                menu.querySelectorAll('button')[1].addEventListener('click', () => { menu.remove(); onConnect(loc.id); });
                menu.querySelectorAll('button')[2].addEventListener('click', () => { menu.remove(); onAddItem(loc.id, loc.name); });
                menu.querySelectorAll('button')[3].addEventListener('click', () => { menu.remove(); onDelete(loc.id); });
                setTimeout(() => document.addEventListener('click', function rm() { menu.remove(); document.removeEventListener('click', rm); }), 10);
            });
            cardLayer.appendChild(card);
        }
    }

    renderCards();
    setTimeout(drawCanvas, 50);

    // 拖动/缩放事件
    body.addEventListener('mousedown', (e) => {
        if (e.target === body || e.target === canvas) {
            isDragging = true; dragStartX = e.clientX; dragStartY = e.clientY;
        }
    });
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panX += (e.clientX - dragStartX);
        panY += (e.clientY - dragStartY);
        dragStartX = e.clientX; dragStartY = e.clientY;
        drawCanvas();
    });
    window.addEventListener('mouseup', () => { isDragging = false; });
    body.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        scale = Math.max(0.3, Math.min(3, scale + delta));
        cardLayer.style.transform = `scale(${scale})`;
        cardLayer.style.transformOrigin = '0 0';
        drawCanvas();
    });
    // 移动端触摸
    body.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            isDragging = true; dragStartX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            dragStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        }
    });
    body.addEventListener('touchmove', (e) => {
        if (!isDragging || e.touches.length !== 2) return;
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        panX += (cx - dragStartX); panY += (cy - dragStartY);
        dragStartX = cx; dragStartY = cy;
        drawCanvas();
    });
    body.addEventListener('touchend', () => { isDragging = false; });

    // 尺寸变化重绘
    new ResizeObserver(() => drawCanvas()).observe(body);
}

// ═══════════════════════════════════════════════════════════
//  表单弹窗（与之前相同）
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
        <input id="bb_map_f_name" class="bb-input" value="${escapeHtml(d.name || '')}" style="width:100%;margin-bottom:10px;box-sizing:border-box;" />
        <label style="font-size:0.85em;">描述</label>
        <textarea id="bb_map_f_desc" class="bb-input" rows="3" style="width:100%;margin-bottom:10px;box-sizing:border-box;resize:vertical;">${escapeHtml(d.description || '')}</textarea>
        <div style="display:flex;gap:8px;">
            <div style="flex:1;"><label style="font-size:0.85em;">区域</label><input id="bb_map_f_region" class="bb-input" value="${escapeHtml(d.region || '')}" style="width:100%;margin-bottom:10px;box-sizing:border-box;" /></div>
            <div style="flex:1;"><label style="font-size:0.85em;">父地点</label><select id="bb_map_f_parent" class="bb-input" style="width:100%;margin-bottom:10px;"><option value="">(无)</option></select></div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="bb_map_f_cancel" class="menu_button" style="opacity:0.6;">取消</button>
            <button id="bb_map_f_save" class="menu_button" style="background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;">保存</button>
        </div>`;
    overlay.appendChild(form); document.body.appendChild(overlay);
    getLocations(getChatId()).then(locs => {
        const sel = form.querySelector('#bb_map_f_parent');
        if (sel) for (const l of locs) { if (l.id !== d.id) sel.innerHTML += `<option value="${l.id}" ${d.parentId === l.id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`; }
    });
    const nameInput = form.querySelector('#bb_map_f_name');
    form.querySelector('#bb_map_f_save').addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (!name) { showToast('请输入名称', 'warning'); return; }
        overlay.remove();
        onSave({ name, description: form.querySelector('#bb_map_f_desc').value.trim(), region: form.querySelector('#bb_map_f_region').value.trim(), parentId: form.querySelector('#bb_map_f_parent').value || null });
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
        <div style="font-weight:bold;margin-bottom:14px;">🔗 从「${escapeHtml(fromName)}」连线</div>
        <label style="font-size:0.85em;">目标地点</label>
        <select id="bb_map_c_target" class="bb-input" style="width:100%;margin-bottom:10px;">${locations.map(l => `<option value="${l.id}">${escapeHtml(l.name)} ${l.region ? '(' + escapeHtml(l.region) + ')' : ''}</option>`).join('')}</select>
        <div style="display:flex;gap:8px;"><div style="flex:1;"><label style="font-size:0.85em;">距离</label><input id="bb_map_c_dist" class="bb-input" style="width:100%;margin-bottom:10px;box-sizing:border-box;" /></div><div style="flex:1;"><label style="font-size:0.85em;">路径类型</label><input id="bb_map_c_type" class="bb-input" style="width:100%;margin-bottom:10px;box-sizing:border-box;" /></div></div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;"><div style="flex:1;"><select id="bb_map_c_diff" class="bb-input"><option value="normal" selected>普通</option><option value="easy">容易</option><option value="hard">困难</option></select></div><div style="flex:1;"><label style="font-size:0.85em;cursor:pointer;"><input type="checkbox" id="bb_map_c_oneway" /> 单向</label></div></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;"><button id="bb_map_c_cancel" class="menu_button" style="opacity:0.6;">取消</button><button id="bb_map_c_save" class="menu_button" style="background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;">创建</button></div>`;
    overlay.appendChild(form); document.body.appendChild(overlay);
    form.querySelector('#bb_map_c_save').addEventListener('click', () => {
        overlay.remove();
        onSave({ targetId: form.querySelector('#bb_map_c_target').value, distance: form.querySelector('#bb_map_c_dist').value.trim(), pathType: form.querySelector('#bb_map_c_type').value.trim(), difficulty: form.querySelector('#bb_map_c_diff').value, oneWay: form.querySelector('#bb_map_c_oneway').checked });
    });
    form.querySelector('#bb_map_c_cancel').addEventListener('click', () => overlay.remove());
}

function showItemPicker(locationName, items, onSave) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    const unplaced = items.filter(i => !i.archived && i.location !== locationName);
    const placed = items.filter(i => !i.archived && i.location === locationName);
    const form = document.createElement('div');
    form.style.cssText = 'background:var(--SmartThemeChatTintColor,#1e1e2e);color:var(--SmartThemeBodyColor,#e0e0e0);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:12px;padding:20px 24px;width:min(480px,92vw);max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    form.innerHTML = `<div style="font-weight:bold;margin-bottom:6px;">📦 为「${escapeHtml(locationName)}」放置物品</div>
        ${placed.length > 0 ? `<div style="font-size:0.75em;opacity:0.5;margin-bottom:8px;">已有: ${placed.map(i => escapeHtml(i.name)).join('、')}</div>` : ''}
        <div style="flex:1;overflow-y:auto;max-height:45vh;margin-bottom:8px;">${unplaced.length === 0 ? '<div style="opacity:0.4;text-align:center;padding:20px;">所有物品已在此地点</div>' : unplaced.map(i => `<label style="display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;border-bottom:1px solid var(--SmartThemeBorderColor,#3333);font-size:0.85em;"><input type="checkbox" class="bb-map-item-cb" data-id="${i.id}" /><span style="flex:1;">${escapeHtml(i.name)}</span><span style="font-size:0.65em;opacity:0.35;">${i.location ? '📍'+escapeHtml(i.location) : ''}</span></label>`).join('')}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;"><button id="bb_map_pi_cancel" class="menu_button" style="opacity:0.6;">取消</button><button id="bb_map_pi_save" class="menu_button" style="background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;">放置选中</button></div>`;
    overlay.appendChild(form); document.body.appendChild(overlay);
    form.querySelector('#bb_map_pi_save').addEventListener('click', () => { const ids = [...form.querySelectorAll('.bb-map-item-cb:checked')].map(cb => cb.dataset.id); overlay.remove(); if (ids.length > 0) onSave(ids); });
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
    let viewMode = 'spatial'; // 'spatial' | 'list'
    let editMode = false; // v8.8.1 编辑布局模式

    const overlay = document.createElement('div');
    overlay.className = 'bb-map-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99991;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const panel = document.createElement('div');
    panel.className = 'bb-map-panel';
    panel.style.cssText = 'background:var(--SmartThemeChatTintColor,#1e1e2e);color:var(--SmartThemeBodyColor,#e0e0e0);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:14px;width:min(720px,96vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,0.5);';
    overlay.appendChild(panel);

    // 头部
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;';
    header.innerHTML = `<i class="fa-solid fa-map" style="color:#4fc3f7;"></i>
        <div style="flex:1;"><strong>世界地图</strong><span class="bb-map-count" style="font-size:0.78em;opacity:0.5;margin-left:6px;"></span></div>
        <button class="bb-map-auto-layout menu_button" style="font-size:0.7em;padding:2px 6px;" title="自动布局">📐</button>
        <button class="bb-map-edit-toggle menu_button" style="font-size:0.7em;padding:2px 8px;${editMode ? 'background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;' : ''}" title="编辑地图布局">${editMode ? '✏️ 编辑中' : '🔒 锁定'}</button>
        <button class="bb-map-view-toggle menu_button" style="font-size:0.72em;padding:2px 8px;">${viewMode === 'spatial' ? '📋 列表' : '🗺 空间'}</button>
        <button class="bb-map-edit-ref menu_button" style="font-size:0.7em;padding:2px 6px;">🌍</button>
        <button class="bb-map-close-btn" style="background:none;border:none;color:inherit;font-size:20px;cursor:pointer;opacity:0.6;line-height:1;padding:0 4px;">&times;</button>`;
    header.querySelector('.bb-map-close-btn').addEventListener('click', () => overlay.remove());
    header.querySelector('.bb-map-edit-ref').addEventListener('click', () => {
        const val = prompt('全局现实参考：', globalRef);
        if (val === null) return;
        globalRef = val.trim();
        updateSettings({ worldRealWorldRef: globalRef });
        renderRefBar();
    });
    header.querySelector('.bb-map-view-toggle').addEventListener('click', () => {
        viewMode = viewMode === 'spatial' ? 'list' : 'spatial';
        header.querySelector('.bb-map-view-toggle').textContent = viewMode === 'spatial' ? '📋 列表' : '🗺 空间';
        refresh();
    });
    header.querySelector('.bb-map-edit-toggle').addEventListener('click', async () => {
        if (editMode) {
            // 退出编辑模式，保存所有位置
            const locs = Object.values(map.locations || {});
            const { updateLocation } = await import('./map-store.js');
            for (const loc of locs) {
                await updateLocation(chatId, loc.id, { x: loc.x, y: loc.y });
            }
            map = await getMap(chatId);
            showToast('布局已保存', 'success');
        }
        editMode = !editMode;
        header.querySelector('.bb-map-edit-toggle').textContent = editMode ? '✏️ 编辑中' : '🔒 锁定';
        header.querySelector('.bb-map-edit-toggle').style.background = editMode ? 'var(--SmartThemeQuoteColor,#4caf50)' : '';
        header.querySelector('.bb-map-edit-toggle').style.color = editMode ? '#fff' : '';
        refresh();
    });
    header.querySelector('.bb-map-auto-layout').addEventListener('click', async () => {
        showToast('自动布局中...', 'info');
        await autoLayout(chatId);
        map = await getMap(chatId);
        refresh();
        showToast('布局完成', 'success');
    });
    panel.appendChild(header);

    // 区域标签页
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;gap:3px;padding:6px 16px;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;overflow-x:auto;flex-wrap:wrap;';
    renderTabs();
    panel.appendChild(tabBar);

    function renderTabs() {
        tabBar.innerHTML = `<button class="menu_button bb-map-region-tab ${activeRegion === '' ? 'active' : ''}" data-region="" style="font-size:0.72em;padding:3px 8px;${activeRegion === '' ? 'background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;' : ''}">全部</button>`;
        for (const r of regions) {
            const rc = getRegionColor(r);
            tabBar.innerHTML += `<button class="menu_button bb-map-region-tab" data-region="${escapeHtml(r)}" style="font-size:0.72em;padding:3px 8px;${activeRegion === r ? 'background:' + rc + '33;border-color:' + rc + ';' : ''}">${escapeHtml(r)}</button>`;
        }
        tabBar.querySelectorAll('.bb-map-region-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                activeRegion = btn.dataset.region;
                renderTabs();
                refresh();
            });
        });
    }

    // 全局现实参考栏
    const refBar = document.createElement('div');
    refBar.style.cssText = 'padding:4px 16px;font-size:0.7em;opacity:0.5;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a11);flex-shrink:0;';
    renderRefBar();
    panel.appendChild(refBar);

    function renderRefBar() {
        refBar.innerHTML = globalRef ? `🌍 全局参考: <strong>${escapeHtml(globalRef)}</strong>` : '🌍 未设置全局现实参考';
    }

    // 主体
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow:hidden;min-height:0;';
    panel.appendChild(body);

    // 底部
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;';
    footer.innerHTML = `<button class="menu_button" id="bb_map_add_loc" style="font-size:0.85em;"><i class="fa-solid fa-plus"></i> 添加地点</button><button class="menu_button" id="bb_map_help" style="font-size:0.85em;opacity:0.6;margin-left:auto;"><i class="fa-solid fa-question"></i> 帮助</button>`;
    panel.appendChild(footer);
    document.body.appendChild(overlay);

    // 回调函数
    async function handleEdit(id) {
        const loc = map.locations[id];
        if (!loc) return;
        showLocationForm('编辑地点', loc, async (data) => {
            await updateLocation(chatId, id, data);
            map = await getMap(chatId); items = await getItems(chatId); regions = await getRegions(chatId);
            renderTabs(); refresh();
        });
    }
    async function handleConnect(fromId) {
        const loc = map.locations[fromId];
        if (!loc) return;
        const others = Object.values(map.locations || {}).filter(l => l.id !== fromId);
        if (others.length === 0) { showToast('没有其他地点', 'warning'); return; }
        showConnectionForm(loc.name, others, async (data) => {
            if (data.oneWay) await addEdge(chatId, fromId, { toId: data.targetId, distance: data.distance, pathType: data.pathType, difficulty: data.difficulty });
            else await addBidirectionalEdge(chatId, fromId, data.targetId, { distance: data.distance, pathType: data.pathType, difficulty: data.difficulty });
            map = await getMap(chatId); refresh(); showToast('连线已创建', 'success');
        });
    }
    async function handleAddItem(locId, locName) {
        const { updateItem } = await import('./memory-store.js');
        showItemPicker(locName, items, async (ids) => {
            for (const id of ids) await updateItem(chatId, id, { location: locName });
            items = await getItems(chatId); refresh(); showToast(`${ids.length}个物品已放置`, 'success');
        });
    }
    async function handleDelete(id) {
        const loc = map.locations[id];
        if (!confirm('删除"' + (loc?.name || id) + '"？')) return;
        const children = Object.values(map.locations || {}).filter(l => l.parentId === id);
        const delIds = [id]; const queue = [id];
        while (queue.length) { const pid = queue.shift(); for (const s of Object.values(map.locations || {}).filter(l => l.parentId === pid)) { delIds.push(s.id); queue.push(s.id); } }
        for (const did of delIds) await removeLocation(chatId, did);
        map = await getMap(chatId); regions = await getRegions(chatId); renderTabs(); refresh(); showToast('已删除', 'success');
    }

    function refresh() {
        const locs = Object.values(map.locations || {});
        if (viewMode === 'spatial') {
            body.style.cssText = 'flex:1;overflow:hidden;min-height:0;';
            renderSpatialView(body, locs, items, activeRegion, editMode, handleEdit, handleConnect, handleAddItem, handleDelete);
        } else {
            body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 16px;min-height:0;';
            body.innerHTML = buildListHTML(locs, items, activeRegion);
            bindListEvents();
        }
        const edges = locs.reduce((s, l) => s + (l.edges || []).length, 0);
        const countEl = panel.querySelector('.bb-map-count');
        if (countEl) countEl.textContent = locs.length + ' 地点 · ' + edges + ' 连接';
    }

    function bindListEvents() {
        body.querySelectorAll('.bb-map-node-box').forEach(box => {
            box.addEventListener('mouseenter', () => { const a = box.querySelector('.bb-map-node-actions'); if (a) a.style.opacity = '1'; });
            box.addEventListener('mouseleave', () => { const a = box.querySelector('.bb-map-node-actions'); if (a) a.style.opacity = '0'; });
        });
        body.querySelectorAll('.bb-map-box-edit').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); handleEdit(b.dataset.locId); }));
        body.querySelectorAll('.bb-map-box-connect').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); handleConnect(b.dataset.locId); }));
        body.querySelectorAll('.bb-map-box-additem').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); handleAddItem(b.dataset.locId, b.dataset.locName); }));
        body.querySelectorAll('.bb-map-box-del').forEach(b => b.addEventListener('click', async (e) => { e.stopPropagation(); handleDelete(b.dataset.locId); }));
        // 跨区域跳转
        body.querySelectorAll('.bb-map-cross-link').forEach(el => {
            el.addEventListener('click', () => {
                activeRegion = el.dataset.region;
                renderTabs(); refresh();
            });
        });
    }

    refresh();

    footer.querySelector('#bb_map_add_loc').addEventListener('click', () => {
        showLocationForm('添加地点', {}, async (data) => {
            await addLocation(chatId, { ...data, source: 'manual' });
            map = await getMap(chatId); regions = await getRegions(chatId); renderTabs(); refresh();
            showToast('地点已添加', 'success');
        });
    });
    footer.querySelector('#bb_map_help').addEventListener('click', () => {
        alert('世界地图 v8.8.0\n\n🗺 空间视图：Canvas连线+CSS卡片\n  - 滚轮缩放 | 拖动平移 | 右键菜单\n  - 双击编辑 | 触摸两指拖动\n📋 列表视图：区域分组+连线\n🌉 跨区域：虚线连接，点击跳转\n📐 自动布局：一键整理地点位置');
    });
    document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
    });
}
