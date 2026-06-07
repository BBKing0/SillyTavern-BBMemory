/**
 * map-view.js —— BB-Memory v8.8.4 地图视图
 * 双模式：2D空间视图(Canvas+CSS) + 列表视图
 * 跨区域标签页、缩放拖动、物品选择器
 */

import {
    getMap, getLocations, addLocation, updateLocation, removeLocation,
    addEdge, addBidirectionalEdge, removeEdge, getRegions, autoLayout,
} from './map-store.js';
import { getItems, getSettings, updateSettings } from './memory-store.js';
import {
    createGraphViewport,
    fitToGraph,
    worldToScreen,
    bindGraphPointerControls,
} from './graph-view-core.js';

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
const MAP_UI_PREF_KEY = 'bb_map_ui_pref';

function getRegionColor(region) {
    if (!region) return '#888';
    let hash = 0; for (let i = 0; i < region.length; i++) hash = ((hash << 5) - hash) + region.charCodeAt(i);
    return REGION_COLORS[Math.abs(hash) % REGION_COLORS.length];
}

function loadMapUiPref() {
    try {
        const raw = localStorage.getItem(MAP_UI_PREF_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function saveMapUiPref(patch) {
    try {
        localStorage.setItem(MAP_UI_PREF_KEY, JSON.stringify({ ...loadMapUiPref(), ...patch }));
    } catch { /* ignore */ }
}

function clamp01(value) {
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0.02, Math.min(0.98, value));
}

function getLocationRegion(loc) {
    return loc?.region || '';
}

function getRegionLabel(region) {
    return region || '(未分区)';
}

function getRegionKeys(locations, knownRegions = []) {
    const keys = new Set((knownRegions || []).map(r => r || ''));
    for (const loc of locations || []) {
        if (loc && !loc.archived) keys.add(getLocationRegion(loc));
    }
    return [...keys].sort((a, b) => getRegionLabel(a).localeCompare(getRegionLabel(b), 'zh-Hans-CN'));
}

function suggestLocationPosition(data, locations) {
    const all = (locations || []).filter(l => l && !l.archived);
    const parent = data?.parentId ? all.find(l => l.id === data.parentId) : null;
    if (parent) {
        return {
            x: clamp01((parent.x ?? 0.5) + 0.055),
            y: clamp01((parent.y ?? 0.5) + 0.055),
        };
    }

    const region = data?.region || '';
    const sameRegion = all.filter(l => getLocationRegion(l) === region);
    if (sameRegion.length) {
        const cx = sameRegion.reduce((sum, loc) => sum + (Number.isFinite(loc.x) ? loc.x : 0.5), 0) / sameRegion.length;
        const cy = sameRegion.reduce((sum, loc) => sum + (Number.isFinite(loc.y) ? loc.y : 0.5), 0) / sameRegion.length;
        const offset = 0.055 + Math.min(0.08, sameRegion.length * 0.012);
        return { x: clamp01(cx + offset), y: clamp01(cy + offset * 0.7) };
    }

    const count = Math.max(4, getRegionKeys(all, [region]).length + 1);
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / cols));
    let best = { x: 0.5, y: 0.5, score: -1 };
    for (let i = 0; i < count; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const candidate = {
            x: clamp01((col + 0.5) / cols),
            y: clamp01((row + 0.5) / rows),
        };
        const score = all.length
            ? Math.min(...all.map(loc => {
                const dx = candidate.x - (Number.isFinite(loc.x) ? loc.x : 0.5);
                const dy = candidate.y - (Number.isFinite(loc.y) ? loc.y : 0.5);
                return dx * dx + dy * dy;
            }))
            : 1;
        if (score > best.score) best = { ...candidate, score };
    }
    return { x: best.x, y: best.y };
}

// ═══════════════════════════════════════════════════════════
//  列表视图（保留原有的区域分组+流程图式）
// ═══════════════════════════════════════════════════════════

function buildListHTML(locations, items, visibleRegions, editMode = false) {
    const all = (locations || []).filter(l => l && !l.archived);
    if (all.length === 0) {
        return `<div class="bb-map-empty"><i class="fa-solid fa-map"></i><div>还没有地图地点</div></div>`;
    }

    const selectedRegions = visibleRegions instanceof Set ? visibleRegions : new Set(getRegionKeys(all));
    const locMap = new Map(all.map(l => [l.id, l]));
    const childMap = new Map();
    for (const loc of all) {
        const pid = loc.parentId || '';
        if (!childMap.has(pid)) childMap.set(pid, []);
        childMap.get(pid).push(loc);
    }

    const matchesRegion = loc => selectedRegions.has(getLocationRegion(loc));
    const visible = all.filter(matchesRegion);
    if (selectedRegions.size === 0) return '<div class="bb-map-empty">未显示任何地区。点击上方地区标签显示地点。</div>';
    if (visible.length === 0) return '<div class="bb-map-empty">当前显示的地区暂无地点</div>';

    function renderLocCard(loc, depth, parentHint = '') {
        const locItems = items.filter(i => !i.archived && i.location === loc.name);
        const rc = getRegionColor(loc.region || parentHint);
        const parentLine = parentHint
            ? `<div class="bb-map-list-parent">父地点: ${escapeHtml(parentHint)}</div>`
            : '';
        return `<div class="bb-map-node-box bb-map-list-node" data-loc-id="${escapeHtml(loc.id)}" style="--bb-map-level:${Math.min(depth, 5)};--bb-map-color:${rc};">
            <div class="bb-map-list-title">${depth > 0 ? '<span class="bb-map-list-branch">└</span>' : ''}${escapeHtml(loc.name)}</div>
            ${parentLine}
            ${loc.region ? `<div class="bb-map-list-meta">${escapeHtml(loc.region)}</div>` : ''}
            ${loc.description ? `<div class="bb-map-list-desc">${escapeHtml(loc.description).slice(0, 90)}</div>` : ''}
            ${locItems.length > 0 ? `<div class="bb-map-list-items"><i class="fa-solid fa-box"></i> ${locItems.length} 件物品</div>` : ''}
            <div class="bb-map-node-actions">
                <button class="bb-map-box-edit menu_button" data-loc-id="${escapeHtml(loc.id)}" title="编辑"><i class="fa-solid fa-pen"></i></button>
                <button class="bb-map-box-connect menu_button" data-loc-id="${escapeHtml(loc.id)}" title="连线" ${editMode ? '' : 'disabled'}><i class="fa-solid fa-link"></i></button>
                <button class="bb-map-box-additem menu_button" data-loc-id="${escapeHtml(loc.id)}" data-loc-name="${escapeHtml(loc.name)}" title="放置物品" ${editMode ? '' : 'disabled'}><i class="fa-solid fa-box"></i></button>
                <button class="bb-map-box-del menu_button" data-loc-id="${escapeHtml(loc.id)}" title="删除" ${editMode ? '' : 'disabled'}><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`;
    }

    function renderTree(loc, depth, rendered, regionKey) {
        if (rendered.has(loc.id)) return '';
        if (getLocationRegion(loc) !== regionKey) return '';
        rendered.add(loc.id);
        let html = renderLocCard(loc, depth);
        for (const child of (childMap.get(loc.id) || [])) {
            html += renderTree(child, depth + 1, rendered, regionKey);
        }
        return html;
    }

    function renderCrossLinks(groupLocs) {
        const lines = [];
        for (const loc of groupLocs) {
            for (const edge of (loc.edges || [])) {
                const target = locMap.get(edge.toId);
                if (!target || target.archived || target.region === loc.region) continue;
                lines.push(`<button class="bb-map-cross-link" data-region="${escapeHtml(target.region || '')}">
                    <span>${escapeHtml(loc.name)}</span>
                    <i class="fa-solid fa-arrow-right"></i>
                    <span>${escapeHtml(target.name)}</span>
                    ${edge.distance ? `<small>${escapeHtml(edge.distance)}</small>` : ''}
                </button>`);
            }
        }
        return lines.length ? `<div class="bb-map-cross-links">${lines.join('')}</div>` : '';
    }

    const groups = new Map();
    for (const loc of visible) {
        const region = getLocationRegion(loc);
        if (!groups.has(region)) groups.set(region, []);
        groups.get(region).push(loc);
    }

    let html = '';
    for (const [region, locs] of [...groups.entries()].sort((a, b) => getRegionLabel(a[0]).localeCompare(getRegionLabel(b[0]), 'zh-Hans-CN'))) {
        const rc = getRegionColor(region);
        const rendered = new Set();
        const content = [];
        const visibleIds = new Set(locs.map(l => l.id));
        const roots = locs.filter(l => !l.parentId || !visibleIds.has(l.parentId));
        for (const loc of roots) {
            const parent = loc.parentId ? locMap.get(loc.parentId) : null;
            if (parent && getLocationRegion(parent) !== region) {
                content.push(renderLocCard(loc, 1, parent.name));
                rendered.add(loc.id);
                for (const child of (childMap.get(loc.id) || [])) content.push(renderTree(child, 2, rendered, region));
            } else {
                content.push(renderTree(loc, parent ? 1 : 0, rendered, region));
            }
        }
        html += `<section class="bb-map-list-region" style="--bb-map-color:${rc};">
            <div class="bb-map-list-region-title">${escapeHtml(getRegionLabel(region))}</div>
            <div class="bb-map-list-region-body">${content.join('')}${renderCrossLinks(locs)}</div>
        </section>`;
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

    // v8.8.3 统一坐标转换
    function getContainerSize() {
        return { w: body.clientWidth, h: Math.max(body.clientHeight, 400) };
    }
    function worldToScreen(loc) {
        const { w, h } = getContainerSize();
        return { x: loc.x * w * scale + panX, y: loc.y * h * scale + panY };
    }

    function drawCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const { w, h } = getContainerSize();
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
            const allPx = rLocs.map(l => worldToScreen(l));
            const pad = 48;
            const minX = Math.min(...allPx.map(p => p.x)) - pad;
            const minY = Math.min(...allPx.map(p => p.y)) - pad;
            const maxX = Math.max(...allPx.map(p => p.x)) + pad;
            const maxY = Math.max(...allPx.map(p => p.y)) + pad;
            const rc = getRegionColor(r);
            ctx.fillStyle = rc + '06';
            ctx.strokeStyle = rc + '44';
            ctx.lineWidth = 1;
            ctx.setLineDash([8, 4]);
            ctx.beginPath();
            ctx.roundRect(minX, minY, maxX - minX, maxY - minY, 12);
            ctx.fill();
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = rc + '88';
            ctx.font = '11px sans-serif';
            const labelW = ctx.measureText(r).width;
            ctx.fillText(r, (minX + maxX) / 2 - labelW / 2, minY - 6);
        }

        // 连线
        for (const loc of filtered) {
            const fp = worldToScreen(loc);
            for (const edge of (loc.edges || [])) {
                const target = locMap[edge.toId];
                if (!target) continue;
                const tp = worldToScreen(target);
                const crossRegion = target.region !== loc.region;
                const isOneWay = !(target.edges || []).some(e => e.toId === loc.id);

                ctx.strokeStyle = crossRegion ? '#ff980088' : '#4fc3f744';
                ctx.lineWidth = crossRegion ? 2 : 1.2;
                ctx.setLineDash(crossRegion ? [6, 4] : (isOneWay ? [] : []));
                if (isOneWay && !crossRegion) ctx.setLineDash([]);

                const midX = (fp.x + tp.x) / 2;
                ctx.beginPath();
                ctx.moveTo(fp.x, fp.y);
                ctx.quadraticCurveTo(midX, fp.y - 10, tp.x, tp.y);
                ctx.stroke();
                ctx.setLineDash([]);

                if (edge.distance) {
                    ctx.fillStyle = '#888';
                    ctx.font = '9px sans-serif';
                    ctx.fillText(edge.distance, midX - 10, (fp.y + tp.y) / 2 - 4);
                }
            }
        }
    }

    function renderAllCards() {
        cardLayer.innerHTML = '';
        const rendered = new Set();

        for (const loc of filtered) {
            if (rendered.has(loc.id)) continue;
            const subLocs = (children[loc.id] || []).filter(l => !l.archived);
            const locItems = items.filter(i => !i.archived && i.location === loc.name);
            const rc = getRegionColor(loc.region);

            if (subLocs.length > 0) {
                // 父地点：大容器包裹子节点
                rendered.add(loc.id);
                const pp = worldToScreen(loc);
                const childPx = subLocs.map(s => worldToScreen(s));
                const allPx = [pp, ...childPx];
                const pad = 48;
                const minX = Math.min(...allPx.map(p => p.x)) - pad;
                const minY = Math.min(...allPx.map(p => p.y)) - pad;
                const maxX = Math.max(...allPx.map(p => p.x)) + pad;
                const maxY = Math.max(...allPx.map(p => p.y)) + pad;

                const container = document.createElement('div');
                container.style.cssText = `position:absolute;left:${minX}px;top:${minY}px;width:${maxX - minX}px;height:${maxY - minY}px;background:${rc}08;border:2px solid ${rc}44;border-radius:12px;pointer-events:none;z-index:2;`;
                const label = document.createElement('div');
                label.style.cssText = `position:absolute;top:-10px;left:12px;background:var(--SmartThemeChatTintColor,#1e1e2e);padding:1px 8px;border-radius:3px;font-size:0.65em;font-weight:700;color:${rc};white-space:nowrap;`;
                label.textContent = '📁 ' + loc.name;
                container.appendChild(label);
                cardLayer.appendChild(container);

                const pCard = makeCard(loc, locItems, rc, pp.x, pp.y, true);
                if (editMode) makeDraggable(pCard, loc);
                cardLayer.appendChild(pCard);
                rendered.add(loc.id);

                for (const sub of subLocs) {
                    rendered.add(sub.id);
                    const subItems = items.filter(i => !i.archived && i.location === sub.name);
                    const src = getRegionColor(sub.region);
                    const sp = worldToScreen(sub);
                    const sCard = makeCard(sub, subItems, src, sp.x, sp.y, false);
                    if (editMode) makeDraggable(sCard, sub);
                    cardLayer.appendChild(sCard);
                }
            } else if (!loc.parentId || !locMap[loc.parentId]) {
                const sp = worldToScreen(loc);
                const card = makeCard(loc, locItems, rc, sp.x, sp.y, false);
                if (editMode) makeDraggable(card, loc);
                cardLayer.appendChild(card);
                rendered.add(loc.id);
            }
        }

        function makeCard(loc, locItems, rc, px, py, isParent) {
            const card = document.createElement('div');
            card.className = 'bb-map-spatial-card';
            card.dataset.locId = loc.id;
            card.style.cssText = `position:absolute;left:${px}px;top:${py}px;transform:translate(-50%,-50%);background:var(--SmartThemeChatTintColor,#1e1e2e);border:${isParent ? '2.5px' : '2px'} solid ${rc}${isParent ? '88' : '66'};border-radius:${isParent ? '10px' : '8px'};padding:${isParent ? '10px 14px' : '6px 10px'};min-width:${isParent ? '110px' : '80px'};max-width:${isParent ? '180px' : '140px'};pointer-events:auto;cursor:pointer;z-index:3;box-shadow:0 2px 8px rgba(0,0,0,0.3);font-size:${isParent ? '0.8em' : '0.7em'};`;
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
                    const { w, h } = getContainerSize();
                    loc.x = Math.max(0, Math.min(1, origX + (ev.clientX - startX) / (w * scale)));
                    loc.y = Math.max(0, Math.min(1, origY + (ev.clientY - startY) / (h * scale)));
                    // v8.8.4 有父节点或有子节点时重建包围盒
                    if ((children[loc.id] && children[loc.id].length > 0) || (loc.parentId && locMap[loc.parentId])) {
                        renderAllCards();
                    } else {
                        const sp = worldToScreen(loc);
                        card.style.left = sp.x + 'px';
                        card.style.top = sp.y + 'px';
                    }
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

    function updateCardsPosition() {
        const cards = cardLayer.querySelectorAll('[data-loc-id]');
        const cardMap = new Map();
        cards.forEach(c => cardMap.set(c.dataset.locId, c));
        for (const loc of filtered) {
            const el = cardMap.get(loc.id);
            if (!el) continue;
            const sp = worldToScreen(loc);
            el.style.left = sp.x + 'px';
            el.style.top = sp.y + 'px';
        }
    }

    renderAllCards();
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
        updateCardsPosition();
        drawCanvas();
    });
    window.addEventListener('mouseup', () => { isDragging = false; });
    body.addEventListener('wheel', (e) => {
        e.preventDefault();
        const oldScale = scale;
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        scale = Math.max(0.3, Math.min(3, scale + delta));
        // v8.8.4 鼠标位置居中缩放
        const rect = body.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        panX = mx - (mx - panX) * scale / oldScale;
        panY = my - (my - panY) * scale / oldScale;
        updateCardsPosition();
        drawCanvas();
    }, { passive: false });
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
        updateCardsPosition();
        drawCanvas();
    });
    body.addEventListener('touchend', () => { isDragging = false; });

    // 尺寸变化重绘
    new ResizeObserver(() => { updateCardsPosition(); drawCanvas(); }).observe(body);
}

// ═══════════════════════════════════════════════════════════
//  表单弹窗（与之前相同）
// ═══════════════════════════════════════════════════════════

function renderSpatialViewV2(body, locations, items, visibleRegions, editMode, onEdit, onConnect, onAddItem, onDelete, onLayoutChanged) {
    if (typeof body._bbMapCleanup === 'function') body._bbMapCleanup();

    const allLocations = (locations || []).filter(l => l && !l.archived);
    allLocations.forEach((loc, index) => {
        if (!Number.isFinite(loc.x)) loc.x = 0.18 + (index % 5) * 0.16;
        if (!Number.isFinite(loc.y)) loc.y = 0.18 + Math.floor(index / 5) * 0.14;
        loc.x = clamp01(loc.x);
        loc.y = clamp01(loc.y);
    });

    const selectedRegions = visibleRegions instanceof Set ? visibleRegions : new Set(getRegionKeys(allLocations));
    const visible = allLocations.filter(l => selectedRegions.has(getLocationRegion(l)));
    const visibleIds = new Set(visible.map(l => l.id));
    const locMap = new Map(allLocations.map(l => [l.id, l]));
    const children = new Map();
    for (const loc of visible) {
        const pid = loc.parentId || '';
        if (!children.has(pid)) children.set(pid, []);
        children.get(pid).push(loc);
    }

    body.innerHTML = '';
    body.className = 'bb-map-spatial-body';
    body.style.cssText = '';

    if (!visible.length) {
        body.innerHTML = selectedRegions.size === 0
            ? '<div class="bb-map-empty">未显示任何地区。点击上方地区标签显示地点。</div>'
            : '<div class="bb-map-empty">当前显示的地区暂无地点</div>';
        body._bbMapCleanup = null;
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'bb-map-spatial-canvas';
    const groupLayer = document.createElement('div');
    groupLayer.className = 'bb-map-group-layer';
    const cardLayer = document.createElement('div');
    cardLayer.className = 'bb-map-card-layer';
    const detailPane = document.createElement('div');
    detailPane.className = 'bb-map-detail-pane';
    detailPane.style.display = 'none';

    body.appendChild(canvas);
    body.appendChild(groupLayer);
    body.appendChild(cardLayer);
    body.appendChild(detailPane);

    const viewport = createGraphViewport(body, { minScale: 0.35, maxScale: 2.8, minHeight: 400 });
    fitToGraph(visible, viewport, {
        padding: window.innerWidth <= 480 ? 54 : 86,
        minScale: 0.35,
        maxScale: 2.2,
    });

    let selectedId = null;

    function getDescendants(loc) {
        const result = [];
        const queue = [...(children.get(loc.id) || [])];
        while (queue.length) {
            const child = queue.shift();
            result.push(child);
            queue.push(...(children.get(child.id) || []));
        }
        return result;
    }

    function getLocItems(loc) {
        return items.filter(i => !i.archived && i.location === loc.name);
    }

    function pointBounds(nodes, pad = 48) {
        const points = nodes.map(n => worldToScreen(n, viewport));
        return {
            minX: Math.min(...points.map(p => p.x)) - pad,
            minY: Math.min(...points.map(p => p.y)) - pad,
            maxX: Math.max(...points.map(p => p.x)) + pad,
            maxY: Math.max(...points.map(p => p.y)) + pad,
        };
    }

    function drawCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const { w, h } = viewport.getSize();
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';

        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        for (const loc of visible) {
            const fp = worldToScreen(loc, viewport);
            for (const edge of (loc.edges || [])) {
                if (!visibleIds.has(edge.toId)) continue;
                const target = locMap.get(edge.toId);
                if (!target) continue;
                const tp = worldToScreen(target, viewport);
                const crossRegion = target.region !== loc.region;
                const midX = (fp.x + tp.x) / 2;
                const midY = (fp.y + tp.y) / 2;

                ctx.strokeStyle = crossRegion ? '#ff9800aa' : '#4fc3f777';
                ctx.lineWidth = crossRegion ? 2 : 1.3;
                ctx.setLineDash(crossRegion ? [7, 5] : []);
                ctx.beginPath();
                ctx.moveTo(fp.x, fp.y);
                ctx.quadraticCurveTo(midX, midY - 18, tp.x, tp.y);
                ctx.stroke();
                ctx.setLineDash([]);

                if (edge.distance) {
                    ctx.fillStyle = '#aaa';
                    ctx.font = '10px sans-serif';
                    ctx.fillText(edge.distance, midX + 4, midY - 8);
                }
            }
        }
    }

    function positionElements() {
        for (const card of cardLayer.querySelectorAll('.bb-map-spatial-card')) {
            const loc = locMap.get(card.dataset.locId);
            if (!loc) continue;
            const p = worldToScreen(loc, viewport);
            card.style.left = p.x + 'px';
            card.style.top = p.y + 'px';
        }

        for (const box of groupLayer.querySelectorAll('.bb-map-region-box')) {
            const region = box.dataset.region || '';
            const nodes = visible.filter(loc => getLocationRegion(loc) === region);
            if (!nodes.length) continue;
            const b = pointBounds(nodes, 86);
            box.style.left = b.minX + 'px';
            box.style.top = b.minY + 'px';
            box.style.width = Math.max(180, b.maxX - b.minX) + 'px';
            box.style.height = Math.max(118, b.maxY - b.minY) + 'px';
        }

        for (const box of groupLayer.querySelectorAll('.bb-map-parent-box')) {
            const loc = locMap.get(box.dataset.locId);
            if (!loc) continue;
            const grouped = [loc, ...getDescendants(loc)];
            const b = pointBounds(grouped, 56);
            box.style.left = b.minX + 'px';
            box.style.top = b.minY + 'px';
            box.style.width = Math.max(120, b.maxX - b.minX) + 'px';
            box.style.height = Math.max(82, b.maxY - b.minY) + 'px';
        }
    }

    function renderDetails(loc) {
        if (!loc) {
            detailPane.style.display = 'none';
            detailPane.innerHTML = '';
            return;
        }
        const locItems = getLocItems(loc);
        detailPane.style.display = '';
        detailPane.innerHTML = `
            <div class="bb-map-detail-title">${escapeHtml(loc.name)}</div>
            ${loc.region ? `<div class="bb-map-detail-meta">${escapeHtml(loc.region)}</div>` : ''}
            ${loc.description ? `<div class="bb-map-detail-desc">${escapeHtml(loc.description)}</div>` : ''}
            ${locItems.length ? `<div class="bb-map-detail-items"><i class="fa-solid fa-box"></i> ${locItems.map(i => escapeHtml(i.name)).join('、')}</div>` : ''}
            <div class="bb-map-detail-actions">
                <button class="menu_button bb-map-detail-edit"><i class="fa-solid fa-pen"></i> 编辑</button>
                <button class="menu_button bb-map-detail-connect" ${editMode ? '' : 'disabled'}><i class="fa-solid fa-link"></i> 连线</button>
                <button class="menu_button bb-map-detail-item" ${editMode ? '' : 'disabled'}><i class="fa-solid fa-box"></i> 物品</button>
                <button class="menu_button bb-map-detail-delete" ${editMode ? '' : 'disabled'}><i class="fa-solid fa-trash"></i></button>
            </div>`;
        detailPane.querySelector('.bb-map-detail-edit')?.addEventListener('click', () => onEdit(loc.id));
        detailPane.querySelector('.bb-map-detail-connect')?.addEventListener('click', () => editMode && onConnect(loc.id));
        detailPane.querySelector('.bb-map-detail-item')?.addEventListener('click', () => editMode && onAddItem(loc.id, loc.name));
        detailPane.querySelector('.bb-map-detail-delete')?.addEventListener('click', () => editMode && onDelete(loc.id));
    }

    function selectLoc(loc) {
        selectedId = loc.id;
        for (const card of cardLayer.querySelectorAll('.bb-map-spatial-card')) {
            card.classList.toggle('selected', card.dataset.locId === selectedId);
        }
        renderDetails(loc);
    }

    let activeDragCleanup = null;

    function startDrag(event, dragLocs) {
        if (!editMode || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        event.stopPropagation();

        if (typeof activeDragCleanup === 'function') activeDragCleanup();

        const startX = event.clientX;
        const startY = event.clientY;
        const originals = dragLocs.map(loc => ({ loc, x: loc.x, y: loc.y }));
        const pointerId = event.pointerId;
        const dragTarget = event.currentTarget;
        dragTarget.setPointerCapture?.(pointerId);
        body.classList.add('dragging');
        let finished = false;

        function onMove(ev) {
            if (ev.pointerId !== pointerId) return;
            const { w, h } = viewport.getSize();
            const dx = (ev.clientX - startX) / (w * viewport.scale);
            const dy = (ev.clientY - startY) / (h * viewport.scale);
            for (const item of originals) {
                item.loc.x = clamp01(item.x + dx);
                item.loc.y = clamp01(item.y + dy);
            }
            positionElements();
            drawCanvas();
        }

        function onUp() {
            if (finished) return;
            finished = true;
            body.classList.remove('dragging');
            try {
                if (dragTarget.hasPointerCapture?.(pointerId)) dragTarget.releasePointerCapture(pointerId);
            } catch { /* pointer may already be released */ }
            document.removeEventListener('pointermove', onMove, true);
            document.removeEventListener('pointerup', onUp, true);
            document.removeEventListener('pointercancel', onUp, true);
            dragTarget.removeEventListener('lostpointercapture', onUp);
            window.removeEventListener('blur', onUp);
            activeDragCleanup = null;
            if (typeof onLayoutChanged === 'function') onLayoutChanged(originals.map(i => i.loc));
        }

        activeDragCleanup = onUp;
        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('pointercancel', onUp, true);
        dragTarget.addEventListener('lostpointercapture', onUp);
        window.addEventListener('blur', onUp);
    }

    function showContextMenu(event, loc) {
        if (!editMode) return;
        event.preventDefault();
        const menu = document.createElement('div');
        menu.className = 'bb-map-context-menu';
        menu.style.left = event.clientX + 'px';
        menu.style.top = event.clientY + 'px';
        menu.innerHTML = `
            <button class="menu_button"><i class="fa-solid fa-pen"></i> 编辑</button>
            <button class="menu_button"><i class="fa-solid fa-link"></i> 连线</button>
            <button class="menu_button"><i class="fa-solid fa-box"></i> 物品</button>
            <button class="menu_button danger"><i class="fa-solid fa-trash"></i> 删除</button>`;
        document.body.appendChild(menu);
        const buttons = menu.querySelectorAll('button');
        buttons[0].addEventListener('click', () => { menu.remove(); onEdit(loc.id); });
        buttons[1].addEventListener('click', () => { menu.remove(); onConnect(loc.id); });
        buttons[2].addEventListener('click', () => { menu.remove(); onAddItem(loc.id, loc.name); });
        buttons[3].addEventListener('click', () => { menu.remove(); onDelete(loc.id); });
        setTimeout(() => document.addEventListener('click', function close() {
            menu.remove();
            document.removeEventListener('click', close);
        }), 10);
    }

    function createCard(loc) {
        const locItems = getLocItems(loc);
        const hasChildren = (children.get(loc.id) || []).length > 0;
        const card = document.createElement('div');
        card.className = `bb-map-spatial-card${hasChildren ? ' parent' : ''}`;
        card.dataset.locId = loc.id;
        card.style.setProperty('--bb-map-color', getRegionColor(loc.region));
        card.innerHTML = `
            <div class="bb-map-spatial-title">${escapeHtml(loc.name)}</div>
            ${loc.description ? `<div class="bb-map-spatial-desc">${escapeHtml(loc.description).slice(0, hasChildren ? 80 : 48)}</div>` : ''}
            ${locItems.length ? `<div class="bb-map-spatial-items"><i class="fa-solid fa-box"></i> ${locItems.length}</div>` : ''}`;
        card.addEventListener('click', (e) => {
            e.stopPropagation();
            selectLoc(loc);
        });
        card.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            onEdit(loc.id);
        });
        card.addEventListener('contextmenu', (e) => showContextMenu(e, loc));
        card.addEventListener('pointerdown', (e) => startDrag(e, [loc]));
        cardLayer.appendChild(card);
    }

    function renderElements() {
        groupLayer.innerHTML = '';
        cardLayer.innerHTML = '';
        const renderedGroups = new Set();
        const regionGroups = new Map();

        for (const loc of visible) {
            const region = getLocationRegion(loc);
            if (!regionGroups.has(region)) regionGroups.set(region, []);
            regionGroups.get(region).push(loc);
        }

        for (const [region, nodes] of regionGroups) {
            const box = document.createElement('div');
            box.className = `bb-map-region-box${editMode ? ' editable' : ''}`;
            box.dataset.region = region;
            box.style.setProperty('--bb-map-color', getRegionColor(region));
            box.innerHTML = `<div class="bb-map-region-label"><i class="fa-solid fa-map-location-dot"></i> ${escapeHtml(getRegionLabel(region))}</div>`;
            box.addEventListener('pointerdown', (e) => startDrag(e, nodes));
            groupLayer.appendChild(box);
        }

        for (const loc of visible) {
            const descendants = getDescendants(loc);
            if (descendants.length && !renderedGroups.has(loc.id)) {
                renderedGroups.add(loc.id);
                const box = document.createElement('div');
                box.className = `bb-map-parent-box${editMode ? ' editable' : ''}`;
                box.dataset.locId = loc.id;
                box.style.setProperty('--bb-map-color', getRegionColor(loc.region));
                box.innerHTML = `<div class="bb-map-parent-label"><i class="fa-solid fa-layer-group"></i> ${escapeHtml(loc.name)}</div>`;
                box.addEventListener('click', (e) => {
                    e.stopPropagation();
                    selectLoc(loc);
                });
                box.addEventListener('pointerdown', (e) => startDrag(e, [loc, ...descendants]));
                groupLayer.appendChild(box);
            }
        }

        for (const loc of visible) createCard(loc);
        positionElements();
        drawCanvas();
    }

    renderElements();

    const unbind = bindGraphPointerControls(body, viewport, {
        shouldStartPan(event) {
            const target = event.target;
            return !target.closest?.('.bb-map-spatial-card,.bb-map-parent-box,.bb-map-region-box,.bb-map-detail-pane,.bb-map-context-menu');
        },
        onChange() {
            positionElements();
            drawCanvas();
        },
    });

    const resizeObserver = new ResizeObserver(() => {
        positionElements();
        drawCanvas();
    });
    resizeObserver.observe(body);

    body.addEventListener('click', (event) => {
        if (event.target === body || event.target === canvas) {
            selectedId = null;
            renderDetails(null);
            for (const card of cardLayer.querySelectorAll('.bb-map-spatial-card')) card.classList.remove('selected');
        }
    });

    body._bbMapCleanup = () => {
        if (typeof activeDragCleanup === 'function') activeDragCleanup();
        unbind();
        resizeObserver.disconnect();
    };
}

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
        <label style="font-size:0.85em;display:flex;align-items:center;gap:6px;margin-bottom:12px;">
            <input id="bb_map_f_resident" type="checkbox" ${(d.memoryTier === 'core' || d.memoryTier === 'eternal' || d.keepPermanent || d.resident) ? 'checked' : ''} />
            常驻地点
        </label>
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
        const resident = form.querySelector('#bb_map_f_resident')?.checked || false;
        onSave({
            name,
            description: form.querySelector('#bb_map_f_desc').value.trim(),
            region: form.querySelector('#bb_map_f_region').value.trim(),
            parentId: form.querySelector('#bb_map_f_parent').value || null,
            memoryTier: resident ? 'core' : 'transient',
            keepPermanent: resident,
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
    if (existing) {
        const existingBody = existing.querySelector('.bb-map-spatial-body');
        if (typeof existingBody?._bbMapCleanup === 'function') existingBody._bbMapCleanup();
        existing.remove();
    }

    const settings = getSettings();
    let map = await getMap(chatId);
    let items = await getItems(chatId);
    let regions = await getRegions(chatId);
    let visibleRegions = new Set(getRegionKeys(Object.values(map.locations || {}), regions));
    let globalRef = settings.worldRealWorldRef || '';
    let viewMode = loadMapUiPref().viewMode === 'list' ? 'list' : 'spatial'; // 'spatial' | 'list'
    let editMode = false; // v8.8.1 编辑布局模式

    const overlay = document.createElement('div');
    overlay.className = 'bb-map-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99991;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });

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
    header.querySelector('.bb-map-close-btn').addEventListener('click', () => closeOverlay());
    header.querySelector('.bb-map-edit-ref').addEventListener('click', () => {
        const val = prompt('全局现实参考：', globalRef);
        if (val === null) return;
        globalRef = val.trim();
        updateSettings({ worldRealWorldRef: globalRef });
        renderRefBar();
    });
    header.querySelector('.bb-map-view-toggle').addEventListener('click', () => {
        viewMode = viewMode === 'spatial' ? 'list' : 'spatial';
        saveMapUiPref({ viewMode });
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
        const regionKeys = getRegionKeys(Object.values(map.locations || {}), regions);
        visibleRegions = new Set([...visibleRegions].filter(r => regionKeys.includes(r)));
        const allVisible = regionKeys.length > 0 && regionKeys.every(r => visibleRegions.has(r));
        tabBar.innerHTML = `<button class="menu_button bb-map-region-tab ${allVisible ? 'active' : ''}" data-all="1" style="font-size:0.72em;padding:3px 8px;${allVisible ? 'background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;' : ''}">全部</button>`;
        for (const r of regionKeys) {
            const rc = getRegionColor(r);
            const isVisible = visibleRegions.has(r);
            tabBar.innerHTML += `<button class="menu_button bb-map-region-tab ${isVisible ? 'active' : ''}" data-region="${escapeHtml(r)}" style="font-size:0.72em;padding:3px 8px;${isVisible ? 'background:' + rc + '33;border-color:' + rc + ';' : ''}">${escapeHtml(getRegionLabel(r))}</button>`;
        }
        tabBar.querySelectorAll('.bb-map-region-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.all) {
                    if (regionKeys.length > 0 && regionKeys.every(r => visibleRegions.has(r))) visibleRegions.clear();
                    else visibleRegions = new Set(regionKeys);
                } else {
                    const region = btn.dataset.region || '';
                    if (visibleRegions.has(region)) visibleRegions.delete(region);
                    else visibleRegions.add(region);
                }
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

    let escHandler = null;

    async function saveLayout(changedLocs) {
        const unique = [...new Map((changedLocs || []).map(loc => [loc.id, loc])).values()];
        for (const loc of unique) {
            if (!loc?.id) continue;
            await updateLocation(chatId, loc.id, { x: loc.x, y: loc.y });
        }
    }

    function closeOverlay() {
        if (typeof body._bbMapCleanup === 'function') body._bbMapCleanup();
        if (escHandler) document.removeEventListener('keydown', escHandler);
        overlay.remove();
    }

    function refresh() {
        const locs = Object.values(map.locations || {});
        if (viewMode === 'spatial') {
            body.style.cssText = 'flex:1;overflow:hidden;min-height:0;';
            renderSpatialViewV2(body, locs, items, visibleRegions, editMode, handleEdit, handleConnect, handleAddItem, handleDelete, saveLayout);
        } else {
            if (typeof body._bbMapCleanup === 'function') body._bbMapCleanup();
            body.className = 'bb-map-list-body';
            body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 16px;min-height:0;';
            body.innerHTML = buildListHTML(locs, items, visibleRegions, editMode);
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
                visibleRegions.add(el.dataset.region || '');
                renderTabs(); refresh();
            });
        });
    }

    refresh();

    footer.querySelector('#bb_map_add_loc').addEventListener('click', () => {
        showLocationForm('添加地点', {}, async (data) => {
            const position = suggestLocationPosition(data, Object.values(map.locations || {}));
            await addLocation(chatId, { ...data, ...position, source: 'manual' });
            visibleRegions.add(data.region || '');
            map = await getMap(chatId); regions = await getRegions(chatId); renderTabs(); refresh();
            showToast('地点已添加', 'success');
        });
    });
    footer.querySelector('#bb_map_help').addEventListener('click', () => {
        alert('世界地图 v8.8.0\n\n🗺 空间视图：Canvas连线+CSS卡片\n  - 滚轮缩放 | 拖动平移 | 右键菜单\n  - 双击编辑 | 触摸两指拖动\n📋 列表视图：区域分组+连线\n🌉 跨区域：虚线连接，点击跳转\n📐 自动布局：一键整理地点位置');
    });
    escHandler = (e) => {
        if (e.key === 'Escape') closeOverlay();
    };
    document.addEventListener('keydown', escHandler);
}
