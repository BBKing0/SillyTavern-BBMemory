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
 */

const DEFAULT_OPTIONS = {
    maxResults: 5,
    minScore: 0.1,
    applyDecay: true,
    boostPinned: true,
    importanceWeight: 0.3,
    decayWeight: 0.2,
    matchWeight: 0.5,
};

// ─── Score Calculation ────────────────────────────────────

/**
 * Compute a composite score from individual components.
 * All weights should sum to ~1.0 for interpretability.
 */
export function computeCompositeScore(matchScore, importance, decayMultiplier, isPinned, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const normImportance = (importance ?? 5) / 10;

    let score =
        opts.matchWeight * matchScore +
        opts.importanceWeight * normImportance +
        opts.decayWeight * decayMultiplier;

    if (opts.boostPinned && isPinned) {
        score *= 1.5;
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
        const results = [];

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

            const decayMultiplier = opts.applyDecay
                ? calculateDecayMultiplier(entry, now)
                : 1.0;

            const finalScore = computeCompositeScore(
                matchScore,
                entry.importance,
                decayMultiplier,
                entry.isPinned,
                opts,
            );

            if (finalScore >= opts.minScore) {
                results.push({
                    entry,
                    score: finalScore,
                    detail: { matchScore, decayMultiplier, importance: entry.importance },
                });
            }
        }

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

        const fuseResultMap = new Map();
        for (const keyword of queryKeywords) {
            const hits = fuse.search(keyword);
            for (const hit of hits) {
                const id = hit.item.id;
                if (!fuseResultMap.has(id)) {
                    fuseResultMap.set(id, { item: hit.item, scores: [] });
                }
                fuseResultMap.get(id).scores.push(1 - (hit.score ?? 0));
            }
        }

        const results = [];
        for (const { item: entry, scores } of fuseResultMap.values()) {
            const avgFuseScore = scores.reduce((a, b) => a + b, 0) / queryKeywords.length;
            const matchScore = Math.min(avgFuseScore, 1.0);

            const decayMultiplier = opts.applyDecay
                ? calculateDecayMultiplier(entry, now)
                : 1.0;

            const finalScore = computeCompositeScore(
                matchScore,
                entry.importance,
                decayMultiplier,
                entry.isPinned,
                opts,
            );

            if (finalScore >= opts.minScore) {
                results.push({
                    entry,
                    score: finalScore,
                    detail: { matchScore, decayMultiplier, importance: entry.importance },
                });
            }
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, opts.maxResults);
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
