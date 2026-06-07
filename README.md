# BB-Memory — SillyTavern 智能长期记忆扩展

让你的 AI 角色真正"记住"故事中的关键信息——事件、NPC、物品、地点和角色关系。

## 功能概览

### 核心功能
- **智能记忆检索** — 发送消息时自动从记忆库中找出相关内容注入到 prompt
- **AI 自动生成** — AI 回复后自动提取值得记忆的信息（副 API 方案）
- **多类型记忆** — 事件、时间线、物品栏、NPC、地点、关系，各有专属格式
- **向量化标签** — 每条记忆带有权重标签，提高检索精度
- **记忆衰减** — 模拟人脑遗忘曲线，不重要的记忆逐渐变淡
- **记忆强化** — 被检索到的记忆会变得更牢固（越回忆越深刻）

### 管理功能
- **记忆管家** — 悬浮窗助手，提供仪表盘、分类浏览、健康分析、批量操作
- **世界书导入** — 上传已有世界书 JSON，一键转换为向量化记忆
- **手动管理** — 添加、编辑、删除、搜索记忆
- **导入/导出** — JSON 格式备份和恢复
- **斜杠命令** — 在聊天框直接 `/memory add/search/count/clear`

---

## 安装方法

### 方法一：通过 SillyTavern 安装（推荐）

1. 打开 SillyTavern
2. 进入 **扩展** → **安装扩展**
3. 输入本仓库的 Git URL
4. 点击安装

### 方法二：手动安装

1. 将本仓库解压/克隆到酒馆前端扩展目录（与[官方文档](https://docs.sillytavern.app/for-contributors/writing-extensions)一致）：
   ```
   <SillyTavern>/public/scripts/extensions/third-party/
   ```
2. **文件夹名称**应与解压后的目录一致（例如 `BB-Memory`）。程序会通过 SillyTavern 内置的 `findExtension('BB-Memory')` 解析真实路径，用于加载 `settings.html`；请勿随意改名除非你清楚自己在改挂载路径。
3. 完全重启 SillyTavern（刷新页面或重启 Node 服务）。

### SillyTavern 兼容性说明（重要）

本扩展面向官方「UI 扩展」模型编写（`manifest.json` + `generate_interceptor` + `renderExtensionTemplateAsync`）。若你在酒馆里**看不到设置面板**或**命令列表里没有 `/memory`**，通常是下列原因之一：

| 现象 | 常见原因 |
|------|-----------|
| 扩展设置区没有 BB-Memory | `renderExtensionTemplateAsync` 的第一个参数必须是当前安装目录的内部键（如 `third-party/BB-Memory`）。v2.6.1 起已改为优先使用官方 `findExtension` 解析，并会对 `#extensions_settings` / `#extensions_settings2` 做短暂重试挂载。 |
| 酒馆版本过旧 | 请尽量使用 [SillyTavern 发行版](https://github.com/SillyTavern/SillyTavern/releases) 的最新稳定版；过旧内核可能没有 `SlashCommandParser`、`POPUP_RESULT` 等接口。 |
| 扩展被禁用 | **扩展** 菜单中确认 BB-Memory 已勾选启用。 |

---

## 使用指南

### 基本使用

1. **启用扩展** — 在 SillyTavern 侧边栏找到 "BB-Memory v2"，确保开关已开启
2. **添加记忆** — 点击"添加记忆"按钮，输入内容
3. **管理记忆** — 点击"管理记忆"按钮，打开记忆管理面板
4. **正常聊天** — 发送消息时，扩展会自动检索相关记忆并注入上下文

### AI 自动生成记忆

1. 在设置面板启用"AI 自动提取记忆"
2. 选择 API 模式：
   - **主 API（推荐）**：使用当前已配置的 AI 接口
   - **自定义 API**：填写第三方 OpenAI 兼容接口
3. AI 每次回复后，会自动分析并记录重要信息

### 记忆管家（悬浮窗）

通过侧边栏的"管理记忆"按钮打开，提供：
- **仪表盘** — 记忆总量、类型分布、强度统计
- **浏览** — 按类型分类查看，支持搜索
- **健康** — 检测弱记忆、疑似重复、老旧记忆
- **批量** — 多选删除、选择弱记忆快速清理

### 世界书导入

1. 点击侧边栏的"导入世界书"按钮
2. 选择 SillyTavern 世界书 JSON 文件
3. 系统自动解析条目，根据内容智能分类
4. 导入完成后即可在记忆管理中查看

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/memory add <内容>` | 快速添加一条事件记忆 |
| `/memory search <关键词>` | 搜索相关记忆 |
| `/memory count` | 查看记忆统计 |
| `/memory clear` | 清空当前聊天所有记忆 |

---

## 设置说明

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 注入深度 | 记忆插入到聊天历史中的位置（0=最末尾） | 4 |
| 最大检索数 | 每次生成时最多检索多少条相关记忆 | 10 |
| Token 预算 | 注入记忆的最大 token 数，防止上下文溢出 | 800 |
| 注入模板 | 控制记忆注入格式，`{{memories}}` 为占位符 | `[角色长期记忆]\n{{memories}}` |
| AI 自动生成 | 是否自动从 AI 回复中提取记忆 | 关闭 |
| API 模式 | 使用主 API 还是自定义端点 | 主 API |
| 记忆衰减 | 是否启用遗忘曲线 | 开启 |
| 衰减速率 | 每次衰减减少的强度值 | 0.05 |

---

## 认知类型说明（v2.2）

| 认知类型 | 图标 | 说明 | 典型分类路径 |
|----------|------|------|-------------|
| 事实 fact | 📖 | 确定的信息 | `npc.profile` `item.ownership` `location.state` `world.politics` |
| 情景 episode | 🎬 | 发生的事件 | `episode.event` `episode.promise` `episode.secret` `episode.combat` |
| 情感 emotion | ❤️ | 情感状态 | `emotion.bond` `emotion.trauma` `npc.attitude` |
| 习惯 habit | 🔄 | 行为模式 | `habit.routine` `habit.preference` `habit.speech` |

### 记忆字段一览

| 字段 | 类型 | 说明 |
|------|------|------|
| `cognitiveType` | string | 认知类型：fact/episode/emotion/habit |
| `categoryPath` | string | 分类路径，如 `npc.relationship` |
| `title` | string | 简短标题 |
| `content` | string | 完整原始内容 |
| `summary` | string | 一句话摘要 |
| `verbatim` | string | 重要原话（承诺、告白等） |
| `hiddenNotes` | array | 隐藏备注（AI 可见，用户默认不可见） |
| `subject` / `target` | string | 主体/对象 |
| `truthStatus` | string | 可信度：true/false/unknown/rumor/misleading/secret_true |
| `pinned` | boolean | 是否固定（固定的记忆不会衰减） |
| `resident` | boolean | 是否常驻（v2.4，每轮以索引卡形式注入） |
| `npcTier` | string | NPC 分级：`core` / `important` / `minor` / `background`（v2.6） |
| `itemTier` | string | 物品分级：`key` / `equipped` / `clue` / `consumable` / `background`（v2.6） |
| `indexCard` | string | 常驻索引卡短句（状态/关系摘要，不含完整史）（v2.6） |
| `relatedMemoryIds` | string[] | 关联记忆 id，按需展开时可连带拉出（v2.6） |
| `standaloneArchive` | boolean | 是否单独建档；路人 NPC 应 `false`（v2.6） |

---

## 文件结构与代码说明

```
bb-memory/
├── manifest.json          ← 扩展清单，告诉 ST 这是什么扩展
├── index.js               ← 总指挥，协调所有模块
├── memory-store.js        ← 数据存储层，记忆的增删改查
├── memory-maintainer.js   ← 记忆维护巡检员（v2.5）
├── entity-tiers.js        ← NPC/物品分级与按需展开（v2.6）
├── message-state.js       ← 消息管理员，自动隐藏 & exchange 去重（v2.1 新增）
├── retriever.js           ← 搜索引擎，智能检索相关记忆
├── memory-types.js        ← 类型定义，6种记忆的规格说明
├── auto-generator.js      ← AI 自动记录员（v2.1 改为 exchange 模式）
├── memory-assistant.js    ← 记忆管家悬浮窗
├── world-book-importer.js ← 世界书翻译官
├── settings.html          ← 侧边栏设置面板
├── style.css              ← 视觉样式
└── README.md              ← 本文件
```

---

## 代码学习指南

> 本节为代码小白准备，解释每个文件中使用的编程概念。

### 1. manifest.json — 扩展的"身份证"

**作用：** 告诉 SillyTavern 这个扩展叫什么、入口文件是什么、有什么特殊能力。

**关键概念：**
- JSON 格式：一种数据描述格式，用花括号包裹键值对
- `generate_interceptor`：声明一个全局函数名，ST 在每次生成 AI 回复前会调用它

### 2. index.js — 总指挥

**作用：** 启动时初始化所有模块、在 AI 生成前注入记忆、处理用户操作。

**关键概念：**
- `import/export`：模块系统，让代码分文件组织
- `async/await`：处理"需要等待"的操作（如读数据库）
- `globalThis.函数名`：在全局作用域注册函数
- `eventSource.on(事件名, 处理函数)`：事件监听模式
- DOM 操作：`document.getElementById()` 等操作页面元素

### 3. memory-store.js — 数据库管理员

**作用：** 管理记忆数据的增删改查，使用 IndexedDB 存储大量数据。

**关键概念：**
- `localforage`：浏览器端的数据库库，像使用 localStorage 一样简单但能存更多数据
- `async function`：异步函数，因为数据库读写需要时间
- `Object.freeze()`：冻结对象，防止默认值被意外修改
- 数据迁移：当升级时把旧格式数据转为新格式

### 4. retriever.js — 搜索引擎

**作用：** 根据当前对话内容，在记忆库中找出最相关的记忆。

**关键概念：**
- 评分算法：多个维度加权求和 → 综合分数
- `Array.sort()`：按分数从高到低排序
- `Array.filter()`：过滤掉不需要的结果
- Fuse.js：模糊搜索库（能容忍拼写错误）

### 5. memory-types.js — 分类字典

**作用：** 定义 6 种记忆类型，每种有专属字段、图标、格式化方式。

**关键概念：**
- `Object.freeze()`：创建不可修改的常量对象
- 函数作为值：每种类型的 `formatForInjection` 是一个函数
- 正则表达式：用模式匹配自动猜测内容类型

### 6. auto-generator.js — AI 自动速记员

**作用：** 监听 AI 回复事件，调用 AI 提取重要信息并存为记忆。

**关键概念：**
- 事件驱动：`MESSAGE_RECEIVED` 事件触发处理
- `fetch()` API：向外部服务器发送 HTTP 请求
- JSON 解析：把 AI 返回的文本解析成结构化数据
- 防抖/队列：避免短时间内重复处理

### 7. memory-assistant.js — 记忆管家

**作用：** 创建一个可拖拽的悬浮窗，提供仪表盘和管理工具。

**关键概念：**
- DOM 动态创建：用 JavaScript 生成 HTML 元素
- 事件委托：在父元素监听子元素事件
- 拖拽实现：mousedown → mousemove → mouseup 三步
- Tab 切换：显示/隐藏不同面板

### 8. world-book-importer.js — 格式转换器

**作用：** 把 SillyTavern 世界书 JSON 转换为 BB-Memory 记忆条目。

**关键概念：**
- JSON.parse()：把 JSON 文本转为 JavaScript 对象
- 格式兼容：处理多种可能的输入格式
- 启发式分类：根据关键词猜测内容类型

---

## 技术说明

### 使用的 SillyTavern 公开 API

| API | 用途 |
|-----|------|
| `SillyTavern.getContext()` | 获取应用上下文 |
| `extensionSettings` | 存储扩展配置 |
| `SillyTavern.libs.localforage` | IndexedDB 数据存储 |
| `SillyTavern.libs.Fuse` | 模糊搜索 |
| `generateRaw()` | 无上下文的 AI 生成 |
| `setExtensionPrompt()` | 注入内容到 prompt |
| `eventSource.on()` | 监听 ST 事件 |
| `renderExtensionTemplateAsync()` | 渲染 HTML 模板（第一个参数为扩展内部目录键） |
| `../../../extensions.js` → `findExtension()` | 按名称解析已安装扩展的真实路径（官方扩展脚本导出） |
| `Popup.show.input/confirm` | 弹窗交互 |
| `POPUP_RESULT.AFFIRMATIVE` | 确认弹窗「确定」按钮的返回值 |
| `SlashCommandParser.addCommandObject()` / `registerSlashCommand()` | 注册斜杠命令（新版优先前者） |

### 数据存储方案

- **配置数据**：存在 `extensionSettings['bb_memory']`（轻量，随 ST 设置保存）
- **记忆数据**：存在 `localforage`（IndexedDB，适合大量数据）

### 记忆检索算法

综合评分 = 关键词匹配(30%) + 标签匹配(25%) + 记忆强度(25%) + 时效性(20%)

评分后乘以重要性系数(0.5~1.5)，按分数排序取前 N 条注入。

### 记忆衰减模型

- 基础衰减率可配置（默认 0.05/次）
- 重要性越高，衰减越慢
- 被检索到时强度 +0.1（巩固效应）
- 最低强度为 0.1（不会完全遗忘）

---

## 版本记录

### v2.3.0（2026-05-03）— 事实更新与隐藏备注机制

**新增功能：**
- 事实更新机制：记忆内容可随剧情推进更新，旧版本自动保存到 `history` 数组，支持查看完整变更历史
- 隐藏备注（hiddenNotes）：每条记忆可附加结构化隐藏备注，包含 7 种类型（通用/角色内心/伏笔/隐藏真相/内心动机/压抑情感/剧情备注）
- 真假状态系统（truthStatus）：支持 6 种状态标记（已确认/已否定/未知/传闻/误导/隐藏真相），在记忆管理器中以彩色标签显示
- AI 隐藏注入：hiddenNotes 自动注入到 prompt 中（标记为 `[隐]`），AI 可用于行为塑造但不会直接透露给用户
- 小眼睛按钮（👁）：记忆管理器中每条记忆旁的眼睛图标，点击展开/折叠隐藏备注面板
- 版本历史按钮（📜）：点击查看该条记忆的所有历史版本，含变更时间、原因和旧内容

**新增/修改文件：**
- `memory-types.js` — 新增 `TRUTH_STATUS`、`HIDDEN_NOTE_TYPES` 常量；注入格式支持 hiddenNotes 和 truthStatus
- `memory-store.js` — 新增 `updateFactContent()`、`addHiddenNote()`、`removeHiddenNote()`；hiddenNotes 从 string 迁移为 array；truthStatus 从 `confirmed` 迁移为 `true`
- `index.js` — 小眼睛 UI、隐藏备注面板、事实更新对话框（含 truthStatus 选择和变更原因）、版本历史面板
- `memory-assistant.js` — 浏览视图显示 truthStatus badge 和 hiddenNotes 数量指示
- `style.css` — 新增 hiddenNotes 面板、truthStatus badge、历史面板、小眼睛高亮样式

**向后兼容：**
- `hiddenNotes` 字段自动从旧版空字符串迁移为数组格式
- `truthStatus` 值 `confirmed` 自动迁移为 `true`
- 旧版记忆首次读取时自动完成迁移，无需手动操作

---

### v2.2.0（2026-05-03）— 认知记忆数据结构重构

**核心变更：**
- 认知类型系统：从 6 种物品分类（event/npc/item/…）升级为 4 种认知类型（fact/episode/emotion/habit），灵感来自认知心理学
- 树状分类路径：新增 `categoryPath` 字段，支持 `world.politics`、`npc.relationship`、`episode.promise` 等 21 种分类路径
- 丰富的记忆字段：每条记忆扩展到 27+ 字段，包含 `title`、`summary`、`compressed`、`verbatim`、`hiddenNotes` 等
- 原话保留：`verbatim` 字段专门用于保存承诺、告白、威胁等重要原话，避免压缩失真
- 结构化信息：新增 `subject`、`target`、`actors`、`location` 等字段，使记忆信息更加结构化
- 状态与可信度：新增 `truthStatus`（确认/谣言/谎言）、`visibility`（公开/私密/秘密）、`confidence` 等字段
- 惰性迁移：旧数据在首次读取时自动转换为新格式，无需手动操作

**新增/重大修改文件：**
- `memory-types.js` — 全面重写：认知类型定义 + 树状分类路径 + 旧类型映射 + 内容自动分类
- `memory-store.js` — 重大更新：新 schema 定义、惰性迁移逻辑、通用字段更新、pinned 记忆免衰减
- `auto-generator.js` — 提取 prompt 改为认知类型格式，AI 现在会输出 `title`、`summary`、`verbatim` 等字段

**适配修改文件：**
- `index.js` — 类型显示和过滤使用 `cognitiveType`，手动添加默认类型改为 `episode`
- `memory-assistant.js` — 类型显示和过滤兼容新格式
- `manifest.json` — 版本号 2.2.0

**向后兼容：**
- 旧记忆数据自动迁移：`type` → `legacyType` + `cognitiveType` + `categoryPath`
- 旧类型名可继续使用：传入 `event`/`npc` 等旧类型名会自动映射到新认知类型
- `MEMORY_TYPES` 导出保留，指向 `COGNITIVE_TYPES`
- `getTypeDefinition()` 同时支持新旧类型 ID
- `emotionalValence` 自动转换为 `emotionalWeight`（取绝对值）
- 旧版 metadata 中的结构化信息会被提取到新字段（如 `metadata.npcName` → `subject`）
- `typeEnabled` 设置自动补充新认知类型键

---

### v2.6.1（2026-05-03）— SillyTavern 接口对齐与界面挂载修复

**修复与改进：**

- 使用官方 `findExtension('BB-Memory')` 解析扩展目录键，保证 `renderExtensionTemplateAsync` 与磁盘路径一致，避免出现「酒馆里看不见设置」的情况。
- 扩展设置 HTML 挂载增加对 `#extensions_settings` / `#extensions_settings2` 的兼容与短时重试，适配 DOM 较晚就绪的酒馆版本。
- 斜杠命令改为优先通过 `SlashCommandParser.addCommandObject` 注册（失败时回退到旧版 `registerSlashCommand`）；并对新版解析器传入的无名参数（字符串或片段数组）做统一归一化。
- `Popup.show.confirm` 的结果改为显式与 `POPUP_RESULT.AFFIRMATIVE` 比较，避免依赖 loosely truthy 判断。
- 事件监听兼容 `event_types` 与 `eventTypes` 两种上下文字段命名。
- 修正文档：手动安装路径说明与官方文档对齐。

**涉及文件：** `index.js`、`memory-assistant.js`、`manifest.json`、`README.md`

---

### v2.6.0（2026-05-03）— NPC / 物品实体分级与按需展开

**新增功能：**
- NPC 四级：`core`（核心）／`important`（重要）／`minor`（配角）／`background`（路人），影响检索分与注入档位（未命中对话实体时路人大幅下降占位）。
- 物品五级：`key`／`equipped`／`clue`／`consumable`／`background`，同样参与检索乘数与档位封顶逻辑。
- 自动提取：`standaloneArchive=false` + `npc.profile` → 自动改为情景记忆 `episode.event`，避免路人落成完整档案；物品可走 `background` 分级减负。
- 记忆索引卡：字段 `indexCard` + `buildDefaultIndexCard()`，低相关/模糊记忆优先注入短卡片或摘要；核心、永恒或高相关记忆注入完整内容。
- 按需展开：`mergeExpandedRelevantResults()` 在用户消息命中实体名时，合并关联记忆并拉高档位；支持 `relatedMemoryIds` 链式展开。
- 分类扩展：`npc.emotion`、`npc.secret`、`npc.goal`、`item.key`、`item.clue`。
- 控制台接口：`globalThis.bbMemoryExpandEntityKeyword(keyword, limit)` 返回关键词关联记忆数组。

**新增/修改文件：**
- `entity-tiers.js` — 分级常量、实体_hint、检索乘数、展开、`applyStandaloneArchivePolicy`
- `retriever.js` — 档位封顶、`tierScoreMultiplier`、`mergeExpandedRelevantResults`、`getResidentMemories` 按 NPC 核心度排序、L4 使用索引卡
- `memory-store.js` — `migrateToV26`、`npcTier`/`itemTier`/`indexCard`/`relatedMemoryIds`/`standaloneArchive`
- `auto-generator.js` — 提取 prompt 与解析字段、路人建档策略
- `memory-types.js` — 新分类路径
- `index.js` — 合并按需展开、管理面板分级/索引卡编辑、`bbMemoryExpandEntityKeyword`
- `style.css` — `.bb-entity-meta-row`
- `manifest.json` — 2.6.0

---

### v2.5.0（2026-05-03）— 记忆维护机制

**新增功能：**
- 维护阈值提醒：活跃记忆超过阈值（默认 50）时，弹出维护建议弹窗
- 多维度问题诊断：弱记忆、重复记忆、过期事实、闲置 NPC、可归档物品、久未使用
- 三种用户操作：自动整理（一键处理）、手动查看（跳转管理面板）、稍后提醒（24 小时免打扰）
- 记忆状态系统：`active`（活跃）、`fuzzy`（模糊）、`archived`（归档）、`pinned`（珍藏）、`deleted`（已删除）
- 模糊化（fuzzy）：将完整内容压缩为摘要版本，原文保留在 `compressed` 字段，可随时恢复
- 归档（archived）：移出检索范围但保留数据，可恢复
- 珍藏保护：`pinned` 记忆不会被自动压缩或归档
- 状态徽章：管理面板中每条记忆显示当前状态（模糊/归档）
- 记忆管理器新增按钮：☁️ 模糊化、📦 归档、🔄 恢复

**新增文件：**
- `memory-maintainer.js` — 维护巡检员：诊断引擎 + 自动整理 + 弹窗 UI 构建

**修改文件：**
- `index.js` — 集成维护触发器、弹窗事件、模糊化/归档/恢复按钮、状态徽章
- `memory-store.js` — 新增 `maintenanceThreshold` 设置、衰减跳过归档记忆
- `settings.html` — 新增维护阈值输入框
- `style.css` — 维护弹窗样式、状态徽章、操作按钮悬停样式

**向后兼容：**
- 旧记忆默认 `status: 'active'`，无需迁移
- 衰减/检索逻辑自动跳过 `archived` / `deleted` 状态的记忆
- 维护提醒为被动式，不会自动修改数据

---

### v2.4.0（2026-05-03）— 检索与注入机制

**新增功能：**
- 8 维综合评分：`keywordScore`、`tagScore`、`embeddingScore`（预留）、`importance`、`emotionalWeight`、`strength`、`sceneScore`、`relationScore`
- 分等级注入：L1（标签）、L2（摘要）、L3（完整内容+原话）、L4（常驻索引卡）
- 常驻记忆：`resident` 字段标记关键角色/物品/世界状态，每轮以低 token 索引卡注入
- 分区注入模板：`[常驻记忆]` / `[本轮相关记忆]` / `[隐藏备注]`
- Token 预算控制：可调节的注入 token 上限（默认 800），常驻记忆占比不超过 30%
- 场景/关系评分：自动检测对话中的角色名和地点，提升相关记忆优先级
- 记忆管理器常驻按钮：📌 图钉图标，一键切换常驻状态

**新增/重大修改文件：**
- `retriever.js` — 全面重写：8 维评分 + 注入等级 + 常驻记忆 + token 预算 + `buildMemoryInjectionPrompt()`
- `index.js` — 注入拦截器改用新的分区流程，新增 `extractRecentContext()` 近期上下文提取
- `memory-store.js` — 新增 `resident` 字段迁移、`tokenBudget` 设置项
- `settings.html` — 新增 Token 预算设置输入框
- `style.css` — 常驻记忆按钮样式

**核心函数：**
- `calculateMemoryScore(memory, query, context)` — 8 维综合评分
- `getResidentMemories(memories)` — 提取常驻记忆
- `getRelevantMemories(memories, queryText, options)` — 智能检索（带评分和等级）
- `buildMemoryInjectionPrompt({ residentMemories, relevantResults, settings })` — 分区注入构建
- `chooseInjectionLevel(memory, score)` — 注入等级选择

**向后兼容：**
- `searchMemories()` 保留旧签名，内部调用 `getRelevantMemories()`
- 旧记忆数据自动获得 `resident: false` 默认值
- `simpleSearch()` 不受影响（管理面板搜索）
- `tokenBudget` 默认 800，不影响旧设置

---

### v2.1.0（2026-05-03）— 消息稳定化机制

**新增功能：**
- 消息自动隐藏：超出短期窗口（默认最近 5 条）的消息由插件自动隐藏（使用 SillyTavern 原生 `is_hidden`）
- 消息状态标记：每条消息标记 `_bbmem_hideSource`（插件/用户隐藏）和 `_bbmem_extracted`（是否已提取）
- Exchange 机制：将「AI 回复 + 前一条用户消息」组成 exchange，整体送入提取流程
- Exchange 指纹去重：基于 cyrb53 哈希算法为每个 exchange 生成唯一指纹，防止重复提取
- 重 Roll 安全：最近窗口内的消息不会被提取，频繁重新生成不会影响已隐藏消息的状态

**新增文件：**
- `message-state.js` — 消息状态管理器，负责自动隐藏、状态标记、指纹计算

**修改文件：**
- `auto-generator.js` — 提取流程改为 exchange 模式，每个周期最多处理 3 个 exchange
- `index.js` — 在 MESSAGE_RECEIVED 和 CHAT_CHANGED 事件中集成消息同步
- `memory-store.js` — 旧版曾新增 `shortTermWindow` 设置项；新版本已由提取窗口与楼层状态标记取代。
- `manifest.json` — 版本号升级到 2.1.0

**向后兼容：**
- 已有聊天数据无需迁移，首次加载时自动标记现有消息状态
- 已有记忆数据不受影响
- 新增的消息属性（`_bbmem_hideSource`、`_bbmem_extracted`）不会影响旧版本运行

---

### v2.0.0（2026-05-03）— 全面升级

**新增功能：**
- AI 自动生成记忆（支持主 API / 自定义 API）
- 多类型记忆系统（事件/时间线/物品/NPC/地点/关系）
- 向量化标签（带权重的标签系统）
- 记忆衰减与强化（模拟艾宾浩斯遗忘曲线）
- 记忆管家悬浮窗（仪表盘/分类浏览/健康分析/批量操作）
- 世界书导入转换器
- 斜杠命令 `/memory`
- 多类型注入格式（按事件/NPC/物品等分区显示）

**架构改进：**
- 数据存储迁移到 localforage（IndexedDB），支持大规模记忆
- 检索算法升级为多维度加权综合评分 + Fuse 模糊搜索
- 模块化架构重构，各功能独立文件

### v1.0.0（初始版本）— 基础记忆

- 手动添加/编辑/删除记忆
- 简单关键词匹配检索
- generate_interceptor 自动注入
- 导入/导出 JSON
- 侧边栏设置面板

---

## 许可证

GPL-3.0 License
