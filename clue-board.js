/**
 * clue-board.js —— BB-Memory v8.4.5 线索板系统
 *
 * 让用户将四柱条目摆上线索板，手动创建连线（因果/暗示/矛盾/关联/推测）。
 * AI 在生成回复时看到用户的推理，自主决定顺着线索推进或提供反例。
 */

import {
    getNpcProfiles, getItems, getTimeline, getMemories,
    getSettings, updateSettings,
} from './memory-store.js';

// ═══════════════════════════════════════════════════════════
//  数据层
// ═══════════════════════════════════════════════════════════

const CLUE_BOARD_KEY = 'bb_clue_board_';

function getLocalForage() {
    return SillyTavern.libs.localforage;
}

function generateId() {
    return 'cb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

async function loadBoard(chatId) {
    if (!chatId) return { nodes: [], connections: [] };
    const data = await getLocalForage().getItem(CLUE_BOARD_KEY + chatId);
    if (data && typeof data === 'object') {
        return {
            nodes: Array.isArray(data.nodes) ? data.nodes : [],
            connections: Array.isArray(data.connections) ? data.connections : [],
            updatedAt: data.updatedAt || 0,
        };
    }
    return { nodes: [], connections: [], updatedAt: 0 };
}

async function saveBoard(chatId, board) {
    board.updatedAt = Date.now();
    await getLocalForage().setItem(CLUE_BOARD_KEY + chatId, board);
}

// ═══════════════════════════════════════════════════════════
//  CRUD
// ═══════════════════════════════════════════════════════════

export async function getClueBoard(chatId) {
    return loadBoard(chatId);
}

export async function addClueNode(chatId, data) {
    const board = await loadBoard(chatId);
    const node = {
        id: generateId(),
        refType: data.refType || 'mem',
        refId: data.refId || '',
        label: data.label || '',
        note: data.note || '',
        createdAt: Date.now(),
    };
    board.nodes.push(node);
    await saveBoard(chatId, board);
    return node;
}

export async function removeClueNode(chatId, nodeId) {
    const board = await loadBoard(chatId);
    const before = board.nodes.length;
    board.nodes = board.nodes.filter(n => n.id !== nodeId);
    // 同时删除所有关联连线
    board.connections = board.connections.filter(
        c => c.fromNodeId !== nodeId && c.toNodeId !== nodeId
    );
    if (board.nodes.length < before) {
        await saveBoard(chatId, board);
        return true;
    }
    return false;
}

export async function updateClueNode(chatId, nodeId, patch) {
    const board = await loadBoard(chatId);
    const node = board.nodes.find(n => n.id === nodeId);
    if (!node) return null;
    if (patch.label !== undefined) node.label = patch.label;
    if (patch.note !== undefined) node.note = patch.note;
    await saveBoard(chatId, board);
    return node;
}

export async function addClueConnection(chatId, data) {
    const board = await loadBoard(chatId);
    const conn = {
        id: generateId(),
        fromNodeId: data.fromNodeId || '',
        toNodeId: data.toNodeId || '',
        type: data.type || 'related',
        confidence: data.confidence || 'medium',
        label: data.label || '',
        createdAt: Date.now(),
    };
    board.connections.push(conn);
    await saveBoard(chatId, board);
    return conn;
}

export async function removeClueConnection(chatId, connId) {
    const board = await loadBoard(chatId);
    const before = board.connections.length;
    board.connections = board.connections.filter(c => c.id !== connId);
    if (board.connections.length < before) {
        await saveBoard(chatId, board);
        return true;
    }
    return false;
}

export async function updateClueConnection(chatId, connId, patch) {
    const board = await loadBoard(chatId);
    const conn = board.connections.find(c => c.id === connId);
    if (!conn) return null;
    if (patch.type !== undefined) conn.type = patch.type;
    if (patch.confidence !== undefined) conn.confidence = patch.confidence;
    if (patch.label !== undefined) conn.label = patch.label;
    await saveBoard(chatId, board);
    return conn;
}

// ═══════════════════════════════════════════════════════════
//  注入格式化
// ═══════════════════════════════════════════════════════════

export function hasActiveClues(board) {
    return !!(board && board.nodes && board.nodes.length > 0);
}

const CONN_TYPE_LABEL = {
    causal: '→因果→',
    hint: '→暗示→',
    contradicts: '→矛盾→',
    related: '→关联→',
    speculation: '→推测→',
};

const CONFIDENCE_LABEL = {
    high: '信心：高',
    medium: '信心：中',
    low: '信心：低',
};

export function buildClueBoardInjection(board) {
    if (!hasActiveClues(board)) return '';

    const nodeMap = new Map();
    for (const n of board.nodes) nodeMap.set(n.id, n);

    const lines = [
        '【玩家推理板】',
        '以下是玩家当前追踪的线索推测。这些推测可能正确也可能错误——',
        '你可以顺着线索推进，也可以提供反例来制造叙事张力。',
        '',
    ];

    // 有连线的节点：按连线格式化
    const connectedNodes = new Set();
    for (const conn of board.connections) {
        const fromNode = nodeMap.get(conn.fromNodeId);
        const toNode = nodeMap.get(conn.toNodeId);
        if (!fromNode || !toNode) continue;

        connectedNodes.add(conn.fromNodeId);
        connectedNodes.add(conn.toNodeId);

        const typeStr = CONN_TYPE_LABEL[conn.type] || '→关联→';
        const confStr = CONFIDENCE_LABEL[conn.confidence] || '信心：中';
        const fromLabel = fromNode.label || fromNode.id;
        const toLabel = toNode.label || toNode.id;

        lines.push(`● [${fromLabel}] ${typeStr} [${toLabel}]（${confStr}）`);

        if (fromNode.note) {
            lines.push(`  玩家推测：${fromNode.note}`);
        }
        if (conn.label) {
            lines.push(`  备注：${conn.label}`);
        }
    }

    // 孤立节点：单独列出
    for (const n of board.nodes) {
        if (!connectedNodes.has(n.id)) {
            lines.push(`● [${n.label || n.id}]（待连线）`);
            if (n.note) lines.push(`  玩家备注：${n.note}`);
        }
    }

    lines.push('');
    lines.push('叙事建议：高信心线索通常应顺着发展；中信心可部分证实部分推翻；');
    lines.push('低信心线索是设置反转的最佳位置。不要一次性回收所有线索——留一些给未来的轮次。');

    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

async function getChatId() {
    try {
        const ctx = SillyTavern.getContext();
        return ctx.chatId || (ctx.chat?.[0]?.chatId) || null;
    } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
//  UI —— 线索板面板
// ═══════════════════════════════════════════════════════════

export async function openClueBoard(chatId) {
    const existing = document.querySelector('.bb-clue-overlay');
    if (existing) existing.remove();

    const board = await getClueBoard(chatId);
    const nodeMap = new Map();
    for (const n of board.nodes) nodeMap.set(n.id, n);

    const overlay = document.createElement('div');
    overlay.className = 'bb-clue-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const panel = document.createElement('div');
    panel.className = 'bb-clue-panel';
    panel.style.cssText = 'background:var(--SmartThemeChatTintColor,#1e1e2e);color:var(--SmartThemeBodyColor,#e0e0e0);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:14px;width:min(620px,94vw);max-height:85vh;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,0.5);';
    overlay.appendChild(panel);

    // ── 头部 ──
    const header = document.createElement('div');
    header.className = 'bb-clue-header';
    header.style.cssText = 'display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;';

    header.innerHTML = `
        <i class="fa-solid fa-magnifying-glass" style="color:#ff9800;"></i>
        <div style="flex:1;">
            <strong>线索板</strong>
            <span class="bb-clue-count" style="font-size:0.78em;opacity:0.5;margin-left:6px;">${board.nodes.length} 节点 · ${board.connections.length} 连线</span>
        </div>
        <button class="bb-clue-close-btn" style="background:none;border:none;color:inherit;font-size:22px;cursor:pointer;opacity:0.6;line-height:1;padding:0 4px;">&times;</button>
    `;
    header.querySelector('.bb-clue-close-btn').addEventListener('click', () => overlay.remove());
    panel.appendChild(header);

    // ── 主体 ──
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 18px;min-height:0;';
    body._clueBoard = board;
    panel.appendChild(body);

    // ── 底部工具栏 ──
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;padding:10px 18px;border-top:1px solid var(--SmartThemeBorderColor,#45475a);flex-shrink:0;flex-wrap:wrap;';
    footer.innerHTML = `
        <button class="menu_button" id="bb_clue_add_node" style="font-size:0.85em;">
            <i class="fa-solid fa-plus"></i> 添加节点
        </button>
        <button class="menu_button" id="bb_clue_add_conn" style="font-size:0.85em;" ${board.nodes.length < 2 ? 'disabled' : ''}>
            <i class="fa-solid fa-arrow-right-arrow-left"></i> 新建连线
        </button>
        <button class="menu_button" id="bb_clue_help" style="font-size:0.85em;opacity:0.6;margin-left:auto;">
            <i class="fa-solid fa-question"></i> 帮助
        </button>
    `;
    panel.appendChild(footer);

    document.body.appendChild(overlay);

    // ── 渲染内容 ──
    renderClueBoardBody(body, board, chatId, overlay);

    // ── 底部按钮事件 ──
    footer.querySelector('#bb_clue_add_node').addEventListener('click', () => {
        showAddNodeDialog(chatId, async () => {
            const newBoard = await getClueBoard(chatId);
            refreshClueBoard(body, newBoard, chatId, overlay, panel);
        });
    });
    footer.querySelector('#bb_clue_add_conn').addEventListener('click', () => {
        const currentBoard = body._clueBoard || board;
        if (!currentBoard.nodes || currentBoard.nodes.length < 2) return;
        showAddConnectionDialog(currentBoard.nodes, async (connData) => {
            await addClueConnection(chatId, connData);
            const newBoard = await getClueBoard(chatId);
            refreshClueBoard(body, newBoard, chatId, overlay, panel);
        });
    });
    footer.querySelector('#bb_clue_help').addEventListener('click', () => {
        const msg = [
            '线索板使用指南',
            '',
            '1. 【添加节点】从记忆库中选择条目摆上线索板',
            '2. 【新建连线】在两个节点间创建关系',
            '   - 因果：A导致B',
            '   - 暗示：A暗示B可能是真的',
            '   - 矛盾：A与B互相矛盾',
            '   - 关联：A和B有某种联系',
            '   - 推测：玩家猜测A和B的关系',
            '3. 【信心】表示你对这条连线的确定程度',
            '4. AI看到你的线索板后会自然地在叙事中响应——',
            '   不会直接告诉你"你对了"或"你错了"',
        ].join('\n');
        alert(msg);
    });

    // ESC 关闭
    const onKeyDown = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKeyDown); } };
    document.addEventListener('keydown', onKeyDown);
}

function refreshClueBoard(body, board, chatId, overlay, panel) {
    body.innerHTML = '';
    renderClueBoardBody(body, board, chatId, overlay, panel);
    body._clueBoard = board;
    if (panel) {
        const connBtn = panel.querySelector('#bb_clue_add_conn');
        if (connBtn) connBtn.disabled = board.nodes.length < 2;
        const countEl = panel.querySelector('.bb-clue-count');
        if (countEl) countEl.textContent = board.nodes.length + ' 节点 · ' + board.connections.length + ' 连线';
    }
}

function showToast(msg, type = 'info') {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.[type] === 'function') {
            ctx.toastr[type](msg, '', { timeOut: 2000 });
        }
    } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════
//  SVG 图形视图
// ═══════════════════════════════════════════════════════════

function renderClueBoardBody(body, board, chatId, overlay, panel) {
    const nodeMap = new Map();
    for (const n of board.nodes) nodeMap.set(n.id, n);

    if (!board.nodes.length) {
        body.innerHTML = `
            <div style="text-align:center;padding:48px 20px;opacity:0.5;">
                <i class="fa-solid fa-magnifying-glass" style="font-size:2.5em;display:block;margin-bottom:16px;opacity:0.2;"></i>
                <div style="font-size:0.95em;">还没有线索节点</div>
                <div style="font-size:0.78em;margin-top:6px;">点击下方"添加节点"从记忆库中选择条目</div>
            </div>`;
        return;
    }

    // 颜色定义
    const refColors = { mem: '#ce93d8', npc: '#64b5f6', item: '#ffb74d', timeline: '#81c784' };
    const refIcons = { mem: 'fa-brain', npc: 'fa-user', item: 'fa-box', timeline: 'fa-clock' };
    const refLabels = { mem: '记忆', npc: 'NPC', item: '物品', timeline: '时间线' };
    const typeColors = { causal: '#ff9800', hint: '#2196f3', contradicts: '#f44336', related: '#9e9e9e', speculation: '#ce93d8' };
    const typeIcons = { causal: '⚡', hint: '💡', contradicts: '⚠️', related: '🔗', speculation: '❓' };
    const typeOrder = { causal: 0, hint: 1, contradicts: 2, related: 3, speculation: 4 };
    const confidenceLabels = { high: '确信', medium: '可能', low: '猜测' };

    // 统计
    const inCount = new Map(), outCount = new Map(), nodeConnsMap = new Map();
    for (const node of board.nodes) {
        inCount.set(node.id, 0); outCount.set(node.id, 0); nodeConnsMap.set(node.id, []);
    }
    for (const conn of board.connections) {
        inCount.set(conn.toNodeId, (inCount.get(conn.toNodeId) || 0) + 1);
        outCount.set(conn.fromNodeId, (outCount.get(conn.fromNodeId) || 0) + 1);
        const refs = nodeConnsMap.get(conn.fromNodeId);
        if (refs) refs.push(conn);
    }

    // 推理链缓存（每个节点只算一次）
    const chainCache = new Map();
    function getChainsForNode(startId) {
        if (chainCache.has(startId)) return chainCache.get(startId);
        function findChains(id, visited, depth) {
            if (depth > 4 || visited.has(id)) return [];
            visited.add(id);
            const chains = [];
            const outConns = board.connections.filter(c => c.fromNodeId === id && !visited.has(c.toNodeId));
            for (const conn of outConns) {
                const subChains = findChains(conn.toNodeId, new Set(visited), depth + 1);
                if (subChains.length === 0) { chains.push([conn]); }
                else { for (const sub of subChains) chains.push([conn, ...sub]); }
            }
            return chains;
        }
        const result = findChains(startId, new Set(), 0);
        chainCache.set(startId, result);
        return result;
    }

    // ── 统计栏 ──
    const connTypeCounts = { causal: 0, hint: 0, contradicts: 0, related: 0, speculation: 0 };
    for (const conn of board.connections) { if (connTypeCounts[conn.type] !== undefined) connTypeCounts[conn.type]++; }
    const totalBar = board.connections.length || 1;
    const barHTML = Object.entries(connTypeCounts).filter(([,v]) => v > 0).map(([k, v]) => {
        const pct = Math.round((v / totalBar) * 100);
        return `<span style="display:inline-flex;align-items:center;gap:2px;background:${typeColors[k]}22;border:1px solid ${typeColors[k]}44;border-radius:3px;padding:1px 5px;font-size:0.68em;color:${typeColors[k]};" title="${typeIcons[k]} ${k}: ${v}条">${typeIcons[k]}${v}</span>`;
    }).join('');
    body.innerHTML = `
        <div class="bb-clue-stats-bar" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0 10px;margin-bottom:4px;border-bottom:1px solid var(--SmartThemeBorderColor,#3333);font-size:0.78em;opacity:0.75;">
            <span><strong>${board.nodes.length}</strong> 节点</span>
            <span style="opacity:0.3;">·</span>
            <span><strong>${board.connections.length}</strong> 连线</span>
            <span style="flex:1;"></span>
            ${barHTML}
        </div>`;

    // ── 节点列表 ──
    for (const node of board.nodes) {
        const nodeConns = (nodeConnsMap.get(node.id) || []).sort((a, b) => (typeOrder[a.type] || 99) - (typeOrder[b.type] || 99));
        const rc = refColors[node.refType] || '#888';
        const ri = refIcons[node.refType] || 'fa-circle';
        const rl = refLabels[node.refType] || '';
        const inN = inCount.get(node.id) || 0;
        const outN = outCount.get(node.id) || 0;
        const chains = getChainsForNode(node.id);
        const hasChain = chains.some(c => c.length >= 2);

        // 节点卡片 — 左侧色条+简洁布局
        const card = document.createElement('div');
        card.className = 'bb-clue-node-card';
        card.style.cssText = `margin-bottom:10px;background:var(--SmartThemeBlurTintColor,rgba(255,255,255,0.015));border:1px solid var(--SmartThemeBorderColor,#3a3a4a);border-left:4px solid ${rc};border-radius:6px;overflow:hidden;`;
        card.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;">
                <span style="background:${rc}22;border-radius:3px;padding:1px 5px;font-size:0.65em;color:${rc};flex-shrink:0;" title="来源: ${rl}">${rl}</span>
                <span class="bb-clue-node-label" data-node-id="${node.id}" style="flex:1;font-size:0.9em;font-weight:600;cursor:text;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="点击编辑名称">${escapeHtml(node.label || node.id)}</span>
                ${(inN > 0 || outN > 0) ? `<span style="font-size:0.65em;opacity:0.35;flex-shrink:0;">${inN > 0 ? '←'+inN : ''}${inN>0&&outN>0?' ':''}${outN > 0 ? outN+'→' : ''}</span>` : ''}
                ${hasChain ? `<span style="font-size:0.62em;opacity:0.25;flex-shrink:0;" title="含推理链">🔗</span>` : ''}
                <button class="bb-clue-node-menu-btn menu_button" data-node-id="${node.id}" style="font-size:0.7em;padding:1px 4px;opacity:0.3;flex-shrink:0;" title="更多操作">···</button>
            </div>
            ${node.note ? `<div style="padding:0 12px 10px;font-size:0.76em;opacity:0.5;border-top:1px solid var(--SmartThemeBorderColor,#3a3a4a11);margin-top:2px;padding-top:8px;">${escapeHtml(node.note)}</div>` : ''}
            <div class="bb-clue-node-actions" data-node-id="${node.id}" style="display:none;padding:0 12px 8px;gap:4px;font-size:0.7em;border-top:1px solid var(--SmartThemeBorderColor,#3a3a4a22);padding-top:6px;">
                <button class="bb-clue-node-edit menu_button" data-node-id="${node.id}" style="font-size:0.85em;padding:2px 8px;">✏️ 备注</button>
                <button class="bb-clue-node-del menu_button" data-node-id="${node.id}" style="font-size:0.85em;padding:2px 8px;color:#f44336;">🗑 删除</button>
            </div>`;
        body.appendChild(card);

        // 连线区 — 可折叠分组
        if (nodeConns.length) {
            const connBlock = document.createElement('div');
            connBlock.style.cssText = 'margin-left:12px;margin-bottom:6px;';

            // 分组
            const groups = new Map();
            for (const conn of nodeConns) {
                if (!groups.has(conn.type)) groups.set(conn.type, []);
                groups.get(conn.type).push(conn);
            }

            for (const [type, conns] of groups) {
                const tc = typeColors[type] || '#888';
                const ti = typeIcons[type] || '🔗';
                const typeName = CONN_TYPE_LABEL[type]?.replace(/→/g, '') || type;

                // 可折叠组标题
                const groupToggle = document.createElement('div');
                groupToggle.className = 'bb-clue-group-toggle';
                const groupId = `clue_group_${node.id}_${type}`;
                groupToggle.style.cssText = `display:flex;align-items:center;gap:4px;font-size:0.72em;color:${tc};cursor:pointer;padding:3px 4px;border-radius:3px;user-select:none;`;
                groupToggle.innerHTML = `<span class="bb-clue-group-arrow" style="display:inline-block;width:10px;transition:transform 0.15s;">▼</span> ${ti} <strong>${typeName}</strong> (${conns.length})`;
                connBlock.appendChild(groupToggle);

                const groupBody = document.createElement('div');
                groupBody.className = 'bb-clue-group-body';
                groupBody.style.cssText = 'padding-left:4px;';

                let isExpanded = true;
                groupToggle.addEventListener('click', () => {
                    isExpanded = !isExpanded;
                    groupBody.style.display = isExpanded ? 'block' : 'none';
                    groupToggle.querySelector('.bb-clue-group-arrow').textContent = isExpanded ? '▼' : '▶';
                });

                for (const conn of conns) {
                    const toNode = nodeMap.get(conn.toNodeId);
                    if (!toNode) continue;
                    const confidenceLabel = confidenceLabels[conn.confidence] || conn.confidence;

                    // 检查是否推理链起点
                    const isChainStart = chains.some(c => c.length >= 2 && c[0].id === conn.id);

                    const row = document.createElement('div');
                    row.className = 'bb-clue-connection';
                    row.style.cssText = `display:flex;align-items:center;gap:4px;padding:3px 4px;font-size:0.78em;border-radius:3px;margin-bottom:1px;`;
                    row.innerHTML = `
                        <span style="color:${tc};font-size:0.8em;flex-shrink:0;">→</span>
                        <strong style="font-size:0.95em;">${escapeHtml(toNode.label || toNode.id)}</strong>
                        <span style="font-size:0.7em;opacity:0.6;">${confidenceLabel}</span>
                        ${conn.label ? `<span style="font-size:0.7em;opacity:0.4;font-style:italic;">${escapeHtml(conn.label)}</span>` : ''}
                        ${isChainStart ? `<span style="font-size:0.6em;opacity:0.3;" title="推理链">🔗</span>` : ''}
                        <span style="flex:1;"></span>
                        <button class="bb-clue-conn-edit menu_button" data-conn-id="${conn.id}" style="font-size:0.6em;padding:0 3px;opacity:0.3;">✏️</button>
                        <button class="bb-clue-conn-del menu_button" data-conn-id="${conn.id}" style="font-size:0.6em;padding:0 3px;opacity:0.3;color:#f44336;">✕</button>
                    `;
                    groupBody.appendChild(row);

                    // 推理链后续步
                    if (isChainStart) {
                        const chain = chains.find(c => c.length >= 2 && c[0].id === conn.id);
                        if (chain) {
                            for (let i = 1; i < chain.length; i++) {
                                const step = chain[i];
                                const stepTo = nodeMap.get(step.toNodeId);
                                if (!stepTo) continue;
                                const stc = typeColors[step.type] || '#888';
                                const subRow = document.createElement('div');
                                subRow.style.cssText = `display:flex;align-items:center;gap:3px;padding:1px 4px 1px 18px;font-size:0.7em;opacity:0.55;`;
                                subRow.innerHTML = `
                                    <span style="font-size:0.7em;">└</span>
                                    <span style="color:${stc};font-size:0.75em;">→</span>
                                    <strong>${escapeHtml(stepTo.label || stepTo.id)}</strong>
                                    <span style="font-size:0.7em;">${confidenceLabels[step.confidence] || step.confidence}</span>
                                `;
                                groupBody.appendChild(subRow);
                            }
                        }
                    }
                }
                connBlock.appendChild(groupBody);
            }
            body.appendChild(connBlock);
        }
    }

    // ── 事件绑定 ──
    // 节点菜单按钮：切换操作栏显示
    body.querySelectorAll('.bb-clue-node-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const actions = body.querySelector(`.bb-clue-node-actions[data-node-id="${btn.dataset.nodeId}"]`);
            if (actions) actions.style.display = actions.style.display === 'none' ? 'flex' : 'none';
        });
    });
    // 编辑备注
    body.querySelectorAll('.bb-clue-node-edit').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const nodeId = btn.dataset.nodeId;
            const node = board.nodes.find(n => n.id === nodeId);
            if (!node) return;
            const newNote = prompt('编辑节点备注：', node.note || '');
            if (newNote === null) return;
            await updateClueNode(chatId, nodeId, { note: newNote.trim() });
            const newBoard = await getClueBoard(chatId);
            refreshClueBoard(body, newBoard, chatId, overlay, panel);
        });
    });
    // 删除节点
    body.querySelectorAll('.bb-clue-node-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const nodeId = btn.dataset.nodeId;
            const node = board.nodes.find(n => n.id === nodeId);
            if (!confirm(`确定删除节点"${node?.label || nodeId}"及其所有连线？`)) return;
            await removeClueNode(chatId, nodeId);
            const newBoard = await getClueBoard(chatId);
            refreshClueBoard(body, newBoard, chatId, overlay, panel);
        });
    });
    // 内联编辑标签
    body.querySelectorAll('.bb-clue-node-label').forEach(el => {
        el.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const nId = el.dataset.nodeId;
            const n = board.nodes.find(nn => nn.id === nId);
            if (!n) return;
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.value = n.label || '';
            inp.style.cssText = 'flex:1;font-size:0.9em;font-weight:600;background:var(--SmartThemeInputColor,#1a1a2e);color:var(--SmartThemeTextColor,#ddd);border:1px solid var(--SmartThemeBorderColor,#555);border-radius:4px;padding:2px 6px;width:100%;min-width:0;';
            el.replaceWith(inp);
            inp.focus(); inp.select();
            const done = async () => {
                const newLabel = inp.value.trim();
                const sp = document.createElement('span');
                sp.className = 'bb-clue-node-label';
                sp.dataset.nodeId = nId;
                sp.style.cssText = 'flex:1;font-size:0.9em;font-weight:600;cursor:text;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                sp.title = '点击编辑名称';
                sp.textContent = newLabel || n.label || n.id;
                inp.replaceWith(sp);
                if (newLabel && newLabel !== n.label) {
                    await updateClueNode(chatId, nId, { label: newLabel });
                }
            };
            inp.addEventListener('blur', done);
            inp.addEventListener('keydown', (ev2) => { if (ev2.key === 'Enter') done(); if (ev2.key === 'Escape') { inp.value = n.label || ''; done(); } });
        });
    });
    // 编辑连线
    body.querySelectorAll('.bb-clue-conn-edit').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const connId = btn.dataset.connId;
            const conn = board.connections.find(c => c.id === connId);
            if (!conn) return;
            const newLabel = prompt('编辑连线标签：', conn.label || '');
            if (newLabel === null) return;
            await updateClueConnection(chatId, connId, { label: newLabel.trim() });
            const newBoard = await getClueBoard(chatId);
            refreshClueBoard(body, newBoard, chatId, overlay, panel);
        });
    });
    // 删除连线
    body.querySelectorAll('.bb-clue-conn-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const connId = btn.dataset.connId;
            if (!confirm('确定删除此连线？')) return;
            await removeClueConnection(chatId, connId);
            const newBoard = await getClueBoard(chatId);
            refreshClueBoard(body, newBoard, chatId, overlay, panel);
        });
    });
}

// ═══════════════════════════════════════════════════════════
//  添加节点对话框
// ═══════════════════════════════════════════════════════════

function showAddNodeDialog(chatId, onDone) {
    const existing = document.querySelector('.bb-clue-add-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'bb-clue-add-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99995;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--SmartThemeBlurTintColor,#1e1e2e);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:10px;padding:16px 18px;width:min(480px,90vw);max-height:70vh;display:flex;flex-direction:column;';
    dialog.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-shrink:0;">
            <i class="fa-solid fa-magnifying-glass" style="color:#ff9800;"></i>
            <strong>从记忆库添加线索节点</strong>
            <button class="bb-clue-add-close" style="margin-left:auto;background:none;border:none;color:inherit;font-size:20px;cursor:pointer;opacity:0.5;">&times;</button>
        </div>
        <div id="bb_clue_node_tabs" style="display:flex;gap:4px;margin-bottom:8px;flex-shrink:0;flex-wrap:wrap;">
            <button class="bb-clue-tab active" data-pillar="all" style="font-size:0.75em;padding:4px 10px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:14px;background:rgba(255,152,0,0.15);color:inherit;cursor:pointer;">全部</button>
            <button class="bb-clue-tab" data-pillar="mem" style="font-size:0.75em;padding:4px 10px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:14px;background:transparent;color:inherit;cursor:pointer;opacity:0.6;">记忆</button>
            <button class="bb-clue-tab" data-pillar="npc" style="font-size:0.75em;padding:4px 10px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:14px;background:transparent;color:inherit;cursor:pointer;opacity:0.6;">NPC</button>
            <button class="bb-clue-tab" data-pillar="item" style="font-size:0.75em;padding:4px 10px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:14px;background:transparent;color:inherit;cursor:pointer;opacity:0.6;">物品</button>
            <button class="bb-clue-tab" data-pillar="timeline" style="font-size:0.75em;padding:4px 10px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:14px;background:transparent;color:inherit;cursor:pointer;opacity:0.6;">时间线</button>
        </div>
        <input type="text" id="bb_clue_node_search" class="bb-input" placeholder="搜索条目..." style="margin-bottom:8px;flex-shrink:0;" />
        <div id="bb_clue_node_list" style="flex:1;overflow-y:auto;min-height:0;font-size:0.85em;">加载中...</div>
    `;
    dialog.querySelector('.bb-clue-add-close').addEventListener('click', () => overlay.remove());
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // 加载数据
    (async () => {
        const [npc, items, timeline, memories] = await Promise.all([
            getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
        ]);
        const allEntries = [
            ...memories.map(e => ({ ...e, _pillar: 'mem', _label: e.title || e.summary?.slice(0, 40) || e.id, _preview: (e.content || e.summary || '').slice(0, 80) })),
            ...npc.map(e => ({ ...e, _pillar: 'npc', _label: e.name || e.id, _preview: e.role || e.personality || '' })),
            ...items.map(e => ({ ...e, _pillar: 'item', _label: e.name || e.id, _preview: e.significance || e.status || '' })),
            ...timeline.map(e => ({ ...e, _pillar: 'timeline', _label: e.event || e.summary?.slice(0, 40) || e.id, _preview: e.summary || e.storyTime || '' })),
        ];

        // 按线索潜力排序：unknown/rumor truthStatus 优先
        const cluePriority = { unknown: 0, rumor: 1, misleading: 2, secret_true: 3 };
        allEntries.sort((a, b) => (cluePriority[a.truthStatus] ?? 99) - (cluePriority[b.truthStatus] ?? 99));

        const listEl = dialog.querySelector('#bb_clue_node_list');
        const searchInput = dialog.querySelector('#bb_clue_node_search');

        const pillarIcon = { mem: 'fa-brain', npc: 'fa-user', item: 'fa-box', timeline: 'fa-clock' };
        const pillarColor = { mem: '#ce93d8', npc: '#64b5f6', item: '#ffb74d', timeline: '#81c784' };
        const truthColor = { unknown: '#9e9e9e', rumor: '#ff9800', misleading: '#f44336', secret_true: '#7c4dff', 'true': '#4caf50', 'false': '#f44336' };

        let activePillar = 'all';

        function renderList(filter = '') {
            const q = filter.toLowerCase();
            const filtered = allEntries.filter(e => {
                if (activePillar !== 'all' && e._pillar !== activePillar) return false;
                if (!q) return true;
                return (e._label || '').toLowerCase().includes(q) || (e._preview || '').toLowerCase().includes(q);
            }).slice(0, 50);

            if (!filtered.length) {
                listEl.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.4;">没有匹配的条目</div>';
                return;
            }

            listEl.innerHTML = filtered.map(e => `
                <div class="bb-clue-add-item" data-pillar="${e._pillar}" data-id="${e.id}" data-label="${escapeHtml(e._label)}"
                    style="display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;border-bottom:1px solid rgba(128,128,128,0.06);border-radius:4px;">
                    <i class="fa-solid ${pillarIcon[e._pillar] || 'fa-circle'}" style="color:${pillarColor[e._pillar] || '#888'};font-size:0.75em;"></i>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(e._label)}</span>
                    ${e.truthStatus && e.truthStatus !== 'true' ? `<span style="font-size:0.65em;color:${truthColor[e.truthStatus] || '#888'};opacity:0.7;">${e.truthStatus}</span>` : ''}
                    <span style="font-size:0.65em;opacity:0.35;">${e._preview.slice(0, 30)}</span>
                </div>
            `).join('');

            listEl.querySelectorAll('.bb-clue-add-item').forEach(item => {
                item.addEventListener('click', async () => {
                    const refType = item.dataset.pillar;
                    const refId = item.dataset.id;
                    const label = item.dataset.label;
                    await addClueNode(chatId, { refType, refId, label });
                    overlay.remove();
                    if (onDone) onDone();
                });
            });
        }

        // 标签切换
        const tabs = dialog.querySelectorAll('.bb-clue-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                activePillar = tab.dataset.pillar;
                tabs.forEach(t => {
                    t.classList.toggle('active', t.dataset.pillar === activePillar);
                    t.style.background = t.dataset.pillar === activePillar ? 'rgba(255,152,0,0.15)' : 'transparent';
                    t.style.opacity = t.dataset.pillar === activePillar ? '1' : '0.6';
                });
                renderList(searchInput.value);
            });
        });

        renderList();
        searchInput.addEventListener('input', () => renderList(searchInput.value));
    })();
}

// ═══════════════════════════════════════════════════════════
//  新建连线对话框
// ═══════════════════════════════════════════════════════════

function showAddConnectionDialog(nodes, onConfirm) {
    const existing = document.querySelector('.bb-clue-conn-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'bb-clue-conn-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99995;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--SmartThemeBlurTintColor,#1e1e2e);border:1px solid var(--SmartThemeBorderColor,#45475a);border-radius:10px;padding:16px 18px;width:min(360px,90vw);';
    const nodeOptions = nodes.map(n => `<option value="${n.id}">${escapeHtml(n.label || n.id)}</option>`).join('');
    dialog.innerHTML = `
        <div style="font-weight:bold;margin-bottom:12px;"><i class="fa-solid fa-arrow-right-arrow-left"></i> 新建连线</div>
        <div style="margin-bottom:8px;">
            <label style="font-size:0.8em;opacity:0.6;">起始节点</label>
            <select id="bb_clue_conn_from" class="bb-input" style="width:100%;">${nodeOptions}</select>
        </div>
        <div style="margin-bottom:8px;">
            <label style="font-size:0.8em;opacity:0.6;">目标节点</label>
            <select id="bb_clue_conn_to" class="bb-input" style="width:100%;">${nodeOptions}</select>
        </div>
        <div style="margin-bottom:8px;">
            <label style="font-size:0.8em;opacity:0.6;">连线类型</label>
            <select id="bb_clue_conn_type" class="bb-input" style="width:100%;">
                <option value="causal">因果 — A导致B</option>
                <option value="hint">暗示 — A暗示B</option>
                <option value="contradicts">矛盾 — A与B矛盾</option>
                <option value="related" selected>关联 — A与B相关</option>
                <option value="speculation">推测 — 玩家猜测</option>
            </select>
        </div>
        <div style="margin-bottom:8px;">
            <label style="font-size:0.8em;opacity:0.6;">信心级别</label>
            <select id="bb_clue_conn_conf" class="bb-input" style="width:100%;">
                <option value="high">高 — 有充分证据</option>
                <option value="medium" selected>中 — 有部分证据</option>
                <option value="low">低 — 纯推测</option>
            </select>
        </div>
        <div style="margin-bottom:12px;">
            <label style="font-size:0.8em;opacity:0.6;">连线标签（可选）</label>
            <input type="text" id="bb_clue_conn_label" class="bb-input" placeholder="如：私人恩怨、隐藏动机..." style="width:100%;" />
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="bb_clue_conn_cancel" class="menu_button" style="opacity:0.6;">取消</button>
            <button id="bb_clue_conn_ok" class="menu_button" style="background:#4caf50;color:#fff;">确认创建</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    dialog.querySelector('#bb_clue_conn_cancel').addEventListener('click', () => overlay.remove());
    dialog.querySelector('#bb_clue_conn_ok').addEventListener('click', () => {
        const fromNodeId = dialog.querySelector('#bb_clue_conn_from').value;
        const toNodeId = dialog.querySelector('#bb_clue_conn_to').value;
        if (fromNodeId === toNodeId) { alert('起始节点和目标节点不能相同'); return; }
        const type = dialog.querySelector('#bb_clue_conn_type').value;
        const confidence = dialog.querySelector('#bb_clue_conn_conf').value;
        const label = dialog.querySelector('#bb_clue_conn_label').value.trim();
        onConfirm({ fromNodeId, toNodeId, type, confidence, label });
        overlay.remove();
    });
}
