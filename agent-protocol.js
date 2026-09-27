/** 管家文本协议解析：兼容多行、代码围栏和结构化对象，不执行任何模型代码。 */
export function parseAgentResponse(response) {
    const text = String(response || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const reads = [], specs = [], errors = [];
    const accept = (value, kind) => {
        if (Array.isArray(value)) { value.forEach(v => accept(v, kind)); return; }
        if (!value || typeof value !== 'object') throw new Error('指令须为 JSON 对象');
        if (kind === 'JSON_READ' || value.tool) reads.push(value);
        else if (kind === 'JSON_ACTION' || value.action) specs.push(value);
        else {
            for (const v of value.reads || []) accept(v, 'JSON_READ');
            for (const v of value.actions || value.proposals || []) accept(v, 'JSON_ACTION');
        }
    };
    // 按字符串/转义状态寻找完整对象，不能用逐行 JSON.parse 或贪婪大括号正则。
    const endOf = start => {
        let depth = 0, quoted = false, escaped = false;
        for (let i = start; i < text.length; i++) {
            const c = text[i];
            if (quoted) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') quoted = false;
            } else if (c === '"') quoted = true;
            else if (c === '{' || c === '[') depth++;
            else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
        }
        return text.length;
    };
    const spans = [];
    const marker = /\b(JSON_READ|JSON_ACTION)\s*[:：]\s*/g;
    for (let match; (match = marker.exec(text));) {
        const start = marker.lastIndex;
        const end = endOf(start);
        try { accept(JSON.parse(text.slice(start, end)), match[1]); }
        catch (error) { errors.push(`指令解析失败：${error.message}`); }
        spans.push([match.index, end]); marker.lastIndex = end;
    }
    let answer = text;
    if (spans.length) {
        for (const [start, end] of spans.reverse()) answer = answer.slice(0, start) + answer.slice(end);
    } else {
        const start = text.search(/[\[{]/);
        if (start >= 0) try {
            const end = endOf(start), obj = JSON.parse(text.slice(start, end));
            accept(obj);
            if (reads.length || specs.length || obj.answer) answer = String(obj.answer || text.slice(0, start) + text.slice(end));
        } catch (error) {
            if (/"(?:reads|actions|proposals|tool|action)"/.test(text)) errors.push(`指令解析失败：${error.message}`);
        }
    }
    return { reads, specs, errors, answer: answer.replace(/```(?:json)?/gi, '').trim() };
}
