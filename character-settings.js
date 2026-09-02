/**
 * character-settings.js —— 角色作用域设置
 *
 * 角色相关设置必须绑定稳定身份（角色头像文件名 / 群组 ID），不能使用
 * characters 数组下标；后者会在导入、删除或排序角色后漂移。
 */

import { getSettings, updateSettings } from './memory-store.js';
import { getStableCharacterId } from './slot-identity.js';

function normalizeScopedTextMap(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = {};
    for (const [key, raw] of Object.entries(source)) {
        const stableId = String(key || '').trim();
        if (!stableId || (!stableId.startsWith('char:') && !stableId.startsWith('charname:') && !stableId.startsWith('group:'))) continue;
        out[stableId] = String(raw || '').trim();
    }
    return out;
}

/**
 * 读取当前角色的地图现实原型参考。
 *
 * 旧版 worldRealWorldRef 仅作只读兼容回退：用户第一次在某角色下保存后，
 * 新值会写进 worldRealWorldRefs[stableId]，不会再污染其他角色。
 */
export function getCharacterWorldRealWorldRef(settings = getSettings(), stableId = getStableCharacterId()) {
    const scoped = normalizeScopedTextMap(settings?.worldRealWorldRefs);
    if (stableId && Object.prototype.hasOwnProperty.call(scoped, stableId)) return scoped[stableId];
    return String(settings?.worldRealWorldRef || '').trim();
}

export function setCharacterWorldRealWorldRef(value, stableId = getStableCharacterId()) {
    if (!stableId) throw new Error('无法解析稳定角色身份，已停止保存以避免绑定错位');
    const settings = getSettings();
    const scoped = normalizeScopedTextMap(settings.worldRealWorldRefs);
    scoped[stableId] = String(value || '').trim();
    updateSettings({ worldRealWorldRefs: scoped });
    return scoped[stableId];
}

export function getCurrentStableCharacterId() {
    return getStableCharacterId();
}
