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
//  时间线事件状态
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
