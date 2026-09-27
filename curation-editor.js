/** Editable result fields, including individual timeline events and split results. */
import { CORRECTION_FIELDS } from './memory-correction.js';

export function mountCurationEditor(host, op, onChange) {
    const results = op.op === 'split' ? op.results : op.result ? [op.result] : [];
    for (const [index, result] of results.entries()) {
        const heading = document.createElement('strong');
        heading.textContent = results.length > 1 ? `编辑建议结果 ${index + 1}` : '编辑建议结果';
        host.appendChild(heading);
        const walk = (value, owner, key, label) => {
            if (/^(?:id|.*Id|.*Ids|__proto__|constructor|prototype)$/.test(key)) return;
            if (value && typeof value === 'object') {
                for (const [child, v] of Object.entries(value)) walk(v, value, child, `${label} · ${/^\d+$/.test(child) ? Number(child) + 1 : CORRECTION_FIELDS[child] || child}`);
                return;
            }
            if (!['string', 'number', 'boolean'].includes(typeof value)) return;
            const wrapper = document.createElement('label'); wrapper.className = 'bb-curate-edit-field';
            const title = document.createElement('span'); title.textContent = label;
            const input = document.createElement(typeof value === 'string' ? 'textarea' : 'input');
            input.className = 'bb-input'; input.setAttribute('aria-label', label);
            if (typeof value === 'boolean') { input.type = 'checkbox'; input.checked = value; }
            else { input.value = String(value); if (typeof value === 'number') { input.type = 'number'; input.step = 'any'; } else input.rows = value.length > 100 ? 4 : 2; }
            input.addEventListener('input', () => {
                owner[key] = typeof value === 'boolean' ? input.checked : typeof value === 'number' ? Number(input.value) : input.value;
                op._edited = true; onChange?.();
            });
            wrapper.append(title, input); host.appendChild(wrapper);
        };
        for (const [key, value] of Object.entries(result)) walk(value, result, key, CORRECTION_FIELDS[key] || key);
    }
}

export function classifyCurationOps(ops, limit = 5) {
    const cap = Math.min(5, Math.max(1, Number(limit) || 5));
    const counts = new Map();
    for (const op of ops) {
        const label = String(op.issueCategory || '其他').trim().slice(0, 16) || '其他';
        op.issueCategory = label;
        if (label !== '其他') counts.set(label, (counts.get(label) || 0) + 1);
    }
    const allowed = [...counts].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([label]) => label);
    for (const op of ops) if (!allowed.includes(op.issueCategory)) op.issueCategory = '其他';
    return [...allowed, ...(ops.some(op => op.issueCategory === '其他') ? ['其他'] : [])];
}
