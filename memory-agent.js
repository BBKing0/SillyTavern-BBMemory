/** v9.4.6 记忆管家面板：聊天内调查与建议选择执行。 */
import { runAgentQuery, executeAgentProposals, getAgentProposals, resetAgentSession } from './memory-agent-core.js';
import { CORRECTION_LABELS } from './memory-correction.js';
import { mountInTopLayer, removeTopLayerElement } from './ui-top-layer.js';
export { runAgentQuery } from './memory-agent-core.js';

function toast(text, type = 'info') {
    const api = globalThis.toastr || globalThis.SillyTavern?.getContext?.()?.toastr;
    api?.[type]?.(text);
}
const showValue = value => value === undefined ? '（未设置）' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

export function openAgent(chatId) {
    const previous = document.querySelector('.bb-agent-overlay');
    if (previous) { previous.querySelector('textarea')?.focus(); toast('记忆管家已经打开'); return; }
    const history = [];
    let working = false, controller;
    const overlay = document.createElement('div');
    overlay.className = 'bb-agent-overlay';
    overlay.innerHTML = `<div class="bb-agent-wrapper"><div class="bb-agent-panel">
        <div class="bb-agent-header"><span class="bb-agent-title"><i class="fa-solid fa-robot"></i> 记忆管家 <em>v9.4.6</em></span>
            <div class="bb-agent-controls"><button class="menu_button" data-action="reset">重置对话</button><button class="menu_button" data-action="close" aria-label="关闭记忆管家">×</button></div></div>
        <div class="bb-agent-body" aria-live="polite"></div>
        <div class="bb-agent-proposals"></div>
        <div class="bb-agent-footer">
            <div class="bb-agent-quick-btns">
                <button class="menu_button" data-prompt="请扫描当前聊天的全库维护问题，按类型整理维护建议并说明依据，先不要执行。">整理维护建议</button>
                <button class="menu_button" data-prompt="请查找所有缺少向量的条目，分页读取完整结果，提出重新生成向量的建议。">检查缺少向量</button>
            </div>
            <div class="bb-agent-status" role="status"></div>
            <div class="bb-agent-input-row"><textarea class="bb-input" rows="2" placeholder="例如：林澈应该是老师，库里是否误写成医生？请查找并建议修改。"></textarea>
                <button class="menu_button" data-action="send">发送</button><button class="menu_button" data-action="stop" hidden>停止</button></div>
        </div></div></div>`;
    mountInTopLayer(overlay);
    const body = overlay.querySelector('.bb-agent-body');
    const plan = overlay.querySelector('.bb-agent-proposals');
    const input = overlay.querySelector('textarea');
    const status = overlay.querySelector('.bb-agent-status');
    const stop = overlay.querySelector('[data-action="stop"]');
    const onProgress = text => { status.textContent = text; };
    const append = (role, text) => {
        const div = document.createElement('div'); div.className = `bb-agent-msg bb-agent-msg-${role}`;
        div.textContent = text; body.appendChild(div); body.scrollTop = body.scrollHeight;
    };
    const welcome = () => append('system', '描述有误或有疑问的事实，我会搜索当前聊天全库、读取原文并提出建议。范围包含所有分类、归档、隐藏备注、实时日程和辅助系统。建议不会自动写入；勾选后执行，或输入“执行建议 1、3”。调查需要副 API。');
    function renderProposals() {
        plan.replaceChildren();
        const proposals = getAgentProposals(chatId);
        if (!proposals.length) return;
        const title = document.createElement('strong'); title.textContent = `待执行建议（${proposals.length}）`;
        plan.appendChild(title);
        const controls = document.createElement('div'); controls.className = 'bb-agent-controls';
        const all = document.createElement('button'); all.className = 'menu_button'; all.textContent = '全选';
        all.onclick = () => { plan.querySelectorAll('input').forEach(c => { c.checked = true; }); toast('已选中全部建议'); };
        const none = document.createElement('button'); none.className = 'menu_button'; none.textContent = '全不选';
        none.onclick = () => { plan.querySelectorAll('input').forEach(c => { c.checked = false; }); toast('已取消全部选择'); };
        const execute = document.createElement('button'); execute.className = 'menu_button'; execute.textContent = '执行所选建议';
        execute.onclick = () => perform(async options => {
            const numbers = [...plan.querySelectorAll('input:checked')].map(c => Number(c.value));
            const result = await executeAgentProposals(chatId, numbers, options);
            return result;
        });
        controls.append(all, none, execute); plan.appendChild(controls);
        for (const p of proposals) {
            const card = document.createElement('details'); card.className = 'bb-agent-proposal';
            const summary = document.createElement('summary');
            const check = document.createElement('input'); check.type = 'checkbox'; check.value = p.number;
            check.setAttribute('aria-label', `选择建议 ${p.number}`); check.onclick = e => e.stopPropagation();
            const label = document.createElement('span'); label.textContent = `${p.number}. ${p.label} · ${p.title}`;
            summary.append(check, label); card.appendChild(summary);
            const reason = document.createElement('p'); reason.textContent = p.reason; card.appendChild(reason);
            const source = document.createElement('div');
            source.textContent = p.row ? `${CORRECTION_LABELS[p.row.pillar]} · ${p.row.entry.id}` : `${p.issue.group || '体检'} · ${p.issue.id || p.issue.type}`;
            card.appendChild(source);
            if (p.patch) for (const [field, value] of Object.entries(p.patch)) {
                const diff = document.createElement('pre'); diff.textContent = `${field}\n原值：${showValue(p.row.entry[field])}\n建议：${showValue(value)}`; card.appendChild(diff);
            }
            plan.appendChild(card);
        }
    }
    async function perform(task) {
        if (working) return;
        if (String(globalThis.SillyTavern?.getContext?.()?.chatId) !== String(chatId)) { toast('聊天已切换，请关闭后重新打开管家', 'warning'); return; }
        working = true; controller = new AbortController();
        overlay.querySelectorAll('button, textarea, input').forEach(el => { el.disabled = true; });
        stop.hidden = false; stop.disabled = false;
        overlay.querySelector('[data-action="close"]').disabled = false;
        onProgress('正在处理…');
        try {
            const result = await task({ signal: controller.signal, onProgress });
            if (!overlay.isConnected) return;
            append('agent', result.answer); history.push({ role: 'assistant', content: result.answer });
            const failed = result.actions.filter(a => a.error).length;
            onProgress(result.cancelled ? `任务已停止，成功 ${result.actions.length - failed}，失败 ${failed}，剩余建议已保留`
                : result.actions.length ? `执行完成：成功 ${result.actions.length - failed}，失败 ${failed}` : '核查完成，建议待你选择执行');
            toast(status.textContent, failed || result.cancelled ? 'warning' : 'success');
        } catch (error) {
            if (overlay.isConnected) { append('agent', error.message); onProgress(error.message); toast(error.message, controller.signal.aborted ? 'info' : 'error'); }
        } finally {
            working = false; renderProposals();
            overlay.querySelectorAll('button, textarea, input').forEach(el => { el.disabled = false; });
            stop.hidden = true;
            if (overlay.isConnected) input.focus();
        }
    }
    const send = () => {
        if (working) return;
        const text = input.value.trim(); if (!text) { toast('请输入要核查的疑问', 'warning'); return; }
        input.value = ''; append('user', text); history.push({ role: 'user', content: text });
        return perform(options => runAgentQuery(chatId, text, history, null, options));
    };
    const close = () => { controller?.abort(); removeTopLayerElement(overlay); document.removeEventListener('keydown', onEscape); };
    const onEscape = event => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', onEscape);
    overlay.querySelector('[data-action="send"]').onclick = send;
    overlay.querySelector('[data-action="close"]').onclick = close;
    stop.onclick = () => { controller?.abort(); onProgress('正在停止，已完成的操作会保留'); };
    overlay.querySelector('[data-action="reset"]').onclick = () => {
        if (working) return;
        resetAgentSession(chatId); history.length = 0; body.replaceChildren(); renderProposals(); welcome();
        onProgress('对话及待执行建议已重置'); toast('管家对话和建议已重置，记忆数据保留', 'success');
    };
    overlay.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { if (!working) { input.value = button.dataset.prompt; send(); } }; });
    input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } };
    welcome(); renderProposals(); input.focus();
}
