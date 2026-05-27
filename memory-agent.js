/**
 * memory-agent.js —— BB-Memory v8.6.0 记忆管家 Agent
 *
 * 使用副 API 实现自然语言记忆管理。用户用自然语言提问，
 * Agent 分析意图、调用工具、返回结果，支持多轮对话。
 */

import { normalizeEndpoint } from './auto-generator.js';
import {
    getSettings,
    getNpcProfiles, getItems, getTimeline, getMemories,
    updateNpcProfile, updateItem, updateTimelineEntry, updateMemory,
    addCategory, removeCategory, renameCategory, setActiveCategory,
    getCategoryStats, isArchived,
} from './memory-store.js';
import { simpleSearch } from './retriever.js';

// ═══════════════════════════════════════════════════════════
//  工具定义
// ═══════════════════════════════════════════════════════════

const TOOLS = [
    {
        name: 'search_entries',
        description: '在所有四柱条目中搜索关键词，返回匹配的条目列表。适合回答"有哪些关于X的记忆？"',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '搜索关键词' },
                pillar: { type: 'string', enum: ['mem', 'npc', 'item', 'timeline', 'all'], description: '限定支柱类型，默认all' },
                limit: { type: 'number', description: '返回数量上限，默认15' },
            },
            required: ['query'],
        },
    },
    {
        name: 'list_entries',
        description: '列出指定支柱的所有条目（不含已归档）。适合回答"有哪些NPC？"',
        parameters: {
            type: 'object',
            properties: {
                pillar: { type: 'string', enum: ['mem', 'npc', 'item', 'timeline', 'all'], description: '支柱类型' },
                category: { type: 'string', description: '按分类筛选，留空=全部' },
                limit: { type: 'number', description: '返回数量上限，默认20' },
            },
            required: ['pillar'],
        },
    },
    {
        name: 'get_entry_detail',
        description: '获取单个条目的完整详情',
        parameters: {
            type: 'object',
            properties: {
                pillar: { type: 'string', enum: ['mem', 'npc', 'item', 'timeline'], description: '支柱类型' },
                id: { type: 'string', description: '条目ID' },
            },
            required: ['pillar', 'id'],
        },
    },
    {
        name: 'update_entry',
        description: '修改一个条目的字段。可修改title/content/summary/category等',
        parameters: {
            type: 'object',
            properties: {
                pillar: { type: 'string', enum: ['mem', 'npc', 'item', 'timeline'], description: '支柱类型' },
                id: { type: 'string', description: '条目ID' },
                patch: { type: 'object', description: '要修改的字段键值对，如{"category":"穿越线"}' },
            },
            required: ['pillar', 'id', 'patch'],
        },
    },
    {
        name: 'assign_category',
        description: '给一个或多个条目分配分类',
        parameters: {
            type: 'object',
            properties: {
                pillar: { type: 'string', enum: ['mem', 'npc', 'item', 'timeline'], description: '支柱类型' },
                ids: { type: 'array', items: { type: 'string' }, description: '条目ID列表' },
                category: { type: 'string', description: '分类名称' },
            },
            required: ['pillar', 'ids', 'category'],
        },
    },
    {
        name: 'manage_category',
        description: '管理分类：添加(add)、删除(remove)、重命名(rename)',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['add', 'remove', 'rename'], description: '操作类型' },
                name: { type: 'string', description: '分类名称（添加时的名称或删除/重命名时的旧名称）' },
                newName: { type: 'string', description: '新名称（仅重命名时需要）' },
            },
            required: ['action', 'name'],
        },
    },
    {
        name: 'get_stats',
        description: '获取记忆统计信息，包括总数、各支柱数量、分类统计',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_category_list',
        description: '获取当前聊天的全部分类列表及每个分类的条目数',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'set_active_category',
        description: '设置当前激活的分类（影响注入过滤）',
        parameters: {
            type: 'object',
            properties: {
                category: { type: 'string', description: '分类名称，空字符串=显示全部' },
            },
            required: ['category'],
        },
    },
];

// ═══════════════════════════════════════════════════════════
//  工具执行
// ═══════════════════════════════════════════════════════════

function buildLoader(type, chatId) {
    switch (type) {
        case 'npc': return async () => getNpcProfiles(chatId);
        case 'item': return async () => getItems(chatId);
        case 'timeline': return async () => getTimeline(chatId);
        case 'mem': return async () => getMemories(chatId);
        default: return null;
    }
}

function buildUpdater(type, chatId) {
    switch (type) {
        case 'npc': return (id, patch) => updateNpcProfile(chatId, id, patch);
        case 'item': return (id, patch) => updateItem(chatId, id, patch);
        case 'timeline': return (id, patch) => updateTimelineEntry(chatId, id, patch);
        case 'mem': return (id, patch) => updateMemory(chatId, id, patch);
        default: return null;
    }
}

function formatEntry(entry, pillar) {
    const base = {
        id: entry.id,
        category: entry.category || null,
        memoryTier: entry.memoryTier,
        archived: entry.archived || false,
    };
    switch (pillar) {
        case 'mem':
            return { ...base, title: entry.title, type: entry.type, summary: entry.summary, tags: entry.tags, truthStatus: entry.truthStatus };
        case 'npc':
            return { ...base, name: entry.name, role: entry.role, npcTier: entry.npcTier, tags: entry.tags };
        case 'item':
            return { ...base, name: entry.name, status: entry.status, itemTier: entry.itemTier, tags: entry.tags, owner: entry.owner };
        case 'timeline':
            return { ...base, event: entry.event, storyTime: entry.storyTime, status: entry.status, participants: entry.participants, tags: entry.tags };
        default:
            return base;
    }
}

async function executeTool(toolName, params, chatId) {
    const PILLARS = ['npc', 'item', 'timeline', 'mem'];

    switch (toolName) {
        case 'search_entries': {
            const { query, pillar = 'all', limit = 15 } = params;
            const types = pillar === 'all' ? PILLARS : [pillar];
            const results = [];
            for (const type of types) {
                const loader = buildLoader(type, chatId);
                if (!loader) continue;
                const items = await loader();
                const filtered = items.filter(e => !isArchived(e) && e.status !== 'deleted');
                const searchResults = simpleSearch(filtered, query, limit);
                for (const r of searchResults) {
                    results.push({ pillar: type, ...formatEntry(r, type) });
                }
            }
            results.sort((a, b) => { /* keep simpleSearch order per type */ return 0; });
            return { count: results.length, results: results.slice(0, limit) };
        }

        case 'list_entries': {
            const { pillar, category, limit = 20 } = params;
            const types = pillar === 'all' ? PILLARS : [pillar];
            const results = [];
            for (const type of types) {
                const loader = buildLoader(type, chatId);
                if (!loader) continue;
                const items = await loader();
                let filtered = items.filter(e => !isArchived(e) && e.status !== 'deleted');
                if (category) filtered = filtered.filter(e => e.category === category);
                for (const item of filtered.slice(0, limit)) {
                    results.push({ pillar: type, ...formatEntry(item, type) });
                }
            }
            return { count: results.length, results: results.slice(0, limit) };
        }

        case 'get_entry_detail': {
            const { pillar, id } = params;
            const loader = buildLoader(pillar, chatId);
            if (!loader) return { error: '未知支柱类型' };
            const items = await loader();
            const entry = items.find(e => e.id === id);
            if (!entry) return { error: '条目未找到' };
            return { pillar, ...entry };
        }

        case 'update_entry': {
            const { pillar, id, patch } = params;
            const updater = buildUpdater(pillar, chatId);
            if (!updater) return { error: '未知支柱类型' };
            const result = await updater(id, patch);
            if (!result) return { error: '条目未找到' };
            return { success: true, ...formatEntry(result, pillar) };
        }

        case 'assign_category': {
            const { pillar, ids, category } = params;
            const updater = buildUpdater(pillar, chatId);
            if (!updater) return { error: '未知支柱类型' };
            let count = 0;
            for (const id of ids) {
                const result = await updater(id, { category: category || null });
                if (result) count++;
            }
            return { success: true, assigned: count, category: category || null };
        }

        case 'manage_category': {
            const { action, name, newName } = params;
            const chatIdForCategory = chatId;
            switch (action) {
                case 'add': {
                    const ok = await addCategory(name);
                    return { success: ok, action: 'add', name };
                }
                case 'remove': {
                    const ok = await removeCategory(chatIdForCategory, name);
                    return { success: ok, action: 'remove', name };
                }
                case 'rename': {
                    if (!newName) return { error: 'rename 操作需要 newName 参数' };
                    const ok = await renameCategory(chatIdForCategory, name, newName);
                    return { success: ok, action: 'rename', oldName: name, newName };
                }
                default:
                    return { error: '未知操作' };
            }
        }

        case 'get_stats': {
            const stats = { total: 0, npc: 0, item: 0, timeline: 0, mem: 0 };
            for (const type of PILLARS) {
                const loader = buildLoader(type, chatId);
                if (!loader) continue;
                const items = await loader();
                const active = items.filter(e => !isArchived(e) && e.status !== 'deleted');
                stats[type] = active.length;
                stats.total += active.length;
            }
            const catStats = await getCategoryStats(chatId);
            return { ...stats, categories: catStats };
        }

        case 'get_category_list': {
            const settings = getSettings();
            const catStats = await getCategoryStats(chatId);
            const categories = (settings.categories || []).map(name => ({
                name,
                counts: catStats[name] || { mem: 0, npc: 0, item: 0, timeline: 0 },
            }));
            return {
                activeCategory: settings.activeCategory || '',
                categories,
            };
        }

        case 'set_active_category': {
            await setActiveCategory(params.category || '');
            return { success: true, activeCategory: params.category || '' };
        }

        default:
            return { error: `未知工具: ${toolName}` };
    }
}

// ═══════════════════════════════════════════════════════════
//  Agent 对话循环
// ═══════════════════════════════════════════════════════════

/**
 * 调用副 API 进行 Agent 推理
 */
async function callAgentApi(messages) {
    const settings = getSettings();
    if (!settings.autoGenEndpoint) {
        throw new Error('请先在设置中配置副 API（自定义端点）');
    }

    const endpoint = normalizeEndpoint(settings.autoGenEndpoint);

    const systemPrompt = `你是 BB-Memory 记忆管家，一个帮助用户管理角色扮演记忆的AI助手。

你的能力：
- 搜索和浏览记忆条目、NPC档案、物品、时间线事件
- 修改条目内容和分类
- 管理记忆分类（创建、删除、重命名）
- 统计记忆数据

你的风格：
- 回答简明扼要，用中文
- 当用户问"有哪些"、"列出"、"查找"时，主动调用搜索或列表工具
- 当用户要求"把XX分类"、"归类"时，先用搜索工具找到对应条目，再用分类工具操作
- 操作完成后简要告知用户结果
- 如果用户的问题模糊，追问澄清

回复格式：
- 如果需要调用工具，输出纯JSON：{"tool_calls":[{"name":"工具名","params":{...}}]}
- 一次可以调用多个工具（并行无依赖的可以一起调）
- 如果是最终回答，直接输出文本`;

    const toolsJson = JSON.stringify(TOOLS, null, 2);
    const apiMessages = [
        { role: 'system', content: systemPrompt },
        ...messages,
        { role: 'system', content: `可用工具列表（JSON格式）：\n${toolsJson}\n\n请根据用户的需求决定是否调用工具。如果需要调用工具，只输出JSON，不要输出其他内容。格式：{"tool_calls":[{"name":"工具名","params":{...}}]}` },
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
                messages: apiMessages,
                temperature: 0.3,
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 执行一轮 Agent 对话
 * @param {string} chatId
 * @param {Array} conversationHistory - [{role, content}]
 * @param {Function} onToolCall - 回调，工具调用时通知UI
 * @returns {object} - {finalAnswer, toolCalls}
 */
export async function runAgentTurn(chatId, conversationHistory, onToolCall) {
    const toolCallsLog = [];

    try {
        const response = await callAgentApi(conversationHistory);
        const text = (response || '').trim();

        // 尝试解析 tool_calls
        let toolCalls = null;
        try {
            const trimmed = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            if (trimmed.startsWith('{') && trimmed.includes('tool_calls')) {
                const parsed = JSON.parse(trimmed);
                if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
                    toolCalls = parsed.tool_calls;
                }
            }
        } catch {
            // 不是JSON，是最终回答
        }

        if (toolCalls && toolCalls.length > 0) {
            // 执行工具调用
            const toolResults = [];
            for (const tc of toolCalls) {
                if (onToolCall) onToolCall(tc.name, tc.params);
                try {
                    const result = await executeTool(tc.name, tc.params, chatId);
                    toolResults.push({ tool: tc.name, params: tc.params, result });
                    toolCallsLog.push({ name: tc.name, params: tc.params, result });
                } catch (e) {
                    toolResults.push({ tool: tc.name, params: tc.params, error: e.message });
                    toolCallsLog.push({ name: tc.name, params: tc.params, error: e.message });
                }
            }
            return { type: 'tool_calls', toolCalls: toolCallsLog, toolResults };
        }

        return { type: 'answer', content: text };
    } catch (e) {
        return { type: 'error', error: e.message };
    }
}

/**
 * 完整对话循环：持续调用直到 Agent 给出最终回答
 * @returns {object} - {answer, rounds, toolCallsLog}
 */
export async function runAgentLoop(chatId, userMessage, onToolCall) {
    const conversationHistory = [
        { role: 'user', content: userMessage },
    ];

    const allToolCalls = [];
    const maxRounds = 5;
    let finalAnswer = '';

    for (let round = 0; round < maxRounds; round++) {
        const turn = await runAgentTurn(chatId, conversationHistory, onToolCall);

        if (turn.type === 'answer') {
            finalAnswer = turn.content;
            break;
        }

        if (turn.type === 'error') {
            finalAnswer = `抱歉，处理出错：${turn.error}`;
            break;
        }

        if (turn.type === 'tool_calls') {
            allToolCalls.push(...turn.toolCalls);

            // 将工具结果反馈给 Agent
            const resultsText = turn.toolResults.map(tr => {
                if (tr.error) return `工具 ${tr.tool} 执行失败: ${tr.error}`;
                return `工具 ${tr.tool} 执行结果:\n${JSON.stringify(tr.result, null, 2)}`;
            }).join('\n\n');

            conversationHistory.push({
                role: 'system',
                content: `工具执行结果：\n${resultsText}\n\n请根据结果继续回答用户。如果还需要更多信息可以继续调用工具，否则直接给出最终回答。`,
            });
        }
    }

    if (!finalAnswer && allToolCalls.length > 0) {
        finalAnswer = `已执行 ${allToolCalls.length} 个工具调用。`;
    } else if (!finalAnswer) {
        finalAnswer = '抱歉，我无法处理这个请求。请尝试更具体地描述您的需求。';
    }

    return { answer: finalAnswer, rounds: allToolCalls.length > 0 ? allToolCalls.length : 1, toolCallsLog: allToolCalls };
}

// ═══════════════════════════════════════════════════════════
//  UI 面板
// ═══════════════════════════════════════════════════════════

let agentOverlay = null;
let agentHistory = [];

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
        if (ctx?.toastr?.[type || 'info']) {
            ctx.toastr[type || 'info'](msg);
        }
    } catch { /* ignore */ }
}

function getChatId() {
    try {
        const ctx = window.SillyTavern?.getContext?.();
        return ctx?.chatId || '';
    } catch { return ''; }
}

function buildAgentHTML() {
    return `
    <div class="bb-agent-panel">
        <div class="bb-agent-header">
            <span><i class="fa-solid fa-robot"></i> 记忆管家 Agent</span>
            <div style="display:flex;gap:6px;">
                <button class="bb-agent-btn-clear menu_button" style="font-size:0.75em;" title="清空对话">
                    <i class="fa-solid fa-eraser"></i>
                </button>
                <button class="bb-agent-btn-close menu_button" style="font-size:0.75em;">
                    <i class="fa-solid fa-times"></i>
                </button>
            </div>
        </div>
        <div class="bb-agent-body" id="bb_agent_body">
            <div class="bb-agent-msg bb-agent-msg-system">
                <i class="fa-solid fa-circle-info"></i> 你好！我是记忆管家。你可以用自然语言让我帮你：
                <ul style="margin:4px 0 0 16px;padding:0;">
                    <li>搜索记忆："有哪些关于魔法的记忆？"</li>
                    <li>列出条目："列出所有NPC"</li>
                    <li>管理分类："把穿越线的记忆都找出来"</li>
                    <li>批量操作："将这些条目归入穿越线分类"</li>
                </ul>
                <div style="margin-top:6px;font-size:0.75em;opacity:0.5;">需要先在设置中配置副 API 端点</div>
            </div>
        </div>
        <div class="bb-agent-footer">
            <div class="bb-agent-quick-btns">
                <button class="bb-agent-quick menu_button" data-cmd="帮我统计当前各类记忆数量">统计</button>
                <button class="bb-agent-quick menu_button" data-cmd="列出所有分类及每个分类下的条目数">分类概况</button>
                <button class="bb-agent-quick menu_button" data-cmd="列出最近的10条记忆">最近记忆</button>
                <button class="bb-agent-quick menu_button" data-cmd="列出所有核心NPC">核心NPC</button>
            </div>
            <div class="bb-agent-input-row">
                <textarea id="bb_agent_input" class="bb-input" rows="2" placeholder="输入自然语言指令，如"把穿越线相关的记忆列出来"..."></textarea>
                <button id="bb_agent_send" class="menu_button" style="background:var(--SmartThemeQuoteColor,#4caf50);color:#fff;">
                    <i class="fa-solid fa-paper-plane"></i>
                </button>
            </div>
        </div>
    </div>`;
}

function appendAgentMessage(role, content, isHtml = false) {
    const body = document.querySelector('#bb_agent_body');
    if (!body) return;

    const div = document.createElement('div');
    const iconMap = {
        user: '<i class="fa-solid fa-user"></i>',
        agent: '<i class="fa-solid fa-robot"></i>',
        tool: '<i class="fa-solid fa-wrench"></i>',
        system: '<i class="fa-solid fa-circle-info"></i>',
    };
    const clsMap = {
        user: 'bb-agent-msg-user',
        agent: 'bb-agent-msg-agent',
        tool: 'bb-agent-msg-tool',
        system: 'bb-agent-msg-system',
    };
    div.className = `bb-agent-msg ${clsMap[role] || 'bb-agent-msg-system'}`;

    if (isHtml) {
        div.innerHTML = `${iconMap[role] || ''} ${content}`;
    } else {
        div.innerHTML = `${iconMap[role] || ''} <span>${escapeHtmlAgent(content)}</span>`;
    }

    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
}

async function handleAgentSend() {
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
    agentHistory.push({ role: 'user', content: text });

    // 显示加载中
    const body = document.querySelector('#bb_agent_body');
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'bb-agent-msg bb-agent-msg-agent';
    loadingDiv.innerHTML = '<i class="fa-solid fa-robot"></i> <span><i class="fa-solid fa-spinner fa-spin"></i> 思考中...</span>';
    body.appendChild(loadingDiv);
    body.scrollTop = body.scrollHeight;

    try {
        const result = await runAgentLoop(chatId, text, (toolName, params) => {
            appendAgentMessage('tool', `调用工具：<b>${escapeHtmlAgent(toolName)}</b> ${escapeHtmlAgent(JSON.stringify(params))}`, true);
        });

        loadingDiv.remove();
        appendAgentMessage('agent', result.answer);
        agentHistory.push({ role: 'assistant', content: result.answer });

        if (result.toolCallsLog && result.toolCallsLog.length > 0) {
            const summary = result.toolCallsLog.map(tc =>
                tc.error ? `${tc.name}: ${tc.error}` : `${tc.name} ✓`
            ).join('；');
            showToast(`完成：${summary}`, 'success');
        }
    } catch (e) {
        loadingDiv.remove();
        appendAgentMessage('agent', `出错：${e.message}`);
        agentHistory.push({ role: 'assistant', content: `Error: ${e.message}` });
        showToast(`Agent 出错: ${e.message}`, 'error');
    } finally {
        input.disabled = false;
        btn.disabled = false;
        input.focus();
    }
}

/**
 * 打开记忆管家 Agent 面板
 */
export function openAgent(chatId) {
    const existing = document.querySelector('.bb-agent-overlay');
    if (existing) { existing.remove(); agentHistory = []; }

    const overlay = document.createElement('div');
    overlay.className = 'bb-agent-overlay';
    overlay.innerHTML = `
        <div class="bb-agent-wrapper">
            ${buildAgentHTML()}
        </div>
    `;
    document.body.appendChild(overlay);

    // 事件绑定
    overlay.querySelector('.bb-agent-btn-close')?.addEventListener('click', () => {
        overlay.remove();
        agentHistory = [];
    });
    overlay.querySelector('.bb-agent-btn-clear')?.addEventListener('click', () => {
        agentHistory = [];
        const body = document.querySelector('#bb_agent_body');
        if (body) {
            body.innerHTML = `<div class="bb-agent-msg bb-agent-msg-system">
                <i class="fa-solid fa-circle-info"></i> 对话已清空。有什么可以帮你的？
            </div>`;
        }
    });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { overlay.remove(); agentHistory = []; }
    });

    overlay.querySelector('#bb_agent_send')?.addEventListener('click', handleAgentSend);
    overlay.querySelector('#bb_agent_input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleAgentSend();
        }
    });

    // 快捷按钮
    overlay.querySelectorAll('.bb-agent-quick').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.querySelector('#bb_agent_input');
            if (input) { input.value = btn.dataset.cmd; }
            handleAgentSend();
        });
    });

    // ESC 关闭
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            overlay.remove();
            agentHistory = [];
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    setTimeout(() => {
        overlay.querySelector('#bb_agent_input')?.focus();
    }, 150);
}
