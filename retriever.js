/**
 * Memory retrieval engine.
 *
 * Architecture:
 *   1. KeywordRetriever  – Fuse.js fuzzy matching on tags (v0.1, active)
 *   2. VectorRetriever   – Embedding-based cosine similarity (future)
 *   3. HybridRetriever   – Weighted combination of multiple retrievers (future)
 *
 * All retrievers implement the same interface:
 *   search(query: RetrievalQuery, memories: MemoryEntry[], options?) → ScoredResult[]
 */

import { calculateDecayMultiplier, touchEntry } from './memory-entry.js';

/**
 * @typedef {Object} RetrievalQuery
 * @property {string[]} keywords
 * @property {string[]} [emotions]     - Future: emotion-based filtering
 * @property {string[]} [categories]   - Future: category filtering
 * @property {string}   [rawText]      - Raw user message (for vector search)
 */

/**
 * @typedef {Object} ScoredResult
 * @property {MemoryEntry} entry
 * @property {number}      score       - Final composite score (higher = more relevant)
 * @property {Object}      [detail]    - Breakdown of scoring components
 */

/**
 * @typedef {Object} RetrievalOptions
 * @property {number}  [maxResults=5]        - Maximum entries to return
 * @property {number}  [minScore=0.1]        - Minimum score threshold
 * @property {boolean} [applyDecay=true]     - Whether to apply time-based decay
 * @property {boolean} [boostPinned=true]    - Boost score for pinned entries
 * @property {number}  [importanceWeight=0.3] - Weight of importance in final score
 * @property {number}  [decayWeight=0.2]      - Weight of decay in final score
 * @property {number}  [matchWeight=0.5]      - Weight of match relevance in final score
 * @property {boolean} [enableAssociative=true]  - Enable spreading activation
 * @property {number}  [associativeBoost=0.3]    - Score boost for associatively activated memories
 * @property {number}  [maxAssociativeHops=1]    - How many hops of association to follow
 * @property {number}  [stmHalfLifeDays=2]       - STM decay half-life
 * @property {number}  [ltmHalfLifeDays=90]      - LTM decay half-life
 */

const DEFAULT_OPTIONS = {
    maxResults: 5,
    minScore: 0.1,
    applyDecay: true,
    boostPinned: true,
    importanceWeight: 0.3,
    decayWeight: 0.2,
    matchWeight: 0.5,
    enableAssociative: true,
    associativeBoost: 0.3,
    maxAssociativeHops: 1,
    stmHalfLifeDays: 2,
    ltmHalfLifeDays: 90,
};

// ─── Score Calculation ────────────────────────────────────

/**
 * Compute a composite score from individual components.
 * Long-term memories get a baseline boost; activation level is factored in.
 */
export function computeCompositeScore(matchScore, importance, decayMultiplier, entry, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const normImportance = (importance ?? 5) / 10;

    let score =
        opts.matchWeight * matchScore +
        opts.importanceWeight * normImportance +
        opts.decayWeight * decayMultiplier;

    const isPinned = typeof entry === 'boolean' ? entry : entry?.isPinned;
    if (opts.boostPinned && isPinned) {
        score *= 1.5;
    }

    if (typeof entry === 'object' && entry !== null) {
        if (entry.memoryType === 'long_term') {
            score *= 1.2;
        }
        const activation = entry.activationLevel ?? 0.5;
        score *= (0.7 + 0.3 * activation);
    }

    return Math.min(score, 1.0);
}

// ─── Keyword Retriever (v0.1 – active) ───────────────────

/**
 * Simple keyword-based retriever using basic text matching.
 * Falls back to this when Fuse.js is not available.
 *
 * Matching strategy:
 *   - Exact match on tag → high score
 *   - Partial/substring match → lower score
 *   - Multiple tag hits → accumulated score
 */
export class KeywordRetriever {
    /**
     * @param {RetrievalQuery} query
     * @param {MemoryEntry[]} memories
     * @param {RetrievalOptions} [options]
     * @returns {ScoredResult[]}
     */
    search(query, memories, options = {}) {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        const now = Date.now();
        const queryKeywords = (query.keywords || []).map(k => k.toLowerCase().trim()).filter(Boolean);

        if (queryKeywords.length === 0) return [];

        const activeMemories = memories.filter(m => m.isActive);
        const scoreMap = new Map();

        for (const entry of activeMemories) {
            const entryKeywords = (entry.tags?.keywords || []).map(k => k.toLowerCase().trim());
            const entryEmotions = (entry.tags?.emotions || []).map(e => e.toLowerCase().trim());
            const entryCategories = (entry.tags?.categories || []).map(c => c.toLowerCase().trim());
            const allEntryTags = [...entryKeywords, ...entryEmotions, ...entryCategories];

            if (allEntryTags.length === 0) continue;

            let matchHits = 0;
            let partialHits = 0;

            for (const qk of queryKeywords) {
                for (const tag of allEntryTags) {
                    if (tag === qk) {
                        matchHits++;
                    } else if (tag.includes(qk) || qk.includes(tag)) {
                        partialHits++;
                    }
                }
            }

            if (matchHits === 0 && partialHits === 0) continue;

            const matchScore = Math.min(
                (matchHits * 1.0 + partialHits * 0.4) / queryKeywords.length,
                1.0,
            );

            const decayConfig = { stmHalfLifeDays: opts.stmHalfLifeDays, ltmHalfLifeDays: opts.ltmHalfLifeDays };
            const decayMultiplier = opts.applyDecay
                ? calculateDecayMultiplier(entry, now, decayConfig)
                : 1.0;

            const finalScore = computeCompositeScore(
                matchScore,
                entry.importance,
                decayMultiplier,
                entry,
                opts,
            );

            if (finalScore >= opts.minScore) {
                scoreMap.set(entry.id, {
                    entry,
                    score: finalScore,
                    detail: { matchScore, decayMultiplier, importance: entry.importance, source: 'direct' },
                });
            }
        }

        if (opts.enableAssociative) {
            applySpreadingActivation(scoreMap, activeMemories, opts, now);
        }

        const results = [...scoreMap.values()];
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, opts.maxResults);
    }
}

// ─── Fuse.js Retriever (enhanced keyword matching) ────────

/**
 * Fuzzy keyword retriever powered by Fuse.js (bundled with SillyTavern).
 * Provides better matching for typos and morphological variations.
 */
export class FuseRetriever {
    /**
     * @param {RetrievalQuery} query
     * @param {MemoryEntry[]} memories
     * @param {RetrievalOptions} [options]
     * @param {Function} FuseClass - Fuse constructor (injected to avoid hard dependency)
     * @returns {ScoredResult[]}
     */
    search(query, memories, options = {}, FuseClass = null) {
        if (!FuseClass) {
            console.warn('[SmartMemory] Fuse.js not available, falling back to KeywordRetriever');
            return new KeywordRetriever().search(query, memories, options);
        }

        const opts = { ...DEFAULT_OPTIONS, ...options };
        const now = Date.now();
        const queryKeywords = (query.keywords || []).filter(Boolean);

        if (queryKeywords.length === 0) return [];

        const activeMemories = memories.filter(m => m.isActive);

        const fuse = new FuseClass(activeMemories, {
            keys: [
                { name: 'tags.keywords', weight: 1.0 },
                { name: 'tags.emotions', weight: 0.6 },
                { name: 'tags.categories', weight: 0.5 },
                { name: 'summary', weight: 0.3 },
            ],
            threshold: 0.4,
            includeScore: true,
            shouldSort: true,
        });

        const scoreMap = new Map();
        for (const keyword of queryKeywords) {
            const hits = fuse.search(keyword);
            for (const hit of hits) {
                const id = hit.item.id;
                if (!scoreMap.has(id)) {
                    scoreMap.set(id, { item: hit.item, scores: [] });
                }
                scoreMap.get(id).scores.push(1 - (hit.score ?? 0));
            }
        }

        const resultMap = new Map();
        for (const { item: entry, scores } of scoreMap.values()) {
            const avgFuseScore = scores.reduce((a, b) => a + b, 0) / queryKeywords.length;
            const matchScore = Math.min(avgFuseScore, 1.0);

            const decayConfig = { stmHalfLifeDays: opts.stmHalfLifeDays, ltmHalfLifeDays: opts.ltmHalfLifeDays };
            const decayMultiplier = opts.applyDecay
                ? calculateDecayMultiplier(entry, now, decayConfig)
                : 1.0;

            const finalScore = computeCompositeScore(
                matchScore,
                entry.importance,
                decayMultiplier,
                entry,
                opts,
            );

            if (finalScore >= opts.minScore) {
                resultMap.set(entry.id, {
                    entry,
                    score: finalScore,
                    detail: { matchScore, decayMultiplier, importance: entry.importance, source: 'direct' },
                });
            }
        }

        if (opts.enableAssociative) {
            applySpreadingActivation(resultMap, activeMemories, opts, now);
        }

        const results = [...resultMap.values()];
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, opts.maxResults);
    }
}

// ─── Spreading Activation (Associative Retrieval) ─────────

/**
 * Given directly-matched memories, spread activation to their associates.
 * Memories linked via shared tags receive a boosted score even if they
 * didn't match the query directly. Long-term memories are easier to activate.
 *
 * @param {Map<string, ScoredResult>} scoreMap - Direct match results (mutated in place)
 * @param {MemoryEntry[]} allMemories - All active memories
 * @param {RetrievalOptions} opts
 * @param {number} now
 */
function applySpreadingActivation(scoreMap, allMemories, opts, now) {
    const boost = opts.associativeBoost ?? 0.3;
    const hops = opts.maxAssociativeHops ?? 1;
    const memoryById = new Map(allMemories.map(m => [m.id, m]));

    let frontier = new Set(scoreMap.keys());

    for (let hop = 0; hop < hops; hop++) {
        const nextFrontier = new Set();

        for (const sourceId of frontier) {
            const sourceResult = scoreMap.get(sourceId);
            if (!sourceResult) continue;

            const sourceEntry = sourceResult.entry;
            const links = sourceEntry.associativeLinks || [];

            for (const link of links) {
                const target = memoryById.get(link.targetId);
                if (!target || !target.isActive) continue;
                if (scoreMap.has(target.id)) continue;

                const linkStrength = link.strength ?? 0.5;
                const ltmBonus = target.memoryType === 'long_term' ? 1.3 : 1.0;
                const activation = target.activationLevel ?? 0.5;

                const associativeScore = sourceResult.score * boost * linkStrength * ltmBonus * (0.6 + 0.4 * activation);

                if (associativeScore >= (opts.minScore ?? 0.1)) {
                    const decayConfig = { stmHalfLifeDays: opts.stmHalfLifeDays, ltmHalfLifeDays: opts.ltmHalfLifeDays };
                    const decayMultiplier = opts.applyDecay
                        ? calculateDecayMultiplier(target, now, decayConfig)
                        : 1.0;

                    scoreMap.set(target.id, {
                        entry: target,
                        score: Math.min(associativeScore * decayMultiplier, 1.0),
                        detail: {
                            matchScore: 0,
                            decayMultiplier,
                            importance: target.importance,
                            source: 'associative',
                            linkedFrom: sourceId,
                        },
                    });
                    nextFrontier.add(target.id);
                }
            }
        }

        frontier = nextFrontier;
        if (frontier.size === 0) break;
    }
}

// ─── Vector Retriever Stub (future) ───────────────────────

/**
 * Placeholder for embedding-based vector retrieval.
 * Will use cosine similarity on dense vectors from an embedding API.
 */
export class VectorRetriever {
    search(/* query, memories, options */) {
        throw new Error('VectorRetriever is not yet implemented. Use KeywordRetriever or FuseRetriever.');
    }
}

// ─── Factory ──────────────────────────────────────────────

/**
 * Create a retriever instance by strategy name.
 * @param {'keyword'|'fuse'|'vector'|'hybrid'} strategy
 * @returns {KeywordRetriever|FuseRetriever|VectorRetriever}
 */
export function createRetriever(strategy = 'keyword') {
    switch (strategy) {
        case 'fuse': return new FuseRetriever();
        case 'vector': return new VectorRetriever();
        case 'keyword':
        default:
            return new KeywordRetriever();
    }
}

export { touchEntry };
