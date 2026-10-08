/** v9.5.0 记忆整理入口与逐线总结范围。 */
import { getSettings, updateSettings, getTimeline } from './memory-store.js';
import { mountInTopLayer, removeTopLayerElement } from './ui-top-layer.js';
import { SUMMARY_TARGETS, SUMMARY_SCOPES, reviewJointSummary } from './story-summary.js';

let handlers = {};
export function configureMemoryOrganization(actions) { handlers = actions; }
const toast = (message, type = 'info') => (globalThis.toastr || SillyTavern.getContext()?.toastr)?.[type]?.(message);

export function openMemoryOrganization(chatId, options = {}) {
    const existing = document.querySelector('.bb-organization-overlay');
    if (existing) {
        mountInTopLayer(existing);
        if (options.initialTab) existing.querySelector(`[data-tab="${options.initialTab}"]`)?.click();
        return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'bb-form-overlay bb-organization-overlay';
    overlay.innerHTML = `<section class="bb-mem-form-popup bb-organization-popup">
        <div class="bb-mem-form-header"><h3>记忆整理</h3><button class="menu_button" data-action="close" aria-label="关闭记忆整理">关闭</button></div>
        <div class="bb-organization-tabs" role="tablist" aria-label="整理功能">
            <button class="menu_button" role="tab" data-tab="curation">全库整理</button>
            <button class="menu_button" role="tab" data-tab="correction">纠错</button>
            <button class="menu_button" role="tab" data-tab="maintenance">记忆维护</button>
        </div>
        <div class="bb-mem-form-body bb-organization-body">
            <section data-panel="curation" role="tabpanel">
                <p>扫描疑似重复或审查全库质量，查看原文、编辑建议后选择应用。</p>
                <div class="bb-organization-actions"><button class="menu_button" id="bb_curate_full_btn" data-action="curation">开始全库整理</button><button class="menu_button" data-action="extraction_updates">提取变更审核</button><button class="menu_button" id="bb_curate_undo_btn" data-action="undo">撤销上次整理 / 总结</button></div>
                <div id="bb_curate_status" role="status">等待启动</div>
            </section>
            <section data-panel="correction" role="tabpanel" hidden><div class="bb-correction-panel"></div></section>
            <section data-panel="maintenance" role="tabpanel" hidden>
                <p>记忆状态与故事线维护</p>
                <button class="menu_button" data-action="maintenance">打开维护与体检</button>
                <div class="bb-organization-summary">
                    <h4>时间线 / 里程碑总结</h4>
                    <label>资料范围 <select class="bb-input" data-setting="timelineSummaryScope">${Object.entries(SUMMARY_SCOPES).map(([key,label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
                    <label data-timeline-choice>时间线 <select class="bb-input" data-setting="timelineSummaryTimelineId"><option value="">正在读取…</option></select></label>
                    <label>允许修改 <select class="bb-input" data-setting="timelineSummaryTarget">${Object.entries(SUMMARY_TARGETS).map(([key,label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
                    <label>生成 API <select class="bb-input" data-setting="timelineCompressionApi"><option value="main">主 API</option><option value="custom">副 API</option></select></label>
                    <label>总结每段输入字符上限<input class="bb-input" type="number" min="2000" max="500000" data-setting="timelineSummarySegmentChars"></label>
                    <label>并行请求数<input class="bb-input" type="number" min="1" max="8" data-setting="timelineSummaryParallel"></label>
                    <label>每次输出 token 上限<input class="bb-input" type="number" min="256" data-setting="timelineCompressionMaxTokens"></label>
                    <p>输出预算默认 64000，包含模型可能消耗的思考 token；请按模型能力调整。输出截断时自动拆小输入重试，失败片段不会覆盖原文。</p>
                    <label>失败拆分重试层数<input class="bb-input" type="number" min="0" max="5" data-setting="timelineSummarySplitRetries"></label>
                    <label>副 API 每次超时（秒）<input class="bb-input" type="number" min="30" max="900" data-setting="timelineSummaryTimeoutSeconds"></label>
                    <button class="menu_button" data-action="summary">生成总结建议</button>
                    <button class="menu_button" data-action="resume_summary">继续上次总结草稿</button>
                </div>
            </section>
        </div><div class="bb-organization-status" role="status" aria-live="polite">请选择整理功能</div>
    </section>`;
    const settings = getSettings(), status = overlay.querySelector('.bb-organization-status');
    let busy = false, timelineLoading = true;
    const scopeInput = overlay.querySelector('[data-setting="timelineSummaryScope"]');
    const timelineInput = overlay.querySelector('[data-setting="timelineSummaryTimelineId"]');
    const updateScopeControls = () => {
        const single = scopeInput.value === 'selected_linked' || scopeInput.value === 'selected_all';
        overlay.querySelector('[data-timeline-choice]').hidden = !single;
        timelineInput.required = single;
        timelineInput.disabled = busy || !single || timelineLoading;
        overlay.querySelector('[data-action="summary"]').disabled = busy || timelineLoading || (single && !timelineInput.value);
    };
    for (const input of overlay.querySelectorAll('[data-setting]')) {
        if (input !== timelineInput) input.value = settings[input.dataset.setting] ?? (input === scopeInput ? 'all_with_milestones' : '');
        input.onchange = () => {
            if (!input.checkValidity()) { input.reportValidity(); return; }
            updateSettings({ [input.dataset.setting]:input.type === 'number' ? Number(input.value) : input.value });
            status.textContent = '设置已保存';
            updateScopeControls();
        };
    }
    const refreshTimelineChoices = async () => {
        timelineLoading = true; updateScopeControls();
        try {
            const timeline = (await getTimeline(chatId)).filter(t => !t.archived && t.status !== 'archived' && t.memoryTier !== 'archived');
            const selectedId = timelineInput.value || getSettings().timelineSummaryTimelineId;
            timelineInput.replaceChildren();
            if (!timeline.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '暂无时间线'; timelineInput.append(option); }
            for (const thread of timeline) { const option = document.createElement('option'); option.value = thread.id; option.textContent = thread.name || '未命名时间线'; timelineInput.append(option); }
            if (timeline.some(t => t.id === selectedId)) timelineInput.value = selectedId;
        } catch (error) { status.textContent = `读取时间线失败：${error.message}`; toast(status.textContent, 'error'); }
        finally { timelineLoading = false; updateScopeControls(); }
    };
    const setBusy = value => { busy = value; overlay.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = value; }); updateScopeControls(); };
    const close = () => { if (busy) { status.textContent = '任务处理中，请等待完成后关闭'; return; } document.removeEventListener('keydown', escape); removeTopLayerElement(overlay); };
    const escape = event => {
        const dialogs = [...document.querySelectorAll('.bb-native-top-layer:popover-open')];
        if (dialogs.length && dialogs.at(-1) !== overlay) return;
        if (event.key === 'Escape') { event.stopImmediatePropagation(); close(); }
    };
    document.addEventListener('keydown', escape);
    overlay.querySelectorAll('[data-tab]').forEach(button => {
        button.onclick = async () => {
            overlay.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== button.dataset.tab; });
            overlay.querySelectorAll('[data-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab === button)));
            status.textContent = `已切换到${button.textContent}`;
            if (button.dataset.tab === 'maintenance') await refreshTimelineChoices();
            if (button.dataset.tab === 'correction') {
                try {
                    const [{ renderCorrectionPanel }, { createManagerFormOverlay }] = await Promise.all([import('./memory-correction-ui.js'), import('./memory-manager.js')]);
                    if (!overlay.isConnected) return;
                    renderCorrectionPanel(overlay.querySelector('.bb-correction-panel'), chatId, { createForm:createManagerFormOverlay, toast, onChange:() => {} });
                } catch (error) { status.textContent = error.message; toast(error.message, 'error'); }
            }
        };
    });
    overlay.querySelector('[data-tab="curation"]').setAttribute('aria-selected','true');
    overlay.addEventListener('click', async event => {
        const button = event.target.closest('[data-action]');
        if (!button || busy) return;
        const action = button.dataset.action;
        if (action === 'close') { close(); return; }
        if (String(SillyTavern.getContext().chatId) !== String(chatId)) { toast('聊天已切换，请重新打开记忆整理', 'warning'); return; }
        if (action === 'summary') {
            const invalid = [...overlay.querySelectorAll('[data-setting]')].find(el => !el.checkValidity());
            if (invalid) { invalid.reportValidity(); status.textContent = '请检查总结参数的范围'; return; }
            updateSettings({ timelineSummaryTimelineId:timelineInput.value });
        }
        const original = button.textContent;
        setBusy(true); button.textContent = '处理中…'; status.textContent = '正在处理…';
        try {
            if (action === 'summary' || action === 'resume_summary') {
                const result = await reviewJointSummary(chatId, { resume:action === 'resume_summary', scope:scopeInput.value, timelineId:timelineInput.value, onProgress:message => { status.textContent = message; } });
                status.textContent = result.summary; toast(result.summary, 'info');
            } else if (action === 'extraction_updates') {
                const { reviewPendingExtractionUpdates } = await import('./extraction-updates.js');
                const result = await reviewPendingExtractionUpdates(chatId);
                status.textContent = result.summary || result.applyResult?.summary || (result.savedDraft ? '提取变更草稿已保存' : '提取变更审核已结束');
                toast(status.textContent, 'info');
            } else {
                if (!handlers[action]) throw new Error('整理入口尚未初始化，请刷新 ST 后重试');
                await handlers[action](chatId);
                status.textContent = action === 'maintenance' ? '维护面板已打开' : overlay.querySelector('#bb_curate_status').textContent;
            }
        } catch (error) { status.textContent = error.message; toast(error.message, 'error'); }
        finally { setBusy(false); button.textContent = original; }
    });
    mountInTopLayer(overlay);
    if (options.initialTab) overlay.querySelector(`[data-tab="${options.initialTab}"]`)?.click();
    else refreshTimelineChoices();
}
