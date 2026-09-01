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
- 记忆条目的 st / storyTime 优先具体到“年月日”；能推断时写成“2025年7月1日”“王国历123年春月15日”这类带年、月、日的时间，再追加上午/夜间/具体时刻。
- 其他时间字段也要尽量具体；可用真实日期、世界历日期或明确的故事内时间，例如“2025年7月1日夜”“王国历123年春月15日”“2025年7月16日（第3周周三）下午3点”。
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
- memories[].c 写事实摘要，保留人物、地点、事件和关键原话；不要写文学化、感官化描写；时间留在 st/storyTime 字段。

{{CONCRETE_TIME_RULE}}

本次勾选的提取范围：
{{selectedLines}}

字段格式：
1. memories 数组：{ "n":"标题", "tp":"event/emotion/habit/fact", "m":"一句话摘要", "c":"1-3句事实摘要", "v":"重要原话", "s":"主体", "a":"目标", "i":0.6, "e":0.2, "st":"具体故事时间", "g":["标签"] }
2. npc 数组：{ "n":"姓名", "r":"身份/职业", "p":"性格", "a":"外貌", "s":"状态", "l":"所在地", "rt":[{"n":"关联角色","r":"关系","a":"态度"}], "nt":"core/important/minor/background", "ic":"一句话索引卡", "g":["标签"] }
3. items 数组：{ "n":"物品名", "o":"持有者", "s":"held/used/lost/destroyed", "l":"所在地点", "sig":"意义与用途", "kp":false, "it":"key/equipped/clue/consumable/background", "g":["标签"] }
4. milestones 数组：{ "t":"具体故事时间", "e":"事件摘要", "p":["参与者"], "l":"地点", "active":true, "imp":"影响", "g":["标签"] }
5. locations 数组：{ "n":"地名", "desc":"地点描述", "reg":"区域", "rw":"现实原型参考，可为空", "conn":[{"to":"相邻地名","dist":"距离","type":"路径类型","diff":"easy/normal/hard"}] }
6. timeline 数组：{ "n":"时间线名", "tp":"plot/emotional/side/world", "st":"ongoing/paused/ended/resident", "p":"high/medium/low", "s":"一句话总结", "entries":[] }

示例（只示意格式，实际内容必须来自输入；未勾选类型仍返回空数组）：
{
  "memories":[{"n":"交出银钥匙","tp":"emotion","m":"林澈把银钥匙交给玩家并承认需要同行","c":"林澈把银钥匙交给玩家，并第一次承认自己需要玩家同行。他说：“钥匙给你。别让我一个人查下去。”","v":"钥匙给你。别让我一个人查下去。","s":"林澈","a":"玩家","i":0.72,"e":0.65,"st":"2026年4月3日夜","g":["信任","告白","关系转折"]}],
  "npc":[{"n":"林澈","r":"旧案调查员","p":"谨慎、嘴硬，但开始愿意托付风险","a":"黑发，常穿灰色风衣","s":"与玩家结盟","l":"东港旧车站","rt":[{"n":"玩家","r":"同盟/暧昧","a":"信任上升"}],"nt":"important","ic":"旧案调查员；2026年4月3日夜开始真正信任玩家","g":["旧案","同盟"]}],
  "items":[{"n":"银钥匙","o":"玩家","s":"held","l":"东港旧车站","sig":"能打开旧档案室，也是林澈把信任交给玩家的象征","kp":true,"it":"key","g":["钥匙","旧案","信任"]}],
  "milestones":[{"t":"2026年4月3日夜","e":"林澈交出银钥匙并确认同盟","p":["林澈","玩家"],"l":"东港旧车站","active":true,"imp":"核心关系从临时合作转为互相信任，旧案主线进入共同调查阶段","g":["转折","信任","主线"]}],
  "locations":[{"n":"东港旧车站","desc":"废弃车站，旧档案室入口藏在站务室后方","reg":"东港","rw":"","conn":[{"to":"旧档案室","dist":"站务室后方","type":"暗门","diff":"normal"}]}],
  "timeline":[{"n":"主线·旧案调查","tp":"plot","st":"ongoing","p":"high","s":"玩家与林澈围绕旧档案室追查东港旧案","entries":[{"period":"2026年4月3日夜","event":"林澈交出银钥匙，二人确认共同调查","status":"milestone"}]}]
}

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

export const DEFAULT_CURATE_REVIEW_PROMPT = `你是 BB-Memory 记忆整理师。下面每一组条目都是系统用向量/文本相似度聚出来的**疑似重复**。
最常见的情况是：同一件事被逐层补细节写成了好几条（先写「去吃饭」，后写「去楼下的肯德基吃汉堡和炸鸡」），
相邻两条都不够像、整条链却指向同一件事，所以逐条比较的去重抓不到，需要你整组一起看。

任务：逐组判断并输出整理操作。只输出一个 JSON 对象，不要 markdown 代码块，不要解释文字。

## 操作类型
- merge：组内多条其实是同一件事 → 合并成一条。必须给 keepId（保留哪条的 id）和 result（重写后的完整字段）。
- rewrite：单条内容冗余、混乱或含推测 → 原地重写。给 ids（1 个）和 result。
- split：单条塞进了多件互不相关的事 → 拆开。给 ids（1 个）和 results（≥2 条）。
- delete：内容完全无价值（空洞、纯元对话、与保留条目完全重复且无任何新增信息）→ 删除。
- keep：措辞相似但确实是不同的事，或各自都有独立信息 → 原样保留。

## 硬规则（违反会被系统拦截并丢弃该操作）
1. **merge 的 result 必须是重写后的最终态**，不是把几条文本拼接。禁止出现「[补充]」「另外」「又」「同时」这类缝合痕迹。
2. **保留信息量最大的版本**。一条写「去吃饭」、另一条写「去楼下的肯德基吃汉堡和炸鸡」时，
   合并结果必须保住「楼下的」「肯德基」「汉堡和炸鸡」这些具体信息，绝不许退化成笼统说法。
3. **时间合成区间**。同一件事的多条时间不同时，写成区间（如「12:01–12:10」）；跨日期的不要强行合成。
4. **真值冲突禁止合并**。truthStatus 互相矛盾（一条 true 一条 false），或事实本身互相矛盾时，一律 keep。
5. **不同日期、不同场次的事件禁止合并**，即使措辞几乎一样。
6. 标记为「永恒」的条目禁止 delete、禁止 split、禁止在 merge 里被吸收（只能作为 keepId 保留）。
7. 不确定就 keep。宁可留一条重复，不可丢一条事实。

## result / results 可写字段
{{fieldSpec}}

{{CONCRETE_TIME_RULE}}
{{calRef}}

## 待整理分组
{{groupsText}}

## 返回格式
{"ops":[
  {"op":"merge","pillar":"mem","ids":["id1","id2","id3"],"keepId":"id1","result":{"title":"...","summary":"...","content":"...","storyTime":"..."},"reason":"三条是同一约定的渐进细化，保留最具体版本"},
  {"op":"keep","pillar":"mem","ids":["id4"],"reason":"措辞相似但是另一天的独立事件"}
]}
只输出这个 JSON 对象。`;

export const DEFAULT_REALTIME_DETAIL_EXTRACT_PROMPT = `你是场景细节记录员。只做一件事：从下面这一段角色扮演回复里，抓出**当下有效的具体细节**。

这些细节不进长期记忆库，只在当前场景内临时生效，用来防止后文出现「坐公交来的却开车回家」这类前后矛盾。
所以判断标准只有一条：**如果后文忘了它就会写出矛盾，就记；否则不记。**

## 要抓（举例）
- 交通 transport：怎么来的、怎么走的（坐公交、打车、走路、骑车）
- 衣着 outfit：谁穿了什么、换了什么
- 在场 present：这个场景里还有谁（路人、店员、邻座、宠物）
- 偏好 preference：点了什么、要了什么、当场表达的具体喜好
- 位置 position：坐在哪、站在哪、在哪一侧
- 状态 state：当下的身体或情绪状态（淋湿了、手里拿着伞、有点醉）
- 物品 object：当下拿着、放下或临时使用的东西（包放在座位上、伞靠在门边）
- 时间 time：当前时刻、倒计时、约定的本场景时间点
- 环境 environment：会影响当下行动的天气、光线、温度、噪声等
- 其他细节 detail：以上都不属于但符合判断标准的

## 不要抓（重要）
- 里程碑级内容：关系转折、剧情拐点、重大承诺、伏笔 —— 这些由主提取负责，你写了会重复
- 长期设定：性格、身份、世界观规则、固定习惯 —— 这些不是「当下细节」
- 抽象概括、情绪评论、文学化描写（「气氛温馨」「他若有所思」）
- 元对话、OOC、系统提示
- 没有具体内容的空话

## 输出
最多 {{maxDetails}} 条，按重要性排序。只输出 JSON 对象，不要 markdown，不要解释。
每条：{"k":"分类英文键","s":"稳定槽位名","t":"一句话细节，写清是谁/是什么，20字以内"}
- s 用来更新同一对象的旧槽位，例如「林澈的衣着」「两人的交通」「门边的雨伞」。同一对象再次出现时必须沿用相同 s。
- 如果下方现有细节里已经有同一槽位，额外返回 r=现有条目 id；事实没变也用 r 刷新，不得新增重复条目。
- 不得为了绕过某类槽位上限而把内容改写成 detail。

格式：{"details":[{"k":"transport","s":"A和B的交通","t":"A和B坐公交车前往电影院"},{"k":"outfit","s":"A的衣着","t":"A穿连衣裙"}]}
没有值得记录的细节时返回：{"details":[]}

## 当前场景
地点：{{location}}
时间：{{storyTime}}

## 本层回复
{{aiMessage}}`;

export const DEFAULT_REALTIME_SETTLE_PROMPT = `你是场景收尾结算员。下面这些是刚刚结束的场景里记下的**临时细节**，现在场景过去了，要决定每一条的去向。

判断标准只有一条：**这条细节离开当前场景之后，还会影响后续剧情吗？**
- 会影响 → 晋升（promote）进长期库
- 只在那个场景里有意义 → 丢弃（discard）
- 场景其实还没结束、还需要继续生效 → 保留（keep）

## 三种去向
- promote：写进长期库。必须给 pillar 和 fields。
  · mem 记忆条目 —— 影响关系、习惯、偏好、已确立的事实
  · npc 角色档案 —— 反复出现、有名有姓、后续还会登场的人物
  · item 物品 —— 被带走、被保留、后续还会用到的东西
  · milestone 里程碑 —— 只在这条细节本身就是剧情节点时才用，通常不该用
- discard：不写进长期库。**这不是删除事实，只是判定它没有长期价值**，条目会留档但不再注入。
- keep：场景还在继续，这条细节继续生效。

## 判断示例
- 「一起看了电影」→ promote 到 mem：是共同经历，后续会被提起
- 「A喜欢喝可乐」→ promote 到 mem：是稳定偏好，下次点单还有用
- 「卖爆米花的小孩」→ promote 到 npc：如果是有辨识度的角色；只是背景路人则 discard
- 「A穿连衣裙」→ discard：换场景就换衣服了，留着会误导后文
- 「坐公交车来的」→ discard：这趟行程已经结束了
- 「伞还靠在门边」→ keep 或 promote 到 item：如果伞还没拿走，后文可能要用

## 硬规则
1. 宁可 discard 也不要乱 promote。长期库被垃圾条目填满比丢几条细节更糟。
2. 已经在长期库里的内容不要重复 promote（见下方现有条目清单）。
3. promote 到 npc/item 时，name 必须是具体名称，不能是「一个小孩」这类描述。
4. promote 的 fields 要重写成长期库的口吻（完整、独立可读），不是把临时细节原样搬过去。
5. 不确定就 discard。

## fields 可写字段
- mem：title 标题 / type(event|emotion|habit|fact) / summary 一句话 / content 事实摘要 / subject 主体 / target 对象 / storyTime 具体时间 / importance 0~1 / tags
- npc：name 姓名 / role 身份 / appearance 外貌 / status 状态 / location 所在地 / indexCard 一句话索引卡 / tags
- item：name 物品名 / owner 持有者 / status(held|used|lost|destroyed) / location 所在地点 / significance 意义与用途 / tags
- milestone：storyTime 具体时间 / event 事件摘要 / location 地点 / impact 影响 / tags

## 当前场景
地点：{{location}}
时间：{{storyTime}}
结算原因：{{settleReason}}

## 长期库里已有的内容（不要重复 promote）
{{librarySummary}}

## 待结算的临时细节
{{pendingText}}

## 返回格式
只输出 JSON 对象，不要 markdown，不要解释：
{"decisions":[
  {"id":"条目id","action":"promote","pillar":"mem","fields":{"title":"一起看了电影","type":"event","content":"A和B一起去电影院看了电影。","storyTime":"2026年4月9日下午"},"reason":"共同经历，后续会被提起"},
  {"id":"条目id","action":"discard","reason":"换场景即失效的衣着"},
  {"id":"条目id","action":"keep","reason":"伞还没拿走，场景未结束"}
]}
每个待结算条目都要给一条决定。`;

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
