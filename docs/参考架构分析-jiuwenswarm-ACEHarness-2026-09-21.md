# 参考架构分析 — jiuwenswarm 与 ACEHarness — 2026-09-21

> 目的：为 `docs/架构评审-2026-09-21.md` 中的 7 个问题寻找已验证的解法。
> 参考项目（已解压到 `.refs/`，仅作分析用）：
> - **jiuwenswarm**（Python，多 agent 运行时）：`.refs/jiuwen/jiuwenswarm-develop/jiuwenswarm/`
> - **ACEHarness**（TypeScript/Next.js，工作流编排 + 多引擎 harness）：`.refs/ace/ACEHarness-main/`

## 一、jiuwenswarm 值得借鉴的设计

### 1. Session 级 Work Scheduler —— 正是对我们「无队列」问题的标准答案

`runtime/session/work_scheduler.py`：`SessionWorkScheduler` — **每个 Session 一条 lane，lane 内一次只跑一个操作，多个 Session 并行**。

- 每个 `_Lane` 持有 `asyncio.PriorityQueue`（支持 latest_first 优先级）、`current`（当前执行项）、`queued`（待执行注册表）；
- 提交操作返回 `Future`，调用方等待结果——**排队、串行化、结果回传全部收敛在一个类里**；
- `generation` 字段支持会话重建后旧 lane 作废（关闭时按 `(session_id, generation)` 收割任务）。

→ 直接映射到我们的问题 #2：`tasks` 表加 `library_id/session` 维度的 lane，同库任务串行、跨库并行；`queued`/`current` 注册表就是取消的落点（按 id 从队列摘除 + abort 当前项）。

### 2. Transport-neutral RuntimeEvent —— 事件先于渲染

`runtime/events.py`：`RuntimeEvent` dataclass（request_id / channel_id / session_id / payload / is_complete / ok），**Runtime 先产出中立事件流，JSON wire 渲染、SSE、日志都是事件的后置投影**（`to_dict()` 还刻意 pop 掉执行期字段以不破坏现有渲染器）。

→ 映射到问题 #4/#6：我们应先定义中立的 `TaskEvent`（task_id / seq / type / payload），trace 列、前端轮询响应、调试页全都从这个流推导，而不是各自维护状态。

### 3. 声明式 Spec + 工厂注册表 —— 能力可序列化、可内省

`agents/swarm/DESIGN.md` + `assembly.py` / `registry.py` / `providers/`：

- agent 能力 = 一组 pydantic spec（`RailSpec` / `BuiltinToolSpec` / `SubAgentSpec`，可 JSON round-trip），`.build()` 按 `type` 查**纯 dict 工厂注册表**（`_TOOL_PROVIDER_REGISTRY: dict[str, Callable]`，无元数据、无类注册表）构造运行对象；
- **跨序列化边界靠 seed 重建**：非序列化句柄不进 spec，spec 上只带 `build_context_seed`，接收侧用注册工厂本地重建（分布式 / 热恢复的关键）。

→ 映射到问题 #5：我们的任务类型（write_cases / explore_cases / …）目前是 executor.ts 里一个 switch-case 硬编码。改成 `TaskTypeSpec`（type + prompt 模板 + 工具清单 + 校验器）+ 注册表后，新增任务类型不碰执行器核心，spec 还能直接下发给 worker / 持久化恢复。

### 4. gateway 分层：channel 与 runtime 彻底解耦

`channels/`（web / cli / ide / tui / browser / acp…）与 `gateway/`（channel_manager / routing / message_handler / heartbeat / health_check / cron）分离，runtime 不感知任何入口形态。

→ 我们只有一个入口（DSH webServer），但同样的原则意味着：HTTP handler 只做「解析请求 → 提交任务 → 返回 handle」，执行细节全部下沉 runtime 层——现在 http.ts 里 2500 行是 API + 业务逻辑 + 进度状态的大杂烩（问题 #5），按 channel/gateway/runtime 三层拆开后天然解决。

### 5. 会话历史独立成 store 层

`server/runtime/session/session_message_store.py` / `history_io.py` / `session_archive.py`：消息持久化、归档、重命名是独立组件而非业务的附属列。

→ 我们的 tasks.trace JSON 列应升级为独立 `task_events` 表（append-only），归档走自己的生命周期（对应我们已有的 executions_archive 模式，扩展到 AI 轨迹）。

## 二、ACEHarness 值得借鉴的设计

### 1. Engine 抽象层 —— 统一接口 + 统一事件流协议

`src/lib/engines/`：

- `engine-interface.ts`：`Engine` 统一接口（`EngineOptions` 含 sessionId / timeoutMs / allowedTools / runId / AbortController 可挂的 env；`EngineTokenUsage` 精确到 cache_read/cache_creation；`EngineResultMetadata` 含 cost_usd / num_turns）；
- **20+ 个引擎 wrapper**（claude-code / codex / cursor / opencode / kiro / trae / codegenie…）全部实现同一接口；
- 统一输出流协议：所有 wrapper 不再各自拼 markdown，而是归一输出 `<ace-process>{kind: reasoning|tool-call|tool-result|subtask-start|subtask-result, ...}</ace-process>` block，UI 只认这一种协议。

→ 映射到问题 #1/#3：我们的 `makeLlm` 是单函数、无接口抽象、重试不换模型。应抽出 `LlmEngine` 接口（含 stream 事件归一、usage/cost 记账、session 概念），provider fallback 变成引擎层策略；trace 事件按 `tool-call/tool-result` 归一后，调试页渲染与 LLM 解耦。

### 2. Event Store + Snapshot —— 事件溯源的完整落地

`src/lib/workflow/event-store.ts`：`WorkflowEventStore` 接口——`append / appendBatch / read(runId, { afterSeq }) / saveSnapshot / getSnapshot`，SQLite 落盘，**read 支持 afterSeq 增量读**（这就是 SSE 断线续传的基础），状态由 `快照 + 增量事件` 重建。

→ 这就是我们问题 #4 的现成答案：`task_events(run_id, seq, type, payload)` + 周期 snapshot；前端轮询/SSE 都按 `afterSeq` 拉增量，reaper 按「最后事件时间」判超时。

### 3. Run 生命周期与崩溃检测 —— 状态机 + isProcessAlive

`src/lib/run/state-persistence.ts` + `run-status.ts` + `store.ts`：

- run 状态是**显式枚举状态机**：`pending | starting | running | waiting-human | waiting-approval | completed | failed | stopped | crashed | cancelled | detached | abandoned | superseded`（比我们的 pending/running/done/failed 细得多，`waiting-approval` 支持人工介入）；
- `findRunningRuns()` 启动时找遗留 run + **`isProcessAlive(pid)` 检查持有进程是否还活着**——重启后能区分「真崩溃」和「进程已被接管」，而不是我们 reaper 那样按 30 分钟盲猜；
- run 目录持久化 `state.yaml` + 流式输出分块落盘（chunk-boundary 分隔），**write queue（`runStateWriteQueues`）串行化每个 run 的写**——正是我们 traceTask 读改写竞态的解法。

→ 映射到问题 #2/#4：任务崩溃检测用「pid 存活检查 + 状态机」替代定时盲扫；trace 写入单队列串行化。

### 4. 上下文恢复与压缩（context-recovery.ts）

`engines/context-recovery.ts`：长任务上下文超限时，自动「压缩摘要 → 以 continuation prompt 续跑新 session」，失败重试有 MAX_ATTEMPTS。我们的 AI 任务（write_cases 生成的用例可能几十条）同样会撞上下文墙，目前直接失败。

### 5. Token / 成本记账贯穿全链路

RunRecord 直接入库 `inputTokens / outputTokens / cacheCreationInputTokens / cacheReadInputTokens`，EngineResult 带 cost_usd——预算、限流、报表都有了数据基础（对应问题 #3 的 token 预算记账）。

### 6. 对抗迭代工作流 + Preflight

`workflow/manager.ts` + `preflight.ts`：工作流执行前先跑 preflight（环境/依赖检查），执行中多 agent 对抗迭代（生成 → 评审 → 修订循环是**工作流的一等公民**，由 workflow manager 驱动多步，而不是 prompt 里硬编码两段）。Git baseline（`git-baseline.ts`）每步快照可回滚——对应我们的用例版本历史。

## 三、对照我们的 7 个问题：可直接套用的方案

| 我们的问题 | jiuwenswarm 解法 | ACEHarness 解法 | 采纳建议 |
|---|---|---|---|
| #1 无 agent loop | — | Engine 统一 tool-call 事件协议（ace-process block）；对抗迭代作为 workflow 一等公民 | 定义 LlmEngine 接口 + 归一事件；用例生成的评审循环改为工作流驱动 |
| #2 无队列/无取消 | **SessionWorkScheduler（lane + queue + generation）** | 状态机 + isProcessAlive 崩溃检测 | 引入任务 lane 调度器；状态枚举细化（waiting-approval 等）；启动时 pid 存活检查 |
| #3 LLM 层缺陷 | model_catalog / mode_catalog 声明式模型目录 | EngineTokenUsage / cost_usd 全链路记账 | 引擎接口内置 fallback 策略与 usage 记账 |
| #4 JSON 列读改写 | **RuntimeEvent 中立事件流**、session_message_store | **EventStore（afterSeq 增量 + Snapshot）**、runStateWriteQueues 串行写 | 建 task_events 表 append-only + snapshot，写路径单队列 |
| #5 模块级单例/上帝文件 | channels / gateway / runtime 三层分离；声明式 Spec + 工厂注册表 | 模块按领域拆（run/ workflow/ engines/） | http.ts 拆为 router 层；任务类型改 Spec 注册表 |
| #6 轮询 | gateway_push 服务端推送 | event store afterSeq 增量 → SSE 天然支持断线续传 | SSE + afterSeq |
| #7 数据在 node_modules | instance_manager 独立数据管理 | getWorkspaceDataFile/getWorkspaceRunsDir 统一路径层（app-paths.ts） | 数据路径收敛到一个 app-paths 等价模块，默认移到 profile 数据目录 |

## 四、两个项目共同印证的三条架构原则

1. **事件先于状态**：jiuwenswarm 的 RuntimeEvent、ACEHarness 的 EventStore 都把「发生的事实」作为第一数据，视图状态全是投影。我们反着做的（状态列 + JSON trace），这是所有竞态和僵死问题的根源。
2. **执行体可替换**：jiuwenswarm 的 provider 工厂注册表、ACEHarness 的 20+ engine wrapper 都把「怎么执行」抽象成可插拔实现。我们的 switch-case executor 和单函数 makeLlm 都不可替换。
3. **生命周期显式化**：状态机细粒度枚举（waiting/approval/crashed/detached）、pid 存活检测、seed 重建、write queue——运行态的每个转变都有显式语义，不存在「靠 30 分钟定时器猜僵死」。
