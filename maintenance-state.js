/** v9.4.6：按聊天保存忽略项；条目内容变化后自动重新提示。 */
import { cyrb53Hash } from './message-state.js';

export function maintenanceIssueKey(issue) {
    return JSON.stringify([issue.type, issue.collection || 'mem', issue.id || issue.item?.id || issue.idA || '', issue.idB || '', issue.floor ?? '']);
}

export function maintenanceFingerprint(issue) {
    const clean = value => {
        if (Array.isArray(value)) return value.map(clean);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.keys(value).sort()
            .filter(key => !/^(embedding.*|updatedAt|lastHitAt|hitCount|hitScore|missStreak|_.*)$/.test(key))
            .map(key => [key, clean(value[key])]));
    };
    return String(cyrb53Hash(JSON.stringify(clean(issue.entry || issue.item || { detail: issue.detail, floor: issue.floor }))
        + JSON.stringify(clean(issue.entryB || null))));
}

async function storage(chatId) {
    const ctx = globalThis.SillyTavern?.getContext?.();
    const lf = ctx?.libs?.localforage || globalThis.SillyTavern?.libs?.localforage;
    if (!lf) throw new Error('维护记录存储不可用');
    const key = `bb_maintenance_ignored_chat_${chatId}`;
    const cloud = String(ctx?.chatId) === String(chatId) ? ctx.chatMetadata?.bb_memory_maintenance_ignored : null;
    return { ctx, lf, key, records: cloud || await lf.getItem(key) || {} };
}

async function save(chatId, state, records) {
    await state.lf.setItem(state.key, records);
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (String(ctx?.chatId) === String(chatId)) {
        ctx.chatMetadata ||= {};
        ctx.chatMetadata.bb_memory_maintenance_ignored = records;
        if (typeof ctx.saveMetadata === 'function') await ctx.saveMetadata();
        else ctx.saveMetadataDebounced?.();
    }
}

export async function filterIgnoredIssues(chatId, issues) {
    const { records } = await storage(chatId);
    return issues.filter(issue => records[maintenanceIssueKey(issue)] !== maintenanceFingerprint(issue));
}

export async function ignoreMaintenanceIssues(chatId, issues) {
    const state = await storage(chatId);
    for (const issue of issues) state.records[maintenanceIssueKey(issue)] = maintenanceFingerprint(issue);
    await save(chatId, state, state.records);
}

export async function resetIgnoredIssues(chatId) {
    const state = await storage(chatId);
    await save(chatId, state, {});
}
