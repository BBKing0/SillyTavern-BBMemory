const naturalTimeCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export function parseEventTimeOrder(value) {
    const entries = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
    return [...new Set(entries.map(entry => String(entry).trim()).filter(Boolean))];
}

function chineseNumber(value) {
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const units = { 十: 10, 百: 100, 千: 1000 };
    if (![...value].some(char => units[char])) return [...value].map(char => digits[char]).join('');
    let total = 0, current = 0;
    for (const char of value) {
        if (units[char]) { total += (current || 1) * units[char]; current = 0; }
        else current = digits[char];
    }
    return String(total + current);
}

function normalizeEventTime(value) {
    return String(value || '').normalize('NFKC').trim()
        .replace(/[零〇一二两三四五六七八九十百千]+(?=年|月|日|天|时|点|分|秒)/g, chineseNumber);
}

function eraMatch(text, order) {
    let match = null;
    for (let index = 0; index < order.length; index++) {
        const era = order[index];
        const offset = text.indexOf(era);
        if (offset >= 0 && (!match || era.length > match.era.length)) match = { era, index, offset };
    }
    return match;
}

export function compareEventTimes(a, b, eraOrder = '') {
    const left = normalizeEventTime(a), right = normalizeEventTime(b);
    if (!left || !right) return left ? -1 : right ? 1 : 0;
    const order = parseEventTimeOrder(eraOrder).map(normalizeEventTime);
    const leftEra = eraMatch(left, order), rightEra = eraMatch(right, order);
    if (!!leftEra !== !!rightEra) return leftEra ? -1 : 1;
    if (leftEra && rightEra && leftEra.index !== rightEra.index) return leftEra.index - rightEra.index;
    if (leftEra && rightEra) {
        const leftDetail = left.slice(0, leftEra.offset) + left.slice(leftEra.offset + leftEra.era.length);
        const rightDetail = right.slice(0, rightEra.offset) + right.slice(rightEra.offset + rightEra.era.length);
        return naturalTimeCollator.compare(leftDetail, rightDetail);
    }
    return naturalTimeCollator.compare(left, right);
}

export function compareEntriesByEventTime(a, b, { direction = 'asc', eraOrder = '' } = {}) {
    const left = String(a.storyTime || '').trim(), right = String(b.storyTime || '').trim();
    // 未填写时间的条目在两个方向都置后，不凭创建时间推断剧情时间。
    if (!left || !right) return left ? -1 : right ? 1 : 0;
    const result = compareEventTimes(left, right, eraOrder);
    return direction === 'desc' ? -result : result;
}
