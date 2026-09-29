/** v9.4.8 记忆整理统一入口。 */
import { getSettings, updateSettings } from './memory-store.js';
import { mountInTopLayer, removeTopLayerElement } from './ui-top-layer.js';
import { SUMMARY_TARGETS, reviewJointSummary } from './story-summary.js';

let handlers = {};
export function configureMemoryOrganization(actions) { handlers = actions; }
const toast = (message, type = 'info') => (globalThis.toastr || SillyTavern.getContext()?.toastr)?.[type]?.(message);

export function openMemoryOrganization(chatId) {
    const existing = document.querySelector('.bb-organization-overlay');
    if (existing) { mountInTopLayer(existing); return; }
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
                <div class="bb-organization-actions"><button class="menu_button" id="bb_curate_full_btn" data-action="curation">开始全库整理</button><button class="menu_button" id="bb_curate_undo_btn" data-action="undo">撤销上次整理 / 总结</button></div>
                <div id="bb_curate_status" role="status">等待启动</div>
            </section>
            <section data-panel="correction" role="tabpanel" hidden><div class="bb-correction-panel"></div></section>
            <section data-panel="maintenance" role="tabpanel" hidden>
                <p>检查条目健康、维护等级和状态，或联合总结时间线与里程碑。</p>
                <button class="menu_button" data-action="maintenance">打开维护与体检</button>
                <div class="bb-organization-summary">
                    <h4>时间线与里程碑联合总结</h4><p>AI 先读取上下文确认故事分段，再按段并行总结对应时间线与里程碑。保留日期与日期区间，省略无必要的时刻；事件数量由实际情节决定。</p>
                    <p class="bb-summary-notice">为避免记忆混乱，开始总结后会保持在此页面，暂时无法关闭或切换栏目。请等待生成完成；结果会自动保存为草稿，可编辑、采纳，或保存后稍后继续审核。已采纳内容也可在记忆管理中再次修改。</p>
                    <label>允许修改 <select class="bb-input" data-setting="timelineSummaryTarget">${Object.entries(SUMMARY_TARGETS).map(([key,label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
                    <label>生成 API <select class="bb-input" data-setting="timelineCompressionApi"><option value="main">主 API</option><option value="custom">副 API</option></select></label>
                    <label>规划每批输入字符上限<input class="bb-input" type="number" min="2000" max="500000" data-setting="timelineCompressionContextChars"></label>
                    <label>总结每段输入字符上限<input class="bb-input" type="number" min="2000" max="500000" data-setting="timelineSummarySegmentChars"></label>
                    <label>并行请求数<input class="bb-input" type="number" min="1" max="8" data-setting="timelineSummaryParallel"></label>
                    <label>每次输出 token 上限<input class="bb-input" type="number" min="256" data-setting="timelineCompressionMaxTokens"></label>
                    <p>输出预算默认 64000，包含模型可能消耗的思考 token；请按模型能力调整。输出截断时自动拆小输入重试，失败片段不会覆盖原文。</p>
                    <label>失败拆分重试层数<input class="bb-input" type="number" min="0" max="5" data-setting="timelineSummarySplitRetries"></label>
                    <label>副 API 每次超时（秒）<input class="bb-input" type="number" min="30" max="900" data-setting="timelineSummaryTimeoutSeconds"></label>
                    <button class="menu_button" data-action="summary">生成联合总结建议</button>
                    <button class="menu_button" data-action="resume_summary">继续上次总结草稿</button>
                </div>
            </section>
        </div><div class="bb-organization-status" role="status" aria-live="polite">请选择整理功能</div>
    </section>`;
    const settings = getSettings(), status = overlay.querySelector('.bb-organization-status');
    let busy = false;
    for (const input of overlay.querySelectorAll('[data-setting]')) {
        input.value = settings[input.dataset.setting];
        input.onchange = () => {
            if (!input.checkValidity()) { input.reportValidity(); return; }
            updateSettings({ [input.dataset.setting]:input.type === 'number' ? Number(input.value) : input.value });
            status.textContent = '设置已保存';
        };
    }
    const setBusy = value => { busy = value; overlay.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = value; }); };
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
        const original = button.textContent;
        setBusy(true); button.textContent = '处理中…'; status.textContent = '正在处理…';
        try {
            if (action === 'summary' || action === 'resume_summary') {
                if (![...overlay.querySelectorAll('[data-setting]')].every(el => el.checkValidity())) throw new Error('请检查总结参数的范围');
                const result = await reviewJointSummary(chatId, { resume:action === 'resume_summary', onProgress:message => { status.textContent = message; } });
                status.textContent = result.summary; toast(result.summary, 'info');
            } else {
                if (!handlers[action]) throw new Error('整理入口尚未初始化，请刷新 ST 后重试');
                await handlers[action](chatId);
                status.textContent = action === 'maintenance' ? '维护面板已打开' : overlay.querySelector('#bb_curate_status').textContent;
            }
        } catch (error) { status.textContent = error.message; toast(error.message, 'error'); }
        finally { setBusy(false); button.textContent = original; }
    });
    mountInTopLayer(overlay);
}
