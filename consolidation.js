/**
 * Memory consolidation engine.
 *
 * Mimics the human STM → LTM promotion process:
 *   - High importance memories consolidate quickly
 *   - Frequently retrieved memories get promoted
 *   - Emotionally intense memories are favored
 *   - Pinned memories are always treated as long-term
 *   - Short-term memories that exceed capacity are pruned (deactivated)
 *
 * Also builds associative links between memories that share tags.
 */

/**
 * @typedef {Object} ConsolidationConfig
 * @property {number} importanceThreshold   - Min importance to auto-consolidate (default 7)
 * @property {number} retrievalThreshold    - Min retrieval count to consolidate (default 3)
 * @property {number} emotionalThreshold    - Min emotionalIntensity to boost consolidation (default 0.7)
 * @property {number} stmCapacity           - Max short-term memories before pruning (default 50)
 * @property {number} stmDecayHalfLifeDays  - Half-life for STM entries (default 2)
 * @property {number} ltmDecayHalfLifeDays  - Half-life for LTM entries (default 90)
 */

const DEFAULT_CONSOLIDATION = {
    importanceThreshold: 7,
    retrievalThreshold: 3,
    emotionalThreshold: 0.7,
    stmCapacity: 50,
    stmDecayHalfLifeDays: 2,
    ltmDecayHalfLifeDays: 90,
};

/**
 * Evaluate whether a single memory should be promoted to long-term.
 * Returns true if at least one consolidation criterion is met.
 *
 * @param {import('./memory-entry.js').MemoryEntry} entry
 * @param {ConsolidationConfig} config
 * @returns {boolean}
 */
export function shouldConsolidate(entry, config = {}) {
    const cfg = { ...DEFAULT_CONSOLIDATION, ...config };

    if (entry.memoryType === 'long_term') return false;
    if (!entry.isActive) return false;
    if (entry.isPinned) return true;
    if (entry.importance >= cfg.importanceThreshold) return true;
    if ((entry.retrievalCount ?? 0) >= cfg.retrievalThreshold) return true;
    if ((entry.emotionalIntensity ?? 0) >= cfg.emotionalThreshold) return true;

    return false;
}

/**
 * Promote a memory entry to long-term. Returns the updated fields.
 * @param {import('./memory-entry.js').MemoryEntry} entry
 * @param {ConsolidationConfig} config
 * @returns {Partial<import('./memory-entry.js').MemoryEntry>}
 */
export function consolidateEntry(entry, config = {}) {
    const cfg = { ...DEFAULT_CONSOLIDATION, ...config };
    return {
        memoryType: 'long_term',
        consolidatedAt: Date.now(),
        activationLevel: Math.min(1.0, (entry.activationLevel ?? 0.5) + 0.2),
        decay: {
            ...entry.decay,
            halfLifeDays: cfg.ltmDecayHalfLifeDays,
        },
    };
}

/**
 * Run a full consolidation pass over all memories in a slot.
 * - Promotes qualifying STM entries to LTM
 * - Deactivates excess STM entries beyond capacity (lowest activation first)
 * Returns arrays of promoted and deactivated entry IDs.
 *
 * @param {import('./memory-entry.js').MemoryEntry[]} memories
 * @param {ConsolidationConfig} config
 * @returns {{ promoted: string[], deactivated: string[] }}
 */
export function runConsolidation(memories, config = {}) {
    const cfg = { ...DEFAULT_CONSOLIDATION, ...config };
    const promoted = [];
    const deactivated = [];

    for (const entry of memories) {
        if (shouldConsolidate(entry, cfg)) {
            promoted.push(entry.id);
        }
    }

    const activeSTM = memories.filter(m =>
        m.isActive &&
        m.memoryType !== 'long_term' &&
        !promoted.includes(m.id),
    );

    if (activeSTM.length > cfg.stmCapacity) {
        const sorted = [...activeSTM].sort((a, b) =>
            (a.activationLevel ?? 0) - (b.activationLevel ?? 0),
        );
        const excess = sorted.slice(0, activeSTM.length - cfg.stmCapacity);
        for (const entry of excess) {
            deactivated.push(entry.id);
        }
    }

    return { promoted, deactivated };
}

/**
 * Build or refresh associative links between memories based on shared tags.
 * Two memories are linked if they share at least one keyword, emotion, or category.
 * Link strength = sharedTagCount / max(tagsA, tagsB).
 *
 * @param {import('./memory-entry.js').MemoryEntry[]} memories - Active memories only
 * @param {number} [minStrength=0.15] - Minimum strength to create a link
 * @returns {Map<string, Array<{targetId:string, strength:number}>>} entryId → links
 */
export function buildAssociativeLinks(memories, minStrength = 0.15) {
    const linkMap = new Map();
    const active = memories.filter(m => m.isActive);

    function allTags(entry) {
        const t = entry.tags || {};
        return [
            ...(t.keywords || []),
            ...(t.emotions || []),
            ...(t.categories || []),
        ].map(s => s.toLowerCase().trim()).filter(Boolean);
    }

    for (let i = 0; i < active.length; i++) {
        const tagsA = allTags(active[i]);
        if (tagsA.length === 0) continue;
        const setA = new Set(tagsA);

        for (let j = i + 1; j < active.length; j++) {
            const tagsB = allTags(active[j]);
            if (tagsB.length === 0) continue;

            let shared = 0;
            for (const tag of tagsB) {
                if (setA.has(tag)) shared++;
            }

            if (shared === 0) continue;

            const strength = shared / Math.max(setA.size, tagsB.length);
            if (strength < minStrength) continue;

            const link = { strength: Math.round(strength * 100) / 100 };

            if (!linkMap.has(active[i].id)) linkMap.set(active[i].id, []);
            linkMap.get(active[i].id).push({ targetId: active[j].id, ...link });

            if (!linkMap.has(active[j].id)) linkMap.set(active[j].id, []);
            linkMap.get(active[j].id).push({ targetId: active[i].id, ...link });
        }
    }

    return linkMap;
}
