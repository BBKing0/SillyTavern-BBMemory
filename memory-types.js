/**
 * memory-types.js —— BB-Memory 的"分类卡片"
 *
 * ═══════════════════════════════════════════════════════════
 *  代码小课堂
 * ═══════════════════════════════════════════════════════════
 *
 * 这个文件是什么？
 *   就像图书馆把书分成小说、历史、科技等类别一样，
 *   这个文件定义了记忆的不同"类型"，每种类型有自己的专属信息。
 *
 * 用了哪些编程概念？
 *   - Object（对象）：用花括号 {} 定义一组有名字的属性
 *   - 常量定义：用 const 创建不会变的值
 *   - export：让其他文件能引用这些定义
 *
 * 6种记忆类型：
 *   1. event    — 事件：故事中发生的事情
 *   2. timeline — 时间线：标记故事进度的时间节点
 *   3. item     — 物品：角色持有或提到的道具
 *   4. npc      — NPC：出现的人物
 *   5. location — 地点：故事中的场景
 *   6. relationship — 关系：人物之间的关系
 *
 * ═══════════════════════════════════════════════════════════
 */

// ═══ 记忆类型定义 ═══

export const MEMORY_TYPES = Object.freeze({
    event: {
        id: 'event',
        label: '事件',
        icon: 'fa-solid fa-bolt',
        color: '#4fc3f7',
        description: '故事中发生的重要事件',
        defaultMetadata: () => ({
            participants: [],
            location: '',
        }),
        metadataFields: [
            { key: 'participants', label: '参与者', type: 'tags', placeholder: '输入人物名后回车' },
            { key: 'location', label: '发生地点', type: 'text', placeholder: '事件发生的地点' },
        ],
        formatForInjection: (memory) => {
            const parts = [memory.content];
            if (memory.metadata?.location) {
                parts.push(`(地点: ${memory.metadata.location})`);
            }
            return parts.join(' ');
        },
    },

    timeline: {
        id: 'timeline',
        label: '时间线',
        icon: 'fa-solid fa-clock-rotate-left',
        color: '#ba68c8',
        description: '故事时间轴上的关键节点',
        defaultMetadata: () => ({
            storyDay: 1,
            chapter: '',
            sequenceOrder: 0,
        }),
        metadataFields: [
            { key: 'storyDay', label: '故事第几天', type: 'number', placeholder: '1' },
            { key: 'chapter', label: '章节/阶段', type: 'text', placeholder: '例如: 第一章' },
            { key: 'sequenceOrder', label: '排序序号', type: 'number', placeholder: '0' },
        ],
        formatForInjection: (memory) => {
            const meta = memory.metadata || {};
            const prefix = meta.storyDay ? `[第${meta.storyDay}天]` : '';
            const chapter = meta.chapter ? `(${meta.chapter})` : '';
            return `${prefix}${chapter} ${memory.content}`.trim();
        },
    },

    item: {
        id: 'item',
        label: '物品',
        icon: 'fa-solid fa-box-open',
        color: '#ffb74d',
        description: '角色持有或提到的物品/道具',
        defaultMetadata: () => ({
            owner: '',
            quantity: 1,
            status: 'active',
        }),
        metadataFields: [
            { key: 'owner', label: '持有者', type: 'text', placeholder: '谁拥有这个物品' },
            { key: 'quantity', label: '数量', type: 'number', placeholder: '1' },
            { key: 'status', label: '状态', type: 'select', options: [
                { value: 'active', label: '持有中' },
                { value: 'lost', label: '已丢失' },
                { value: 'consumed', label: '已消耗' },
                { value: 'given', label: '已赠出' },
            ]},
        ],
        formatForInjection: (memory) => {
            const meta = memory.metadata || {};
            const qty = meta.quantity > 1 ? ` x${meta.quantity}` : '';
            const status = meta.status && meta.status !== 'active' ? ` [${meta.status}]` : '';
            const owner = meta.owner ? ` (${meta.owner}持有)` : '';
            return `${memory.content}${qty}${status}${owner}`;
        },
    },

    npc: {
        id: 'npc',
        label: 'NPC',
        icon: 'fa-solid fa-user-group',
        color: '#81c784',
        description: '故事中出现的人物信息',
        defaultMetadata: () => ({
            npcName: '',
            role: '',
            relationship: '',
            attitude: '',
        }),
        metadataFields: [
            { key: 'npcName', label: 'NPC名字', type: 'text', placeholder: '人物名称' },
            { key: 'role', label: '身份/职业', type: 'text', placeholder: '例如: 旅店老板' },
            { key: 'relationship', label: '与主角关系', type: 'text', placeholder: '例如: 朋友、敌人' },
            { key: 'attitude', label: '态度', type: 'select', options: [
                { value: 'friendly', label: '友好' },
                { value: 'neutral', label: '中立' },
                { value: 'hostile', label: '敌对' },
                { value: 'romantic', label: '暧昧' },
                { value: 'unknown', label: '未知' },
            ]},
        ],
        formatForInjection: (memory) => {
            const meta = memory.metadata || {};
            const name = meta.npcName || '未知人物';
            const role = meta.role ? `(${meta.role})` : '';
            const rel = meta.relationship ? ` - ${meta.relationship}` : '';
            return `${name}${role}${rel}: ${memory.content}`;
        },
    },

    location: {
        id: 'location',
        label: '地点',
        icon: 'fa-solid fa-map-location-dot',
        color: '#e57373',
        description: '故事中的场景/地点',
        defaultMetadata: () => ({
            locationName: '',
            description: '',
            visited: true,
        }),
        metadataFields: [
            { key: 'locationName', label: '地点名称', type: 'text', placeholder: '场景名' },
            { key: 'description', label: '简短描述', type: 'text', placeholder: '这个地方的特征' },
            { key: 'visited', label: '是否到访过', type: 'checkbox' },
        ],
        formatForInjection: (memory) => {
            const meta = memory.metadata || {};
            const name = meta.locationName || '未知地点';
            const visited = meta.visited ? '' : ' [未到访]';
            return `${name}${visited}: ${memory.content}`;
        },
    },

    relationship: {
        id: 'relationship',
        label: '关系',
        icon: 'fa-solid fa-heart',
        color: '#f06292',
        description: '人物之间的关系',
        defaultMetadata: () => ({
            person1: '',
            person2: '',
            relationType: '',
        }),
        metadataFields: [
            { key: 'person1', label: '人物1', type: 'text', placeholder: '人物A' },
            { key: 'person2', label: '人物2', type: 'text', placeholder: '人物B' },
            { key: 'relationType', label: '关系类型', type: 'text', placeholder: '例如: 恋人、师徒、仇敌' },
        ],
        formatForInjection: (memory) => {
            const meta = memory.metadata || {};
            const p1 = meta.person1 || '?';
            const p2 = meta.person2 || '?';
            const rel = meta.relationType ? `[${meta.relationType}]` : '';
            return `${p1} ↔ ${p2} ${rel}: ${memory.content}`;
        },
    },
});

// ═══ 工具函数 ═══

/**
 * 获取所有类型ID列表
 */
export function getTypeIds() {
    return Object.keys(MEMORY_TYPES);
}

/**
 * 获取类型定义
 */
export function getTypeDefinition(typeId) {
    return MEMORY_TYPES[typeId] || MEMORY_TYPES.event;
}

/**
 * 获取类型的默认元数据
 */
export function getDefaultMetadata(typeId) {
    const typeDef = getTypeDefinition(typeId);
    return typeDef.defaultMetadata();
}

/**
 * 按类型分组记忆，用于注入 prompt
 * 返回格式化好的文本，每种类型一个区块
 */
export function formatMemoriesForInjection(memories, enabledTypes) {
    const grouped = {};

    for (const memory of memories) {
        const type = memory.type || 'event';
        if (enabledTypes && !enabledTypes[type]) continue;
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push(memory);
    }

    const sections = [];

    // 按固定顺序输出各类型
    const typeOrder = ['event', 'timeline', 'npc', 'item', 'location', 'relationship'];

    for (const typeId of typeOrder) {
        const mems = grouped[typeId];
        if (!mems || !mems.length) continue;

        const typeDef = getTypeDefinition(typeId);
        const header = `== ${typeDef.label} ==`;
        const lines = mems.map((m, i) => {
            const formatted = typeDef.formatForInjection(m);
            return typeId === 'event' || typeId === 'timeline'
                ? `${i + 1}. ${formatted}`
                : `- ${formatted}`;
        });

        sections.push(`${header}\n${lines.join('\n')}`);
    }

    return sections.join('\n\n');
}

/**
 * 根据内容自动推测记忆类型（用于世界书导入等场景）
 */
export function guessTypeFromContent(content, keywords = []) {
    const text = (content + ' ' + keywords.join(' ')).toLowerCase();

    // NPC 特征词
    if (/(?:角色|人物|名字|外貌|性格|npc|character)/.test(text)) return 'npc';
    // 物品特征词
    if (/(?:物品|道具|武器|装备|药水|宝石|item|weapon|potion)/.test(text)) return 'item';
    // 地点特征词
    if (/(?:地点|场所|城市|村庄|森林|洞穴|location|place|city)/.test(text)) return 'location';
    // 关系特征词
    if (/(?:关系|感情|仇恨|友情|恋人|师徒|relation)/.test(text)) return 'relationship';
    // 时间线特征词
    if (/(?:第.+天|时间线|章节|时间|之前|之后|timeline|chapter|day\s*\d)/.test(text)) return 'timeline';

    return 'event';
}
