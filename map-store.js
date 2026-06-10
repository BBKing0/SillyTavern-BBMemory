/**
 * map-store.js —— BB-Memory v8.7.0 地图记忆数据层（第5支柱）
 *
 * 邻接表存储图结构：每个地点内嵌 edges[] 数组。
 * 支持地点 CRUD、边管理、BFS 路径查找、区域查询。
 */

import { getSettings } from './memory-store.js';

// ═══ 存储键 ═══
const MAP_KEY = 'bb_map_chat_';
const SOURCE_ROLLBACK_KEY = '_bbmemSourceRollback';

// ═══ SillyTavern 接口 ═══
function getLocalForage() {
    try {
        return window.SillyTavern.getContext().libs.localforage;
    } catch {
        return window.localforage;
    }
}

function generateId() {
    return 'loc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function deepClonePlain(value) {
    if (!value || typeof value !== 'object') return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return { ...value };
    }
}

function normalizeSourceFloor(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getSourceRollbackFloorWindow() {
    const value = Number(getSettings().sourceRollbackFloorWindow);
    if (!Number.isFinite(value)) return 10;
    return Math.max(0, Math.min(200, Math.floor(value)));
}

function stripUpdateSourceAttribution(patch) {
    const next = { ...patch };
    delete next.source;
    delete next.sourceExchange;
    delete next.sourceFloor;
    delete next.sourceMessageHash;
    delete next.sourceChatId;
    return next;
}

function cloneForSourceRollback(entry) {
    const copy = deepClonePlain(entry);
    if (!copy || typeof copy !== 'object') return null;
    delete copy.embedding;
    delete copy[SOURCE_ROLLBACK_KEY];
    return copy;
}

function pruneStaleSourceRollback(entry, currentFloor) {
    const rollback = entry?.[SOURCE_ROLLBACK_KEY];
    const rollbackFloor = normalizeSourceFloor(rollback?.sourceFloor);
    if (!rollback || rollbackFloor === null || currentFloor === null) return;
    const windowFloors = getSourceRollbackFloorWindow();
    if (rollbackFloor > currentFloor - windowFloors) return;

    const previous = rollback.previous || {};
    if (entry.sourceExchange === rollback.exchange) {
        entry.source = previous.source || entry.source;
        entry.sourceExchange = previous.sourceExchange || '';
        entry.sourceFloor = normalizeSourceFloor(previous.sourceFloor) ?? -1;
        entry.sourceMessageHash = previous.sourceMessageHash || '';
        entry.sourceChatId = previous.sourceChatId || entry.sourceChatId || '';
    }
    delete entry[SOURCE_ROLLBACK_KEY];
}

function attachSourceRollback(entry, patch) {
    const exchange = patch?.sourceExchange;
    if (!entry || !exchange) return patch;
    const currentFloor = normalizeSourceFloor(patch.sourceFloor);
    pruneStaleSourceRollback(entry, currentFloor);
    if (getSourceRollbackFloorWindow() <= 0) return stripUpdateSourceAttribution(patch);
    if (entry[SOURCE_ROLLBACK_KEY]?.exchange === exchange) return patch;
    return {
        ...patch,
        [SOURCE_ROLLBACK_KEY]: {
            exchange,
            sourceFloor: currentFloor,
            createdAt: Date.now(),
            previous: cloneForSourceRollback(entry),
        },
    };
}

// ═══ 数据加载/保存 ═══

async function loadMap(chatId) {
    if (!chatId) return { locations: {} };
    const lf = getLocalForage();
    const data = await lf.getItem(MAP_KEY + chatId);
    return (data && typeof data === 'object' && data.locations) ? data : { locations: {} };
}

async function saveMap(chatId, data, options = {}) {
    const lf = getLocalForage();
    await lf.setItem(MAP_KEY + chatId, data);
    if (!options.skipBackup) {
        import('./memory-store.js')
            .then(m => m.scheduleAutoBackup?.(chatId))
            .catch(() => {});
    }
}

// ═══════════════════════════════════════════════════════════
//  地点 CRUD
// ═══════════════════════════════════════════════════════════

export async function getMap(chatId) {
    return loadMap(chatId);
}

export async function setMap(chatId, data, options = {}) {
    const safe = (data && typeof data === 'object' && data.locations)
        ? { ...data, locations: data.locations || {} }
        : { locations: {} };
    await saveMap(chatId, safe, options);
    return safe;
}

export async function getLocations(chatId) {
    const map = await loadMap(chatId);
    return Object.values(map.locations || {});
}

export async function addLocation(chatId, data) {
    const map = await loadMap(chatId);
    const now = Date.now();
    const id = generateId();
    const entry = {
        id,
        name: data.name || '',
        description: data.description || '',
        realWorldRef: data.realWorldRef || '',
        region: data.region || '',
        embedding: data.embedding ?? null,
        parentId: data.parentId || null,  // v8.7.1 父地点ID（层级）
        memoryTier: data.memoryTier || 'transient',
        keepPermanent: data.keepPermanent || false,
        resident: data.resident || false,
        category: data.category || null,
        x: typeof data.x === 'number' ? data.x : (0.3 + Math.random() * 0.4),  // v8.8.0 2D坐标
        y: typeof data.y === 'number' ? data.y : (0.2 + Math.random() * 0.6),
        edges: Array.isArray(data.edges) ? data.edges : [],
        hitCount: data.hitCount || 0,
        lastHitAt: data.lastHitAt || null,
        createdAt: now,
        updatedAt: now,
        source: data.source || 'manual',
        sourceExchange: data.sourceExchange || '',
        sourceFloor: typeof data.sourceFloor === 'number' ? data.sourceFloor : -1,
        creationFloor: typeof data.creationFloor === 'number' ? data.creationFloor : (typeof data.sourceFloor === 'number' ? data.sourceFloor : -1),
        sourceMessageHash: data.sourceMessageHash || '',
        sourceChatId: data.sourceChatId || '',
        archived: data.archived || false,  // v8.8.1
    };
    map.locations[id] = entry;
    await saveMap(chatId, map);
    // 如果指定了双向连接，自动在目标地点添加反向边
    if (Array.isArray(data.edges)) {
        for (const edge of data.edges) {
            if (edge.bidirectional && map.locations[edge.toId]) {
                const reverse = {
                    toId: id,
                    distance: edge.distance || '',
                    pathType: edge.pathType || '',
                    difficulty: edge.difficulty || 'normal',
                };
                const target = map.locations[edge.toId];
                if (!target.edges.some(e => e.toId === id)) {
                    target.edges.push(reverse);
                }
            }
        }
        await saveMap(chatId, map);
    }
    return entry;
}

export async function updateLocation(chatId, id, patch) {
    const map = await loadMap(chatId);
    const loc = map.locations[id];
    if (!loc) return null;
    patch = attachSourceRollback(loc, patch);
    const { id: _id, createdAt: _ca, ...safe } = patch;
    Object.assign(loc, safe);
    loc.updatedAt = Date.now();
    await saveMap(chatId, map);
    return loc;
}

export async function removeLocation(chatId, id) {
    const map = await loadMap(chatId);
    if (!map.locations[id]) return false;
    delete map.locations[id];
    // 清理所有指向此节点的边
    for (const loc of Object.values(map.locations)) {
        loc.edges = loc.edges.filter(e => e.toId !== id);
    }
    await saveMap(chatId, map);
    return true;
}

// ═══════════════════════════════════════════════════════════
//  边管理
// ═══════════════════════════════════════════════════════════

export async function addEdge(chatId, fromId, edgeData) {
    const map = await loadMap(chatId);
    const loc = map.locations[fromId];
    if (!loc) return null;
    if (loc.edges.some(e => e.toId === edgeData.toId)) return loc; // 已存在
    loc.edges.push({
        toId: edgeData.toId,
        distance: edgeData.distance || '',
        pathType: edgeData.pathType || '',
        difficulty: edgeData.difficulty || 'normal',
    });
    loc.updatedAt = Date.now();
    await saveMap(chatId, map);
    return loc;
}

export async function addBidirectionalEdge(chatId, id1, id2, edgeData) {
    const map = await loadMap(chatId);
    const loc1 = map.locations[id1];
    const loc2 = map.locations[id2];
    if (!loc1 || !loc2) return false;

    if (!loc1.edges.some(e => e.toId === id2)) {
        loc1.edges.push({ toId: id2, distance: edgeData.distance || '', pathType: edgeData.pathType || '', difficulty: edgeData.difficulty || 'normal' });
    }
    if (!loc2.edges.some(e => e.toId === id1)) {
        loc2.edges.push({ toId: id1, distance: edgeData.distance || '', pathType: edgeData.pathType || '', difficulty: edgeData.difficulty || 'normal' });
    }
    loc1.updatedAt = Date.now();
    loc2.updatedAt = Date.now();
    await saveMap(chatId, map);
    return true;
}

export async function removeEdge(chatId, fromId, toId) {
    const map = await loadMap(chatId);
    const loc = map.locations[fromId];
    if (!loc) return false;
    const before = loc.edges.length;
    loc.edges = loc.edges.filter(e => e.toId !== toId);
    if (loc.edges.length < before) {
        loc.updatedAt = Date.now();
        await saveMap(chatId, map);
        return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════
//  图算法：BFS 最短路径
// ═══════════════════════════════════════════════════════════

export async function findPath(chatId, startId, endId) {
    const map = await loadMap(chatId);
    if (!map.locations[startId] || !map.locations[endId]) return null;

    const visited = new Set();
    const queue = [[startId]];
    visited.add(startId);

    while (queue.length > 0) {
        const path = queue.shift();
        const current = path[path.length - 1];
        if (current === endId) return path;

        const loc = map.locations[current];
        if (!loc) continue;

        for (const edge of (loc.edges || [])) {
            if (!visited.has(edge.toId)) {
                visited.add(edge.toId);
                queue.push([...path, edge.toId]);
            }
        }
    }
    return null; // 无路径
}

// ═══════════════════════════════════════════════════════════
//  区域查询
// ═══════════════════════════════════════════════════════════

export async function getRegions(chatId) {
    const locations = await getLocations(chatId);
    const regions = new Set();
    for (const loc of locations) {
        if (loc.region) regions.add(loc.region);
    }
    return [...regions].sort();
}

export async function getLocationsInRegion(chatId, region) {
    const locations = await getLocations(chatId);
    return locations.filter(l => l.region === region);
}

export async function getMapStats(chatId) {
    const map = await loadMap(chatId);
    const locations = Object.values(map.locations || {});
    let edgeCount = 0;
    for (const loc of locations) edgeCount += (loc.edges || []).length;
    return {
        locationCount: locations.length,
        edgeCount,
        regions: [...new Set(locations.map(l => l.region).filter(Boolean))],
    };
}

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
//  v8.8.1 归档/恢复
// ═══════════════════════════════════════════════════════════

export async function archiveLocation(chatId, id) {
    const map = await loadMap(chatId);
    const loc = map.locations[id];
    if (!loc) return false;
    loc.archived = true;
    loc.updatedAt = Date.now();
    await saveMap(chatId, map);
    return true;
}

export async function restoreLocation(chatId, id) {
    const map = await loadMap(chatId);
    const loc = map.locations[id];
    if (!loc) return false;
    loc.archived = false;
    loc.updatedAt = Date.now();
    await saveMap(chatId, map);
    return true;
}

// ═══════════════════════════════════════════════════════════
//  v8.8.0 自动布局：力导向算法
// ═══════════════════════════════════════════════════════════

export async function autoLayout(chatId) {
    const map = await loadMap(chatId);
    const locs = Object.values(map.locations || {});
    if (locs.length === 0) return;

    // 按区域分组，分配到不同Y区域
    const regions = [...new Set(locs.map(l => l.region || ''))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const regionLocs = {};
    for (const r of regions) {
        regionLocs[r] = locs.filter(l => (l.region || '') === r);
    }
    const locRegion = new Map(locs.map(l => [l.id, l.region || '']));

    // 为每个区域分配Y范围
    const regionCount = regions.length || 1;
    const cols = Math.max(1, Math.ceil(Math.sqrt(regionCount)));
    const rows = Math.max(1, Math.ceil(regionCount / cols));
    const gap = 0.035;
    for (let ri = 0; ri < regions.length; ri++) {
        const r = regions[ri];
        const rLocs = regionLocs[r];
        const col = ri % cols;
        const row = Math.floor(ri / cols);
        const cellW = 1 / cols;
        const cellH = 1 / rows;
        const xMin = Math.min(0.95, col * cellW + gap);
        const yMin = Math.min(0.95, row * cellH + gap);
        const xMax = Math.max(xMin + 0.05, (col + 1) * cellW - gap);
        const yMax = Math.max(yMin + 0.05, (row + 1) * cellH - gap);
        const xRange = Math.max(0.05, xMax - xMin);
        const yRange = Math.max(0.05, yMax - yMin);

        // 区域内按连通分量分组X
        const visited = new Set();
        const components = [];
        for (const loc of rLocs) {
            if (visited.has(loc.id)) continue;
            const comp = [];
            const queue = [loc.id];
            while (queue.length) {
                const id = queue.shift();
                if (visited.has(id)) continue;
                visited.add(id);
                const l = map.locations[id];
                if (!l) continue;
                comp.push(l);
                for (const e of (l.edges || [])) {
                    if (locRegion.get(e.toId) === r && !visited.has(e.toId)) queue.push(e.toId);
                }
            }
            if (comp.length > 0) components.push(comp);
        }

        // 分配X坐标：每个分量占据一段X范围
        const compCount = components.length || 1;
        for (let ci = 0; ci < components.length; ci++) {
            const comp = components[ci];
            const compMinX = xMin + (ci / compCount) * xRange;
            const compMaxX = xMin + ((ci + 1) / compCount) * xRange;
            const compWidth = Math.max(0.04, compMaxX - compMinX);
            const compPadX = Math.min(0.035, compWidth * 0.18);
            const compLeft = compMinX + compPadX;
            const compRight = compMaxX - compPadX;
            const compSpan = Math.max(0.02, compRight - compLeft);

            // 分量内：有连线的节点形成链，无连线的均匀分布
            const connected = comp.filter(l => (l.edges || []).some(e => locRegion.get(e.toId) === r));
            const isolated = comp.filter(l => !(l.edges || []).some(e => locRegion.get(e.toId) === r));

            // 连接节点：BFS排序后均匀分布
            if (connected.length > 1) {
                const bfsOrder = [];
                const bfsVisited = new Set();
                const start = connected[0];
                const bfsQueue = [start.id];
                while (bfsQueue.length) {
                    const id = bfsQueue.shift();
                    if (bfsVisited.has(id)) continue;
                    bfsVisited.add(id);
                    const l = map.locations[id];
                    if (l) bfsOrder.push(l);
                    for (const e of (l?.edges || [])) {
                        if (locRegion.get(e.toId) === r && !bfsVisited.has(e.toId)) bfsQueue.push(e.toId);
                    }
                }
                for (let i = 0; i < bfsOrder.length; i++) {
                    bfsOrder[i].x = compLeft + (i / (bfsOrder.length - 1 || 1)) * compSpan;
                    bfsOrder[i].y = yMin + yRange * (0.2 + (i % 2) * 0.18);
                }
            } else if (connected.length === 1) {
                connected[0].x = compMinX + compWidth / 2;
                connected[0].y = yMin + yRange * 0.28;
            }

            // 孤立节点
            for (let i = 0; i < isolated.length; i++) {
                const isoCols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(isolated.length))));
                const isoRows = Math.max(1, Math.ceil(isolated.length / isoCols));
                const ix = i % isoCols;
                const iy = Math.floor(i / isoCols);
                isolated[i].x = compMinX + compWidth * ((ix + 1) / (isoCols + 1));
                isolated[i].y = yMin + yRange * (0.55 + (iy / Math.max(1, isoRows)) * 0.35);
                isolated[i].x = Math.max(xMin + 0.02, Math.min(xMax - 0.02, isolated[i].x));
                isolated[i].y = Math.max(yMin + 0.02, Math.min(yMax - 0.02, isolated[i].y));
            }
        }

        const childrenByParent = new Map();
        for (const loc of rLocs) {
            const parent = loc.parentId ? map.locations[loc.parentId] : null;
            if (!parent || (parent.region || '') !== r) continue;
            if (!childrenByParent.has(parent.id)) childrenByParent.set(parent.id, []);
            childrenByParent.get(parent.id).push(loc);
        }
        for (const [parentId, children] of childrenByParent.entries()) {
            const parent = map.locations[parentId];
            if (!parent) continue;
            const radius = Math.max(0.035, Math.min(xRange, yRange) * 0.16);
            const angleStep = (Math.PI * 2) / Math.max(1, children.length);
            children.forEach((child, i) => {
                const angle = -Math.PI / 2 + i * angleStep;
                child.x = parent.x + Math.cos(angle) * radius;
                child.y = parent.y + Math.sin(angle) * radius;
                child.x = Math.max(xMin + 0.025, Math.min(xMax - 0.025, child.x));
                child.y = Math.max(yMin + 0.025, Math.min(yMax - 0.025, child.y));
            });
        }
    }

    await saveMap(chatId, map);
    return map;
}

// ═══════════════════════════════════════════════════════════
//  物品联动：查询某地点的物品
// ═══════════════════════════════════════════════════════════

/**
 * 获取指定地点的物品列表（从 Item 支柱反向查询）
 * 需要调用方传入 getItems 函数以避免循环依赖
 */
export async function getItemsAtLocation(getItemsFn, chatId, locationName) {
    if (!locationName) return [];
    const items = await getItemsFn(chatId);
    return items.filter(i => !i.archived && i.location === locationName);
}
