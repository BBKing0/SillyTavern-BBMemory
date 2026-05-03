/**
 * memory-types.js —— BB-Memory 的"认知分类系统"
 *
 * v2.2 重构：从 6 种物品分类升级为 4 种认知类型 + 树状分类路径。
 * v2.3 新增：TRUTH_STATUS（真假标记）、HIDDEN_NOTE_TYPES（隐藏备注类型）
 */

// ═══════════════════════════════════════════════════════════
//  四大认知类型
// ═══════════════════════════════════════════════════════════

export const COGNITIVE_TYPES = Object.freeze({
    fact: {
        id: 'fact',
        label: '事实',
        icon: 'fa-solid fa-book',
        color: '#4fc3f7',
        description: '确定的事实信息（NPC档案、物品、地点、世界设定等）',
    },
    episode: {
        id: 'episode',
        label: '情景',
        icon: 'fa-solid fa-film',
        color: '#ba68c8',
        description: '发生过的事件或经历（战斗、对话、承诺、秘密等）',
    },
    emotion: {
        id: 'emotion',
        label: '情感',
        icon: 'fa-solid fa-heart',
        color: '#f06292',
        description: '情感状态和关系变化（好感、敌意、情绪波动等）',
    },
    habit: {
        id: 'habit',
        label: '习惯',
        icon: 'fa-solid fa-repeat',
        color: '#81c784',
        description: '行为模式和偏好（口头禅、日常习惯、喜好厌恶等）',
    },
});

// ═══════════════════════════════════════════════════════════
//  树状分类路径
// ═══════════════════════════════════════════════════════════

export const CATEGORY_PATHS = Object.freeze({
    // ── 世界 ──
    'world.politics':  { label: '世界·政治', cognitiveType: 'fact' },
    'world.lore':      { label: '世界·背景', cognitiveType: 'fact' },
    'world.rules':     { label: '世界·规则', cognitiveType: 'fact' },
    // ── NPC ──
    'npc.profile':      { label: 'NPC·档案', cognitiveType: 'fact' },
    'npc.relationship': { label: 'NPC·关系', cognitiveType: 'fact' },
    'npc.emotion':      { label: 'NPC·情感线', cognitiveType: 'emotion' },
    'npc.secret':       { label: 'NPC·秘密', cognitiveType: 'episode' },
    'npc.goal':         { label: 'NPC·目标', cognitiveType: 'fact' },
    'npc.attitude':     { label: 'NPC·态度', cognitiveType: 'emotion' },
    // ── 物品 ──
    'item.ownership':  { label: '物品·持有', cognitiveType: 'fact' },
    'item.quest':      { label: '物品·任务', cognitiveType: 'fact' },
    'item.key':        { label: '物品·关键', cognitiveType: 'fact' },
    'item.clue':       { label: '物品·线索', cognitiveType: 'fact' },
    // ── 地点 ──
    'location.state':  { label: '地点·状态', cognitiveType: 'fact' },
    'location.map':    { label: '地点·地图', cognitiveType: 'fact' },
    // ── 情景 ──
    'episode.event':   { label: '情景·事件', cognitiveType: 'episode' },
    'episode.promise': { label: '情景·承诺', cognitiveType: 'episode' },
    'episode.secret':  { label: '情景·秘密', cognitiveType: 'episode' },
    'episode.dialogue':{ label: '情景·对话', cognitiveType: 'episode' },
    'episode.combat':  { label: '情景·战斗', cognitiveType: 'episode' },
    // ── 情感 ──
    'emotion.bond':    { label: '情感·羁绊', cognitiveType: 'emotion' },
    'emotion.trauma':  { label: '情感·创伤', cognitiveType: 'emotion' },
    'emotion.desire':  { label: '情感·愿望', cognitiveType: 'emotion' },
    // ── 习惯 ──
    'habit.routine':   { label: '习惯·日常', cognitiveType: 'habit' },
    'habit.preference':{ label: '习惯·偏好', cognitiveType: 'habit' },
    'habit.speech':    { label: '习惯·语言', cognitiveType: 'habit' },
});

// ═══════════════════════════════════════════════════════════
//  旧版类型 → 新版类型 映射表
// ═══════════════════════════════════════════════════════════

export const LEGACY_TYPE_MAP = Object.freeze({
    event:        { cognitiveType: 'episode', categoryPath: 'episode.event' },
    timeline:     { cognitiveType: 'episode', categoryPath: 'episode.event' },
    item:         { cognitiveType: 'fact',    categoryPath: 'item.ownership' },
    npc:          { cognitiveType: 'fact',    categoryPath: 'npc.profile' },
    location:     { cognitiveType: 'fact',    categoryPath: 'location.state' },
    relationship: { cognitiveType: 'fact',    categoryPath: 'npc.relationship' },
});

// ═══════════════════════════════════════════════════════════
//  向后兼容：MEMORY_TYPES 指向新的认知类型
//  让 index.js / memory-assistant.js 等文件中
//  Object.values(MEMORY_TYPES) 的遍历自动使用新类型
// ═══════════════════════════════════════════════════════════

export const MEMORY_TYPES = COGNITIVE_TYPES;

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
//  工具函数
// ═══════════════════════════════════════════════════════════

/**
 * 获取所有认知类型 ID
 */
export function getTypeIds() {
    return Object.keys(COGNITIVE_TYPES);
}

/**
 * 获取类型定义（同时兼容新旧类型 ID）
 */
export function getTypeDefinition(typeId) {
    if (COGNITIVE_TYPES[typeId]) return COGNITIVE_TYPES[typeId];
    const mapped = LEGACY_TYPE_MAP[typeId];
    if (mapped) return COGNITIVE_TYPES[mapped.cognitiveType];
    return COGNITIVE_TYPES.fact;
}

/**
 * 获取分类路径的显示标签
 */
export function getCategoryLabel(path) {
    return CATEGORY_PATHS[path]?.label || path || '';
}

/**
 * 获取分类路径的定义
 */
export function getCategoryDefinition(path) {
    return CATEGORY_PATHS[path] || null;
}

/**
 * 获取类型的默认元数据（保留兼容接口，新版不再使用 metadata 子对象）
 */
export function getDefaultMetadata(_typeId) {
    return {};
}

/**
 * 从记忆对象中解析出认知类型 ID（兼容新旧格式）
 */
export function resolveMemoryType(memory) {
    if (memory.cognitiveType && COGNITIVE_TYPES[memory.cognitiveType]) {
        return memory.cognitiveType;
    }
    const mapped = LEGACY_TYPE_MAP[memory.type];
    return mapped ? mapped.cognitiveType : 'fact';
}

// ═══════════════════════════════════════════════════════════
//  格式化注入（为 prompt 注入准备文本）
// ═══════════════════════════════════════════════════════════

/**
 * 将记忆列表按认知类型分组，格式化为注入文本。
 * 如果记忆包含 allowInjection 的 hiddenNotes，会附加在对应记忆行下方。
 */
export function formatMemoriesForInjection(memories, enabledTypes) {
    const grouped = {};
    let hasHiddenNotes = false;

    for (const memory of memories) {
        const cogType = resolveMemoryType(memory);
        if (enabledTypes && !enabledTypes[cogType]) continue;
        if (!grouped[cogType]) grouped[cogType] = [];
        grouped[cogType].push(memory);
        if (getInjectableNotes(memory).length) hasHiddenNotes = true;
    }

    const sections = [];
    const typeOrder = ['fact', 'episode', 'emotion', 'habit'];

    if (hasHiddenNotes) {
        sections.push('（标记为[隐]的信息仅供你塑造角色行为和推进剧情，绝不要在对话中直接透露。）');
    }

    for (const typeId of typeOrder) {
        const mems = grouped[typeId];
        if (!mems || !mems.length) continue;

        const typeDef = COGNITIVE_TYPES[typeId];
        const header = `== ${typeDef.label} ==`;
        const lines = mems.map((m, i) => {
            const mainLine = `${i + 1}. ${formatSingleMemory(m)}`;
            const notes = getInjectableNotes(m);
            if (!notes.length) return mainLine;
            const noteLines = notes.map(n => {
                const typeLabel = HIDDEN_NOTE_TYPES[n.type]?.label || '备注';
                return `   [隐·${typeLabel}] ${n.content}`;
            });
            return mainLine + '\n' + noteLines.join('\n');
        });

        sections.push(`${header}\n${lines.join('\n')}`);
    }

    return sections.join('\n\n');
}

/**
 * 从记忆条目中提取允许注入的 hiddenNotes
 */
function getInjectableNotes(memory) {
    if (!Array.isArray(memory.hiddenNotes)) return [];
    return memory.hiddenNotes.filter(n => n.allowInjection !== false);
}

/**
 * 格式化单条记忆为注入文本
 */
function formatSingleMemory(m) {
    const parts = [];

    if (m.title) parts.push(`[${m.title}]`);

    const catLabel = getCategoryLabel(m.categoryPath);
    if (catLabel) parts.push(`(${catLabel})`);

    // 非默认 truthStatus 时标记
    if (m.truthStatus && m.truthStatus !== 'true') {
        const ts = TRUTH_STATUS[m.truthStatus];
        if (ts) parts.push(`{${ts.label}}`);
    }

    parts.push(m.summary || m.content);

    if (m.verbatim) parts.push(`「${m.verbatim}」`);

    if (m.subject && m.target) {
        parts.push(`(${m.subject} → ${m.target})`);
    } else if (m.subject) {
        parts.push(`(${m.subject})`);
    }

    return parts.join(' ');
}

// ═══════════════════════════════════════════════════════════
//  内容自动分类（用于世界书导入等场景）
// ═══════════════════════════════════════════════════════════

/**
 * 根据内容推测旧版类型（保留兼容，世界书导入用）
 */
export function guessTypeFromContent(content, keywords = []) {
    const text = (content + ' ' + keywords.join(' ')).toLowerCase();

    if (/(?:角色|人物|名字|外貌|性格|npc|character)/.test(text)) return 'npc';
    if (/(?:物品|道具|武器|装备|药水|宝石|item|weapon|potion)/.test(text)) return 'item';
    if (/(?:地点|场所|城市|村庄|森林|洞穴|location|place|city)/.test(text)) return 'location';
    if (/(?:关系|感情|仇恨|友情|恋人|师徒|relation)/.test(text)) return 'relationship';
    if (/(?:第.+天|时间线|章节|时间|之前|之后|timeline|chapter|day\s*\d)/.test(text)) return 'timeline';

    return 'event';
}

/**
 * 根据内容推测认知类型和分类路径（新版推测）
 */
export function guessCognitiveInfo(content, keywords = []) {
    const text = (content + ' ' + keywords.join(' ')).toLowerCase();

    if (/(?:承诺|发誓|保证|约定|promise|swear|vow)/.test(text))
        return { cognitiveType: 'episode', categoryPath: 'episode.promise' };
    if (/(?:秘密|暗中|偷偷|不为人知|secret|hidden)/.test(text))
        return { cognitiveType: 'episode', categoryPath: 'episode.secret' };
    if (/(?:战斗|攻击|打|砍|施法|combat|fight|attack)/.test(text))
        return { cognitiveType: 'episode', categoryPath: 'episode.combat' };

    if (/(?:喜欢|讨厌|偏好|习惯|总是|从不|prefer|habit|always|never)/.test(text))
        return { cognitiveType: 'habit', categoryPath: 'habit.preference' };
    if (/(?:口头禅|说话方式|语气|口癖|catchphrase)/.test(text))
        return { cognitiveType: 'habit', categoryPath: 'habit.speech' };

    if (/(?:好感|敌意|情感|爱|恨|信任|背叛|love|hate|trust|betray)/.test(text))
        return { cognitiveType: 'emotion', categoryPath: 'emotion.bond' };
    if (/(?:创伤|恐惧|噩梦|阴影|trauma|fear|nightmare)/.test(text))
        return { cognitiveType: 'emotion', categoryPath: 'emotion.trauma' };

    if (/(?:角色|人物|名字|外貌|性格|身份|npc|character)/.test(text))
        return { cognitiveType: 'fact', categoryPath: 'npc.profile' };
    if (/(?:关系|与.+之间|relation)/.test(text))
        return { cognitiveType: 'fact', categoryPath: 'npc.relationship' };
    if (/(?:物品|道具|武器|装备|item|weapon)/.test(text))
        return { cognitiveType: 'fact', categoryPath: 'item.ownership' };
    if (/(?:地点|场所|城市|location|place)/.test(text))
        return { cognitiveType: 'fact', categoryPath: 'location.state' };
    if (/(?:政治|势力|阵营|王国|politics|faction)/.test(text))
        return { cognitiveType: 'fact', categoryPath: 'world.politics' };

    return { cognitiveType: 'episode', categoryPath: 'episode.event' };
}
