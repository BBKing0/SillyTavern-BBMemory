/**
 * memory-manager.js —— BB-Memory v5.5 记忆管理器
 *
 * 全屏覆盖弹窗，3 标签页：记忆 / 存档 / 常驻档案。
 * 从 v4.4.2 移植，适配 v5.5 四柱数据架构。
 */

import {
    getNpcProfiles, addNpcProfile, updateNpcProfile, removeNpcProfile,
    getItems, addItem, updateItem, removeItem,
    getTimeline, addTimelineEntry, updateTimelineEntry, removeTimelineEntry,
    getMemories, addMemory, updateMemory, removeMemory,
    clearAllData, getMemoryStats, getSettings, updateSettings,
    exportMemories, importMemories, updateFactContent, addHiddenNote, removeHiddenNote,
} from './memory-store.js';
import { getCharacterId, listSlots, saveToSlot, loadFromSlot, createEmptySlot, deleteSlot } from './memory-slots.js';
import { simpleSearch } from './retriever.js';
import { MEMORY_TYPES, TRUTH_STATUS, HIDDEN_NOTE_TYPES } from './memory-types.js';
import { NPC_TIERS, ITEM_TIERS, normalizeNpcTier, normalizeItemTier } from './entity-tiers.js';
import { extractFromContext, saveExtractedMemories } from './auto-generator.js';
import { markExchangeExtracted, hideExchange } from './message-state.js';
import { fuzzyMemory, archiveMemory, restoreMemory } from './memory-maintainer.js';

// ═══ 全局状态 ═══
let activeFilter = 'all';

// ═══ 入口 ═══

export async function openMemoryManager(chatId) {
    const existing = document.querySelector('.bb-mem-overlay');
    if (existing) existing.remove();

    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);

    const overlay = document.createElement('div');
    overlay.className = 'bb-mem-overlay';
    overlay.innerHTML = buildManagerHTML(npc, items, timeline, memories, chatId);
    document.body.appendChild(overlay);

    bindManagerEvents(overlay, chatId);
    updateCurrentSlotBar(overlay, chatId);
}

// ═══ HTML 构建 ═══

function buildManagerHTML(npc, items, timeline, memories, chatId) {
    const totalCount = npc.length + items.length + timeline.length + memories.length;
    const allEntries = [
        ...npc.map(e => ({ ...e, _pillar: 'npc' })),
        ...items.map(e => ({ ...e, _pillar: 'item' })),
        ...timeline.map(e => ({ ...e, _pillar: 'timeline' })),
        ...memories.map(e => ({ ...e, _pillar: 'mem' })),
    ];

    const listHTML = allEntries.length
        ? allEntries.map(e => buildEntryItemHTML(e)).join('')
        : '<div class="bb-mem-empty">暂无记忆，点击上方按钮添加第一条记忆吧</div>';

    return `
    <div class="bb-mem-popup">
        <div class="bb-mem-popup-header">
            <h3><i class="fa-solid fa-brain"></i> BB-Memory 记忆管家</h3>
            <span class="bb-mem-close" title="关闭">&times;</span>
        </div>

        <div class="bb-mgr-tabs">
            <button class="bb-mgr-tab active" data-tab="memories">
                <i class="fa-solid fa-list"></i> 记忆
            </button>
            <button class="bb-mgr-tab" data-tab="slots">
                <i class="fa-solid fa-floppy-disk"></i> 存档
            </button>
            <button class="bb-mgr-tab" data-tab="persistent">
                <i class="fa-solid fa-archive"></i> 常驻档案
            </button>
        </div>

        <!-- 记忆标签页 -->
        <div class="bb-mgr-panel" data-panel="memories">
            <div class="bb-current-slot-bar">
                <span><i class="fa-solid fa-floppy-disk"></i> 存档: <strong id="bb_current_slot_name">default</strong></span>
                <span>条目: <strong id="bb_current_slot_count">0</strong> 条</span>
            </div>

            <div class="bb-mem-toolbar">
                <input type="text" class="bb-mem-search text_pole" placeholder="搜索..." id="bb_mgr_search" />
                <select id="bb_mgr_sort" class="text_pole" style="width:auto;min-width:120px;">
                    <option value="created_desc" selected>创建时间 ↓</option>
                    <option value="created_asc">创建时间 ↑</option>
                    <option value="updated_desc">修改时间 ↓</option>
                    <option value="updated_asc">修改时间 ↑</option>
                </select>
                <button class="menu_button bb-mem-toolbar-btn" id="bb_mgr_add">
                    <i class="fa-solid fa-plus"></i> 添加
                </button>
                <button class="menu_button bb-mem-toolbar-btn" id="bb_mgr_ai_extract">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> AI提取
                </button>
            </div>

            <div class="bb-mem-type-filters">
                <button class="menu_button bb-mem-type-filter active" data-type="all">
                    <i class="fa-solid fa-layer-group"></i> 全部
                </button>
                <button class="menu_button bb-mem-type-filter" data-type="npc">
                    <i class="fa-solid fa-user"></i> NPC
                </button>
                <button class="menu_button bb-mem-type-filter" data-type="item">
                    <i class="fa-solid fa-box"></i> 物品
                </button>
                <button class="menu_button bb-mem-type-filter" data-type="timeline">
                    <i class="fa-solid fa-clock"></i> 时间线
                </button>
                <button class="menu_button bb-mem-type-filter" data-type="mem">
                    <i class="fa-solid fa-brain"></i> 记忆
                </button>
            </div>

            <div class="bb-mem-batch-bar" id="bb_batch_bar">
                <span class="bb-batch-count">已选 <strong id="bb_batch_count">0</strong> 条</span>
                <button class="menu_button" id="bb_batch_select_all">全选</button>
                <button class="menu_button" id="bb_batch_deselect_all">取消全选</button>
                <button class="menu_button" id="bb_batch_delete" style="color:#f44336;" disabled>
                    <i class="fa-solid fa-trash"></i> 删除
                </button>
                <button class="menu_button" id="bb_batch_fuzzy" disabled>
                    <i class="fa-solid fa-cloud"></i> 模糊化
                </button>
                <button class="menu_button" id="bb_batch_archive" disabled>
                    <i class="fa-solid fa-box-archive"></i> 归档
                </button>
            </div>

            <div class="bb-mem-stats">
                共 <strong>${totalCount}</strong> 条（NPC ${npc.length} / 物品 ${items.length} / 时间线 ${timeline.length} / 记忆 ${memories.length}）
            </div>

            <div class="bb-mem-list" id="bb_mgr_list">${listHTML}</div>

            <div class="bb-mem-footer">
                <button class="menu_button" id="bb_mgr_export" title="导出记忆到JSON文件">
                    <i class="fa-solid fa-download"></i> 导出
                </button>
                <button class="menu_button" id="bb_mgr_import" title="从JSON文件导入">
                    <i class="fa-solid fa-upload"></i> 导入
                </button>
                <button class="menu_button" id="bb_mgr_import_wb" title="从世界书导入">
                    <i class="fa-solid fa-book-atlas"></i> 世界书
                </button>
                <button class="menu_button menu_button_danger" id="bb_mgr_clear" title="清空全部数据">
                    <i class="fa-solid fa-trash"></i> 清空
                </button>
            </div>
        </div>

        <!-- 存档标签页 -->
        <div class="bb-mgr-panel" data-panel="slots" style="display:none;">
            <div class="bb-slots-panel" id="bb_mgr_slots">
                <div class="bb-mem-empty"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>
            </div>
        </div>

        <!-- 常驻档案标签页 -->
        <div class="bb-mgr-panel" data-panel="persistent" style="display:none;">
            <div class="bb-persistent-tabs">
                <button class="bb-mgr-tab active" data-pcat="npc">
                    <i class="fa-solid fa-user"></i> NPC
                </button>
                <button class="bb-mgr-tab" data-pcat="item">
                    <i class="fa-solid fa-box"></i> 物品
                </button>
                <button class="bb-mgr-tab" data-pcat="timeline">
                    <i class="fa-solid fa-clock"></i> 时间线
                </button>
            </div>
            <div class="bb-persistent-toolbar">
                <button class="menu_button" id="bb_persistent_add">
                    <i class="fa-solid fa-plus"></i> 添加
                </button>
            </div>
            <div class="bb-persistent-list" id="bb_persistent_list">
                <div class="bb-mem-empty">加载中...</div>
            </div>
            <div class="bb-persistent-form" id="bb_persistent_form" style="display:none;margin:8px;">
                <input type="text" id="bb_persistent_name" class="text_pole" placeholder="名称（必填）" style="margin-bottom:4px;" />
                <textarea id="bb_persistent_content" class="text_pole" placeholder="内容" rows="3" style="margin-bottom:4px;"></textarea>
                <div style="display:flex;gap:4px;">
                    <button class="menu_button" id="bb_persistent_cancel">取消</button>
                    <button class="menu_button" id="bb_persistent_save" style="background:#4caf50;color:#fff;">保存</button>
                </div>
            </div>
        </div>
    </div>`;
}

// ═══ 条目渲染 ═══

function buildEntryItemHTML(e) {
    const pillar = e._pillar;
    const pillarConfig = {
        npc:      { icon: 'fa-user',        label: 'NPC',   color: '#ba68c8' },
        item:     { icon: 'fa-box',          label: '物品',  color: '#4fc3f7' },
        timeline: { icon: 'fa-clock',        label: '时间线', color: '#ffb74d' },
        mem:      { icon: 'fa-brain',        label: '记忆',  color: '#81c784' },
    }[pillar] || { icon: 'fa-circle', label: pillar, color: '#888' };

    const title = e.title || e.name || (e.content || '').slice(0, 30) || '(无标题)';
    const content = e.content || e.description || '';
    const subtitle = [];

    if (pillar === 'npc') {
        const tier = NPC_TIERS[e.tier];
        if (tier) subtitle.push(`层级: ${tier.label}`);
        if (e.appearanceCount != null) subtitle.push(`出场: ${e.appearanceCount}次`);
    } else if (pillar === 'item') {
        if (e.status) subtitle.push(`状态: ${e.status}`);
        if (e.quantity != null) subtitle.push(`数量: ${e.quantity}`);
        const tier = ITEM_TIERS[e.tier];
        if (tier) subtitle.push(`层级: ${tier.label}`);
    } else if (pillar === 'timeline') {
        subtitle.push(e.isActive ? '进行中' : '已结束');
        if (e.timestamp) subtitle.push(new Date(e.timestamp).toLocaleDateString('zh-CN'));
    } else if (pillar === 'mem') {
        const typeDef = MEMORY_TYPES[e.cognitiveType];
        if (typeDef) subtitle.push(typeDef.label);
        if (e.memoryTier) subtitle.push(`层级: ${e.memoryTier}`);
    }

    const createdDate = e.createdAt ? new Date(e.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

    return `
    <div class="bb-mem-item" data-id="${escapeHtml(e.id)}" data-pillar="${pillar}">
        <div class="bb-mem-item-header">
            <input type="checkbox" class="bb-mem-batch-cb" data-id="${escapeHtml(e.id)}" data-pillar="${pillar}" style="margin-right:8px;width:15px;height:15px;cursor:pointer;flex-shrink:0;" />
            <span class="bb-mem-item-type" style="color:${pillarConfig.color}">
                <i class="fa-solid ${pillarConfig.icon}"></i> ${pillarConfig.label}
            </span>
            ${subtitle.length ? `<span style="font-size:0.75em;opacity:0.6;">${subtitle.join(' · ')}</span>` : ''}
        </div>
        <div class="bb-mem-item-content"><strong>${escapeHtml(title)}</strong>${content ? ' — ' + escapeHtml(content.slice(0, 100)) : ''}</div>
        ${createdDate ? `<div class="bb-mem-item-meta"><span class="bb-mem-item-date">${createdDate}</span></div>` : ''}
        <div class="bb-mem-item-actions">
            <button class="menu_button bb-mem-btn-sm bb-mem-edit" data-id="${escapeHtml(e.id)}" data-pillar="${pillar}" title="编辑">
                <i class="fa-solid fa-pen"></i>
            </button>
            <button class="menu_button bb-mem-btn-sm bb-mem-delete menu_button_danger" data-id="${escapeHtml(e.id)}" data-pillar="${pillar}" title="删除">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    </div>`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text || '');
    return div.innerHTML;
}

// ═══ 事件绑定 ═══

function bindManagerEvents(overlay, chatId) {
    // 关闭
    overlay.querySelector('.bb-mem-close')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // 标签页切换
    overlay.querySelectorAll('.bb-mgr-tabs > .bb-mgr-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            const panelName = tab.dataset.tab;
            if (!panelName) return;
            overlay.querySelectorAll('.bb-mgr-tabs > .bb-mgr-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            overlay.querySelectorAll('.bb-mgr-panel').forEach(p => {
                p.style.display = p.dataset.panel === panelName ? 'block' : 'none';
            });
            if (panelName === 'slots') {
                await renderSlotsPanel(overlay, chatId);
            } else if (panelName === 'persistent') {
                await renderPersistentPanel(overlay, chatId, 'npc');
            }
        });
    });

    // 类型过滤
    overlay.querySelectorAll('.bb-mem-type-filter').forEach(btn => {
        btn.addEventListener('click', async () => {
            overlay.querySelectorAll('.bb-mem-type-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.dataset.type;
            await rerenderManagerList(overlay, chatId);
        });
    });

    // 搜索
    overlay.querySelector('#bb_mgr_search')?.addEventListener('input', async (e) => {
        const query = e.target.value.trim();
        if (!query) {
            activeFilter = overlay.querySelector('.bb-mem-type-filter.active')?.dataset?.type || 'all';
            await rerenderManagerList(overlay, chatId);
        } else {
            const results = simpleSearch(await getMemories(chatId), query, 100);
            const listEl = overlay.querySelector('#bb_mgr_list');
            if (listEl) {
                listEl.innerHTML = results.length
                    ? results.map(m => buildEntryItemHTML({ ...m, _pillar: 'mem' })).join('')
                    : '<div class="bb-mem-empty">未找到匹配的记忆</div>';
            }
        }
    });

    // 排序
    overlay.querySelector('#bb_mgr_sort')?.addEventListener('change', async () => {
        await rerenderManagerList(overlay, chatId);
    });

    // 添加
    overlay.querySelector('#bb_mgr_add')?.addEventListener('click', () => {
        showQuickAddForm(overlay, chatId);
    });

    // AI 提取
    overlay.querySelector('#bb_mgr_ai_extract')?.addEventListener('click', async () => {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const recent = chat.filter(m => m.mes?.trim()).slice(-12);
        if (!recent.length) { showToast('对话不足，无法提取'); return; }
        const contextText = recent.map(m => `${m.is_user ? '用户' : m.name || '角色'}: ${m.mes}`).join('\n');
        try {
            const results = await extractFromContext(chatId, contextText);
            showToast(`提取完成！NPC ${results.npc}/物品 ${results.items}/时间线 ${results.timeline}/记忆 ${results.memories}`, 'success');
            await rerenderManagerList(overlay, chatId);
        } catch (e) {
            showToast(`提取失败: ${e.message}`, 'error');
        }
    });

    // 导出
    overlay.querySelector('#bb_mgr_export')?.addEventListener('click', async () => {
        const json = await exportMemories(chatId);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `bb-memory-${chatId}-${Date.now()}.json`; a.click();
        URL.revokeObjectURL(url);
        showToast('已导出', 'success');
    });

    // 导入
    overlay.querySelector('#bb_mgr_import')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    const count = await importMemories(chatId, ev.target.result);
                    showToast(`成功导入 ${count} 条`, 'success');
                    await rerenderManagerList(overlay, chatId);
                } catch (err) { showToast(`导入失败: ${err.message}`, 'error'); }
            };
            reader.readAsText(file);
        });
        input.click();
    });

    // 世界书导入
    overlay.querySelector('#bb_mgr_import_wb')?.addEventListener('click', async () => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    const { importWorldBook } = await import('./world-book-importer.js');
                    const count = await importWorldBook(chatId, ev.target.result);
                    showToast(`世界书导入 ${count} 条`, 'success');
                    await rerenderManagerList(overlay, chatId);
                } catch (err) { showToast(`导入失败: ${err.message}`, 'error'); }
            };
            reader.readAsText(file);
        });
        input.click();
    });

    // 清空
    overlay.querySelector('#bb_mgr_clear')?.addEventListener('click', async () => {
        const ctx = SillyTavern.getContext();
        const ok = await ctx.Popup?.show?.confirm('确认清空', '确定要删除所有记忆数据吗？此操作不可撤销。');
        if (!ok) return;
        await clearAllData(chatId);
        showToast('所有记忆已清空', 'warning');
        await rerenderManagerList(overlay, chatId);
    });

    // 批量操作
    bindBatchEvents(overlay, chatId);

    // 条目操作
    rebindItemActions(overlay, chatId);
}

// ═══ 批量操作 ═══

function bindBatchEvents(overlay, chatId) {
    const updateUI = () => {
        const checked = overlay.querySelectorAll('.bb-mem-batch-cb:checked');
        const count = checked.length;
        const countEl = overlay.querySelector('#bb_batch_count');
        if (countEl) countEl.textContent = String(count);
        ['bb_batch_delete', 'bb_batch_archive', 'bb_batch_fuzzy'].forEach(id => {
            const btn = overlay.querySelector('#' + id);
            if (btn) btn.disabled = (count === 0);
        });
    };

    overlay.addEventListener('change', (e) => {
        if (e.target.classList.contains('bb-mem-batch-cb')) updateUI();
    });

    overlay.querySelector('#bb_batch_select_all')?.addEventListener('click', () => {
        overlay.querySelectorAll('.bb-mem-batch-cb').forEach(cb => { cb.checked = true; });
        updateUI();
    });

    overlay.querySelector('#bb_batch_deselect_all')?.addEventListener('click', () => {
        overlay.querySelectorAll('.bb-mem-batch-cb').forEach(cb => { cb.checked = false; });
        updateUI();
    });

    overlay.querySelector('#bb_batch_delete')?.addEventListener('click', async () => {
        const checked = overlay.querySelectorAll('.bb-mem-batch-cb:checked');
        if (!checked.length) return;
        const ctx = SillyTavern.getContext();
        const ok = await ctx.Popup?.show?.confirm('批量删除', `确定删除选中的 ${checked.length} 条吗？`);
        if (!ok) return;
        for (const cb of checked) {
            const id = cb.dataset.id;
            const pillar = cb.dataset.pillar;
            if (pillar === 'npc') await removeNpcProfile(chatId, id);
            else if (pillar === 'item') await removeItem(chatId, id);
            else if (pillar === 'timeline') await removeTimelineEntry(chatId, id);
            else await removeMemory(chatId, id);
        }
        showToast(`已删除 ${checked.length} 条`, 'success');
        await rerenderManagerList(overlay, chatId);
    });

    overlay.querySelector('#bb_batch_archive')?.addEventListener('click', async () => {
        const checked = overlay.querySelectorAll('.bb-mem-batch-cb:checked');
        if (!checked.length) return;
        for (const cb of checked) {
            if (cb.dataset.pillar === 'mem') {
                await archiveMemory(chatId, cb.dataset.id);
            }
        }
        showToast(`已归档 ${checked.length} 条`, 'success');
        await rerenderManagerList(overlay, chatId);
    });

    overlay.querySelector('#bb_batch_fuzzy')?.addEventListener('click', async () => {
        const checked = overlay.querySelectorAll('.bb-mem-batch-cb:checked');
        if (!checked.length) return;
        for (const cb of checked) {
            if (cb.dataset.pillar === 'mem') {
                await fuzzyMemory(chatId, cb.dataset.id);
            }
        }
        showToast(`已模糊化 ${checked.length} 条`, 'success');
        await rerenderManagerList(overlay, chatId);
    });
}

// ═══ 条目操作 ═══

function rebindItemActions(overlay, chatId) {
    // 删除
    overlay.querySelectorAll('.bb-mem-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const pillar = btn.dataset.pillar;
            const ok = confirm('确定删除这条记录吗？');
            if (!ok) return;
            if (pillar === 'npc') await removeNpcProfile(chatId, id);
            else if (pillar === 'item') await removeItem(chatId, id);
            else if (pillar === 'timeline') await removeTimelineEntry(chatId, id);
            else await removeMemory(chatId, id);
            showToast('已删除', 'info');
            await rerenderManagerList(overlay, chatId);
        });
    });

    // 编辑
    overlay.querySelectorAll('.bb-mem-edit').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const pillar = btn.dataset.pillar;
            showQuickEditForm(overlay, chatId, id, pillar);
        });
    });
}

// ═══ 快速添加表单 ═══

function showQuickAddForm(overlay, chatId) {
    const existing = overlay.querySelector('.bb-quick-add-form');
    if (existing) { existing.remove(); return; }

    const form = document.createElement('div');
    form.className = 'bb-quick-add-form';
    form.style.cssText = 'padding:12px;margin:0 18px 12px;background:var(--SmartThemeBlurTintColor, rgba(255,255,255,0.05));border-radius:8px;border:1px solid var(--SmartThemeBorderColor,#444);';
    form.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:8px;">
            <select id="bb_quick_pillar" class="text_pole" style="flex:1;">
                <option value="mem">记忆条目</option>
                <option value="npc">NPC 档案</option>
                <option value="item">物品</option>
                <option value="timeline">时间线事件</option>
            </select>
            <select id="bb_quick_mem_type" class="text_pole" style="flex:1;">
                <option value="event">事件</option>
                <option value="emotion">情感</option>
                <option value="habit">习惯</option>
                <option value="fact">事实</option>
            </select>
        </div>
        <input id="bb_quick_title" class="text_pole" placeholder="标题" style="width:100%;margin-bottom:6px;" />
        <textarea id="bb_quick_content" class="text_pole" placeholder="内容" rows="2" style="width:100%;margin-bottom:6px;"></textarea>
        <div style="display:flex;gap:4px;">
            <button class="menu_button" id="bb_quick_cancel">取消</button>
            <button class="menu_button" id="bb_quick_save" style="background:#4caf50;color:#fff;">保存</button>
        </div>
    `;

    const listEl = overlay.querySelector('#bb_mgr_list');
    listEl.parentNode.insertBefore(form, listEl);

    form.querySelector('#bb_quick_pillar')?.addEventListener('change', (e) => {
        const memTypeRow = form.querySelector('#bb_quick_mem_type')?.parentElement;
        if (memTypeRow) memTypeRow.style.display = e.target.value === 'mem' ? '' : 'none';
    });

    form.querySelector('#bb_quick_cancel')?.addEventListener('click', () => form.remove());
    form.querySelector('#bb_quick_save')?.addEventListener('click', async () => {
        const pillar = form.querySelector('#bb_quick_pillar')?.value || 'mem';
        const title = form.querySelector('#bb_quick_title')?.value?.trim();
        const content = form.querySelector('#bb_quick_content')?.value?.trim();
        if (!title && !content) { showToast('标题或内容不能为空', 'warning'); return; }
        try {
            if (pillar === 'npc') {
                await addNpcProfile(chatId, { name: title || content, description: content });
            } else if (pillar === 'item') {
                await addItem(chatId, { name: title || content, description: content });
            } else if (pillar === 'timeline') {
                await addTimelineEntry(chatId, { title: title || content, content, isActive: true, status: 'ongoing' });
            } else {
                const memType = form.querySelector('#bb_quick_mem_type')?.value || 'event';
                await addMemory(chatId, { title: title || content.slice(0, 30), content, cognitiveType: memType });
            }
            showToast('已添加', 'success');
            form.remove();
            await rerenderManagerList(overlay, chatId);
            updateCurrentSlotBar(overlay, chatId);
        } catch (e) {
            showToast(`添加失败: ${e.message}`, 'error');
        }
    });
}

// ═══ 快速编辑 ═══

async function showQuickEditForm(overlay, chatId, id, pillar) {
    const existing = overlay.querySelector('.bb-quick-add-form');
    if (existing) existing.remove();

    let entry;
    if (pillar === 'npc') {
        const list = await getNpcProfiles(chatId);
        entry = list.find(e => e.id === id);
    } else if (pillar === 'item') {
        const list = await getItems(chatId);
        entry = list.find(e => e.id === id);
    } else if (pillar === 'timeline') {
        const list = await getTimeline(chatId);
        entry = list.find(e => e.id === id);
    } else {
        const list = await getMemories(chatId);
        entry = list.find(e => e.id === id);
    }
    if (!entry) return;

    const title = entry.title || entry.name || '';
    const content = entry.content || entry.description || '';

    const form = document.createElement('div');
    form.className = 'bb-quick-add-form';
    form.style.cssText = 'padding:12px;margin:0 18px 12px;background:var(--SmartThemeBlurTintColor, rgba(255,255,255,0.05));border-radius:8px;border:1px solid var(--SmartThemeBorderColor,#444);';
    form.innerHTML = `
        <input id="bb_edit_title" class="text_pole" placeholder="标题" value="${escapeHtml(title)}" style="width:100%;margin-bottom:6px;" />
        <textarea id="bb_edit_content" class="text_pole" placeholder="内容" rows="2" style="width:100%;margin-bottom:6px;">${escapeHtml(content)}</textarea>
        <div style="display:flex;gap:4px;">
            <button class="menu_button" id="bb_edit_cancel">取消</button>
            <button class="menu_button" id="bb_edit_save" style="background:#4caf50;color:#fff;">保存</button>
        </div>
    `;

    const listEl = overlay.querySelector('#bb_mgr_list');
    listEl.parentNode.insertBefore(form, listEl);

    form.querySelector('#bb_edit_cancel')?.addEventListener('click', () => form.remove());
    form.querySelector('#bb_edit_save')?.addEventListener('click', async () => {
        const newTitle = form.querySelector('#bb_edit_title')?.value?.trim();
        const newContent = form.querySelector('#bb_edit_content')?.value?.trim();
        if (!newTitle && !newContent) { showToast('标题或内容不能为空', 'warning'); return; }
        try {
            if (pillar === 'npc') await updateNpcProfile(chatId, id, { name: newTitle, description: newContent });
            else if (pillar === 'item') await updateItem(chatId, id, { name: newTitle, description: newContent });
            else if (pillar === 'timeline') await updateTimelineEntry(chatId, id, { title: newTitle, content: newContent });
            else await updateMemory(chatId, id, { title: newTitle, content: newContent });
            showToast('已保存', 'success');
            form.remove();
            await rerenderManagerList(overlay, chatId);
        } catch (e) {
            showToast(`保存失败: ${e.message}`, 'error');
        }
    });
}

// ═══ 存档标签页 ═══

async function renderSlotsPanel(overlay, chatId) {
    const slotsEl = overlay.querySelector('#bb_mgr_slots');
    if (!slotsEl) return;

    const charId = getCharacterId();
    if (!charId) {
        slotsEl.innerHTML = '<div class="bb-mem-empty">请先选择角色开始聊天</div>';
        return;
    }

    try {
        const slots = await listSlots(charId);
        const [npc, items, timeline, memories] = await Promise.all([
            getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
        ]);
        const totalCount = npc.length + items.length + timeline.length + memories.length;

        slotsEl.innerHTML = `
            <div class="bb-slots-info">
                <i class="fa-solid fa-circle-info"></i>
                当前聊天 <strong>${totalCount}</strong> 条数据 · 角色ID: ${escapeHtml(charId)}
            </div>

            <div class="bb-slots-list">
                ${slots.map(s => `
                    <div class="bb-slot-item">
                        <div class="bb-slot-info">
                            <span class="bb-slot-name">
                                <i class="fa-solid fa-floppy-disk"></i> ${escapeHtml(s.name)}
                                ${s.name === 'default' ? '<span class="bb-slot-default-badge">默认</span>' : ''}
                            </span>
                            <span class="bb-slot-count">${s.count} 条记忆</span>
                        </div>
                        <div class="bb-slot-actions">
                            <button class="menu_button bb-slot-btn-save" data-slot="${escapeHtml(s.name)}" title="将当前数据保存到此槽">
                                <i class="fa-solid fa-arrow-up"></i> 保存
                            </button>
                            <button class="menu_button bb-slot-btn-load" data-slot="${escapeHtml(s.name)}" title="从此槽加载数据（覆盖当前）">
                                <i class="fa-solid fa-arrow-down"></i> 加载
                            </button>
                            ${s.name !== 'default' ? `
                            <button class="menu_button menu_button_danger bb-slot-btn-delete" data-slot="${escapeHtml(s.name)}" title="删除此存档槽">
                                <i class="fa-solid fa-trash"></i>
                            </button>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>

            <div class="bb-slots-create">
                <input type="text" class="text_pole" id="bb_slot_new_name" placeholder="新存档名称（如：if线A、主线）" />
                <button class="menu_button" id="bb_slot_create_btn">
                    <i class="fa-solid fa-plus"></i> 新建存档
                </button>
            </div>
        `;

        bindSlotEvents(overlay, chatId, charId, slotsEl);
    } catch (err) {
        slotsEl.innerHTML = `<div class="bb-mem-empty">加载失败：${escapeHtml(err.message)}</div>`;
    }
}

function bindSlotEvents(overlay, chatId, charId, slotsEl) {
    slotsEl.querySelectorAll('.bb-slot-btn-save').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slotName = btn.dataset.slot;
            try {
                const count = await saveToSlot(charId, chatId, slotName);
                showToast(`已保存 ${count} 条到「${slotName}」`, 'success');
                updateSettings({ currentSlotName: slotName });
                await renderSlotsPanel(overlay, chatId);
                updateCurrentSlotBar(overlay, chatId);
            } catch (err) { showToast(`保存失败: ${err.message}`, 'error'); }
        });
    });

    slotsEl.querySelectorAll('.bb-slot-btn-load').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slotName = btn.dataset.slot;
            const ok = confirm(`确定从「${slotName}」加载吗？当前数据将被覆盖！`);
            if (!ok) return;
            try {
                const count = await loadFromSlot(charId, chatId, slotName);
                showToast(`已从「${slotName}」加载 ${count} 条`, 'success');
                updateSettings({ currentSlotName: slotName });
                await renderSlotsPanel(overlay, chatId);
                updateCurrentSlotBar(overlay, chatId);
                await rerenderManagerList(overlay, chatId);
            } catch (err) { showToast(`加载失败: ${err.message}`, 'error'); }
        });
    });

    slotsEl.querySelectorAll('.bb-slot-btn-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slotName = btn.dataset.slot;
            const ok = confirm(`确定删除存档「${slotName}」吗？此操作不可撤销！`);
            if (!ok) return;
            try {
                await deleteSlot(charId, slotName);
                showToast(`已删除存档「${slotName}」`, 'info');
                await renderSlotsPanel(overlay, chatId);
            } catch (err) { showToast(`删除失败: ${err.message}`, 'error'); }
        });
    });

    slotsEl.querySelector('#bb_slot_create_btn')?.addEventListener('click', async () => {
        const input = slotsEl.querySelector('#bb_slot_new_name');
        const name = input?.value?.trim();
        if (!name) { showToast('请输入存档名称', 'warning'); return; }
        try {
            await createEmptySlot(charId, name);
            showToast(`已创建存档「${name}」`, 'success');
            input.value = '';
            await renderSlotsPanel(overlay, chatId);
        } catch (err) { showToast(`创建失败: ${err.message}`, 'error'); }
    });
}

// ═══ 常驻档案标签页 ═══

let persistentCategory = 'npc';

async function renderPersistentPanel(overlay, chatId, category = 'npc') {
    persistentCategory = category;
    const listEl = overlay.querySelector('#bb_persistent_list');
    if (!listEl) return;

    try {
        let items = [];
        if (category === 'npc') items = await getNpcProfiles(chatId);
        else if (category === 'item') items = await getItems(chatId);
        else items = await getTimeline(chatId);

        if (!items.length) {
            const labels = { npc: 'NPC', item: '物品', timeline: '时间线' };
            listEl.innerHTML = `<div class="bb-mem-empty">暂无${labels[category] || ''}档案</div>`;
        } else {
            listEl.innerHTML = items.map(item => `
                <div class="bb-persistent-item" data-id="${item.id}">
                    <div class="bb-persistent-item-info">
                        <div class="bb-persistent-item-name">${escapeHtml(item.name || item.title || '(无标题)')}</div>
                        <div class="bb-persistent-item-content">${escapeHtml((item.description || item.content || '').slice(0, 80))}</div>
                    </div>
                    <div class="bb-persistent-item-actions">
                        <button class="menu_button bb-persistent-edit" data-id="${item.id}" title="编辑">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="menu_button bb-persistent-delete" data-id="${item.id}" title="删除">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            `).join('');
        }
        bindPersistentEvents(overlay, chatId);
    } catch (err) {
        listEl.innerHTML = `<div class="bb-mem-empty">加载失败：${escapeHtml(err.message)}</div>`;
    }
}

function bindPersistentEvents(overlay, chatId) {
    // 子标签切换
    overlay.querySelectorAll('.bb-persistent-tabs .bb-mgr-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            overlay.querySelectorAll('.bb-persistent-tabs .bb-mgr-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const cat = tab.dataset.pcat;
            await renderPersistentPanel(overlay, chatId, cat);
        });
    });

    let editingId = null;
    const formEl = overlay.querySelector('#bb_persistent_form');
    const nameInput = overlay.querySelector('#bb_persistent_name');
    const contentInput = overlay.querySelector('#bb_persistent_content');

    overlay.querySelector('#bb_persistent_add')?.addEventListener('click', () => {
        editingId = null;
        if (nameInput) nameInput.value = '';
        if (contentInput) contentInput.value = '';
        if (formEl) formEl.style.display = 'block';
    });

    overlay.querySelector('#bb_persistent_cancel')?.addEventListener('click', () => {
        editingId = null;
        if (formEl) formEl.style.display = 'none';
    });

    overlay.querySelector('#bb_persistent_save')?.addEventListener('click', async () => {
        const name = nameInput?.value?.trim();
        const content = contentInput?.value?.trim();
        if (!name && !content) { showToast('名称和内容不能都为空', 'warning'); return; }
        try {
            if (editingId) {
                if (persistentCategory === 'npc') await updateNpcProfile(chatId, editingId, { name, description: content });
                else if (persistentCategory === 'item') await updateItem(chatId, editingId, { name, description: content });
                else await updateTimelineEntry(chatId, editingId, { title: name, content });
                showToast('已更新', 'success');
            } else {
                if (persistentCategory === 'npc') await addNpcProfile(chatId, { name: name || content, description: content });
                else if (persistentCategory === 'item') await addItem(chatId, { name: name || content, description: content });
                else await addTimelineEntry(chatId, { title: name || content, content, isActive: true, status: 'ongoing' });
                showToast('已添加', 'success');
            }
            editingId = null;
            if (formEl) formEl.style.display = 'none';
            await renderPersistentPanel(overlay, chatId, persistentCategory);
        } catch (err) { showToast(`保存失败: ${err.message}`, 'error'); }
    });

    // 编辑/删除按钮
    overlay.querySelectorAll('.bb-persistent-edit').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            let list;
            if (persistentCategory === 'npc') list = await getNpcProfiles(chatId);
            else if (persistentCategory === 'item') list = await getItems(chatId);
            else list = await getTimeline(chatId);
            const item = list.find(e => e.id === id);
            if (!item) return;
            editingId = id;
            if (nameInput) nameInput.value = item.name || item.title || '';
            if (contentInput) contentInput.value = item.description || item.content || '';
            if (formEl) formEl.style.display = 'block';
        });
    });

    overlay.querySelectorAll('.bb-persistent-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (!confirm('确定删除吗？')) return;
            try {
                if (persistentCategory === 'npc') await removeNpcProfile(chatId, id);
                else if (persistentCategory === 'item') await removeItem(chatId, id);
                else await removeTimelineEntry(chatId, id);
                showToast('已删除', 'info');
                await renderPersistentPanel(overlay, chatId, persistentCategory);
            } catch (err) { showToast(`删除失败: ${err.message}`, 'error'); }
        });
    });
}

// ═══ 工具函数 ═══

async function updateCurrentSlotBar(overlay, chatId) {
    const nameEl = overlay.querySelector('#bb_current_slot_name');
    const countEl = overlay.querySelector('#bb_current_slot_count');
    if (!nameEl && !countEl) return;

    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);
    const totalCount = npc.length + items.length + timeline.length + memories.length;
    const settings = getSettings();
    const currentSlot = settings.currentSlotName || 'default';

    if (nameEl) nameEl.textContent = currentSlot;
    if (countEl) countEl.textContent = String(totalCount);
}

async function rerenderManagerList(overlay, chatId) {
    const [npc, items, timeline, memories] = await Promise.all([
        getNpcProfiles(chatId), getItems(chatId), getTimeline(chatId), getMemories(chatId),
    ]);

    let allEntries = [
        ...npc.map(e => ({ ...e, _pillar: 'npc' })),
        ...items.map(e => ({ ...e, _pillar: 'item' })),
        ...timeline.map(e => ({ ...e, _pillar: 'timeline' })),
        ...memories.map(e => ({ ...e, _pillar: 'mem' })),
    ];

    // 应用筛选
    if (activeFilter && activeFilter !== 'all') {
        allEntries = allEntries.filter(e => e._pillar === activeFilter);
    }

    // 排序
    const sortEl = overlay.querySelector('#bb_mgr_sort');
    const sortMode = sortEl ? sortEl.value : 'created_desc';
    allEntries.sort((a, b) => {
        const aTime = sortMode.startsWith('updated') ? (a.updatedAt || 0) : (a.createdAt || 0);
        const bTime = sortMode.startsWith('updated') ? (b.updatedAt || 0) : (b.createdAt || 0);
        return sortMode.endsWith('asc') ? aTime - bTime : bTime - aTime;
    });

    const totalCount = npc.length + items.length + timeline.length + memories.length;
    const statsEl = overlay.querySelector('.bb-mem-stats');
    if (statsEl) {
        statsEl.innerHTML = `共 <strong>${totalCount}</strong> 条（NPC ${npc.length} / 物品 ${items.length} / 时间线 ${timeline.length} / 记忆 ${memories.length}）`;
    }

    const listEl = overlay.querySelector('#bb_mgr_list');
    if (listEl) {
        listEl.innerHTML = allEntries.length
            ? allEntries.map(e => buildEntryItemHTML(e)).join('')
            : '<div class="bb-mem-empty">暂无匹配的条目</div>';
    }

    rebindItemActions(overlay, chatId);
}

function showToast(msg, type = 'info') {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.toastr?.[type] === 'function') {
            ctx.toastr[type](msg, '', { timeOut: 3000 });
        }
    } catch { /* ignore */ }
}
