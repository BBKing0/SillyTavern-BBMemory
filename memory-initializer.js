/**
 * memory-initializer.js — BB-Memory 初始化工作台
 *
 * 先把角色卡、世界书、聊天记录提取为可审阅草稿，再由用户编辑/合并/保存。
 */

import {
    extractInitialDataFromContext,
    saveInitialExtractionResult,
} from './auto-generator.js';

const PILLARS = [
    { key: 'memories', label: '记忆', icon: 'fa-brain' },
    { key: 'npc', label: 'NPC', icon: 'fa-user' },
    { key: 'items', label: '物品', icon: 'fa-box' },
    { key: 'locations', label: '地点', icon: 'fa-map-location-dot' },
    { key: 'milestones', label: '里程碑', icon: 'fa-flag-checkered' },
    { key: 'timeline', label: '时间线', icon: 'fa-timeline' },
];

const FIELD_SPECS = {
    memories: [
        ['title', '标题', 'text'],
        ['type', '类型', 'select', ['event', 'emotion', 'habit', 'fact']],
        ['summary', '摘要', 'textarea'],
        ['content', '完整内容', 'textarea'],
        ['verbatim', '重要原话', 'textarea'],
        ['subject', '主体', 'text'],
        ['target', '目标', 'text'],
        ['importance', '重要性 0-1', 'number'],
        ['emotionalWeight', '情感权重 0-1', 'number'],
        ['storyTime', '故事时间', 'text'],
        ['truthStatus', '真实性', 'select', ['true', 'false', 'unknown', 'rumor', 'misleading', 'secret_true']],
        ['memoryTier', '等级', 'select', ['transient', 'stable', 'core', 'eternal']],
        ['tags', '标签（逗号分隔）', 'tags'],
    ],
    npc: [
        ['name', '姓名', 'text'],
        ['role', '身份/职业', 'text'],
        ['personality', '性格', 'textarea'],
        ['appearance', '外貌', 'textarea'],
        ['status', '状态', 'text'],
        ['location', '所在地', 'text'],
        ['indexCard', '索引卡', 'textarea'],
        ['npcTier', '分级', 'select', ['core', 'important', 'minor', 'background']],
        ['relationships', '关系 JSON', 'json'],
        ['tags', '标签（逗号分隔）', 'tags'],
    ],
    items: [
        ['name', '物品名', 'text'],
        ['owner', '持有者', 'text'],
        ['status', '状态', 'select', ['held', 'used', 'lost', 'destroyed']],
        ['location', '所在地点', 'text'],
        ['significance', '意义与用途', 'textarea'],
        ['itemTier', '分级', 'select', ['key', 'equipped', 'clue', 'consumable', 'background']],
        ['keepPermanent', '常驻/永久保留', 'checkbox'],
        ['tags', '标签（逗号分隔）', 'tags'],
    ],
    locations: [
        ['name', '地名', 'text'],
        ['region', '区域', 'text'],
        ['description', '地点描述', 'textarea'],
        ['realWorldRef', '现实原型参考', 'text'],
        ['memoryTier', '等级', 'select', ['transient', 'stable', 'core', 'eternal']],
        ['keepPermanent', '常驻/永久保留', 'checkbox'],
        ['edges', '连接 JSON', 'json'],
    ],
    milestones: [
        ['storyTime', '故事时间', 'text'],
        ['event', '事件摘要', 'text'],
        ['summary', '详细描述', 'textarea'],
        ['participants', '参与者（逗号分隔）', 'list'],
        ['location', '地点', 'text'],
        ['status', '状态', 'select', ['ongoing', 'ended', 'foreshadow']],
        ['isActive', '仍在进行', 'checkbox'],
        ['impact', '影响', 'textarea'],
        ['tags', '标签（逗号分隔）', 'tags'],
    ],
    timeline: [
        ['name', '时间线名', 'text'],
        ['type', '类型', 'select', ['plot', 'emotional', 'side', 'world']],
        ['status', '状态', 'select', ['ongoing', 'paused', 'ended', 'archived', 'resident']],
        ['priority', '优先级', 'select', ['high', 'medium', 'low']],
        ['summary', '一句话总结', 'textarea'],
        ['entries', '关联事件 JSON', 'json'],
    ],
};

const state = {
    chatId: null,
    activePillar: 'memories',
    currentContext: null,
    uploaded: { character: null, worldbook: null, chat: null },
    draft: emptyDraft(),
    busy: false,
};

function emptyDraft() {
    return { version: '9.4.4-init-draft', npc: [], items: [], milestones: [], timeline: [], memories: [], locations: [] };
}

function $(root, selector) {
    return root.querySelector(selector);
}

function $all(root, selector) {
    return [...root.querySelectorAll(selector)];
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

function generateDraftId() {
    return 'draft_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function notify(message, type = 'info') {
    if (typeof globalThis.bbMemoryShowToast === 'function') {
        globalThis.bbMemoryShowToast(message, type);
        return;
    }
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.[type] === 'function') {
            ctx.toastr[type](message, '', { timeOut: 3000 });
            return;
        }
    } catch { /* ignore */ }
    console.log('[BB-Memory]', message);
}

function getContextSafe() {
    try { return SillyTavern.getContext(); } catch { return null; }
}

function getChatIdSafe() {
    const ctx = getContextSafe();
    return ctx?.chatId || (ctx?.chat?.[0]?.chatId) || state.chatId || null;
}

export function openMemoryInitializer(chatId, options = {}) {
    const nextChatId = chatId || getChatIdSafe();
    if (state.chatId && nextChatId && state.chatId !== nextChatId) {
        state.currentContext = null;
        state.uploaded = { character: null, worldbook: null, chat: null };
        state.draft = emptyDraft();
        state.activePillar = 'memories';
    }
    state.chatId = nextChatId;
    if (!state.chatId) {
        notify('请先进入角色对话', 'warning');
        return;
    }

    document.getElementById('bb_init_overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'bb_init_overlay';
    overlay.className = 'bb-init-overlay';
    overlay.innerHTML = buildShell(options);
    document.body.appendChild(overlay);
    bindEvents(overlay, options);
    renderAll(overlay);
}

function buildShell(options) {
    const rangeValue = options.rangeStr ? escapeHtml(options.rangeStr) : '';
    return `
        <div class="bb-init-panel">
            <div class="bb-init-header">
                <div>
                    <div class="bb-init-title"><i class="fa-solid fa-rocket"></i> BB-Memory 初始化工作台</div>
                    <div class="bb-init-subtitle">上传或读取资料 → AI 提取草稿 → 编辑合并 → 保存到当前聊天</div>
                </div>
                <button class="menu_button bb-init-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="bb-init-body">
                <section class="bb-init-source">
                    <div class="bb-init-notice">
                        <i class="fa-solid fa-circle-info"></i>
                        <span>从当前酒馆读取时，将自动读取当前上下文、已绑定世界书和角色卡。若有不希望 AI 读取的内容，请先删除、隐藏或暂时解除绑定。</span>
                    </div>

                    <div class="bb-init-grid">
                        <div class="bb-init-box">
                            <div class="bb-init-box-title"><i class="fa-solid fa-wand-magic-sparkles"></i> 当前酒馆资料</div>
                            <div class="bb-init-source-options">
                                <label><input type="checkbox" class="bb-init-current-part" value="character" checked> 角色卡</label>
                                <label><input type="checkbox" class="bb-init-current-part" value="worldbook" checked> 已绑定世界书</label>
                                <label><input type="checkbox" class="bb-init-current-part" value="chat" checked> 聊天记录</label>
                            </div>
                            <div class="bb-init-inline">
                                <label>楼层范围</label>
                                <input class="bb-init-input" id="bb_init_range" value="${rangeValue}" placeholder="例如 0-80；留空读取最近楼层">
                                <label>最近楼层数</label>
                                <input class="bb-init-input" id="bb_init_chat_limit" type="number" min="10" max="500" value="120">
                            </div>
                            <button class="menu_button bb-init-load-current"><i class="fa-solid fa-download"></i> 读取当前酒馆资料</button>
                            <div class="bb-init-source-summary" id="bb_init_current_summary">尚未读取当前酒馆资料</div>
                        </div>

                        <div class="bb-init-box">
                            <div class="bb-init-box-title"><i class="fa-solid fa-file-import"></i> 上传资料</div>
                            <div class="bb-init-upload-row">
                                <label class="bb-init-upload"><i class="fa-solid fa-id-card"></i><span>角色卡 JSON/TXT</span><input type="file" data-kind="character" accept=".json,.txt,.md"></label>
                                <label class="bb-init-upload"><i class="fa-solid fa-book"></i><span>世界书 JSON/TXT</span><input type="file" data-kind="worldbook" accept=".json,.txt,.md"></label>
                                <label class="bb-init-upload"><i class="fa-solid fa-comments"></i><span>聊天记录 JSON/TXT</span><input type="file" data-kind="chat" accept=".json,.txt,.md"></label>
                                <label class="bb-init-upload"><i class="fa-solid fa-layer-group"></i><span>草稿/BBMemory JSON</span><input type="file" data-kind="draft" accept=".json"></label>
                            </div>
                            <div class="bb-init-source-summary" id="bb_init_upload_summary">尚未上传资料</div>
                        </div>
                    </div>

                    <div class="bb-init-box">
                        <div class="bb-init-box-title"><i class="fa-solid fa-list-check"></i> 提取范围</div>
                        <div class="bb-init-pillars">
                            ${PILLARS.map(p => `
                                <label class="bb-init-pillar-choice">
                                    <input type="checkbox" class="bb-init-pillar" value="${p.key}" checked>
                                    <i class="fa-solid ${p.icon}"></i><span>${p.label}</span>
                                </label>
                            `).join('')}
                        </div>
                        <label class="bb-init-merge-toggle">
                            <input type="checkbox" id="bb_init_merge_draft" checked>
                            提取结果合并到现有草稿（适合第一波只提记忆、第二波只提地图）
                        </label>
                        <div class="bb-init-actions">
                            <button class="menu_button bb-init-extract"><i class="fa-solid fa-sparkles"></i> AI 提取为草稿</button>
                            <button class="menu_button bb-init-add-entry"><i class="fa-solid fa-plus"></i> 新增当前类型</button>
                            <button class="menu_button bb-init-export"><i class="fa-solid fa-download"></i> 导出草稿 JSON</button>
                            <button class="menu_button bb-init-clear"><i class="fa-solid fa-trash"></i> 清空草稿</button>
                        </div>
                    </div>
                </section>

                <section class="bb-init-draft">
                    <div class="bb-init-progress" id="bb_init_progress">
                        <div class="bb-init-progress-bar"><span></span></div>
                        <div class="bb-init-progress-text">准备就绪</div>
                    </div>

                    <div class="bb-init-stats" id="bb_init_stats"></div>
                    <div class="bb-init-tabs" id="bb_init_tabs"></div>
                    <div class="bb-init-list" id="bb_init_list"></div>

                    <div class="bb-init-savebar">
                        <button class="menu_button bb-init-save"><i class="fa-solid fa-floppy-disk"></i> 保存草稿到当前聊天</button>
                        <span id="bb_init_save_hint">保存时会按名称/事件/地点合并已有条目；记忆会使用向量或精确键去重。</span>
                    </div>
                </section>
            </div>
        </div>
    `;
}

function bindEvents(root, options) {
    $('.bb-init-close', root).addEventListener('click', () => root.remove());
    root.addEventListener('click', e => {
        if (e.target === root) root.remove();
    });

    $('.bb-init-load-current', root).addEventListener('click', () => {
        state.currentContext = collectCurrentContext(root, options);
        renderSources(root);
        notify('已读取当前酒馆资料，请确认提取范围后开始 AI 提取', 'success');
    });

    $all(root, 'input[type="file"][data-kind]').forEach(input => {
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                await handleUpload(root, input.dataset.kind, file);
                input.value = '';
            } catch (e) {
                notify(`读取文件失败: ${e.message}`, 'error');
            }
        });
    });

    $('.bb-init-extract', root).addEventListener('click', () => runExtraction(root));
    $('.bb-init-save', root).addEventListener('click', () => saveDraft(root));
    $('.bb-init-clear', root).addEventListener('click', () => {
        if (!confirm('确定清空当前初始化草稿吗？')) return;
        state.draft = emptyDraft();
        renderAll(root);
    });
    $('.bb-init-export', root).addEventListener('click', exportDraft);
    $('.bb-init-add-entry', root).addEventListener('click', () => openEditDialog(root, state.activePillar, null));
}

function renderAll(root) {
    renderSources(root);
    renderDraft(root);
}

function setBusy(root, busy, text = '') {
    state.busy = busy;
    $all(root, 'button, input').forEach(el => {
        if (el.classList.contains('bb-init-close')) return;
        el.disabled = busy;
    });
    if (busy || text) {
        setProgress(root, busy ? 35 : 0, text || '处理中...');
    }
}

function setProgress(root, pct, text) {
    const bar = $('#bb_init_progress .bb-init-progress-bar span', root);
    const label = $('#bb_init_progress .bb-init-progress-text', root);
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (label) label.textContent = text || '';
}

function renderSources(root) {
    const current = state.currentContext;
    $('#bb_init_current_summary', root).textContent = current
        ? `已读取：角色卡 ${current.characterText ? '有' : '无'} / 世界书 ${current.worldText ? current.worldCount + ' 条' : '无'} / 聊天 ${current.chatCount || 0} 条`
        : '尚未读取当前酒馆资料';

    const names = [];
    for (const [kind, data] of Object.entries(state.uploaded)) {
        if (data) names.push(`${sourceKindLabel(kind)}：${data.name}`);
    }
    $('#bb_init_upload_summary', root).textContent = names.length ? names.join('；') : '尚未上传资料';
}

function renderDraft(root) {
    const stats = countDraft(state.draft);
    $('#bb_init_stats', root).innerHTML = PILLARS.map(p => `
        <div class="bb-init-stat">
            <i class="fa-solid ${p.icon}"></i>
            <span>${p.label}</span>
            <strong>${stats[p.key] || 0}</strong>
        </div>
    `).join('');

    $('#bb_init_tabs', root).innerHTML = PILLARS.map(p => `
        <button class="menu_button bb-init-tab ${state.activePillar === p.key ? 'active' : ''}" data-pillar="${p.key}">
            <i class="fa-solid ${p.icon}"></i> ${p.label} <span>${stats[p.key] || 0}</span>
        </button>
    `).join('');
    $all(root, '.bb-init-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            state.activePillar = btn.dataset.pillar;
            renderDraft(root);
        });
    });

    const list = $('#bb_init_list', root);
    const entries = state.draft[state.activePillar] || [];
    if (!entries.length) {
        list.innerHTML = `<div class="bb-init-empty">当前没有${getPillarLabel(state.activePillar)}草稿。可以切换提取范围后再次提取，或手动新增。</div>`;
        return;
    }

    list.innerHTML = entries.map(entry => renderEntryCard(state.activePillar, entry)).join('');
    $all(list, '.bb-init-edit').forEach(btn => {
        btn.addEventListener('click', () => openEditDialog(root, state.activePillar, btn.dataset.id));
    });
    $all(list, '.bb-init-delete').forEach(btn => {
        btn.addEventListener('click', () => {
            state.draft[state.activePillar] = (state.draft[state.activePillar] || []).filter(e => e._draftId !== btn.dataset.id);
            renderDraft(root);
        });
    });
}

function renderEntryCard(pillar, entry) {
    const title = getEntryTitle(pillar, entry);
    const meta = getEntryMeta(pillar, entry);
    const body = getEntryBody(pillar, entry);
    const tags = Array.isArray(entry.tags) ? entry.tags.map(t => typeof t === 'string' ? t : t.name).filter(Boolean) : [];
    return `
        <article class="bb-init-entry">
            <div class="bb-init-entry-main">
                <div class="bb-init-entry-title">${escapeHtml(title || '(未命名)')}</div>
                <div class="bb-init-entry-meta">${escapeHtml(meta)}</div>
                <div class="bb-init-entry-body">${escapeHtml(body)}</div>
                ${tags.length ? `<div class="bb-init-entry-tags">${tags.slice(0, 8).map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>` : ''}
            </div>
            <div class="bb-init-entry-actions">
                <button class="menu_button bb-init-edit" data-id="${escapeHtml(entry._draftId)}" title="编辑"><i class="fa-solid fa-pen"></i></button>
                <button class="menu_button bb-init-delete" data-id="${escapeHtml(entry._draftId)}" title="删除"><i class="fa-solid fa-trash"></i></button>
            </div>
        </article>
    `;
}

function getEntryTitle(pillar, entry) {
    if (pillar === 'memories') return entry.title;
    if (pillar === 'milestones') return entry.event;
    return entry.name;
}

function getEntryMeta(pillar, entry) {
    if (pillar === 'memories') return `${entry.type || 'event'} · ${entry.memoryTier || 'stable'} · ${entry.storyTime || '无时间'}`;
    if (pillar === 'npc') return `${entry.npcTier || 'minor'} · ${entry.role || '身份未填'} · ${entry.location || '地点未填'}`;
    if (pillar === 'items') return `${entry.itemTier || 'consumable'} · ${entry.status || 'held'} · ${entry.owner || entry.location || '归属未填'}`;
    if (pillar === 'locations') return `${entry.region || '未分区'} · ${(entry.edges || []).length || 0} 条连接`;
    if (pillar === 'milestones') return `${entry.status || 'ongoing'} · ${entry.storyTime || '无时间'} · ${entry.location || '地点未填'}`;
    if (pillar === 'timeline') return `${entry.type || 'plot'} · ${entry.status || 'ongoing'} · ${entry.priority || 'medium'}`;
    return '';
}

function getEntryBody(pillar, entry) {
    if (pillar === 'memories') return entry.summary || entry.content || '';
    if (pillar === 'npc') return entry.indexCard || entry.personality || entry.appearance || '';
    if (pillar === 'items') return entry.significance || '';
    if (pillar === 'locations') return entry.description || '';
    if (pillar === 'milestones') return entry.summary || entry.impact || '';
    if (pillar === 'timeline') return entry.summary || '';
    return '';
}

function openEditDialog(root, pillar, draftId) {
    const isNew = !draftId;
    const list = state.draft[pillar] || [];
    const entry = isNew ? makeDefaultEntry(pillar) : list.find(e => e._draftId === draftId);
    if (!entry) return;

    const overlay = document.createElement('div');
    overlay.className = 'bb-init-edit-overlay';
    overlay.innerHTML = `
        <div class="bb-init-edit-dialog">
            <div class="bb-init-edit-title">${isNew ? '新增' : '编辑'}${getPillarLabel(pillar)}</div>
            <div class="bb-init-edit-fields">
                ${FIELD_SPECS[pillar].map(spec => renderField(spec, entry)).join('')}
            </div>
            <div class="bb-init-edit-actions">
                <button class="menu_button bb-init-edit-cancel">取消</button>
                <button class="menu_button bb-init-edit-ok"><i class="fa-solid fa-check"></i> 保存</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    $('.bb-init-edit-cancel', overlay).addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    $('.bb-init-edit-ok', overlay).addEventListener('click', () => {
        try {
            const updated = collectEditFields(overlay, pillar, entry);
            if (isNew) {
                state.draft[pillar].push(updated);
            } else {
                Object.assign(entry, updated);
            }
            overlay.remove();
            renderDraft(root);
        } catch (e) {
            notify(e.message, 'error');
        }
    });
}

function renderField(spec, entry) {
    const [key, label, type, options] = spec;
    const value = entry[key];
    const id = `bb_init_field_${key}`;
    if (type === 'select') {
        return `
            <label class="bb-init-edit-field">
                <span>${escapeHtml(label)}</span>
                <select class="bb-init-field" data-key="${key}" data-type="${type}">
                    ${(options || []).map(opt => `<option value="${opt}" ${value === opt ? 'selected' : ''}>${opt}</option>`).join('')}
                </select>
            </label>
        `;
    }
    if (type === 'checkbox') {
        return `
            <label class="bb-init-edit-field inline">
                <input class="bb-init-field" data-key="${key}" data-type="${type}" type="checkbox" ${value ? 'checked' : ''}>
                <span>${escapeHtml(label)}</span>
            </label>
        `;
    }
    if (type === 'textarea' || type === 'json') {
        const text = type === 'json' ? JSON.stringify(value || [], null, 2) : String(value || '');
        return `
            <label class="bb-init-edit-field">
                <span>${escapeHtml(label)}</span>
                <textarea class="bb-init-field" data-key="${key}" data-type="${type}" rows="${type === 'json' ? 5 : 3}">${escapeHtml(text)}</textarea>
            </label>
        `;
    }
    const text = type === 'tags' ? tagsToText(value) : (type === 'list' ? listToText(value) : String(value ?? ''));
    return `
        <label class="bb-init-edit-field">
            <span>${escapeHtml(label)}</span>
            <input id="${id}" class="bb-init-field" data-key="${key}" data-type="${type}" type="${type === 'number' ? 'number' : 'text'}" value="${escapeHtml(text)}" ${type === 'number' ? 'step="0.05" min="0" max="1"' : ''}>
        </label>
    `;
}

function collectEditFields(dialog, pillar, original) {
    const next = { ...original };
    $all(dialog, '.bb-init-field').forEach(field => {
        const key = field.dataset.key;
        const type = field.dataset.type;
        if (type === 'checkbox') next[key] = field.checked;
        else if (type === 'number') next[key] = Number(field.value || 0);
        else if (type === 'tags') next[key] = textToTags(field.value);
        else if (type === 'list') next[key] = textToList(field.value);
        else if (type === 'json') {
            try { next[key] = field.value.trim() ? JSON.parse(field.value) : []; }
            catch { throw new Error(`${key} 不是有效 JSON`); }
        } else {
            next[key] = field.value;
        }
    });
    next._draftId = next._draftId || generateDraftId();
    normalizeEntryInPlace(pillar, next);
    return next;
}

async function runExtraction(root) {
    const contextText = buildContextText(root);
    if (!contextText.trim()) {
        notify('请先读取当前酒馆资料，或上传角色卡/世界书/聊天记录', 'warning');
        return;
    }
    const selectedPillars = getSelectedPillars(root);
    if (!selectedPillars.length) {
        notify('请至少选择一种要提取的类型', 'warning');
        return;
    }

    setBusy(root, true, '正在准备初始化资料...');
    try {
        const result = await extractInitialDataFromContext(state.chatId, contextText, {
            selectedPillars,
            onProgress: info => setProgress(root, info.stage === 'ai' ? 55 : 35, info.progress || '处理中...'),
        });
        assignDraftIds(result);
        if ($('#bb_init_merge_draft', root).checked) {
            mergeDraft(result, selectedPillars);
        } else {
            replaceSelectedDraft(result, selectedPillars);
        }
        setProgress(root, 100, '草稿提取完成，请检查后保存');
        renderDraft(root);
        notify('初始化草稿提取完成', 'success');
    } catch (e) {
        setProgress(root, 0, '提取失败');
        notify(`初始化提取失败: ${e.message}`, 'error');
    } finally {
        setTimeout(() => setBusy(root, false), 300);
    }
}

async function saveDraft(root) {
    const total = Object.values(countDraft(state.draft)).reduce((sum, n) => sum + n, 0);
    if (!total) {
        notify('草稿为空，无法保存', 'warning');
        return;
    }
    const chatId = getChatIdSafe();
    if (!chatId) {
        notify('请先进入角色对话', 'warning');
        return;
    }
    setBusy(root, true, '正在保存草稿到 BB-Memory...');
    try {
        const result = await saveInitialExtractionResult(chatId, stripDraftIds(state.draft), {
            selectedPillars: PILLARS.map(p => p.key),
            sourceInfo: { source: 'init', sourceFloor: -1 },
        });
        setProgress(root, 100, '保存完成');
        notify(`保存完成：记忆 ${result.memories} / NPC ${result.npc} / 物品 ${result.items} / 地点 ${result.locations} / 里程碑 ${result.milestones} / 时间线 ${result.timeline}，合并 ${result.merged}，跳过 ${result.skipped}`, 'success');
    } catch (e) {
        setProgress(root, 0, '保存失败');
        notify(`保存失败: ${e.message}`, 'error');
    } finally {
        setTimeout(() => setBusy(root, false), 300);
    }
}

function buildContextText(root) {
    const sections = [];
    const currentParts = new Set($all(root, '.bb-init-current-part:checked').map(el => el.value));
    if (state.currentContext) {
        if (currentParts.has('character') && state.currentContext.characterText) {
            sections.push(`【当前角色卡】\n${state.currentContext.characterText}`);
        }
        if (currentParts.has('worldbook') && state.currentContext.worldText) {
            sections.push(`【当前已绑定世界书】\n${state.currentContext.worldText}`);
        }
        if (currentParts.has('chat') && state.currentContext.chatText) {
            sections.push(`【当前聊天记录】\n${state.currentContext.chatText}`);
        }
    }
    if (state.uploaded.character?.text) sections.push(`【上传角色卡】\n${state.uploaded.character.text}`);
    if (state.uploaded.worldbook?.text) sections.push(`【上传世界书】\n${state.uploaded.worldbook.text}`);
    if (state.uploaded.chat?.text) sections.push(`【上传聊天记录】\n${state.uploaded.chat.text}`);
    return sections.join('\n\n').slice(0, 180000);
}

function collectCurrentContext(root, options = {}) {
    const ctx = getContextSafe();
    if (!ctx) throw new Error('无法读取 SillyTavern 上下文');
    const rangeStr = ($('#bb_init_range', root)?.value || options.rangeStr || '').trim();
    const limit = Math.max(10, Math.min(500, parseInt($('#bb_init_chat_limit', root)?.value || '120', 10) || 120));
    const characterText = getCurrentCharacterText(ctx);
    const world = getCurrentWorldText(ctx);
    const chat = getCurrentChatText(ctx, rangeStr, limit);
    return {
        characterText,
        worldText: world.text,
        worldCount: world.count,
        chatText: chat.text,
        chatCount: chat.count,
    };
}

function getCurrentCharacterText(ctx) {
    const char = (ctx.characters && ctx.characterId !== undefined) ? ctx.characters[ctx.characterId] : null;
    const data = char?.data || char || {};
    const lines = [];
    const fields = [
        ['角色名', data.name || char?.name],
        ['描述', data.description || char?.description],
        ['性格', data.personality || char?.personality],
        ['场景', data.scenario || char?.scenario],
        ['开场白', data.first_mes || char?.first_mes],
        ['示例对话', data.mes_example || char?.mes_example],
        ['创作者备注', data.creator_notes || char?.creator_notes],
        ['系统提示', data.system_prompt || char?.system_prompt],
        ['后置指令', data.post_history_instructions || char?.post_history_instructions],
    ];
    for (const [label, value] of fields) {
        if (value) lines.push(`${label}：${value}`);
    }
    if (data.character_book?.entries) {
        lines.push('角色卡内置世界书：');
        lines.push(formatWorldEntries(extractWorldEntries(data.character_book)));
    }
    return lines.join('\n');
}

function getCurrentWorldText(ctx) {
    const source = ctx.worldInfo || ctx.world_info || null;
    const entries = extractWorldEntries(source);
    return { text: formatWorldEntries(entries), count: entries.length };
}

function getCurrentChatText(ctx, rangeStr, limit) {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    let start = Math.max(0, chat.length - limit);
    let end = chat.length - 1;
    const match = rangeStr.match(/^(\d+)\s*-\s*(\d+)$/);
    if (match) {
        start = Math.max(0, parseInt(match[1], 10));
        end = Math.min(chat.length - 1, parseInt(match[2], 10));
    }
    const messages = chat.slice(start, end + 1).filter(m => m && m.mes && !m.is_system);
    return {
        count: messages.length,
        text: messages.map((m, i) => {
            const floor = start + i;
            const speaker = m.is_user ? '用户' : (m.name || '角色');
            return `[${floor}] ${speaker}: ${stripHtml(m.mes)}`;
        }).join('\n'),
    };
}

async function handleUpload(root, kind, file) {
    const text = await readFileText(file);
    if (kind === 'draft') {
        const data = JSON.parse(text);
        const normalized = normalizeDraftData(data);
        assignDraftIds(normalized);
        mergeDraft(normalized, PILLARS.map(p => p.key));
        notify('已将 JSON 合并到当前草稿', 'success');
        renderAll(root);
        return;
    }
    const parsedText = parseUploadedText(kind, text);
    state.uploaded[kind] = { name: file.name, text: parsedText };
    renderSources(root);
    notify(`已读取 ${sourceKindLabel(kind)}：${file.name}`, 'success');
}

function readFileText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
        reader.readAsText(file, 'utf-8');
    });
}

function parseUploadedText(kind, text) {
    const trimmed = text.trim();
    if (!trimmed) return '';
    try {
        const data = JSON.parse(trimmed);
        if (kind === 'character') return formatCharacterData(data);
        if (kind === 'worldbook') return formatWorldEntries(extractWorldEntries(data));
        if (kind === 'chat') return formatChatData(data);
    } catch { /* plain text */ }
    return trimmed;
}

function formatCharacterData(raw) {
    const data = raw.data || raw;
    const fields = [
        ['角色名', data.name],
        ['描述', data.description],
        ['性格', data.personality],
        ['场景', data.scenario],
        ['开场白', data.first_mes],
        ['示例对话', data.mes_example],
        ['创作者备注', data.creator_notes],
        ['系统提示', data.system_prompt],
        ['后置指令', data.post_history_instructions],
    ];
    const lines = fields.filter(([, v]) => v).map(([k, v]) => `${k}：${v}`);
    if (data.character_book?.entries) {
        lines.push('角色卡内置世界书：');
        lines.push(formatWorldEntries(extractWorldEntries(data.character_book)));
    }
    return lines.join('\n');
}

function extractWorldEntries(data) {
    if (!data) return [];
    let entries = data.entries || data.world_info || data.worldInfo || [];
    if (!Array.isArray(entries) && typeof entries === 'object') entries = Object.values(entries);
    if (!Array.isArray(entries)) return [];
    return entries
        .filter(e => e && (e.content || e.comment || e.key || e.keys))
        .map((e, i) => ({
            index: i + 1,
            key: Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : (e.key ? [e.key] : [])),
            comment: e.comment || e.name || '',
            content: e.content || e.entry || '',
            constant: Boolean(e.constant),
            disabled: Boolean(e.disable || e.disabled),
        }))
        .filter(e => !e.disabled && e.content);
}

function formatWorldEntries(entries) {
    return entries.map(e => {
        const keys = e.key?.length ? `关键词：${e.key.join(', ')}\n` : '';
        const comment = e.comment ? `标题：${e.comment}\n` : '';
        return `[世界书条目 ${e.index}${e.constant ? ' 常驻' : ''}]\n${comment}${keys}内容：${e.content}`;
    }).join('\n\n');
}

function formatChatData(data) {
    const arr = Array.isArray(data) ? data : (data.chat || data.messages || data.data || []);
    if (!Array.isArray(arr)) return JSON.stringify(data, null, 2);
    return arr.map((m, i) => {
        if (typeof m === 'string') return `[${i}] ${m}`;
        const speaker = m.is_user || m.role === 'user' ? '用户' : (m.name || m.role || '角色');
        return `[${i}] ${speaker}: ${stripHtml(m.mes || m.content || m.message || '')}`;
    }).join('\n');
}

function normalizeDraftData(data) {
    const draft = emptyDraft();
    draft.npc = Array.isArray(data.npc) ? data.npc : [];
    draft.items = Array.isArray(data.items) ? data.items : [];
    const rawTimeline = Array.isArray(data.timeline) ? data.timeline : [];
    const rawLooksLikeOldMilestones = looksLikeMilestoneDraftList(rawTimeline);
    draft.milestones = Array.isArray(data.milestones)
        ? data.milestones
        : (rawLooksLikeOldMilestones ? rawTimeline : []);
    draft.timeline = rawLooksLikeOldMilestones
        ? (Array.isArray(data.threads) ? data.threads : (Array.isArray(data.timelineThreads) ? data.timelineThreads : (Array.isArray(data.timeThreads) ? data.timeThreads : [])))
        : (Array.isArray(data.timeline) ? data.timeline : (Array.isArray(data.threads) ? data.threads : (Array.isArray(data.timelineThreads) ? data.timelineThreads : (Array.isArray(data.timeThreads) ? data.timeThreads : []))));
    draft.memories = Array.isArray(data.memories) ? data.memories : (Array.isArray(data.mem) ? data.mem : []);
    if (Array.isArray(data.locations)) draft.locations = data.locations;
    else if (data.map?.locations && typeof data.map.locations === 'object') draft.locations = Object.values(data.map.locations);
    else draft.locations = [];
    for (const pillar of PILLARS.map(p => p.key)) {
        draft[pillar] = draft[pillar].map(e => normalizeEntry(pillar, e));
    }
    return draft;
}

function looksLikeMilestoneDraftList(list) {
    if (!Array.isArray(list) || !list.length) return false;
    return list.some(entry => {
        if (!entry || typeof entry !== 'object') return false;
        const hasMilestoneFields = entry.event || entry.storyTime || entry.impact || entry.isActive !== undefined;
        const hasTimelineFields = entry.name || Array.isArray(entry.entries);
        return Boolean(hasMilestoneFields && !hasTimelineFields);
    });
}

function assignDraftIds(data) {
    for (const pillar of PILLARS.map(p => p.key)) {
        if (!Array.isArray(data[pillar])) data[pillar] = [];
        data[pillar] = data[pillar].map(e => normalizeEntry(pillar, e));
    }
}

function normalizeEntry(pillar, raw) {
    const entry = { ...(raw || {}) };
    entry._draftId = entry._draftId || generateDraftId();
    normalizeEntryInPlace(pillar, entry);
    return entry;
}

function normalizeEntryInPlace(pillar, entry) {
    if (pillar === 'memories') {
        entry.title = entry.title || '';
        entry.type = ['event', 'emotion', 'habit', 'fact'].includes(entry.type) ? entry.type : 'event';
        entry.memoryTier = ['transient', 'stable', 'core', 'eternal'].includes(entry.memoryTier) ? entry.memoryTier : 'stable';
        entry.truthStatus = entry.truthStatus || 'true';
        entry.importance = clamp01(entry.importance ?? 0.6);
        entry.emotionalWeight = clamp01(entry.emotionalWeight ?? 0);
    } else if (pillar === 'npc') {
        entry.npcTier = entry.npcTier || 'minor';
        entry.relationships = Array.isArray(entry.relationships) ? entry.relationships : [];
    } else if (pillar === 'items') {
        entry.status = entry.status || 'held';
        entry.itemTier = entry.itemTier || 'consumable';
        entry.keepPermanent = Boolean(entry.keepPermanent);
    } else if (pillar === 'locations') {
        entry.edges = Array.isArray(entry.edges) ? entry.edges : [];
        entry.memoryTier = entry.memoryTier || 'transient';
        entry.keepPermanent = Boolean(entry.keepPermanent || entry.resident);
    } else if (pillar === 'milestones') {
        entry.status = entry.status || (entry.isActive === false ? 'ended' : 'ongoing');
        entry.isActive = entry.isActive !== false && entry.status !== 'ended';
        entry.participants = Array.isArray(entry.participants) ? entry.participants : [];
    } else if (pillar === 'timeline') {
        entry.type = entry.type || 'plot';
        entry.status = entry.status || 'ongoing';
        entry.priority = entry.priority || 'medium';
        entry.entries = Array.isArray(entry.entries) ? entry.entries : [];
    }
    entry.tags = Array.isArray(entry.tags) ? entry.tags : [];
}

function makeDefaultEntry(pillar) {
    const defaults = {
        memories: { title: '', type: 'event', summary: '', content: '', importance: 0.6, emotionalWeight: 0, memoryTier: 'stable', truthStatus: 'true', tags: [] },
        npc: { name: '', role: '', personality: '', appearance: '', status: '', location: '', indexCard: '', npcTier: 'minor', relationships: [], tags: [] },
        items: { name: '', owner: '', status: 'held', location: '', significance: '', itemTier: 'consumable', keepPermanent: false, tags: [] },
        locations: { name: '', region: '', description: '', realWorldRef: '', memoryTier: 'transient', keepPermanent: false, edges: [] },
        milestones: { storyTime: '', event: '', summary: '', participants: [], location: '', status: 'ongoing', isActive: true, impact: '', tags: [] },
        timeline: { name: '', type: 'plot', status: 'ongoing', priority: 'medium', summary: '', entries: [] },
    };
    return normalizeEntry(pillar, defaults[pillar]);
}

function mergeDraft(incoming, selectedPillars) {
    for (const pillar of selectedPillars) {
        const entries = incoming[pillar] || [];
        const target = state.draft[pillar] || [];
        const byKey = new Map(target.map(e => [entryKey(pillar, e), e]).filter(([k]) => k));
        for (const entry of entries) {
            const key = entryKey(pillar, entry);
            if (key && byKey.has(key)) {
                mergeEntryInPlace(pillar, byKey.get(key), entry);
            } else {
                target.push(entry);
                if (key) byKey.set(key, entry);
            }
        }
        state.draft[pillar] = target;
    }
}

function replaceSelectedDraft(incoming, selectedPillars) {
    for (const pillar of selectedPillars) {
        state.draft[pillar] = incoming[pillar] || [];
    }
}

function mergeEntryInPlace(pillar, base, incoming) {
    for (const [key,, type] of FIELD_SPECS[pillar] || []) {
        if (type === 'tags') base[key] = mergeTags(base[key], incoming[key]);
        else if (type === 'list') base[key] = mergeList(base[key], incoming[key]);
        else if (type === 'json') base[key] = Array.isArray(base[key]) && base[key].length ? base[key] : (incoming[key] || []);
        else if (type === 'textarea') base[key] = mergeText(base[key], incoming[key]);
        else if (incoming[key] !== undefined && incoming[key] !== '' && (base[key] === undefined || base[key] === '')) base[key] = incoming[key];
    }
}

function entryKey(pillar, entry) {
    if (pillar === 'memories') return `${(entry.title || '').toLowerCase().trim()}|${(entry.content || entry.summary || '').toLowerCase().trim().slice(0, 120)}`;
    if (pillar === 'milestones') return `${(entry.event || '').toLowerCase().trim()}|${entry.storyTime || ''}`;
    return (entry.name || '').toLowerCase().trim();
}

function stripDraftIds(draft) {
    const out = emptyDraft();
    for (const pillar of PILLARS.map(p => p.key)) {
        out[pillar] = (draft[pillar] || []).map(entry => {
            const { _draftId, ...clean } = entry;
            return clean;
        });
    }
    return out;
}

function exportDraft() {
    const json = JSON.stringify(stripDraftIds(state.draft));
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bb-memory-init-draft-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function getSelectedPillars(root) {
    return $all(root, '.bb-init-pillar:checked').map(el => el.value);
}

function countDraft(draft) {
    return Object.fromEntries(PILLARS.map(p => [p.key, Array.isArray(draft[p.key]) ? draft[p.key].length : 0]));
}

function getPillarLabel(key) {
    return PILLARS.find(p => p.key === key)?.label || key;
}

function sourceKindLabel(kind) {
    return ({ character: '角色卡', worldbook: '世界书', chat: '聊天记录', draft: '草稿' })[kind] || kind;
}

function stripHtml(text) {
    const div = document.createElement('div');
    div.innerHTML = String(text || '');
    return div.textContent || div.innerText || '';
}

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function tagsToText(tags) {
    if (!Array.isArray(tags)) return '';
    return tags.map(t => typeof t === 'string' ? t : t.name).filter(Boolean).join(', ');
}

function textToTags(text) {
    return String(text || '').split(/[,，]/).map(t => t.trim()).filter(Boolean).map(name => ({ name, weight: 0.6 }));
}

function listToText(list) {
    return Array.isArray(list) ? list.join(', ') : '';
}

function textToList(text) {
    return String(text || '').split(/[,，]/).map(t => t.trim()).filter(Boolean);
}

function mergeText(a, b) {
    const left = String(a || '').trim();
    const right = String(b || '').trim();
    if (!right) return left;
    if (!left) return right;
    if (left.includes(right)) return left;
    if (right.includes(left)) return right;
    return `${left}\n${right}`;
}

function mergeList(a, b) {
    return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter(Boolean))];
}

function mergeTags(a, b) {
    const map = new Map();
    for (const tag of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
        const name = typeof tag === 'string' ? tag : tag?.name;
        if (!name) continue;
        map.set(name, typeof tag === 'object' ? tag : { name, weight: 0.6 });
    }
    return [...map.values()];
}
