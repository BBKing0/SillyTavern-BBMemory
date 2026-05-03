/**
 * entity-tiers.js —— NPC / 物品分级与按需展开（v2.6）
 *
 * 目标：路人 NPC 与背景物品少占 token；核心实体常驻索引卡；
 * 用户提到实体时再合并关联记忆的完整注入档位。
 */

// ═══════════════════════════════════════════════════════════
//  分级定义
// ═══════════════════════════════════════════════════════════

export const NPC_TIERS = Object.freeze({
    core:       { id: 'core',       label: '核心', injectionBias: 'resident_or_high' },
    important:  { id: 'important',  label: '重要', injectionBias: 'on_demand' },
    minor:      { id: 'minor',      label: '配角', injectionBias: 'when_relevant' },
    background: { id: 'background', label: '路人', injectionBias: 'minimal' },
});

export const ITEM_TIERS = Object.freeze({
    key:         { id: 'key',         label: '关键物', injectionBias: 'high' },
    equipped:    { id: 'equipped',    label: '持有/装备', injectionBias: 'high' },
    clue:        { id: 'clue',        label: '线索', injectionBias: 'when_relevant' },
    consumable:  { id: 'consumable',  label: '消耗品', injectionBias: 'low' },
    background:  { id: 'background',  label: '背景物', injectionBias: 'minimal' },
});

const NPC_TIER_IDS = new Set(Object.keys(NPC_TIERS));
const ITEM_TIER_IDS = new Set(Object.keys(ITEM_TIERS));

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

export function isNpcCategoryPath(path) {
    return typeof path === 'string' && path.startsWith('npc.');
}

export function isItemCategoryPath(path) {
    return typeof path === 'string' && path.startsWith('item.');
}

/**
 * 默认分级（未填写时）
 */
export function defaultNpcTierForPath(categoryPath) {
    return isNpcCategoryPath(categoryPath) ? 'minor' : '';
}

export function defaultItemTierForPath(categoryPath) {
    return isItemCategoryPath(categoryPath) ? 'consumable' : '';
}

/**
 * AI 提取后的策略：路人不要单独建 npc.profile 档案
 */
export function applyStandaloneArchivePolicy(mem) {
    const cp = mem.categoryPath || '';
    const standalone = mem.standaloneArchive !== false;

    if (!standalone && cp.startsWith('npc.')) {
        mem.categoryPath = 'episode.event';
        mem.cognitiveType = 'episode';
        mem.npcTier = normalizeNpcTier(mem.npcTier) || 'background';
        mem.itemTier = '';
        return;
    }

    if (!standalone && cp.startsWith('item.')) {
        mem.itemTier = normalizeItemTier(mem.itemTier) || 'background';
    }
}

/**
 * 自动推断是否值得单独建档（无 AI 字段时的启发式）
 */
export function inferStandaloneArchive(mem) {
    if (mem.importance >= 0.55) return true;
    if (mem.emotionalWeight >= 0.35) return true;
    if ((mem.verbatim || '').length >= 8) return true;
    return false;
}

// ═══════════════════════════════════════════════════════════
// 实体提及检测（用于按需展开）
// ═══════════════════════════════════════════════════════════

function tokenizeForHints(text) {
    return text
        .toLowerCase()
        .split(/[\s,，。！？!?、；;：:""''「」（）()\[\]{}·\n\r\t]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2 && t.length <= 24);
}

/**
 * 从用户输入中提取可能的 NPC / 物品名提示（含书名号、引号片段）
 */
export function extractEntityHints(queryText) {
    if (!queryText || !queryText.trim()) return [];

    const hints = new Set();

    const quoted = queryText.match(/「([^」]{1,16})」|"([^"]{1,24})"|“([^”]{1,24})”/g);
    if (quoted) {
        for (const q of quoted) {
            const inner = q.replace(/[「」""“”]/g, '').trim();
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

/**
 * 判断记忆是否与某个实体提示相关（主体、标题、关键词）
 */
export function entityTouchesMemory(memory, hint) {
    const h = normHint(hint);
    if (!h || h.length < 2) return false;

    const pool = [
        memory.subject,
        memory.target,
        memory.title,
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

/**
 * 记忆在本轮 query 下是否视为「实体命中」（用于档位与乘数）
 */
export function shouldTreatAsEntityHit(memory, queryText) {
    if (memoryMatchesQueryEntities(memory, queryText)) return true;
    if (memory.resident && (memory.npcTier === 'core' || memory.itemTier === 'key')) return true;
    return false;
}

// ═══════════════════════════════════════════════════════════
// 分级对检索分的调节（可解释、可调参）
// ═══════════════════════════════════════════════════════════

export function tierScoreMultiplier(memory, queryMatched) {
    let mult = 1;
    const nt = normalizeNpcTier(memory.npcTier);
    const it = normalizeItemTier(memory.itemTier);

    if (nt) {
        if (nt === 'core') mult *= 1.18;
        else if (nt === 'important') mult *= 1.06;
        else if (nt === 'minor') mult *= queryMatched ? 1 : 0.72;
        else if (nt === 'background') mult *= queryMatched ? 0.88 : 0.28;
    }

    if (it) {
        if (it === 'key') mult *= 1.12;
        else if (it === 'equipped') mult *= 1.1;
        else if (it === 'clue') mult *= queryMatched ? 1.04 : 0.82;
        else if (it === 'consumable') mult *= queryMatched ? 0.92 : 0.52;
        else if (it === 'background') mult *= queryMatched ? 0.8 : 0.32;
    }

    return Math.min(1.55, mult);
}

// ═══════════════════════════════════════════════════════════
// 常驻索引卡（短句，不含完整剧情史）
// ═══════════════════════════════════════════════════════════

export function buildDefaultIndexCard(memory) {
    if (memory.indexCard && String(memory.indexCard).trim()) return String(memory.indexCard).trim();

    const parts = [];
    if (memory.subject || memory.title) parts.push(memory.subject || memory.title);
    if (memory.summary) parts.push(memory.summary);
    else if (memory.content) parts.push(memory.content.slice(0, 48));

    const nt = normalizeNpcTier(memory.npcTier);
    const it = normalizeItemTier(memory.itemTier);
    if (nt) parts.push(`NPC·${NPC_TIERS[nt].label}`);
    if (it) parts.push(`物·${ITEM_TIERS[it].label}`);

    return parts.filter(Boolean).join('｜').slice(0, 120);
}

// ═══════════════════════════════════════════════════════════
// 按需展开：拉取与提及实体相关的其它记忆（关系线、秘密线等）
// ═══════════════════════════════════════════════════════════

/**
 * 按需展开：与本轮提及实体相关的记忆（含 npc.* / item.* / 情景线），并沿 relatedMemoryIds 链展开。
 *
 * @param {object[]} memories - 全量记忆
 * @param {string} queryText - 用户本轮输入
 * @param {Set<string>} excludeIds - 已在候选里的 id（含常驻）
 * @param {number} limit - 最多追加条数
 * @returns {object[]} 记忆对象（去重）
 */
export function expandEntityMemories(memories, queryText, excludeIds, limit = 8) {
    const hints = extractEntityHints(queryText);
    if (!hints.length || !memories.length) return [];

    const byId = new Map(memories.map(m => [m.id, m]));
    const out = [];
    const seen = new Set(excludeIds);

    function tryPush(m) {
        if (!m || seen.has(m.id)) return false;
        if (m.status === 'archived' || m.status === 'deleted') return false;
        if (m.resident) return false;
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

/**
 * 程序化按需展开接口（供外部或调试使用）：返回某实体关键词关联的一批记忆。
 */
export function expandMemoriesForEntityKeyword(memories, keyword, options = {}) {
    const { limit = 12 } = options;
    const hints = keyword ? [keyword] : [];
    if (!hints.length) return [];
    const excludeIds = new Set();
    return expandEntityMemories(
        memories,
        hints.join(' '),
        excludeIds,
        limit,
    );
}
