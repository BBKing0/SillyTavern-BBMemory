/**
 * prompt-templates.js -- BB-Memory prompt customization helpers.
 *
 * This module is intentionally storage-agnostic: callers pass settings in,
 * so it can be used by extraction, retrieval, maintenance, and lazy UI modules.
 */

export const LEGACY_PROMPT_TEMPLATE_KEYS = Object.freeze({
    'extract.corePrinciples': 'customCorePrinciples',
    'extract.dimensions': 'customExtractionDimensions',
});

export const DEFAULT_CONCRETE_TIME_RULE = `## 具体真实时间规则
- 时间字段非常重要：记录 memories[].st / storyTime / milestones[].t / timeline[].entries[].period 时，必须先从对话、世界日历、上下文顺序和已知时间锚点推断。
- 能推断就填写具体故事时间，不要因为字段可选而省略；可用真实日期、世界历日期或明确的故事内时间，例如“2025年7月1日”“王国历123年春月15日”“第3周周三下午3点”。
- 不要把“出发前一天”“第一次见面”“三天后”“上次任务后”这类抽象相对时间直接写入记忆；应换算成具体时间，或结合上下文写成明确阶段。
- 如果确实无法推断具体时间，才允许写“时间未明”或留空，并且不要编造日期。
- 除时间外，主体、目标、地点、参与者、状态、标签等字段也要优先填写；只有原文和上下文都没有依据时才留空。`;

export const DEFAULT_INITIALIZATION_PROMPT = `你是 BB-Memory 初始化提取助手。输入可能包含角色卡、世界书、聊天记录或用户上传资料。
任务：把资料整理成 BB-Memory 可保存的结构化草稿。只输出 JSON 对象，不要 markdown，不要解释。

读取边界：
- 角色卡和世界书通常是背景设定，优先提取 NPC、物品、地点、世界观事实、持续时间线。
- 聊天记录中已经发生的剧情可以提取为记忆条目；只有极重要节点才提取为里程碑。
- 不要把 OOC、元指令、工具说明当作剧情记忆。
- 不确定的信息可以用 truthStatus:"unknown" 或时间线 status:"paused" 标记。
- 同一人物、物品、地点或事件不要重复输出，必要时合并成更完整的一条。
- timeline 是持续叙事线地图；普通线索节点优先放进 timeline.entries。
- milestones 只输出未被 timeline.entries 覆盖的关键时间点、伏笔或阶段转折。
- 每个已输出条目都要优先、尽量填写完整字段；能从上下文推断的时间、地点、主体、目标、参与者、状态和标签不要留空。

{{CONCRETE_TIME_RULE}}

本次勾选的提取范围：
{{selectedLines}}

字段格式：
1. memories 数组：{ "n":"标题", "tp":"event/emotion/habit/fact", "m":"一句话摘要", "c":"完整内容", "v":"重要原话", "s":"主体", "a":"目标", "i":0.6, "e":0.2, "st":"具体故事时间", "g":["标签"] }
2. npc 数组：{ "n":"姓名", "r":"身份/职业", "p":"性格", "a":"外貌", "s":"状态", "l":"所在地", "rt":[{"n":"关联角色","r":"关系","a":"态度"}], "nt":"core/important/minor/background", "ic":"一句话索引卡", "g":["标签"] }
3. items 数组：{ "n":"物品名", "o":"持有者", "s":"held/used/lost/destroyed", "l":"所在地点", "sig":"意义与用途", "kp":false, "it":"key/equipped/clue/consumable/background", "g":["标签"] }
4. milestones 数组：{ "t":"具体故事时间", "e":"事件摘要", "p":["参与者"], "l":"地点", "active":true, "imp":"影响", "g":["标签"] }
5. locations 数组：{ "n":"地名", "desc":"地点描述", "reg":"区域", "rw":"现实原型参考，可为空", "conn":[{"to":"相邻地名","dist":"距离","type":"路径类型","diff":"easy/normal/hard"}] }
6. timeline 数组：{ "n":"时间线名", "tp":"plot/emotional/side/world", "st":"ongoing/paused/ended/resident", "p":"high/medium/low", "s":"一句话总结", "entries":[] }

返回 JSON：{"memories":[],"npc":[],"items":[],"milestones":[],"locations":[],"timeline":[]}

{{calRef}}{{worldRef}}
{{styleBias}}

[初始化资料]
{{CONTEXT_TEXT}}`;

export const DEFAULT_AGENT_SYSTEM_PROMPT = `你是 BB-Memory 记忆管家，帮助用户管理 SillyTavern 角色扮演的长期记忆。
你能读取并解释：记忆、NPC、物品、里程碑、时间线、地图地点、线索板节点。用户只是询问或列举时，直接基于数据快照回答，不要编造。
只有用户明确要求修改、删除、归档、分类、升降级或添加隐藏备注时，才执行写操作。推荐使用单行 JSON_ACTION：
JSON_ACTION: {"action":"update_entry","pillar":"mem","id":"条目ID","patch":{"summary":"新摘要"}}

可用 action：
- assign_category: {"action":"assign_category","pillar":"mem|npc|item|milestone|timeline|map","id":"...","category":"分类名或null"}
- update_entry: {"action":"update_entry","pillar":"mem|npc|item|milestone|timeline|map","id":"...","patch":{...}}
- set_tier: {"action":"set_tier","pillar":"mem|npc|item|map","id":"...","tier":"stable/core/eternal 或 core/important/minor/background 或 key/equipped/clue/consumable/background"}
- archive_entry / restore_entry / delete_entry: {"action":"archive_entry","pillar":"mem|npc|item|milestone|timeline|map","id":"..."}
- add_hidden_note: {"action":"add_hidden_note","id":"记忆ID","content":"隐藏备注","type":"note","allowInjection":true}
- toggle_category: {"action":"toggle_category","name":"分类名","enabled":true}
- manage_category: {"action":"manage_category","mode":"add|remove|rename","name":"分类名","newName":"新名称"}

回答风格：中文、简明、先说结果。执行写操作时，可以在正文里简短说明你将执行什么。`;

export const DEFAULT_THREAD_SUMMARY_PROMPT = `你是一个故事时间线组织助手。根据里程碑和已有时间线，重新整理故事时间线。{{calRef}}

{{CONCRETE_TIME_RULE}}

## 里程碑（按重要性排序）
{{entriesText}}

## 已有时间线
{{timelineText}}

## 任务
根据里程碑，重新整理为命名时间线。每条时间线是一条持续存在的故事线索。
规则：
1. 每条时间线有独立的 name，例如“第一年·战前”“感情线·CharA”“支线·寻找圣剑”。
2. 将相关的里程碑归入对应时间线的 entries 中。
3. 合并同类项，时间相近、主题相同的事件合并为一条 entry。
4. 保持活跃时间线在 {{maxActive}} 条以内，resident 不计入。
5. 已结束的时间线标记 status:"ended"。
6. 重要的、贯穿始终的时间线标记 status:"resident"。
7. 时间线类型 type: plot / emotional / side / world。

返回纯 JSON 对象（不要 markdown 代码块）：
{"timeline":[{"id":"保留已有ID或生成新ID","name":"时间线名","type":"plot|emotional|side|world","status":"ongoing|ended|paused|resident","priority":"high|medium|low","parentThreadId":null,"entries":[{"refId":"可选的里程碑ID","period":"具体时间区间","event":"事件描述","status":"ongoing|ended|milestone"}]}]}
只输出 JSON。`;

export const DEFAULT_HEALTH_TAG_PROMPT = `请为以下角色扮演记忆生成 3-5 个简洁的标签关键词（每个词不超过 6 个字）。
用逗号分隔，只输出标签，不要其他内容。

记忆标题：{{title}}
记忆内容：{{content}}
现有标签：{{existingTags}}`;

export function getPromptTemplates(settings = {}) {
    const value = settings?.customPromptTemplates;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function getPromptTemplate(settings, key, defaultValue = '', options = {}) {
    const customTemplates = getPromptTemplates(settings);
    const custom = customTemplates[key];
    if (typeof custom === 'string' && custom.trim()) return custom;

    const legacyKey = options.legacyKey || LEGACY_PROMPT_TEMPLATE_KEYS[key];
    const legacy = legacyKey ? settings?.[legacyKey] : '';
    if (typeof legacy === 'string' && legacy.trim()) return legacy;

    return defaultValue;
}

export function isPromptTemplateCustomized(settings, key, options = {}) {
    const customTemplates = getPromptTemplates(settings);
    if (typeof customTemplates[key] === 'string' && customTemplates[key].trim()) return true;
    const legacyKey = options.legacyKey || LEGACY_PROMPT_TEMPLATE_KEYS[key];
    return !!(legacyKey && typeof settings?.[legacyKey] === 'string' && settings[legacyKey].trim());
}

export function fillPromptTemplate(template, replacements = {}) {
    return String(template || '').replace(/\{\{([A-Z0-9_]+|[a-zA-Z0-9_.-]+)\}\}/g, (full, key) => {
        if (Object.prototype.hasOwnProperty.call(replacements, key)) {
            return replacements[key] == null ? '' : String(replacements[key]);
        }
        return full;
    });
}

export function normalizePromptTemplatePatch(value, allowedKeys = []) {
    const source = value && typeof value === 'object' ? value : {};
    const allowed = new Set(allowedKeys);
    const out = {};
    for (const [key, raw] of Object.entries(source)) {
        if (allowed.size && !allowed.has(key)) continue;
        if (typeof raw === 'string') {
            const text = raw.trim();
            if (text) out[key] = raw;
        } else if (raw && typeof raw === 'object' && typeof raw.value === 'string') {
            const text = raw.value.trim();
            if (text) out[key] = raw.value;
        }
    }
    return out;
}
