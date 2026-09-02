# DSH Agent — Obsidian 插件

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）作为内置 AI 协作者嵌入 Obsidian。插件以子进程方式启动 DSH 官方 ACP 自动化服务器（`@deepseek-ai/dsh-acp-demo`），通过 ACP v1（JSON-RPC / ndjson over stdio）驱动，交互体验对齐 [Claudian](https://github.com/YishenTu/claudian)。

[English below](#dsh-agent--obsidian-plugin-1)

## 功能

- **聊天视图**：右侧栏对话界面，会话列表管理，历史副本持久化。
- **Synapse 会话地图**：把当前 ACP 会话按工作区和真实分支关系投影到可拖拽、缩放和平移的纯地图画布；只显示标题、状态、消息数量和更新时间，不重复展示对话正文或输入框。支持定位当前会话、自动整理、创建分支、单会话归档、确认后一次性关闭当前工作区全部会话，以及跳转到聊天视图；工作区列表在切换和重绘时保留滚动位置，地图布局随插件数据持久化。交互与视觉设计移植自 MIT 许可的 [dsh-synapse](https://github.com/liangmianya/dsh-synapse)。
- **实时工具过程渲染**（Claudian 级）：插件 tail 会话 JSONL 日志，把 agent 的工具调用实时渲染为可折叠卡片——工具名/图标、参数摘要、参数 JSON、输出/错误、glob 结果文件列表（可点击打开）、fs 读取窗口、**todo_write 任务清单**；回合结束时自动落定卡片状态。
- **流式 Markdown**：流式阶段节流重渲染 Markdown，代码块带复制按钮；智能自动滚动 + 「跳转到最新」悬浮按钮（块级时间线离屏重建后原子替换 + MutationObserver 粘底，跟随流式输出不再跳顶）。
- **会话标题**：从会话日志的 `session/title` 事件同步（LLM/回退标题由 DSH 后端生成）。
- **多模态附件上下文**：支持拖放/选择 PDF、图片和普通文件，并保留库内完整路径与页码/段落范围；文本可插件侧提取，PDF 可提示 MinerU 工作流；当 ACP 握手与模型均支持视觉时，PNG/JPEG/WebP/GIF 以原生 `image` 块发送，否则明确降级而不猜测内容。
- **编辑器选区自动附加**：编辑模式与阅读模式下选中文本 → 自动出现在聊天框（显示「N lines selected · 笔记名」英文标签），随提问作为引用上下文发送；取消选中即清除。
- **内置浏览器网页上下文**：读取当前激活的 Obsidian Web Viewer 已渲染页面；网页全文和用户选区是两个可同时存在、可分别移除的独立上下文，并保留标题和 URL。微信文章优先读取 `#js_content`，普通网页依次读取 `article/main`，最长保留 8 万字符并明确标记截断；只读渲染文本，不读取 Cookie、表单值或浏览器存储。
- **新建会话自动附加当前笔记**：创建会话时自动把活跃笔记作为 resource_link 上下文附上。
- **自动标题**：每段对话的标题由模型自动总结（服务端 session/title 事件优先，未生成时插件用独立会话请模型起标题，失败静默回退）。
- **Codex 式分支**：分支按钮直接复制整段对话为新会话，顶部横幅显示「分支自『原会话』」。
- **框选引用上下文**：在 AI 回复上框选文字即悬浮「加入上下文」按钮，点击弹出注释气泡（可选注释），确认后作为引用片段进入下一次对话的上下文（Codex 式），并显示在附件行可移除。
- **Claudian 式底部气泡**：聊天框最下方以胶囊气泡显示 `Model: 模型商 · 模型`、`Effort: 强度`、`Mode: 库内/全量`；点击（或聚焦后回车）弹出切换菜单，模型商与模型合并展示、按模型商分组；模型、供应商和思考强度会热更新到运行中的顶层 Agent，下一次模型调用生效且不重启后端；工作模式仍需重启。发送按钮已移除，回车即发送。
- **@ 笔记提及**：composer 输入 @ 弹出库内笔记模糊搜索选择器，选中即附加为上下文 chip。
- **/ 斜杠命令与技能**：/ 弹出面板——插件原生命令（/new /clear /stop /attach /settings）、模型中介的 DSH 命令（/goal /workflow /compact）与**同步技能清单**（选中即插入 /技能名 调用；也可直接在输入框输入 /技能名，DSH 会在 pre-step 识别该 token 并加载技能）。
- **思考过程渲染**：从会话 JSONL 的 assistant/message 事件提取**完整**思考块（非稀疏增量），按事件顺序渲染可折叠「思考过程」块。
- **Goal 可视化**：goal/change 事件渲染目标卡片（创建/暂停/完成/受阻 + 目标内容 + 轮次预算）。
- **Workflow 可视化**：tool-workflow 事件渲染运行卡片（运行名 + 各子 agent 状态 + 完成结果）。
- **多工作区**：会话级工作区切换（composer 文件夹按钮），ACP session/new 使用所选文件夹为 cwd；切换自动失效旧会话；会话日志按工作区分目录落盘。
- **技能与电脑 DSH 同步**：运行时自动发现 `~/.agents/skills`（`$DSH_AGENTS_HOME` 可覆盖）并与库内 `.dsh/skills` 合并——Obsidian 里的 agent 与电脑 DSH 共享同一套技能（agent-reach、computer-use、orca-cli、orchestration 等），无需拷贝。
- **界面打磨**：会话列表以底部横向 chip 条呈现（消息流下方、输入框上方），默认收起为序号、双击展开标题（Claudian 式）；右键 chip 弹出菜单（删除会话/关闭会话条）；顶栏「历史」按钮打开历史对话面板（也可作为会话条关闭后的入口）；复制/分支按钮在回答完成后出现在消息下方；输入框常驻底部不随消息滚动；消息/工具卡片/思考块的入场动画、卡片展开动画、状态点呼吸灯，全部尊重 Obsidian 的「减弱动态效果」设置。
- **权限内联卡片**：权限请求不再居中弹窗，在消息流下方、输入框上方以内联卡片出现（允许一次/拒绝/超时自动拒绝）。
- **P0 可靠性闭环**：失败回答可重试、重新生成或从中断处继续；旧尝试和工具审计仍保留，单轮请求可配置超时。
- **可管理队列与权限并发**：回复期间排队的消息显示位置，可上移、下移或取消；并发权限请求顺序展示，不再静默取消，并显示风险级别与脱敏后的工具参数。
- **文件改动中心与安全撤销**：每轮前后对工作区文本文件做快照，回答下方列出新增/修改/删除、行数与差异；撤销前校验当前内容，冲突文件自动跳过，库内新增文件通过 Obsidian 移入系统回收区。
- **上下文治理**：状态浮层明确展示新 ACP 会话转移时保留、截断和省略的消息数，支持手动压缩；可设置 70%/80%/90% 自动压缩阈值，并避免短时间重复触发。
- **版本化数据与保留策略**：`data.json` 带 schemaVersion，迁移前自动保留最近 5 份备份；会话删除进入可恢复回收区，原始 JSONL 日志可设置保留期，详细撤销载荷只保留最近 30 个改动回合，设置页显示分类存储占用；工具记录默认对 token/API key/password 等字段脱敏。
- **三 Provider**：
  - `opencode-go`（默认）：经 [opencode.ai/zen](https://opencode.ai/zen) 托管网关访问 DeepSeek/Kimi/GLM/Qwen/MiniMax/Grok 等模型，凭据复用你主 DSH 的 `OPENCODE_GO_API_KEY`；
  - `deepseek-official`：DeepSeek 官方 API；
  - `local-qwen`：连接 `http://127.0.0.1:8081/v1` 的本地 llama.cpp，内置模型 `qwen3.6-35b-a3b-uncensored-i-compact`，上下文按服务当前实际值 65,536 配置。
- **模型与思考强度**：启动时刷新当前 DSH/provider 模型目录；新发现模型默认不勾选。每个模型按自身能力显示 `default/off/minimal/low/medium/high/xhigh/max` 的可用子集，切换后热更新生效。
- **聊天框模型列表可见性**：设置中可逐模型开关（按模型商分组，支持一键全部显示/隐藏），控制各模型是否出现在聊天框 Model 气泡的切换列表。
- **沙箱与权限**：bash 与文件工具默认 `workspace-write`（写入限制在笔记库内）；越界重试触发 `session/request_permission` 内联卡片（允许一次/拒绝）。
- **完整工具链**：fs read/write/edit/glob/grep、bash、subagent（spawn/fork）、Codex/Claude Code 一次性子代理、workflow、todo、goal、压缩（compaction）等随 DSH 运行时提供。产品子代理读取各自原生账号与配置，并跟随插件权限模式运行。
- **自动配置**：首次使用时自动在 `$DSH_HOME/profiles/acp` 安装运行时（npm，约 1-3 分钟），并从你的主 DSH 配置导入 `llm-pi-ai` 路由（只读，绝不写回）。

## 安装 / 开发

```bash
npm install
cp .env.example .env.local
# 编辑 .env.local，将 OBSIDIAN_VAULT 指向你的 Obsidian 库
npm run dev        # esbuild watch；配置 vault 后自动复制插件文件
npm run build      # production 构建；配置 vault 后自动复制插件文件
```

也可以只为单次构建设置 `OBSIDIAN_VAULT` 环境变量。若不配置 vault，构建仍会正常完成，但不会部署到 Obsidian；`npm run test:integration` 始终使用不部署模式。

然后在 Obsidian 中：设置 → 第三方插件 → 启用 **DeepSeek Harness Agent** → 重载。

## 使用

1. 点击左侧机器人图标（或命令面板「打开 DSH Agent 聊天」）打开聊天视图；点击网络图标或聊天顶栏地图按钮打开「DSH 会话地图」。
2. 首次发送消息会触发运行时安装（需要 Node.js + npm，PATH 上可用即可）。
3. 输入消息，Enter 发送；进行中可点停止图标按钮或按 Esc 结束（`session/cancel` 通知）；@ 打开笔记选择、/ 打开命令与技能菜单，均在输入框上方内联弹出。
4. 设置页可切换 provider/模型/思考强度/权限模式/审批策略；前三项立即热更新，权限、工具、预设等启动配置会自动重启，必要时也可点「重新生成并重启」。
5. 在 Obsidian 内置浏览器打开文章后，切回 DSH 聊天即可看到带地球图标的“网页上下文”胶囊；先框选网页文字时，还会同时出现独立的“网页选区”胶囊，两者可分别移除。

## 已知限制（当前 DSH ACP rc.2 组合）

- **历史恢复使用新 ACP 会话**：插件侧保留对话副本，通过「在新会话中继续」注入压缩后的历史上下文。
- **过程事件来自会话日志**：回答文本通过 ACP 块流式接收；工具调用、推理与子代理过程主要留在会话 JSONL 日志（`<vault>/.obsidian/plugins/dsh-agent/.sessions`，未压缩以便观测），插件通过 tailer 实时还原并渲染。
- **模型热切换**：运行中的顶层 Agent 使用可变模型路由；当前正在生成的步骤保持原模型，下一次模型调用采用新模型。子代理仍使用各自的工作流/生成配置，不被顶层热切换覆盖。
- **DSH 文件工具面不含 delete 原语**：删除笔记需经 bash（`rm`）或人工操作——这恰好符合多数笔记库「不删内容」的协作规范。

## 架构

```
Obsidian (renderer)
  ├─ src/main.ts            插件入口 / 会话管理 / 权限接线 / tailer 生命周期
  ├─ src/features/chat/     聊天 ItemView + 会话模型 + renderers（工具卡片/todo）
  │                         + session-tailer（JSONL 事件观测）
  ├─ src/features/synapse/  原生会话地图 ItemView + 分支树布局（dsh-synapse 移植）
  ├─ src/features/permissions/  权限询问 Modal（视图未打开时的兜底）
  ├─ src/features/chat/inline-picker.ts  内联面板（@ 笔记选择 / 斜杠命令 / 工作区 / 权限卡片）
  ├─ src/backend/           DshRuntimeInstaller（运行时安装/配置生成）
  │                         DshAcpBackend（子进程 spawn/重启/诊断）
  ├─ src/acp/               ACP v1 客户端（ndjson transport/connection/types）
  └─ src/runtime/templates  cordis.yml / package.json / settings 种子模板
        │  spawn node dsh-acp-demo --config cordis.yml（cwd = 笔记库根）
        ▼
  $DSH_HOME/profiles/acp/   DSH ACP 自动化服务器
        │  ACP JSON-RPC over stdio             │  会话 JSONL（未压缩）
        ▼                                       ▼
  DeepSeek Harness agent loop          SessionTailer（工具事件/标题/todo）
  LLM: opencode-go / deepseek-official / local-qwen（pi-ai）
```

### 测试

`npm run test:integration` 在不部署到 Obsidian 的隔离模式下运行 100+ 项断言：ACP mock 编排（握手/流式/权限/取消/未知请求/坏行）、JSONL tailer 路径编码与增量解析（使用合成会话样本），以及 UI/会话状态、队列、上下文治理、敏感信息脱敏和文件改动/撤销回归。真实 opencode-go 往返默认跳过，显式设置 `DSH_RUN_REAL_INTEGRATION=1` 时才会调用真实 provider；可用 `DSH_INTEGRATION_WORKSPACE`、`DSH_ACP_BIN` 和 `DSH_INTEGRATION_CONFIG` 覆盖测试路径。

`npm run test:obsidian-live` 用于部署后的实机验收。Obsidian 需以 `--remote-debugging-port=9222` 启动；测试会检查插件/后端状态、P0 数据版本与存储统计、上下文治理入口、历史排序、Effort 即时刷新，并发送一次最小真实 ACP 请求验证用量、无意外文件改动与分支上下文。临时会话和分支会在结束时自动清理，截图与 JSON 报告写入 `artifacts/obsidian-live-acceptance/`。

## 致谢与许可

- ACP 客户端架构借鉴 [Claudian](https://github.com/YishenTu/claudian)（MIT License）的实现思路；cordis 组合基线改编自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `examples/acp-agent`（MIT License）。
- 本插件 MIT License。运行时依赖的 DSH 包版本钉定为 `0.1.1-rc.2`。

---

## DSH Agent — Obsidian Plugin (English)

Embeds DeepSeek Harness as an AI collaborator in your vault. The plugin spawns the official DSH ACP automation server (`@deepseek-ai/dsh-acp-demo`) as a subprocess and drives it over ACP v1 (JSON-RPC / ndjson over stdio), with a Claudian-style chat view.

- Chat view with streaming replies, conversation tabs and persisted transcripts.
- Providers: `opencode-go`, `deepseek-official`, and built-in local Qwen/llama.cpp at `127.0.0.1:8081`.
- Sandboxed tools (workspace-write by default) with one-shot inline permission cards for escalation retries.
- Subagents: in-process spawn/fork plus official one-shot Codex and Claude Code providers using each product's native account and settings.
- Auto-installs the DSH runtime under `$DSH_HOME/profiles/acp` on first use (Node.js + npm required).

Known limitations (current DSH ACP rc.2 composition): historical continuation starts a fresh ACP session with transferred context; tool/reasoning/subagent activity is reconstructed from session JSONL; Codex/Claude Code children receive a standalone task and return only their final result (no continuation or intermediate stream); a model switch applies from the next model step rather than mutating an in-flight request; and the DSH fs tool surface has no delete primitive.

License: MIT. The ACP client architecture borrows from Claudian (MIT); the cordis composition adapts deepseek-harness `examples/acp-agent` (MIT).
