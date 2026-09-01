/**
 * memory-types.js —— BB-Memory v5.0 类型定义
 *
 * 四柱架构下的精简类型系统。
 * NPC/物品分级定义在 entity-tiers.js。
 */

// ═══════════════════════════════════════════════════════════
//  记忆条目类型（四类）
// ═══════════════════════════════════════════════════════════

export const MEMORY_TYPES = Object.freeze({
    event:   { id: 'event',   label: '事件', icon: 'fa-solid fa-bolt',       color: '#ba68c8' },
    emotion: { id: 'emotion', label: '情感', icon: 'fa-solid fa-heart',       color: '#f06292' },
    habit:   { id: 'habit',   label: '习惯', icon: 'fa-solid fa-repeat',      color: '#81c784' },
    fact:    { id: 'fact',    label: '事实', icon: 'fa-solid fa-circle-info', color: '#4fc3f7' },
});

// ═══════════════════════════════════════════════════════════
//  里程碑状态
// ═══════════════════════════════════════════════════════════

export const TIMELINE_STATUS = Object.freeze({
    ongoing:    { id: 'ongoing',    label: '进行中', color: '#4fc3f7' },
    ended:      { id: 'ended',      label: '已结束', color: '#9e9e9e' },
    foreshadow: { id: 'foreshadow', label: '伏笔',   color: '#ff9800' },
});

// ═══════════════════════════════════════════════════════════
//  物品状态
// ═══════════════════════════════════════════════════════════

export const ITEM_STATUS = Object.freeze({
    held:      { id: 'held',      label: '持有中', color: '#4caf50' },
    used:      { id: 'used',      label: '已使用', color: '#ff9800' },
    lost:      { id: 'lost',      label: '已失去', color: '#f44336' },
    destroyed: { id: 'destroyed', label: '已销毁', color: '#9e9e9e' },
});

// ═══════════════════════════════════════════════════════════
//  记忆层级（升降格系统）
// ═══════════════════════════════════════════════════════════

export const MEMORY_TIERS = Object.freeze({
    transient: { id: 'transient', label: '瞬时', hitThreshold: 0,  missDecay: 30 },
    stable:    { id: 'stable',    label: '稳定', hitThreshold: 3,  missDecay: 60 },
    core:      { id: 'core',      label: '核心', hitThreshold: 8,  missDecay: 30 },
    eternal:   { id: 'eternal',   label: '永恒', hitThreshold: Infinity, missDecay: Infinity },
});

// ═══════════════════════════════════════════════════════════
//  真假状态标记
// ═══════════════════════════════════════════════════════════

export const TRUTH_STATUS = Object.freeze({
    'true':        { id: 'true',        label: '已确认',   color: '#4caf50' },
    'false':       { id: 'false',       label: '已否定',   color: '#f44336' },
    'unknown':     { id: 'unknown',     label: '未知',     color: '#9e9e9e' },
    'rumor':       { id: 'rumor',       label: '传闻',     color: '#ff9800' },
    'misleading':  { id: 'misleading',  label: '误导',     color: '#e91e63' },
    'secret_true': { id: 'secret_true', label: '隐藏真相', color: '#7c4dff' },
});

// ═══════════════════════════════════════════════════════════
//  v9.3.3 实时记忆（第五柱）
// ═══════════════════════════════════════════════════════════

/**
 * 实时记忆的细节分类。
 *
 * 这一柱专门装「具体、易被遗忘、当下有效」的场景细节：坐什么车来的、穿了什么、
 * 谁在场、点了什么。它们不进向量检索、无条件注入，用来解决长线逻辑断裂
 * （query 里没有「车」字，"坐车来电影院"就永远检索不到）。
 */
export const REALTIME_KINDS = Object.freeze({
    transport: { id: 'transport', label: '交通', icon: 'fa-solid fa-bus',              color: '#4fc3f7' },
    outfit:    { id: 'outfit',    label: '衣着', icon: 'fa-solid fa-shirt',            color: '#f06292' },
    present:   { id: 'present',   label: '在场', icon: 'fa-solid fa-users',            color: '#81c784' },
    preference:{ id: 'preference',label: '偏好/点单', icon: 'fa-solid fa-heart-circle-check', color: '#ffb74d' },
    position:  { id: 'position',  label: '位置', icon: 'fa-solid fa-location-dot',     color: '#9575cd' },
    state:     { id: 'state',     label: '状态', icon: 'fa-solid fa-wave-square',      color: '#4db6ac' },
    object:    { id: 'object',    label: '物品', icon: 'fa-solid fa-hand-holding',     color: '#a1887f' },
    time:      { id: 'time',      label: '时间', icon: 'fa-solid fa-clock',            color: '#ffd54f' },
    environment:{ id: 'environment', label: '环境', icon: 'fa-solid fa-cloud-sun',    color: '#64b5f6' },
    detail:    { id: 'detail',    label: '其他细节', icon: 'fa-solid fa-circle-dot',   color: '#90a4ae' },
});

/**
 * 各实时分类对应的用户设置键。值为 0 表示整类关闭；正数既是当前场景的槽位上限，
 * 也是注入时的分类硬上限。放在纯常量模块里，避免提取、注入和 UI 各维护一份映射。
 */
export const REALTIME_KIND_SLOT_SETTINGS = Object.freeze({
    transport: 'realtimeTransportSlots',
    outfit: 'realtimeOutfitSlots',
    present: 'realtimePresentSlots',
    preference: 'realtimePreferenceSlots',
    position: 'realtimePositionSlots',
    state: 'realtimeStateSlots',
    object: 'realtimeObjectSlots',
    time: 'realtimeTimeSlots',
    environment: 'realtimeEnvironmentSlots',
    detail: 'realtimeDetailSlots',
});

export function getRealtimeKindSlotLimits(settings = {}) {
    const limits = {};
    for (const kind of Object.keys(REALTIME_KINDS)) {
        const raw = Number(settings[REALTIME_KIND_SLOT_SETTINGS[kind]]);
        limits[kind] = Number.isFinite(raw) ? Math.max(0, Math.min(20, Math.floor(raw))) : 2;
    }
    return limits;
}

export const DEFAULT_REALTIME_KIND = 'detail';

export function normalizeRealtimeKind(value) {
    const key = String(value || '').trim().toLowerCase();
    if (REALTIME_KINDS[key]) return key;
    // 容错：AI 可能直接回中文标签
    const label = String(value || '').trim();
    const aliases = {
        偏好: 'preference', 点单: 'preference', 临时偏好: 'preference',
        随手物: 'object', 随手物品: 'object',
        天气: 'environment', 场景环境: 'environment',
    };
    if (aliases[label]) return aliases[label];
    const byLabel = Object.values(REALTIME_KINDS).find(k => k.label === label);
    return byLabel ? byLabel.id : DEFAULT_REALTIME_KIND;
}

/** 实时记忆的结算状态。 */
export const REALTIME_SETTLE_STATES = Object.freeze({
    active:         { id: 'active',         label: '生效中', color: '#4caf50' },
    pending_settle: { id: 'pending_settle', label: '待结算', color: '#ff9800' },
    settled:        { id: 'settled',        label: '已结算', color: '#9e9e9e' },
});

export function normalizeSettleState(value) {
    const key = String(value || '').trim();
    return REALTIME_SETTLE_STATES[key] ? key : 'active';
}

// ═══════════════════════════════════════════════════════════
//  隐藏备注类型
// ═══════════════════════════════════════════════════════════

export const HIDDEN_NOTE_TYPES = Object.freeze({
    note:          { id: 'note',          label: '通用备注' },
    inner_thought: { id: 'inner_thought', label: '角色内心' },
    foreshadow:    { id: 'foreshadow',    label: '伏笔' },
    hidden_truth:  { id: 'hidden_truth',  label: '隐藏真相' },
    motivation:    { id: 'motivation',    label: '内心动机' },
    emotion:       { id: 'emotion',       label: '压抑情感' },
    plot:          { id: 'plot',          label: '剧情备注' },
});


// ═══════════════════════════════════════════════════════════
//  隐藏备注工具
// ═══════════════════════════════════════════════════════════

/**
 * 获取可注入的隐藏备注行
 */
export function getInjectableNotes(memory) {
    if (!Array.isArray(memory.hiddenNotes)) return [];
    return memory.hiddenNotes.filter(n => n.allowInjection !== false);
}
