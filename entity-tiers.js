/**
 * entity-tiers.js —— NPC / 物品分级与按需展开（v5.0 精简）
 *
 * 四柱架构下不再有 categoryPath 判断，分级直接关联到 NPC 档案 / 物品条目。
 * 保留：分级定义、标准化、检索乘数、索引卡、实体展开。
 */

import { isArchived } from './memory-store.js';

// ═══════════════════════════════════════════════════════════
//  分级定义
// ═══════════════════════════════════════════════════════════

export const NPC_TIERS = Object.freeze({
    core:       { id: 'core',       label: '核心',   injectionBias: 'always' },
    important:  { id: 'important',  label: '重要',   injectionBias: 'on_demand' },
    minor:      { id: 'minor',      label: '配角',   injectionBias: 'when_relevant' },
    background: { id: 'background', label: '路人',   injectionBias: 'minimal' },
});

export const ITEM_TIERS = Object.freeze({
    key:        { id: 'key',        label: '关键物',   injectionBias: 'always' },
    equipped:   { id: 'equipped',   label: '持有/装备', injectionBias: 'high' },
    clue:       { id: 'clue',       label: '线索',     injectionBias: 'when_relevant' },
    consumable: { id: 'consumable', label: '消耗品',    injectionBias: 'low' },
    background: { id: 'background', label: '背景物',    injectionBias: 'minimal' },
});

const NPC_TIER_IDS = new Set(Object.keys(NPC_TIERS));
const ITEM_TIER_IDS = new Set(Object.keys(ITEM_TIERS));

// ═══════════════════════════════════════════════════════════
//  标准化
// ═══════════════════════════════════════════════════════════

export function normalizeNpcTier(v) {
    if (!v || typeof v !== 'string') return '';
    const id = v.trim().toLowerCase();
    return NPC_TIER_IDS.has(id) ? id : '';
}

export function normalizeItemTier(v) {
    if (!v || typeof v !== 'string') return '';
    const id = v.trim().toLowerCase();
    return ITEM_TIER_IDS.has(id) ? id : '';
}

// ═══════════════════════════════════════════════════════════
//  检索分调节（v5.0 简化：基于 memoryTier + 实体命中）
// ═══════════════════════════════════════════════════════════

const TIER_SCORE_BOOST = {
    eternal: 1.15,
    core:    1.05,
    stable:  1.0,
    transient: 0.90,
};

export function tierScoreMultiplier(memory, queryMatched) {
    const mt = memory.memoryTier || 'transient';
    let mult = TIER_SCORE_BOOST[mt] || 1.0;

    if (!queryMatched) {
        if (mt === 'core' || mt === 'eternal') mult *= 0.90;
        else if (mt === 'transient') mult *= 0.70;
        else mult *= 0.80;
    }

    return Math.min(1.20, mult);
}

// ═══════════════════════════════════════════════════════════
//  实体提及检测（用于按需展开）
// ═══════════════════════════════════════════════════════════

function tokenizeForHints(text) {
    const tokens = text
        .toLowerCase()
        .split(/[\s,，。！？!?、；;：:""''「」（）()\[\]{}·\n\r\t]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2 && t.length <= 24);

    // CJK bigram 补充
    const cjkOnly = text.replace(/[\s,，。！？!?、；;：:""''「」（）()\[\]{}·\n\r\t0-9a-zA-Z]+/g, '');
    if (cjkOnly.length >= 2) {
        for (let i = 0; i < cjkOnly.length - 1; i++) {
            const bigram = cjkOnly.substring(i, i + 2);
            if (!tokens.includes(bigram)) tokens.push(bigram);
        }
    }

    return tokens;
}

export function extractEntityHints(queryText) {
    if (!queryText || !queryText.trim()) return [];

    const hints = new Set();

    const quoted = queryText.match(/「([^」]{1,16})」|"([^"]{1,24})"|"([^"]{1,24})"/g);
    if (quoted) {
        for (const q of quoted) {
            const inner = q.replace(/[「」"""]/g, '').trim();
            if (inner.length >= 2) hints.add(inner);
        }
    }

    for (const t of tokenizeForHints(queryText)) {
        hints.add(t);
    }

    return [...hints];
}

function normHint(h) {
    return String(h || '').toLowerCase().trim();
}

export function entityTouchesMemory(memory, hint) {
    const h = normHint(hint);
    if (!h || h.length < 2) return false;

    const pool = [
        memory.subject,
        memory.target,
        memory.title,
        memory.name,           // NPC 档案 / 物品
        ...(memory.keywords || []),
        ...(memory.tags || []).map(t => (typeof t === 'string' ? t : t.name)),
    ].filter(Boolean).map(s => String(s).toLowerCase());

    for (const p of pool) {
        if (p.includes(h) || h.includes(p)) return true;
    }
    return false;
}

export function memoryMatchesQueryEntities(memory, queryText) {
    const hints = extractEntityHints(queryText);
    return hints.some(h => entityTouchesMemory(memory, h));
}

// ═══════════════════════════════════════════════════════════
//  索引卡构建（v5.0 简化）
// ═══════════════════════════════════════════════════════════

/**
 * 为 NPC 档案构建常驻索引卡
 */
export function buildNpcIndexCard(npc) {
    if (npc.indexCard && String(npc.indexCard).trim()) return String(npc.indexCard).trim();
    const parts = [npc.name];
    if (npc.role) parts.push(npc.role);
    if (npc.status) parts.push(npc.status);
    const tier = NPC_TIERS[npc.npcTier];
    if (tier) parts.push(tier.label);
    return parts.filter(Boolean).join('｜').slice(0, 120);
}

/**
 * 为物品条目构建索引卡
 */
export function buildItemIndexCard(item) {
    if (item.indexCard && String(item.indexCard).trim()) return String(item.indexCard).trim();
    const parts = [item.name];
    if (item.owner) parts.push(`持有:${item.owner}`);
    if (item.significance) parts.push(item.significance.slice(0, 40));
    const tier = ITEM_TIERS[item.itemTier];
    if (tier) parts.push(tier.label);
    return parts.filter(Boolean).join('｜').slice(0, 120);
}

/**
 * 通用索引卡（记忆条目用）
 */
export function buildDefaultIndexCard(memory) {
    if (memory.indexCard && String(memory.indexCard).trim()) return String(memory.indexCard).trim();
    const parts = [];
    if (memory.subject || memory.title) parts.push(memory.subject || memory.title);
    if (memory.summary) parts.push(memory.summary);
    else if (memory.content) parts.push(memory.content.slice(0, 48));
    return parts.filter(Boolean).join('｜').slice(0, 120);
}

// ═══════════════════════════════════════════════════════════
//  按需展开
// ═══════════════════════════════════════════════════════════

export function expandEntityMemories(memories, queryText, excludeIds, limit = 8) {
    const hints = extractEntityHints(queryText);
    if (!hints.length || !memories.length) return [];

    const byId = new Map(memories.map(m => [m.id, m]));
    const out = [];
    const seen = new Set(excludeIds);

    function tryPush(m) {
        if (!m || seen.has(m.id)) return false;
        if (isArchived(m) || m.status === 'deleted') return false;
        out.push(m);
        seen.add(m.id);
        return true;
    }

    for (const m of memories) {
        if (out.length >= limit) break;
        const hit = hints.some(h => entityTouchesMemory(m, h));
        if (hit) tryPush(m);
    }

    let scan = 0;
    while (scan < out.length && out.length < limit) {
        const m = out[scan++];
        const rel = Array.isArray(m.relatedMemoryIds) ? m.relatedMemoryIds : [];
        for (const rid of rel) {
            if (out.length >= limit) break;
            tryPush(byId.get(rid));
        }
    }

    return out;
}

export function expandMemoriesForEntityKeyword(memories, keyword, options = {}) {
    const { limit = 12 } = options;
    const hints = keyword ? [keyword] : [];
    if (!hints.length) return [];
    const excludeIds = new Set();
    return expandEntityMemories(memories, hints.join(' '), excludeIds, limit);
}
