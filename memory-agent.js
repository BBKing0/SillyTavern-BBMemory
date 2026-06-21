/**
 * memory-agent.js —— BB-Memory v9.2.0 记忆管家 Agent（测试版）
 *
 * 混合模式：读操作直接注入数据给 LLM 自由回答，写操作保留轻量工具。
 * 支持分类管理 UI 内嵌于 Agent 面板。
 */

import { normalizeEndpoint } from './auto-generator.js';
import {
    getSettings, updateSettings,
    getNpcProfiles, getItems, getMilestones, getTimeline, getMemories,
    removeNpcProfile, removeItem, removeMilestone, removeTimeline, removeMemory,
    updateNpcProfile, updateItem, updateMilestone, updateMemory,
    upsertTimeline,
    archiveEntry, restoreEntry, addHiddenNote,
    addCategory, removeCategory, renameCategory, toggleCategory,
    getCategoryStats,
} from './memory-store.js';
import { simpleSearch } from './retriever.js';
import { DEFAULT_AGENT_SYSTEM_PROMPT, getPromptTemplate } from './prompt-templates.js';

// ═══════════════════════════════════════════════════════════
//  预检索：将相关数据直接注入 prompt
// ═══════════════════════════════════════════════════════════

async function prepareContext(chatId, userMessage) {
    const settings = getSettings();
    const enabled = settings.enabledCategories || {};
    const hasEnabled = Object.values(enabled).some(v => v === true);
    const [{ getMap }, { getClueBoard }] = await Promise.all([
        import('./map-store.js'),
        import('./clue-board.js'),
    ]);

    // 并行加载所有数据
    const [npcs, items, milestones, timeline, memories, mapData, clueBoard] = await Promise.all([
        getNpcProfiles(chatId),
        getItems(chatId),
        getMilestones(chatId),
        getTimeline(chatId),
        getMemories(chatId),
        getMap(chatId).catch(() => ({ locations: {} })),
        getClueBoard(chatId).catch(() => ({ nodes: [], connections: [] })),
    ]);
    const mapLocations = Object.values(mapData?.locations || {}).filter(e => e && !e.archived);
    const clueNodes = Array.isArray(clueBoard?.nodes) ? clueBoard.nodes : [];
    const clueConnections = Array.isArray(clueBoard?.connections) ? clueBoard.connections : [];

    // 搜索相关条目
    const allEntries = [
        ...npcs.filter(e => !e.archived).map(e => ({ ...e, _pillar: 'npc' })),
        ...items.filter(e => !e.archived).map(e => ({ ...e, _pillar: 'item' })),
        ...milestones.filter(e => !e.archived).map(e => ({ ...e, _pillar: 'milestone' })),
        ...timeline.filter(e => !e.archived).map(e => ({ ...e, _pillar: 'timeline' })),
        ...memories.filter(e => !e.archived && e.status !== 'deleted').map(e => ({ ...e, _pillar: 'mem' })),
        ...mapLocations.map(e => ({ ...e, title: e.name, content: e.description, _pillar: 'map' })),
        ...clueNodes.map(e => ({ ...e, title: e.label, content: e.note, name: e.label, _pillar: 'clue' })),
    ];
    const searchResults = simpleSearch(allEntries, userMessage, 20);

    // 统计
    const stats = {
        npc: npcs.filter(e => !e.archived).length,
        item: items.filter(e => !e.archived).length,
        milestone: milestones.filter(e => !e.archived).length,
        timeline: timeline.filter(e => !e.archived).length,
        mem: memories.filter(e => !e.archived && e.status !== 'deleted').length,
        map: mapLocations.length,
        clue: clueNodes.length,
        clueConnection: clueConnections.length,
    };
    const catStats = await getCategoryStats(chatId);
    const categories = (settings.categories || []).map(name => ({
        name,
        enabled: enabled[name] === true,
        counts: catStats[name] || { mem: 0, npc: 0, item: 0, milestone: 0, timeline: 0 },
    }));
    const enabledList = hasEnabled ? (settings.categories || []).filter(c => enabled[c]).join('、') || '(无)' : '';
    const filterStatus = hasEnabled ? '已开启: ' + enabledList : '全部显示';

    // 构建数据上下文
    const pillars = ['mem', 'npc', 'item', 'milestone', 'timeline', 'map', 'clue'];
    const grouped = {};
    for (const p of pillars) grouped[p] = [];

    for (const r of searchResults) {
        const p = r._pillar || 'mem';
        const label = r.title || r.name || r.event || (r.content || '').slice(0, 50);
        const cat = r.category ? ' [' + r.category + ']' : '';
        const tierBadge = r.memoryTier === 'eternal' ? '⭐' : r.memoryTier === 'core' ? '★' : '';
        let detail = '';
        if (p === 'mem') detail = (r.content || r.summary || '').slice(0, 300);
        else if (p === 'npc') detail = [r.role, r.personality, (r.notes || []).join('; ')].filter(Boolean).join(' | ').slice(0, 200);
        else if (p === 'item') detail = (r.significance || '').slice(0, 200);
        else if (p === 'milestone') detail = (r.summary || r.event || '').slice(0, 200);
        else if (p === 'timeline') detail = [r.status, r.priority, r.summary].filter(Boolean).join(' | ').slice(0, 200);
        else if (p === 'map') detail = [r.region, r.description, r.realWorldRef].filter(Boolean).join(' | ').slice(0, 220);
        else if (p === 'clue') detail = [r.note, r.refType ? `引用:${r.refType}/${r.refId}` : ''].filter(Boolean).join(' | ').slice(0, 220);
        grouped[p].push('- ' + label + cat + tierBadge + '\n  ' + detail + '\n  ID: ' + r.id);
    }

    let catListText = '(无分类)';
    if (categories.length > 0) {
        catListText = categories.map(function (c) {
            var statusIcon = c.enabled ? '✅注入' : '⏸暂停';
            var counts = '记忆' + (c.counts.mem || 0) + ' NPC' + (c.counts.npc || 0) + ' 物品' + (c.counts.item || 0) + ' 里程碑' + (c.counts.milestone || c.counts.timeline || 0);
            return '- ' + c.name + ': ' + statusIcon + ' (' + counts + ')';
        }).join('\n');
    }

    let contextText = '【数据概览】\n记忆:' + stats.mem + '条 NPC:' + stats.npc + '个 物品:' + stats.item + '件 里程碑:' + stats.milestone + '条 时间线:' + stats.timeline + '条 地图:' + stats.map + '处 线索:' + stats.clue + '节点/' + stats.clueConnection + '连线\n注入过滤: ' + filterStatus + '\n\n【分类】\n' + catListText;

    const pillarLabels = { mem: '记忆', npc: 'NPC', item: '物品', milestone: '里程碑', timeline: '时间线', map: '地图地点', clue: '线索板节点' };
    for (const p of pillars) {
        if (grouped[p].length > 0) {
            contextText += '\n\n【' + pillarLabels[p] + ' (' + grouped[p].length + '条)】\n' + grouped[p].join('\n');
        }
    }

    if (searchResults.length === 0) {
        const recent = allEntries.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).slice(0, 10);
        if (recent.length > 0) {
            contextText += '\n\n【最近条目】\n' + recent.map(function (r) {
                var label = r.title || r.name || r.event || (r.content || '').slice(0, 50);
                var p2 = r._pillar || 'mem';
                return '- [' + (pillarLabels[p2] || p2) + '] ' + label;
            }).join('\n');
        }
    }

    return { contextText, stats, categories, searchResults, hasEnabled, data: { npcs, items, milestones, timeline, memories, mapLocations, clueNodes, clueConnections } };
}

function formatBriefEntry(entry, pillar) {
    const label = entry.title || entry.name || entry.event || entry.label || entry.id;
    const detail = {
        mem: entry.summary || entry.content || '',
        npc: [entry.role, entry.status, entry.location].filter(Boolean).join(' | '),
        item: [entry.owner ? '持有:' + entry.owner : '', entry.status, entry.location, entry.significance].filter(Boolean).join(' | '),
        milestone: [entry.status, entry.storyTime, entry.summary || entry.event].filter(Boolean).join(' | '),
        timeline: [entry.status, entry.priority, entry.summary || entry.name].filter(Boolean).join(' | '),
        map: [entry.region, entry.description].filter(Boolean).join(' | '),
        clue: [entry.note, entry.refType ? `引用:${entry.refType}/${entry.refId}` : ''].filter(Boolean).join(' | '),
    }[pillar] || '';
    return `- ${label}${detail ? '：' + String(detail).slice(0, 120) : ''}\n  ID: ${entry.id}`;
}

async function tryLocalAgentAnswer(chatId, userMessage) {
    const text = String(userMessage || '').trim();
    if (!text) return null;
    const lower = text.toLowerCase();
    const [{ getMap }, { getClueBoard }] = await Promise.all([
        import('./map-store.js'),
        import('./clue-board.js'),
    ]);
    const [npcs, items, milestones, timeline, memories, mapData, clueBoard] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getMilestones(chatId), getTimeline(chatId), getMemories(chatId),
        getMap(chatId).catch(() => ({ locations: {} })),
        getClueBoard(chatId).catch(() => ({ nodes: [], connections: [] })),
    ]);
    const activeMemories = memories.filter(m => !m.archived && m.status !== 'deleted');
    const activeNpcs = npcs.filter(n => !n.archived);
    const activeItems = items.filter(i => !i.archived);
    const activeMilestones = milestones.filter(t => !t.archived);
    const activeTimeline = timeline.filter(t => !t.archived);
    const mapLocations = Object.values(mapData?.locations || {}).filter(l => l && !l.archived);
    const clueNodes = Array.isArray(clueBoard?.nodes) ? clueBoard.nodes : [];

    if (/统计|概况|概览|多少/.test(text)) {
        return [
            `当前共有：记忆 ${activeMemories.length} 条，NPC ${activeNpcs.length} 个，物品 ${activeItems.length} 件，里程碑 ${activeMilestones.length} 条，时间线 ${activeTimeline.length} 条，地图地点 ${mapLocations.length} 处，线索板 ${clueNodes.length} 个节点。`,
            `核心/永恒记忆：${activeMemories.filter(m => m.memoryTier === 'core' || m.memoryTier === 'eternal').length} 条；进行中/伏笔里程碑：${activeMilestones.filter(t => t.status === 'ongoing' || t.status === 'foreshadow' || t.isActive).length} 条。`,
        ].join('\n');
    }

    if (/核心npc|核心 npc|重要npc|重要 npc|列.*npc|所有npc|所有 npc/.test(lower)) {
        const list = activeNpcs
            .filter(n => /核心|重要/.test(text) ? (n.npcTier === 'core' || n.npcTier === 'important') : true)
            .slice(0, 30)
            .map(n => formatBriefEntry(n, 'npc'));
        return list.length ? list.join('\n') : '没有找到符合条件的 NPC。';
    }

    if (/最近.*记忆|近期.*记忆|最新.*记忆/.test(text)) {
        const list = [...activeMemories]
            .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
            .slice(0, 10)
            .map(m => formatBriefEntry(m, 'mem'));
        return list.length ? list.join('\n') : '目前没有记忆条目。';
    }

    if (/活跃.*里程碑|进行中.*里程碑|活跃.*时间点|伏笔/.test(text)) {
        const list = activeMilestones
            .filter(t => t.status === 'ongoing' || t.status === 'foreshadow' || t.isActive)
            .slice(0, 30)
            .map(t => formatBriefEntry(t, 'milestone'));
        return list.length ? list.join('\n') : '目前没有进行中或伏笔里程碑。';
    }

    if (/时间线|叙事线|故事线/.test(text) && /活跃|进行中|所有|列/.test(text)) {
        const list = activeTimeline
            .slice(0, 30)
            .map(t => formatBriefEntry(t, 'timeline'));
        return list.length ? list.join('\n') : '目前没有时间线。';
    }

    if (/地图|地点/.test(text) && /孤立|断开|无路径/.test(text)) {
        const connected = new Set();
        for (const loc of mapLocations) {
            if (loc.parentId) { connected.add(loc.id); connected.add(loc.parentId); }
            for (const edge of (loc.edges || [])) { connected.add(loc.id); connected.add(edge.toId); }
        }
        const itemLocs = new Set(activeItems.map(i => String(i.location || '').trim().toLowerCase()).filter(Boolean));
        const isolated = mapLocations.filter(l => !connected.has(l.id) && !itemLocs.has(String(l.name || '').toLowerCase()) && !itemLocs.has(String(l.id || '').toLowerCase()));
        return isolated.length
            ? isolated.slice(0, 30).map(l => formatBriefEntry(l, 'map')).join('\n')
            : '没有发现孤立地点。';
    }

    return null;
}

// ═══════════════════════════════════════════════════════════
//  API 调用
// ═══════════════════════════════════════════════════════════

async function callAgentApi(contextText, conversationHistory) {
    const settings = getSettings();
    if (!settings.autoGenEndpoint) {
        throw new Error('请先在设置中配置副 API（自定义端点）');
    }

    const endpoint = normalizeEndpoint(settings.autoGenEndpoint);

    const systemPrompt = getPromptTemplate(settings, 'agent.systemPrompt', DEFAULT_AGENT_SYSTEM_PROMPT) || `你是 BB-Memory 记忆管家，帮助用户管理 SillyTavern 角色扮演的长期记忆。

你能读取并解释：记忆、NPC、物品、里程碑、时间线、地图地点、线索板节点。
当用户只是询问或列举时，直接基于数据快照回答，不要编造。

只有用户明确要求修改、删除、归档、分类、升降级或添加隐藏备注时，才执行写操作。
推荐使用单行 JSON_ACTION，格式如下：
JSON_ACTION: {"action":"update_entry","pillar":"mem","id":"条目ID","patch":{"summary":"新摘要"}}

可用 action：
- assign_category: {"action":"assign_category","pillar":"mem|npc|item|milestone|timeline|map","id":"...","category":"分类名或null"}
- update_entry: {"action":"update_entry","pillar":"mem|npc|item|milestone|timeline|map","id":"...","patch":{...}}
- set_tier: {"action":"set_tier","pillar":"mem|npc|item|map","id":"...","tier":"stable/core/eternal 或 core/important/minor/background 或 key/equipped/clue/consumable/background"}
- archive_entry / restore_entry / delete_entry: {"action":"archive_entry","pillar":"mem|npc|item|milestone|timeline|map","id":"..."}
- add_hidden_note: {"action":"add_hidden_note","id":"记忆ID","content":"隐藏备注","type":"note","allowInjection":true}
- toggle_category: {"action":"toggle_category","name":"分类名","enabled":true}
- manage_category: {"action":"manage_category","mode":"add|remove|rename","name":"分类名","newName":"新名称"}

回答风格：中文、简明、先说结果。执行写操作时，可以在正文里简短说明你将执行什么。`;

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: contextText },
        ...conversationHistory,
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.autoGenApiKey}`,
            },
            body: JSON.stringify({
                model: settings.autoGenModel || 'gpt-3.5-turbo',
                messages,
                temperature: 0.5,
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    } finally {
        clearTimeout(timer);
    }
}

// ═══════════════════════════════════════════════════════════
//  ACTION 指令执行
// ═══════════════════════════════════════════════════════════

function getUpdaterForPillar(pillar) {
    return {
        mem: updateMemory,
        npc: updateNpcProfile,
        item: updateItem,
        milestone: updateMilestone,
        timeline: (chatId, id, patch) => upsertTimeline(chatId, { id, ...(patch || {}) }),
        map: async (chatId, id, patch) => {
            const { updateLocation } = await import('./map-store.js');
            return updateLocation(chatId, id, patch);
        },
    }[pillar];
}

function parseLegacyAction(actionLine) {
    const match = actionLine.match(/^ACTION:\s*(\w+)\s*(.*)$/);
    if (!match) return null;
    const [, action, rawArgs] = match;
    const args = rawArgs.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(a => a.replace(/^"|"$/g, '')) || [];
    if (action === 'update_entry') {
        const m = rawArgs.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
        return m ? { action, pillar: m[1], id: m[2], patch: JSON.parse(m[3]) } : null;
    }
    if (action === 'assign_category') return { action, pillar: args[0], id: args[1], category: args.slice(2).join(' ') };
    if (action === 'toggle_category') return { action, name: args[0], enabled: args[1] === 'true' };
    if (action === 'manage_category') return { action, mode: args[0], name: args[1], newName: args[2] };
    return { action, args };
}

function extractActionSpecs(response) {
    const specs = [];
    for (const line of String(response || '').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('JSON_ACTION:')) {
            const raw = trimmed.slice('JSON_ACTION:'.length).trim();
            try { specs.push(JSON.parse(raw)); } catch (e) { specs.push({ action: '__parse_error__', error: e.message }); }
        } else if (trimmed.startsWith('ACTION:')) {
            try { specs.push(parseLegacyAction(trimmed)); } catch (e) { specs.push({ action: '__parse_error__', error: e.message }); }
        }
    }
    return specs.filter(Boolean);
}

async function executeAction(actionSpec, chatId) {
    const spec = typeof actionSpec === 'string' ? parseLegacyAction(actionSpec) : actionSpec;
    if (!spec?.action) return null;

    try {
        switch (spec.action) {
            case '__parse_error__':
                return { error: '动作解析失败: ' + (spec.error || 'unknown') };

            case 'assign_category': {
                const updater = getUpdaterForPillar(spec.pillar);
                if (!updater) return { error: '未知支柱: ' + spec.pillar };
                const category = spec.category === 'null' || spec.category === '无' ? null : spec.category;
                await updater(chatId, spec.id, { category });
                return { success: true, msg: `已设置分类` };
            }

            case 'update_entry': {
                const updater = getUpdaterForPillar(spec.pillar);
                if (!updater) return { error: '未知支柱: ' + spec.pillar };
                await updater(chatId, spec.id, spec.patch || {});
                return { success: true, msg: '已更新' };
            }

            case 'set_tier': {
                const updater = getUpdaterForPillar(spec.pillar);
                if (!updater) return { error: '未知支柱: ' + spec.pillar };
                const key = spec.pillar === 'npc' ? 'npcTier' : (spec.pillar === 'item' ? 'itemTier' : 'memoryTier');
                await updater(chatId, spec.id, { [key]: spec.tier });
                return { success: true, msg: `已调整等级为 ${spec.tier}` };
            }

            case 'archive_entry':
                await archiveEntry(chatId, spec.pillar || 'mem', spec.id);
                return { success: true, msg: '已归档' };

            case 'restore_entry':
                await restoreEntry(chatId, spec.pillar || 'mem', spec.id);
                return { success: true, msg: '已恢复' };

            case 'delete_entry': {
                const remover = {
                    mem: removeMemory,
                    npc: removeNpcProfile,
                    item: removeItem,
                    milestone: removeMilestone,
                    timeline: removeTimeline,
                    map: async (chatId, id) => {
                        const { removeLocation } = await import('./map-store.js');
                        return removeLocation(chatId, id);
                    },
                }[spec.pillar || 'mem'];
                if (!remover) return { error: '未知支柱: ' + spec.pillar };
                await remover(chatId, spec.id);
                return { success: true, msg: '已删除' };
            }

            case 'add_hidden_note':
                await addHiddenNote(chatId, spec.id, {
                    type: spec.type || 'note',
                    content: spec.content || '',
                    allowInjection: spec.allowInjection !== false,
                });
                return { success: true, msg: '已添加隐藏备注' };

            case 'toggle_category': {
                await toggleCategory(spec.name, !!spec.enabled);
                return { success: true, msg: `分类「${spec.name}」已${spec.enabled ? '开启' : '暂停'}注入` };
            }

            case 'manage_category': {
                switch (spec.mode) {
                    case 'add': await addCategory(spec.name); return { success: true, msg: `分类「${spec.name}」已添加` };
                    case 'remove': await removeCategory(chatId, spec.name); return { success: true, msg: `分类「${spec.name}」已删除` };
                    case 'rename': await renameCategory(chatId, spec.name, spec.newName); return { success: true, msg: `已重命名为「${spec.newName}」` };
                    default: return { error: '未知子操作: ' + spec.mode };
                }
            }

            default:
                return { error: '未知操作: ' + spec.action };
        }
    } catch (e) {
        return { error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════
//  主对话流程
// ═══════════════════════════════════════════════════════════

export async function runAgentQuery(chatId, userMessage, conversationHistory, onAction) {
    // 1. 本地快捷回答：统计、列举等无需消耗副 API。
    const localAnswer = await tryLocalAgentAnswer(chatId, userMessage);
    if (localAnswer) return { answer: localAnswer, actions: [] };

    // 2. 预检索
    const { contextText } = await prepareContext(chatId, userMessage);

    // 3. 调用 LLM
    const response = await callAgentApi(contextText, conversationHistory);

    // 4. 解析 ACTION / JSON_ACTION 指令
    const actionSpecs = extractActionSpecs(response);
    const actionResults = [];
    let answerText = response || '';

    for (const spec of actionSpecs) {
        const result = await executeAction(spec, chatId);
        if (result) {
            actionResults.push(result);
            if (onAction) onAction(JSON.stringify(spec), result);
        }
    }
    answerText = answerText
        .split('\n')
        .filter(line => !line.trim().startsWith('ACTION:') && !line.trim().startsWith('JSON_ACTION:'))
        .join('\n')
        .trim();

    return { answer: answerText || '操作已完成。', actions: actionResults };
}

// ═══════════════════════════════════════════════════════════
//  UI 面板
// ═══════════════════════════════════════════════════════════

function escapeHtmlAgent(text) {
    if (!text) return '';
    if (typeof text === 'object') text = JSON.stringify(text, null, 2);
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

function buildAgentHTML(chatId) {
    return `
    <div class="bb-agent-panel">
        <div class="bb-agent-header">
            <span class="bb-agent-title"><i class="fa-solid fa-robot"></i> 记忆管家 Agent <em>测试版</em></span>
            <div style="display:flex;gap:4px;">
                <button class="bb-agent-btn-clear menu_button" style="font-size:0.72em;" title="清空对话"><i class="fa-solid fa-eraser"></i></button>
                <button class="bb-agent-btn-close menu_button" style="font-size:0.72em;"><i class="fa-solid fa-times"></i></button>
            </div>
        </div>

        <div class="bb-agent-body" id="bb_agent_body">
            <div class="bb-agent-beta-note">
                <i class="fa-solid fa-triangle-exclamation"></i>
                测试版功能：Agent 可能按你的明确指令执行分类、编辑、归档等写操作。建议先备份，完成后复核记忆数据。
            </div>
            <div class="bb-agent-msg bb-agent-msg-system">
                <i class="fa-solid fa-circle-info"></i> 你好！我是记忆管家 Agent 测试版。你可以用自然语言问我：
                <div style="margin:4px 0 0 4px;font-size:0.85em;opacity:0.7;">
                    · "有哪些记忆？"<br>
                    · "列出所有NPC"<br>
                    · "穿越线分类里有什么？"<br>
                    · "把记忆XXX归入穿越线"<br>
                    · "停止注入穿越线分类"
                </div>
                <div style="margin-top:6px;font-size:0.7em;opacity:0.4;">需要先在设置中配置副 API 端点</div>
            </div>
        </div>

        <div class="bb-agent-footer">
            <div class="bb-agent-quick-btns">
                <button class="bb-agent-quick menu_button" data-cmd="帮我统计当前各类记忆数量">📊 统计</button>
                <button class="bb-agent-quick menu_button" data-cmd="列出所有分类及每个分类下的条目数">🏷 分类概况</button>
                <button class="bb-agent-quick menu_button" data-cmd="列出最近的10条记忆">📝 最近记忆</button>
                <button class="bb-agent-quick menu_button" data-cmd="列出所有核心NPC">👤 核心NPC</button>
                <button class="bb-agent-quick menu_button" data-cmd="列出所有活跃的里程碑">⏱ 活跃里程碑</button>
            </div>
            <div class="bb-agent-input-row">
                <textarea id="bb_agent_input" class="bb-input" rows="2" placeholder="输入自然语言指令..."></textarea>
                <button id="bb_agent_send" class="menu_button" style="background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;">
                    <i class="fa-solid fa-paper-plane"></i>
                </button>
            </div>
        </div>
    </div>`;
}

function appendAgentMessage(role, content, isHtml) {
    const body = document.querySelector('#bb_agent_body');
    if (!body) return;
    const div = document.createElement('div');
    const icons = { user: '👤', agent: '🤖', tool: '🔧', system: '💬' };
    const classes = { user: 'bb-agent-msg-user', agent: 'bb-agent-msg-agent', tool: 'bb-agent-msg-tool', system: 'bb-agent-msg-system' };
    div.className = `bb-agent-msg ${classes[role] || 'bb-agent-msg-system'}`;
    div.innerHTML = isHtml ? content : `${icons[role] || ''} <span>${escapeHtmlAgent(content)}</span>`;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
}

async function handleAgentSend(conversationHistory) {
    const input = document.querySelector('#bb_agent_input');
    const btn = document.querySelector('#bb_agent_send');
    const chatId = getChatId();
    if (!chatId) { showToast('请先进入角色对话', 'warning'); return; }

    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.disabled = true;
    btn.disabled = true;

    appendAgentMessage('user', text);
    conversationHistory.push({ role: 'user', content: text });

    const body = document.querySelector('#bb_agent_body');
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'bb-agent-msg bb-agent-msg-agent';
    loadingDiv.innerHTML = '🤖 <span><i class="fa-solid fa-spinner fa-spin"></i> 思考中...</span>';
    body.appendChild(loadingDiv);
    body.scrollTop = body.scrollHeight;

    try {
        const result = await runAgentQuery(chatId, text, conversationHistory, (action, res) => {
            const ok = res && !res.error;
            appendAgentMessage('tool', escapeHtmlAgent(`${ok ? '✅' : '❌'} ${action} → ${ok ? (res.msg || '成功') : (res.error || '失败')}`), true);
        });

        loadingDiv.remove();
        appendAgentMessage('agent', result.answer);
        conversationHistory.push({ role: 'assistant', content: result.answer });

        if (result.actions.length > 0) {
            showToast(`执行了 ${result.actions.length} 个操作`, 'success');
        }
    } catch (e) {
        loadingDiv.remove();
        appendAgentMessage('agent', `出错：${e.message}`);
        conversationHistory.push({ role: 'assistant', content: `Error: ${e.message}` });
        showToast(`Agent 出错: ${e.message}`, 'error');
    } finally {
        input.disabled = false;
        btn.disabled = false;
        input.focus();
    }
}

export function openAgent(chatId) {
    const existing = document.querySelector('.bb-agent-overlay');
    if (existing) existing.remove();

    const conversationHistory = [];

    const overlay = document.createElement('div');
    overlay.className = 'bb-agent-overlay';
    overlay.innerHTML = `<div class="bb-agent-wrapper">${buildAgentHTML(chatId)}</div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('.bb-agent-btn-close')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('.bb-agent-btn-clear')?.addEventListener('click', () => {
        conversationHistory.length = 0;
        const body = document.querySelector('#bb_agent_body');
        if (body) body.innerHTML = `<div class="bb-agent-beta-note"><i class="fa-solid fa-triangle-exclamation"></i> 测试版功能：Agent 可能按你的明确指令执行写操作。建议先备份并复核结果。</div><div class="bb-agent-msg bb-agent-msg-system"><i class="fa-solid fa-comment-dots"></i> 对话已清空。有什么可以帮你的？</div>`;
    });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    overlay.querySelector('#bb_agent_send')?.addEventListener('click', () => handleAgentSend(conversationHistory));
    overlay.querySelector('#bb_agent_input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAgentSend(conversationHistory); }
    });

    overlay.querySelectorAll('.bb-agent-quick').forEach(btn => {
        btn.addEventListener('click', () => {
            const inp = document.querySelector('#bb_agent_input');
            if (inp) { inp.value = btn.dataset.cmd; }
            handleAgentSend(conversationHistory);
        });
    });

    document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
    });

    setTimeout(() => overlay.querySelector('#bb_agent_input')?.focus(), 150);
}
