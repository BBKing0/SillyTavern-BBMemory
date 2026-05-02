/**
 * Memory entry data model.
 *
 * Designed for extensibility: tag categories, importance scoring,
 * and time-based decay are all first-class fields even though the
 * initial implementation only uses keyword matching.
 */

let _idCounter = 0;

function generateId() {
    return `mem_${Date.now()}_${_idCounter++}`;
}

/**
 * Tag categories for RP scenarios.
 * @typedef {Object} MemoryTags
 * @property {string[]} keywords   - Core keyword tags (active in v0.1)
 * @property {string[]} emotions   - Emotional state tags (e.g. happy, anxious, angry)
 * @property {string[]} categories - RP-specific categories:
 *     "promise"      – commitments / promises made
 *     "daily"        – routine / daily life details
 *     "event"        – notable events / turning points
 *     "relationship" – relationship dynamics
 *     "secret"       – secrets / hidden info
 *     "preference"   – likes / dislikes / tastes
 *     "lore"         – world-building / setting details
 *     "custom"       – user-defined
 */

/**
 * Decay configuration.
 * @typedef {Object} DecayConfig
 * @property {number} baseWeight       - Initial weight, default 1.0
 * @property {number} lastAccessedAt   - Timestamp of last retrieval
 * @property {number} accessCount      - Total retrieval count
 * @property {number} halfLifeDays     - Decay half-life in days (0 = no decay)
 */

/**
 * Full memory entry.
 * @typedef {Object} MemoryEntry
 * @property {string}      id
 * @property {number}      messageIndex    - Index of the source message in chat
 * @property {string}      chatId          - Chat identifier
 * @property {string}      summary         - Summarized content
 * @property {string}      originalExcerpt - Truncated original text for reference
 * @property {MemoryTags}  tags
 * @property {number}      importance      - 1-10 scale
 * @property {DecayConfig} decay
 * @property {'user'|'assistant'|'system'} source
 * @property {number}      createdAt
 * @property {boolean}     isActive
 * @property {boolean}     isPinned        - Pinned entries bypass decay
 * @property {Object}      [meta]          - Extensible metadata bag
 */

const EXCERPT_MAX_LENGTH = 200;

/**
 * Create a new memory entry with safe defaults.
 * @param {Partial<MemoryEntry>} overrides
 * @returns {MemoryEntry}
 */
export function createMemoryEntry(overrides = {}) {
    const now = Date.now();
    return {
        id: generateId(),
        messageIndex: -1,
        chatId: '',
        summary: '',
        originalExcerpt: '',
        tags: {
            keywords: [],
            emotions: [],
            categories: [],
            ...(overrides.tags || {}),
        },
        importance: 5,
        decay: {
            baseWeight: 1.0,
            lastAccessedAt: now,
            accessCount: 0,
            halfLifeDays: 0,
            ...(overrides.decay || {}),
        },
        source: 'assistant',
        createdAt: now,
        isActive: true,
        isPinned: false,
        meta: {},
        ...overrides,
        // Re-apply nested objects so shallow spread doesn't clobber them
        tags: {
            keywords: [],
            emotions: [],
            categories: [],
            ...(overrides.tags || {}),
        },
        decay: {
            baseWeight: 1.0,
            lastAccessedAt: now,
            accessCount: 0,
            halfLifeDays: 0,
            ...(overrides.decay || {}),
        },
    };
}

/**
 * Truncate text to create an excerpt.
 * @param {string} text
 * @returns {string}
 */
export function makeExcerpt(text) {
    if (!text) return '';
    if (text.length <= EXCERPT_MAX_LENGTH) return text;
    return text.slice(0, EXCERPT_MAX_LENGTH) + '...';
}

/**
 * Calculate the current decay multiplier for an entry.
 * Returns a value between 0 and 1, where 1 means no decay.
 *
 * @param {MemoryEntry} entry
 * @param {number} [now=Date.now()]
 * @returns {number}
 */
export function calculateDecayMultiplier(entry, now = Date.now()) {
    if (entry.isPinned) return 1.0;
    const halfLife = entry.decay?.halfLifeDays ?? 0;
    if (halfLife <= 0) return 1.0;

    const daysSinceAccess = (now - (entry.decay?.lastAccessedAt ?? entry.createdAt)) / (1000 * 60 * 60 * 24);
    // Exponential decay: weight = baseWeight * (0.5 ^ (days / halfLife))
    return (entry.decay?.baseWeight ?? 1.0) * Math.pow(0.5, daysSinceAccess / halfLife);
}

/**
 * Record an access (retrieval) on an entry, resetting its decay timer.
 * Returns a *new* entry object (immutable pattern).
 * @param {MemoryEntry} entry
 * @returns {MemoryEntry}
 */
export function touchEntry(entry) {
    return {
        ...entry,
        decay: {
            ...entry.decay,
            lastAccessedAt: Date.now(),
            accessCount: (entry.decay?.accessCount ?? 0) + 1,
        },
    };
}

/**
 * All recognised RP categories (for UI dropdowns, validation, etc.).
 */
export const RP_CATEGORIES = [
    'promise',
    'daily',
    'event',
    'relationship',
    'secret',
    'preference',
    'lore',
    'custom',
];

/**
 * All recognised emotion labels.
 */
export const EMOTION_LABELS = [
    'happy', 'sad', 'angry', 'anxious', 'surprised',
    'fearful', 'disgusted', 'neutral', 'loving', 'nostalgic',
];
