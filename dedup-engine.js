/**
 * dedup-engine.js — BB-Memory v9.3.0 混合去重引擎
 *
 * 纯函数模块：组合名称归一化、结构字段、字符相似度和可选向量相似度。
 * 自动提取与存储层共用，避免 NPC / 物品只按完整名称匹配。
 */

const LEADING_ITEM_QUANTIFIER = /^(?:这|那|某|一|两|几)?(?:个|件|条|套|枚|把|只|双|顶|块|张|本|支|瓶|盒|串|根|面|床|身|袭|对|束|颗|粒|包|袋|台|部|辆|座|幅|封|卷|把)?/;

export function normalizeIdentityText(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s"'“”‘’`.,，。！？!?、:：;；()[\]{}<>《》【】\-—_/\\|·]+/g, '')
        .trim();
}

export function normalizeAliases(input) {
    const list = Array.isArray(input)
        ? input
        : (typeof input === 'string' ? input.split(/[,，、\n]/) : []);
    const seen = new Set();
    const out = [];
    for (const value of list) {
        const text = String(typeof value === 'string' ? value : (value?.name || value?.alias || '')).trim();
        const key = normalizeIdentityText(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function entityNames(entry = {}, pillar = '') {
    const names = [entry.name, entry.canonicalName, ...normalizeAliases(entry.aliases)].filter(Boolean);
    return [...new Set(names.map(name => pillar === 'item' ? normalizeItemName(name) : normalizeIdentityText(name)).filter(Boolean))];
}

export function normalizeItemName(value) {
    return normalizeIdentityText(value).replace(LEADING_ITEM_QUANTIFIER, '');
}

export function charBigrams(value) {
    const text = normalizeIdentityText(value);
    if (!text) return [];
    if (text.length === 1) return [text];
    const out = [];
    for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2));
    return out;
}

/**
 * Dice 系数，输入为已切好的二元组数组。
 * 调用方可缓存 charBigrams 结果，避免在 O(n^2) 两两比较里重复归一化字符串。
 */
export function diceFromBigrams(aa, bb) {
    if (!Array.isArray(aa) || !Array.isArray(bb) || !aa.length || !bb.length) return 0;
    const counts = new Map();
    for (const token of aa) counts.set(token, (counts.get(token) || 0) + 1);
    let overlap = 0;
    for (const token of bb) {
        const count = counts.get(token) || 0;
        if (!count) continue;
        overlap++;
        counts.set(token, count - 1);
    }
    return (2 * overlap) / (aa.length + bb.length);
}

export function textDiceSimilarity(a, b) {
    return diceFromBigrams(charBigrams(a), charBigrams(b));
}

function longestCommonSubstringLength(a, b) {
    const left = normalizeIdentityText(a).slice(0, 320);
    const right = normalizeIdentityText(b).slice(0, 320);
    if (!left || !right) return 0;
    const row = new Uint16Array(right.length + 1);
    let best = 0;
    for (let i = 1; i <= left.length; i++) {
        for (let j = right.length; j >= 1; j--) {
            if (left[i - 1] === right[j - 1]) {
                row[j] = row[j - 1] + 1;
                best = Math.max(best, row[j]);
            } else row[j] = 0;
        }
    }
    return best;
}

export function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom ? Math.max(0, Math.min(1, dot / denom)) : 0;
}

function sameMeaningfulField(a, b) {
    const left = normalizeIdentityText(a);
    const right = normalizeIdentityText(b);
    return Boolean(left && right && left === right);
}

function conflictingField(a, b) {
    const left = normalizeIdentityText(a);
    const right = normalizeIdentityText(b);
    return Boolean(left && right && left !== right);
}

// ═══ v9.3.3 故事时间冲突的判定粒度 ═══

export const TIME_CONFLICT_SCOPES = Object.freeze(['date', 'exact', 'off']);

/** 时刻类表述：clock 时间、中文时段词、N点/N时/N分/N秒。 */
const TIME_OF_DAY_PATTERN = /\d{1,2}\s*[:：]\s*\d{1,2}(?:\s*[:：]\s*\d{1,2})?|\d{1,2}\s*(?:点半|点钟|点|時|时|分|秒)|凌晨|清晨|早晨|早上|上午|正午|中午|午后|下午|傍晚|黄昏|晚上|夜里|深夜|半夜|午夜|夜晚|夜|晨|昼|傍午/g;

/**
 * 抽出故事时间里的“日期部分”签名，丢掉时刻表述。
 *
 * 「12:01」「12:05」都会归一化成空——同一天内的时刻差异不该被判为时间冲突。
 * 「2026年4月3日夜」→「2026年4月3日」，「2026年4月4日」→ 与前者不同，仍算冲突。
 */
export function storyTimeDateSignature(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return normalizeIdentityText(text.replace(TIME_OF_DAY_PATTERN, ' '));
}

/**
 * 两个故事时间是否算冲突。
 * @param {string} scope 'date' 按日期（默认）| 'exact' 按完整时间（旧行为）| 'off' 不判定
 */
export function conflictingStoryTime(a, b, scope = 'date') {
    if (scope === 'off') return false;
    if (scope === 'exact') return conflictingField(a, b);
    const left = storyTimeDateSignature(a);
    const right = storyTimeDateSignature(b);
    // 任一侧只写了时刻（日期签名为空）时无法判断日期，不扣分
    return Boolean(left && right && left !== right);
}

export function entityNameSimilarity(pillar, incoming, existing) {
    const incomingNames = entityNames(incoming, pillar);
    const existingNames = entityNames(existing, pillar);
    let best = 0;
    for (const a of incomingNames) {
        for (const b of existingNames) {
            if (a === b) return 1;
            const shorter = a.length <= b.length ? a : b;
            const longer = a.length > b.length ? a : b;
            let score = textDiceSimilarity(a, b);
            if (shorter.length >= 2 && longer.includes(shorter)) score = Math.max(score, 0.94);
            if (pillar === 'item' && a.length >= 2 && b.length >= 2 && a.slice(-2) === b.slice(-2)) {
                // “睡裙”与“白色刺猬睡裙”：通用短名可作为同一物品的基础名称。
                const hasGenericShortName = Math.min(a.length, b.length) <= 3;
                const sharesDescriptorPrefix = a.slice(0, 2) === b.slice(0, 2);
                score = Math.max(score, hasGenericShortName ? 0.92 : (sharesDescriptorPrefix ? 0.90 : 0.72));
            }
            best = Math.max(best, score);
        }
    }
    return best;
}

function memoryText(entry = {}) {
    return [entry.title, entry.summary, entry.content, entry.verbatim].filter(Boolean).join('\n');
}

function memoryScore(incoming, existing, config = {}) {
    const incomingBody = normalizeIdentityText(incoming.content || incoming.summary || incoming.title);
    const existingBody = normalizeIdentityText(existing.content || existing.summary || existing.title);
    if (incomingBody && incomingBody === existingBody) return { score: 1, reason: '内容指纹一致', conflict: false };

    let lexical = textDiceSimilarity(memoryText(incoming), memoryText(existing));
    if (incomingBody && existingBody) {
        const shorter = incomingBody.length <= existingBody.length ? incomingBody : existingBody;
        const longer = incomingBody.length > existingBody.length ? incomingBody : existingBody;
        if (shorter.length >= 6 && longer.includes(shorter)) lexical = Math.max(lexical, 0.94);
        const sharedRun = longestCommonSubstringLength(incomingBody, existingBody);
        const sharedRatio = sharedRun / Math.max(1, Math.min(incomingBody.length, existingBody.length));
        if (sharedRun >= 4 && sharedRatio >= 0.45) lexical = Math.max(lexical, 0.76);
        if (sharedRun >= 6 && sharedRatio >= 0.65) lexical = Math.max(lexical, 0.88);
    }
    const vector = cosineSimilarity(incoming.embedding, existing.embedding);
    let score = Math.max(lexical, vector);
    if (sameMeaningfulField(incoming.subject, existing.subject)) score += 0.04;
    if (sameMeaningfulField(incoming.target, existing.target)) score += 0.03;
    const truthConflict = incoming.truthStatus && existing.truthStatus
        && ((incoming.truthStatus === 'true' && existing.truthStatus === 'false')
            || (incoming.truthStatus === 'false' && existing.truthStatus === 'true'));
    const timeConflict = ['event', 'emotion'].includes(incoming.type || existing.type)
        && conflictingStoryTime(incoming.storyTime, existing.storyTime,
            TIME_CONFLICT_SCOPES.includes(config.timeConflictScope) ? config.timeConflictScope : 'date');
    if (truthConflict) score -= 0.35;
    if (timeConflict) score -= 0.12;
    return {
        score: Math.max(0, Math.min(1, score)),
        reason: vector >= lexical ? '向量与结构相似' : '文本与结构相似',
        conflict: truthConflict,
    };
}

function entityScore(pillar, incoming, existing) {
    const name = entityNameSimilarity(pillar, incoming, existing);
    if (pillar !== 'item' && name === 1) return { score: 1, reason: '名称或别名一致', conflict: false };
    const vector = cosineSimilarity(incoming.embedding, existing.embedding);
    let score = Math.max(name, vector * 0.94);
    if (pillar === 'item') {
        if (sameMeaningfulField(incoming.owner, existing.owner)) score += 0.05;
        if (sameMeaningfulField(incoming.location, existing.location)) score += 0.03;
        const ownerConflict = conflictingField(incoming.owner, existing.owner);
        const locationConflict = conflictingField(incoming.location, existing.location);
        if (ownerConflict) score -= 0.14;
        if (ownerConflict && locationConflict) score -= 0.10;
        // 强名称关系（同名、量词变化、短名/完整名）优先解释为同一件物品的流转状态。
        // 否则“蓝色宝石 → 宝石 → 一块宝石”会因持有者/地点变化被保存成三件物品。
        // 真正的同名不同物应由提取器使用独立标准名；用户仍可在管理器中拆分误合并项。
        const stateUpdateLikely = name >= 0.94;
        if (stateUpdateLikely) score = Math.max(score, 0.94);
        return {
            score: Math.max(0, Math.min(1, score)),
            reason: stateUpdateLikely ? '物品强名称一致，按持有/地点状态更新' : (name >= vector ? '物品名称相似' : '物品语义相似'),
            conflict: stateUpdateLikely ? false : ownerConflict,
        };
    }
    if (sameMeaningfulField(incoming.role, existing.role)) score += 0.04;
    if (sameMeaningfulField(incoming.location, existing.location)) score += 0.02;
    return { score: Math.max(0, Math.min(1, score)), reason: name >= vector ? 'NPC 名称相似' : 'NPC 语义相似', conflict: false };
}

export function findExactEntityMatch(pillar, incoming, existingEntries = []) {
    const incomingNames = new Set(entityNames(incoming, pillar));
    if (!incomingNames.size) return null;
    return existingEntries.find(entry => entityNames(entry, pillar).some(name => incomingNames.has(name))) || null;
}

export function findBestDuplicate(pillar, incoming, existingEntries = [], config = {}) {
    const autoMergeThreshold = Number(config.autoMergeThreshold) || (pillar === 'memory' ? 0.88 : 0.90);
    const reviewThreshold = Number(config.reviewThreshold) || 0.74;
    let best = null;
    for (const existing of existingEntries) {
        if (!existing || existing.archived) continue;
        const detail = pillar === 'memory'
            ? memoryScore(incoming, existing, config)
            : entityScore(pillar, incoming, existing);
        if (!best || detail.score > best.score) best = { entry: existing, ...detail };
    }
    if (!best || best.score < reviewThreshold) return null;
    return {
        ...best,
        action: !best.conflict && best.score >= autoMergeThreshold ? 'merge' : 'review',
    };
}

export function mergeEntityAliases(existing = {}, incoming = {}) {
    return normalizeAliases([
        ...(existing.aliases || []),
        ...(incoming.aliases || []),
        existing.name,
        incoming.name,
    ]).filter(alias => normalizeIdentityText(alias) !== normalizeIdentityText(existing.name));
}
