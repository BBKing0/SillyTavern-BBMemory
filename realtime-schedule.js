/** v9.4.5 日程：与实时细节共用第五柱存储，但不受场景/楼层结算影响。 */
import { normalizeIdentityText } from './dedup-engine.js';

export function scheduleLimit(value, fallback, max = 200) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback;
}

export function scheduleDayKey(label) {
    const value = String(label || '').trim();
    const date = value.match(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/);
    return `date:${date ? `${date[1]}-${Number(date[2])}-${Number(date[3])}` : normalizeIdentityText(value)}`;
}

function periodOrder(entry) {
    const period = String(entry.text || '').split(/[，,]/)[0];
    const clock = period.match(/(\d{1,2})[:：点时](\d{1,2})?/);
    if (clock) {
        let hour = Number(clock[1]);
        if (/下午|晚上|夜间|傍晚/.test(period) && hour < 12) hour += 12;
        if (/凌晨/.test(period) && hour === 12) hour = 0;
        return hour * 60 + Number(clock[2] || 0);
    }
    const parts = [[/午夜|零点/, 0], [/凌晨/, 3], [/清晨|早晨|黎明/, 6], [/上午|早上/, 9], [/中午|午间|正午/, 12], [/下午/, 15], [/傍晚|黄昏/, 18], [/晚上|晚间/, 20], [/深夜|夜间/, 23]];
    return (parts.find(([pattern]) => pattern.test(period))?.[1] ?? 24) * 60;
}

export function getScheduleDays(entries, settings = {}) {
    const days = new Map();
    for (const entry of entries || []) {
        if (entry?.kind !== 'schedule' || entry.settleState === 'settled' || entry.promotedTo) continue;
        const key = entry.dayKey || entry.dayLabel || 'unknown';
        if (!days.has(key)) days.set(key, { key, label: entry.dayLabel || '日期未注明', order: Number(entry.dayOrder || entry.createdAt || 0), entries: [] });
        days.get(key).entries.push(entry);
    }
    return [...days.values()].sort((a, b) => b.order - a.order)
        .slice(0, settings.scheduleAllDays ? undefined : scheduleLimit(settings.realtimeScheduleDays, 3, 30))
        .reverse().map(day => ({ ...day, entries: day.entries.sort((a, b) =>
            periodOrder(a) - periodOrder(b)
            || Number(a.actionOrder || a.createdAt || 0) - Number(b.actionOrder || b.createdAt || 0)) }));
}

export function buildSchedulePrompt(entries, settings = {}) {
    if (settings.realtimeScheduleEnabled === false) return '\n日程已关闭，不输出 schedule。';
    const days = getScheduleDays(entries, settings);
    const context = days.map(day => `${day.label}：${day.entries.map(e => e.text).join('；')}`).join('\n') || '暂无';
    return `\n\n## 同时记录每日行动轨迹（独立于细节条数）
在同一个 JSON 对象内追加 schedule 数组，每项 {"day":"明确的故事日期或第几天；未注明则空串","newDay":false,"period":"上午/中午/下午/晚上/明确时刻；未知则时段未明","action":"人物+已发生的行动和目的地，简练一句"}。
仅记录本层实际发生的出行、到达、学习、用餐、办事等行动；不记录打算、约定、想象、回忆、外貌、表情、环境。按实际发生先后输出，保留人物名；没有行动则 schedule:[]。
同一天换地点不换日；只有原文明说次日/第二天才设 newDay:true。不要把现实日期当故事日期，不推测年月日。一天多项只在第一项标 newDay。明确日期时优先填完整日期，不填“今天/昨日/次日”。
例如：{"details":[],"schedule":[{"day":"第三天","newDay":false,"period":"上午","action":"A前往学校学习"},{"day":"第三天","newDay":false,"period":"中午","action":"A前往酒店吃饭"}]}。
每次最多 ${scheduleLimit(settings.realtimeScheduleActionsPerDay, 30)} 项，每项行动最多 ${scheduleLimit(settings.realtimeScheduleActionChars, 80, 500)} 字；已记录且未改变的行动不要重复。
已有日程（仅供去重和判断日期延续，不能当作本层新事实）：\n${context}`;
}

export function planScheduleWrites(entries, rawSchedule, context = {}) {
    const settings = context.settings || {};
    if (settings.realtimeScheduleEnabled === false) return { adds: [], rejected: [] };
    const existing = (entries || []).filter(e => e.kind === 'schedule');
    const working = existing.slice();
    const sameFloorEntries = existing.filter(e => e.sourceChatId === context.chatId && e.sourceFloor === context.floor
        && e.sourceExchange === (context.sourceExchange || ''));
    const sameFloor = sameFloorEntries[0];
    let current = sameFloor || existing.slice().sort((a, b) => Number(b.dayOrder || b.createdAt || 0) - Number(a.dayOrder || a.createdAt || 0))[0];
    const adds = [], rejected = [];
    const now = context.now || Date.now();
    for (const [index, raw] of (Array.isArray(rawSchedule) ? rawSchedule : []).entries()) {
        if (!raw || typeof raw !== 'object') continue;
        const action = String(raw.action || '').trim().replace(/\s+/g, ' ');
        if (!action) continue;
        const maxChars = scheduleLimit(settings.realtimeScheduleActionChars, 80, 500);
        if (action.length > maxChars) { rejected.push(`日程行动超过${maxChars}字，请缩短后补录或调大设置`); continue; }
        const period = String(raw.period || '时段未明').trim().slice(0, 30);
        const day = String(raw.day || '').trim().slice(0, 60);
        const text = `${period}，${action}`;
        const previousAction = sameFloorEntries.find(e => e.sourceActionIndex === index || normalizeIdentityText(e.text) === normalizeIdentityText(text));
        const explicit = day && !/^(今天|今日|当天|次日|明天|昨日|昨天|未知|未注明日期)$/.test(day);
        let target = explicit ? working.find(e => e.dayKey === scheduleDayKey(day) || scheduleDayKey(e.dayLabel) === scheduleDayKey(day)) : previousAction || current;
        if (!target || (raw.newDay === true && !explicit && !previousAction)) {
            const number = new Set(working.map(e => e.dayKey)).size + 1;
            target = { dayKey: explicit ? scheduleDayKey(day) : `day:${number}:${now + index}`,
                dayLabel: explicit ? day : `故事第${number}日（日期未注明）`, dayOrder: now + index };
        }
        current = target;
        const sameDay = working.filter(e => e.dayKey === target.dayKey);
        if (sameDay.some(e => normalizeIdentityText(e.text) === normalizeIdentityText(text))) continue;
        if (sameDay.length >= scheduleLimit(settings.realtimeScheduleActionsPerDay, 30)) {
            rejected.push(`${target.dayLabel}日程已达每日上限，请调大设置或手动整理`); continue;
        }
        const entry = { kind: 'schedule', text, dayKey: target.dayKey, dayLabel: target.dayLabel, dayOrder: target.dayOrder,
            actionOrder: now + index, sceneKey: '', storyTime: target.dayLabel, location: '',
            sourceActionIndex: index,
            createdFloor: context.floor, lastSeenFloor: context.floor, sourceFloor: context.floor,
            sourceExchange: context.sourceExchange || '', sourceChatId: context.chatId, settleState: 'active' };
        adds.push(entry); working.push(entry);
    }
    return { adds, rejected };
}

export function realtimeFloorLabel(entry) {
    const first = Number(entry.createdFloor ?? -1), last = Number(entry.lastSeenFloor ?? -1);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return '未知楼层';
    if (first < 0 && last < 0) return '旧聊天';
    if (first < 0) return `旧聊天 · 最近第 ${last} 层`;
    if (last < 0 || first === last) return `第 ${first} 层`;
    return `第 ${first}–${last} 层`;
}
