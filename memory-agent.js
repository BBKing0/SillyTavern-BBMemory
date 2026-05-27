/**
 * memory-agent.js —— BB-Memory v8.6.0 记忆管家 Agent
 *
 * 混合模式：读操作直接注入数据给 LLM 自由回答，写操作保留轻量工具。
 * 支持分类管理 UI 内嵌于 Agent 面板。
 */

import { normalizeEndpoint } from './auto-generator.js';
import {
    getSettings, updateSettings,
    getNpcProfiles, getItems, getTimeline, getMemories,
    updateNpcProfile, updateItem, updateTimelineEntry, updateMemory,
    addCategory, removeCategory, renameCategory, toggleCategory,
    getCategoryStats,
} from './memory-store.js';
import { simpleSearch } from './retriever.js';

// ═══════════════════════════════════════════════════════════
//  预检索：将相关数据直接注入 prompt
// ═══════════════════════════════════════════════════════════

async function prepareContext(chatId, userMessage) {
    const settings = getSettings();
    const enabled = settings.enabledCategories || {};
    const hasEnabled = Object.values(enabled).some(v => v === true);

    // 并行加载所有数据
    const [npcs, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId),
        getItems(chatId),
        getTimeline(chatId),
        getMemories(chatId),
    ]);

    // 搜索相关条目
    const allEntries = [
        ...npcs.filter(e => !e.archived).map(e => ({ ...e, _pillar: 'npc' })),
        ...items.filter(e => !e.archived).map(e => ({ ...e, _pillar: 'item' })),
        ...timeline.filter(e => !e.archived).map(e => ({ ...e, _pillar: 'timeline' })),
        ...memories.filter(e => !e.archived && e.status !== 'deleted').map(e => ({ ...e, _pillar: 'mem' })),
    ];
    const searchResults = simpleSearch(allEntries, userMessage, 20);

    // 统计
    const stats = { npc: npcs.filter(e => !e.archived).length, item: items.filter(e => !e.archived).length, timeline: timeline.filter(e => !e.archived).length, mem: memories.filter(e => !e.archived && e.status !== 'deleted').length };
    const catStats = await getCategoryStats(chatId);
    const categories = (settings.categories || []).map(name => ({
        name,
        enabled: enabled[name] === true,
        counts: catStats[name] || { mem: 0, npc: 0, item: 0, timeline: 0 },
    }));
    const enabledList = hasEnabled ? (settings.categories || []).filter(c => enabled[c]).join('、') || '(无)' : '';
    const filterStatus = hasEnabled ? '已开启: ' + enabledList : '全部显示';

    // 构建数据上下文
    const pillars = ['mem', 'npc', 'item', 'timeline'];
    const grouped = {};
    for (const p of pillars) grouped[p] = [];

    for (const r of searchResults) {
        const p = r._pillar || 'mem';
        const label = r.title || r.name || r.event || (r.content || '').slice(0, 30);
        const cat = r.category ? ` [${r.category}]` : '';
        const tierBadge = r.memoryTier === 'eternal' ? ' ⭐' : r.memoryTier === 'core' ? ' ★' : '';
        grouped[p].push(`- ${label}${cat}${tierBadge} (${r.id})`);
    }

    let catListText = '(无分类)';
    if (categories.length > 0) {
        catListText = categories.map(c => {
            const statusIcon = c.enabled ? '✅注入' : '⏸暂停';
            const counts = `记忆${c.counts.mem||0} NPC${c.counts.npc||0} 物品${c.counts.item||0} 时间线${c.counts.timeline||0}`;
            return '- ' + c.name + ': ' + statusIcon + ' (' + counts + ')';
        }).join('\n');
    }

    let contextText = `【数据快照】
总条目: ${stats.mem}条记忆 / ${stats.npc}个NPC / ${stats.item}件物品 / ${stats.timeline}条时间线
注入过滤: ${filterStatus}

【分类列表】
${catListText}`;

    const pillarLabels = { mem: '记忆', npc: 'NPC', item: '物品', timeline: '时间线' };
    for (const p of pillars) {
        if (grouped[p].length > 0) {
            contextText += `\n\n【${pillarLabels[p]}搜索结果 (${grouped[p].length}条)】\n${grouped[p].join('\n')}`;
        }
    }

    return { contextText, stats, categories, searchResults, hasEnabled };
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

    const systemPrompt = `你是 BB-Memory 记忆管家，帮助用户管理 SillyTavern 角色扮演的长期记忆。

你的能力：
- 回答关于记忆条目、NPC、物品、时间线的问题
- 分析记忆数据的统计和分布
- 提供分类管理建议

你可以执行的写操作（需要用户明确要求时才执行）：
- 给条目分配分类：回复 "ACTION: assign_category 支柱类型 条目ID 分类名"
- 修改条目内容：回复 "ACTION: update_entry 支柱类型 条目ID {\"key\":\"value\"}"
- 切换分类注入开关：回复 "ACTION: toggle_category 分类名 true/false"
- 添加/删除/重命名分类：回复 "ACTION: manage_category add|remove|rename 分类名 [新名称]"

回答风格：
- 用中文，简明扼要
- 当用户问"有哪些"、"列出"时，基于下方数据快照直接回答
- 当用户要求执行操作时，使用 ACTION 指令
- 不要编造数据快照中没有的信息`;

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

async function executeAction(actionLine, chatId) {
    const match = actionLine.match(/^ACTION:\s*(\w+)\s+(.+)$/);
    if (!match) return null;

    const [, action, argsStr] = match;
    const args = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(a => a.replace(/^"|"$/g, '')) || [];

    try {
        switch (action) {
            case 'assign_category': {
                const [pillar, id, category] = args;
                const updater = {
                    mem: updateMemory, npc: updateNpcProfile,
                    item: updateItem, timeline: updateTimelineEntry,
                }[pillar];
                if (!updater) return { error: '未知支柱: ' + pillar };
                await updater(chatId, id, { category: category === 'null' || category === '无' ? null : category });
                return { success: true, msg: `已设置分类` };
            }

            case 'update_entry': {
                const [pillar, id, jsonStr] = args;
                const updater = {
                    mem: updateMemory, npc: updateNpcProfile,
                    item: updateItem, timeline: updateTimelineEntry,
                }[pillar];
                if (!updater) return { error: '未知支柱: ' + pillar };
                const patch = JSON.parse(jsonStr);
                await updater(chatId, id, patch);
                return { success: true, msg: '已更新' };
            }

            case 'toggle_category': {
                const [name, enabledStr] = args;
                const enabled = enabledStr === 'true';
                await toggleCategory(name, enabled);
                return { success: true, msg: `分类「${name}」已${enabled ? '开启' : '暂停'}注入` };
            }

            case 'manage_category': {
                const [subAction, name, newName] = args;
                switch (subAction) {
                    case 'add': await addCategory(name); return { success: true, msg: `分类「${name}」已添加` };
                    case 'remove': await removeCategory(chatId, name); return { success: true, msg: `分类「${name}」已删除` };
                    case 'rename': await renameCategory(chatId, name, newName); return { success: true, msg: `已重命名为「${newName}」` };
                    default: return { error: '未知子操作: ' + subAction };
                }
            }

            default:
                return { error: '未知操作: ' + action };
        }
    } catch (e) {
        return { error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════
//  主对话流程
// ═══════════════════════════════════════════════════════════

export async function runAgentQuery(chatId, userMessage, conversationHistory, onAction) {
    // 1. 预检索
    const { contextText } = await prepareContext(chatId, userMessage);

    // 2. 调用 LLM
    const response = await callAgentApi(contextText, conversationHistory);

    // 3. 解析 ACTION 指令
    const actionLines = (response || '').split('\n').filter(l => l.trim().startsWith('ACTION:'));
    const actionResults = [];
    let answerText = response || '';

    for (const line of actionLines) {
        const result = await executeAction(line.trim(), chatId);
        if (result) {
            actionResults.push(result);
            if (onAction) onAction(line.trim(), result);
        }
        // 从回答中移除 ACTION 行
        answerText = answerText.replace(line, '').trim();
    }

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
            <span><i class="fa-solid fa-robot"></i> 记忆管家</span>
            <div style="display:flex;gap:4px;">
                <button class="bb-agent-btn-clear menu_button" style="font-size:0.72em;" title="清空对话"><i class="fa-solid fa-eraser"></i></button>
                <button class="bb-agent-btn-close menu_button" style="font-size:0.72em;"><i class="fa-solid fa-times"></i></button>
            </div>
        </div>

        <div class="bb-agent-body" id="bb_agent_body">
            <div class="bb-agent-msg bb-agent-msg-system">
                <i class="fa-solid fa-circle-info"></i> 你好！我是记忆管家。你可以用自然语言问我：
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
                <button class="bb-agent-quick menu_button" data-cmd="列出所有活跃的时间线事件">⏱ 活跃时间线</button>
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
            appendAgentMessage('tool', `${ok ? '✅' : '❌'} ${action} → ${ok ? (res.msg || '成功') : (res.error || '失败')}`, true);
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
        if (body) body.innerHTML = `<div class="bb-agent-msg bb-agent-msg-system">💬 对话已清空。有什么可以帮你的？</div>`;
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
