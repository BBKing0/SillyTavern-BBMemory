# BB-Memory — SillyTavern 记忆扩展

一个简洁的 SillyTavern 长期记忆扩展，让你的角色能够"记住"重要信息。

## 功能

- **添加记忆** — 手动输入角色需要记住的信息
- **删除记忆** — 移除不再需要的记忆
- **编辑记忆** — 修改已有记忆的内容
- **搜索记忆** — 通过关键词搜索记忆库
- **自动注入** — 发送消息时，自动检索相关记忆并注入到 prompt 中
- **导入/导出** — 记忆数据可以导出为 JSON 文件，也可以从文件导入

## 安装方法

### 方法一：通过 SillyTavern 安装（推荐）

1. 打开 SillyTavern
2. 进入 **扩展** → **安装扩展**
3. 输入本仓库的 Git URL
4. 点击安装

### 方法二：手动安装

1. 将本文件夹复制到：
   ```
   SillyTavern/public/scripts/extensions/third-party/
   ```
2. 建议将文件夹重命名为 `bb-memory`
3. 重启 SillyTavern

## 使用方法

### 基本操作

1. **启用扩展** — 在 SillyTavern 侧边栏找到 "BB-Memory"，确保开关已开启
2. **添加记忆** — 点击"添加记忆"按钮，输入你希望角色记住的内容
3. **管理记忆** — 点击"管理记忆"按钮，查看、搜索、编辑或删除记忆
4. **正常聊天** — 发送消息时，扩展会自动检索相关记忆并注入到上下文中

### 设置说明

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 注入深度 | 记忆插入到聊天历史中的位置（0 = 最末尾） | 4 |
| 最大检索数 | 每次生成时最多注入多少条相关记忆 | 5 |
| 注入模板 | 控制记忆注入到上下文中的格式，使用 `{{memories}}` 作为占位符 | `[角色记忆]\n{{memories}}` |

### 记忆检索原理

当你发送消息时，扩展会：

1. 提取你消息中的关键词
2. 在记忆库中查找包含这些关键词的记忆
3. 按匹配度排序，选出最相关的几条
4. 格式化后作为系统消息注入到 prompt 中

这样 AI 就能"看到"这些记忆信息，从而做出更连贯的回复。

## 文件结构

```
bb-memory/
├── manifest.json     ← 扩展的"身份证"，告诉 ST 这是什么扩展
├── index.js          ← 主入口，负责初始化、事件监听、UI 交互
├── memory-store.js   ← 记忆存储引擎，管理记忆数据的增删改查
├── retriever.js      ← 搜索引擎，负责关键词匹配和记忆检索
├── settings.html     ← 侧边栏面板的 HTML 模板
├── style.css         ← 视觉样式
└── README.md         ← 你正在读的这个文件
```

## 技术说明

### 使用的 SillyTavern 公开接口

本扩展完全基于 SillyTavern 官方推荐的公开 API 构建：

- `SillyTavern.getContext()` — 获取应用上下文（设置、事件、工具函数）
- `extensionSettings` — 存储扩展设置和记忆数据
- `saveSettingsDebounced()` — 防抖保存设置
- `renderExtensionTemplateAsync()` — 渲染 HTML 模板
- `setExtensionPrompt()` — 将记忆注入到生成 prompt 中
- `eventSource` / `eventTypes` — 监听聊天切换等事件
- `generate_interceptor` — 在文本生成前执行记忆检索

### 数据存储

记忆数据存储在 SillyTavern 的 `extensionSettings` 中，跟随 SillyTavern 设置一起保存。
不使用外部数据库，不需要额外配置。

## 未来计划

- [ ] 向量化搜索（embedding），提高检索精度
- [ ] 自动从聊天中提取记忆
- [ ] 记忆分类（事件、情感、承诺等）
- [ ] 记忆衰减（模拟人类遗忘曲线）
- [ ] 联想记忆（相关记忆自动关联）

## 许可证

MIT License
