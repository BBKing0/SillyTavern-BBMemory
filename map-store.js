/**
 * map-store.js —— BB-Memory v8.7.0 地图记忆数据层（第5支柱）
 *
 * 邻接表存储图结构：每个地点内嵌 edges[] 数组。
 * 支持地点 CRUD、边管理、BFS 路径查找、区域查询。
 */

// ═══ 存储键 ═══
const MAP_KEY = 'bb_map_chat_';

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

// ═══ 数据加载/保存 ═══

async function loadMap(chatId) {
    if (!chatId) return { locations: {} };
    const lf = getLocalForage();
    const data = await lf.getItem(MAP_KEY + chatId);
    return (data && typeof data === 'object' && data.locations) ? data : { locations: {} };
}

async function saveMap(chatId, data) {
    const lf = getLocalForage();
    await lf.setItem(MAP_KEY + chatId, data);
}

// ═══════════════════════════════════════════════════════════
//  地点 CRUD
// ═══════════════════════════════════════════════════════════

export async function getMap(chatId) {
    return loadMap(chatId);
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
        parentId: data.parentId || null,  // v8.7.1 父地点ID（层级）
        x: typeof data.x === 'number' ? data.x : (0.3 + Math.random() * 0.4),  // v8.8.0 2D坐标
        y: typeof data.y === 'number' ? data.y : (0.2 + Math.random() * 0.6),
        edges: Array.isArray(data.edges) ? data.edges : [],
        createdAt: now,
        updatedAt: now,
        source: data.source || 'manual',
        sourceExchange: data.sourceExchange || '',
        sourceFloor: typeof data.sourceFloor === 'number' ? data.sourceFloor : -1,
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
    const regions = [...new Set(locs.map(l => l.region || ''))];
    const regionLocs = {};
    for (const r of regions) {
        regionLocs[r] = locs.filter(l => (l.region || '') === r);
    }

    // 为每个区域分配Y范围
    const regionCount = regions.length || 1;
    for (let ri = 0; ri < regions.length; ri++) {
        const r = regions[ri];
        const rLocs = regionLocs[r];
        const yBase = ri / regionCount;
        const yRange = 0.8 / regionCount;

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
                    if (!visited.has(e.toId)) queue.push(e.toId);
                }
            }
            if (comp.length > 0) components.push(comp);
        }

        // 分配X坐标：每个分量占据一段X范围
        const compCount = components.length || 1;
        for (let ci = 0; ci < components.length; ci++) {
            const comp = components[ci];
            const xBase = ci / compCount;
            const xRange = 0.8 / compCount;

            // 分量内：有连线的节点形成链，无连线的均匀分布
            const connected = comp.filter(l => (l.edges || []).length > 0);
            const isolated = comp.filter(l => (l.edges || []).length === 0);

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
                        if (!bfsVisited.has(e.toId)) bfsQueue.push(e.toId);
                    }
                }
                for (let i = 0; i < bfsOrder.length; i++) {
                    bfsOrder[i].x = xBase + 0.05 + (i / (bfsOrder.length - 1 || 1)) * (xRange - 0.1);
                    bfsOrder[i].y = yBase + 0.02 + Math.random() * yRange * 0.3;
                }
            } else if (connected.length === 1) {
                connected[0].x = xBase + xRange / 2;
                connected[0].y = yBase + yRange * 0.3;
            }

            // 孤立节点
            for (let i = 0; i < isolated.length; i++) {
                isolated[i].x = xBase + 0.05 + (i % 3) * (xRange / 3);
                isolated[i].y = yBase + yRange * 0.5 + Math.floor(i / 3) * (yRange * 0.15);
            }
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
