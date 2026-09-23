import { loadCorrectionRows, searchCorrectionRows, correctionFields, buildCorrectionPatch, saveCorrection, CORRECTION_LABELS } from './memory-correction.js';
import { getSettings } from './memory-store.js';
import { realtimeFloorLabel, scheduleLimit } from './realtime-schedule.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderCorrectionPanel(panel, chatId, { createForm, toast, onChange }) {
    if (panel.dataset.initialized) return;
    panel.dataset.initialized = 'true';
    panel.innerHTML = `<div class="bb-correction-controls">
        <strong><i class="fa-solid fa-magnifying-glass"></i> 记忆纠错</strong>
        <p>描述哪里记错了，可同时写出两个人名、错误职业和正确职业。搜索包含所有分类、归档和隐藏备注；候选不代表已判定错误。</p>
        <textarea class="bb-input" id="bb_correct_query" rows="3" placeholder="例如：林澈不是医生，是历史老师；是不是和沈川记混了？" aria-label="描述记忆问题"></textarea>
        <div class="bb-correction-buttons"><button class="menu_button" id="bb_correct_search">查找相关条目</button><button class="menu_button" id="bb_correct_all">查看全库</button></div>
        <div id="bb_correct_status" role="status" aria-live="polite">关键词/同义词、中文片段、人物别名和引用关联取并集；全部结果分页展示。</div>
    </div><div class="bb-correction-results"></div><div class="bb-correction-pages"></div>`;
    const status = panel.querySelector('#bb_correct_status');
    const resultEl = panel.querySelector('.bb-correction-results');
    const pages = panel.querySelector('.bb-correction-pages');
    const buttons = [...panel.querySelectorAll('.bb-correction-buttons button')];
    let results = [], page = 0, allMode = false, busy = false;
    const pageSize = () => scheduleLimit(getSettings().correctionPageSize, 30, 100);
    const draw = () => {
        const size = pageSize(), max = Math.max(1, Math.ceil(results.length / size));
        page = Math.min(page, max - 1);
        resultEl.innerHTML = results.slice(page * size, (page + 1) * size).map((row, i) => {
            const e = row.entry;
            const archived = e.archived || e.memoryTier === 'archived' || e.status === 'archived' || e.settleState === 'settled';
            const floor = row.pillar === 'realtime' ? realtimeFloorLabel(e) : e.sourceFloor >= 0 ? `第 ${e.sourceFloor} 层` : '旧聊天/未标楼层';
            const preview = e.role || e.summary || e.content || e.text || e.note || e.description || '';
            return `<article class="bb-correction-card"><div class="bb-correction-card-head"><strong>${escape(CORRECTION_LABELS[row.pillar])} · ${escape(row.title)}</strong><button class="menu_button" data-edit="${i + page * size}">修改此条</button></div>
                <div class="bb-correction-meta">${escape(floor)}${archived ? ' · 已归档' : ''}${e.category ? ` · ${escape(e.category)}` : ''} · ${escape(e.id)}</div>
                ${preview ? `<div class="bb-correction-preview">${escape(String(preview).slice(0, 180))}${String(preview).length > 180 ? '…' : ''}</div>` : ''}
                <div class="bb-correction-reason">${escape((row.reasons || ['全库浏览']).join('；'))}</div>
                <details><summary>查看完整内容（${row.fields.length} 个字段）</summary><dl>${row.fields.map(f => `<dt>${escape(f.label)}</dt><dd>${escape(f.value)}</dd>`).join('')}</dl></details></article>`;
        }).join('') || '<div class="bb-mem-empty">没有找到候选。可缩短关键词、补充别名，或点“查看全库”逐条检查。</div>';
        pages.innerHTML = `<button class="menu_button" data-page="-1" ${page === 0 ? 'disabled' : ''}>上一页</button><span>第 ${page + 1}/${max} 页 · 共 ${results.length} 条</span><button class="menu_button" data-page="1" ${page + 1 >= max ? 'disabled' : ''}>下一页</button>`;
        pages.querySelectorAll('[data-page]').forEach(btn => btn.onclick = () => { page += Number(btn.dataset.page); draw(); resultEl.scrollTop = 0; });
        resultEl.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => edit(results[Number(btn.dataset.edit)]));
    };
    const run = async (showAll, keepPage = false) => {
        if (busy) return;
        const query = panel.querySelector('#bb_correct_query').value.trim();
        if (!showAll && !query) { toast('请先输入问题或关键词', 'warning'); return; }
        busy = true; buttons.forEach(b => b.disabled = true);
        status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在扫描五柱、时间线、地图和线索板…';
        try {
            const rows = await loadCorrectionRows(chatId);
            results = showAll ? rows : searchCorrectionRows(rows, query, getSettings());
            allMode = showAll; if (!keepPage) page = 0;
            draw();
            status.textContent = `扫描 ${rows.length} 条，找到 ${results.length} 条候选。已包含归档、隐藏备注及其它分类，无 Top-K 截断。`;
            toast(`查找完成：${results.length} 条候选`, 'success');
        } catch (error) { status.textContent = `查找失败：${error.message}`; toast(status.textContent, 'error'); }
        finally { busy = false; buttons.forEach(b => b.disabled = false); }
    };
    const edit = row => {
        const fields = correctionFields(row.entry, row.pillar, { includeEmpty: true });
        const form = createForm('bb-correction-form');
        form.innerHTML = `<div class="bb-mem-form-popup"><div class="bb-mem-form-header"><h3>纠错 · ${escape(CORRECTION_LABELS[row.pillar])}</h3><button class="menu_button" data-close aria-label="关闭">×</button></div>
            <div class="bb-mem-form-body"><p>修改后保存到原条目。涉及同名或混淆人物时，请继续检查其它候选的摘要、关系和隐藏备注。</p>
            ${fields.map((f, i) => `<div class="bb-mem-form-group"><label for="bb_correct_field_${i}">${escape(f.label)}</label>${typeof f.value === 'boolean' ? `<select id="bb_correct_field_${i}" class="bb-input" data-field="${i}"><option value="true" ${f.value ? 'selected' : ''}>是</option><option value="false" ${f.value ? '' : 'selected'}>否</option></select>` : `<textarea id="bb_correct_field_${i}" class="bb-input" data-field="${i}" rows="${String(f.value).length > 80 ? 4 : 2}">${escape(f.value)}</textarea>`}</div>`).join('')}</div>
            <div class="bb-mem-form-footer"><button class="menu_button" data-close>取消</button><button class="menu_button" data-save>保存纠错</button></div></div>`;
        form.querySelectorAll('[data-close]').forEach(b => b.onclick = () => form.remove());
        form.querySelector('[data-save]').onclick = async event => {
            const btn = event.currentTarget;
            btn.disabled = true; btn.textContent = '保存中…';
            try {
                const values = [...form.querySelectorAll('[data-field]')].map(input => input.value);
                const result = await saveCorrection(chatId, row, buildCorrectionPatch(row, values));
                form.remove();
                toast(result.changed ? (['realtime', 'clue', 'connection'].includes(row.pillar) ? '已保存纠错' : '已保存纠错；旧向量已失效，后续可用“补全向量”重建') : '内容未改变', result.changed ? 'success' : 'info');
                await onChange?.();
                await run(allMode, true);
            } catch (error) { toast(`纠错保存失败：${error.message}`, 'error'); btn.disabled = false; btn.textContent = '保存纠错'; }
        };
    };
    buttons[0].onclick = () => run(false);
    buttons[1].onclick = () => run(true);
}
