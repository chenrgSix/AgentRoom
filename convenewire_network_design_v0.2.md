# ConveneWire

中央 Web Team Hub · 轻量 Bridge · MCP 协作接入

版本：产品与系统设计方案 v0.2

| 项目 | 内容 |
| --- | --- |
| 文档状态 | Implementation-ready Architecture Baseline |
| 日期 | 2026-08-23 |
| 核心目标 | 在不修改 Codex、WorkBuddy 等客户端源码的前提下，将现有 Agent 组成类似 Hermes Studio Group Chat 的 Team |
| 核心形态 | 中央 Web Team Hub + Remote MCP Server + 每台机器一个可选的无界面 Bridge |
| 非目标 | 不开发独立桌面客户端，不替代现有 Agent Runtime，不建设完整分布式 Agent 平台 |

声明：本文中的许可证分析用于工程风险判断，不构成法律意见。

## 1. 执行摘要

后续增量架构见 [ADR-0036](docs/adr/0036-add-governed-software-team-execution.md)：
在现有 Task / Run / Result 上增加受控软件团队执行、仓库隔离、验证和集成。
该 ADR 对本文早期“不接管 Git 生命周期”的非目标作明确扩展，但不授予中央服务
远程 Shell、成员文件系统或本地权限；交付状态仍只记录在 `docs/TASKS.md`。

ConveneWire 是现有 AI 客户端之上的轻量 Team Layer。用户在中央 Web 项目的 Room 中组织 Member 和 Agent，通过结构化 `@mention` 发起协作；中央服务保存消息、路由 Mention，并将任务推送到目标机器上的 ConveneWire Bridge。Bridge 使用目标 Runtime 已有的机器接口启动或恢复一次 Team Session，再把状态和回复送回 Room。多 Agent Discussion 在 Room 中表现为 Agent 直接对话；同一逻辑轮次使用 durable parallel Wave 并发唤醒经当前 Room/Task 权限校验的参与者，后续 Wave 可依据冻结策略和最高优先级未决问题确定性聚焦。中央 Orchestrator 在 all-settled barrier 后依据进展、预算和策略决定下一步，不建立 Bridge 间直连，也不调用模型选择参与者。

MCP 仅负责“运行中的 Agent 主动使用 Team 能力”，例如读取 Room、发送消息和 handoff。MCP Server 不能可靠地凭空启动 Codex Turn，因此主动唤醒由中央服务与 Bridge 之间的 WebSocket 通道承担。

最终边界：

- 中央 Web 是唯一 Team 对话入口和协作状态权威。
- 现有 Codex、WorkBuddy、Claude Code 等继续负责模型、工作区、工具、权限和审批。
- Bridge 是轻量 Runtime Bridge，不是新的 Agent 平台或远程管理 Gateway。
- 客户端接入以配置、Skill、MCP 或已有机器协议为主，不 fork 客户端源码。
- 没有可编程启动接口的 Runtime 仍可作为 manual participant 加入 Team。
- Agent 只提交评估和建议；中央 Orchestrator 拥有 Discussion 流程决策权，用户拥有最终控制权。当前语义 evaluator 仅定义 standalone evidence contract，未接入 Orchestrator，也不会调用额外模型。

## 2. 产品目标与非目标

### 2.1 目标

1. 在中央 Web Room 中创建由人和 Agent 组成的 Team。
2. 使用 `@Alice/Coder`、`@Bob/Reviewer` 等稳定身份路由消息。
3. 让已连接 Bridge 的 Agent 收到 Mention 后自动运行并回复。
4. 让运行中的 Agent 通过 MCP读取 Room 上下文、回复和 handoff。
5. 保持 Agent 的认证、工作目录、工具和审批留在原 Runtime。
6. 安装成本控制为一个 Bridge 二进制和一份可选 MCP/Skill 配置。
7. 支持并行 Wave、all-settled barrier、确定性问题聚焦、自适应结束、停滞检测和人工控制的 Agent-to-Agent Discussion。

### 2.2 非目标

- 不开发 ConveneWire 桌面 GUI。
- 不远程暴露 Codex App Server、CLI 或用户文件系统。
- 不统一不同 Runtime 的内部工具协议。
- MVP 不实现 A2A、CRDT、P2P 历史同步或跨站点 Federation。
- 不接管 Git worktree、Patch、Commit 或 Artifact 生命周期。
- 不承诺把 Team 任务注入用户当前正在浏览的任意客户端会话。
- 不允许 Agent 无限制递归唤醒其他 Agent。

## 3. 核心架构

```text
Browser
  │
  ▼
Central ConveneWire Web
├── Team / Room UI
├── Member / Agent Registry
├── Message / Mention Router
├── Scheduling / Handoff Guardrails
├── Discussion Wave / Barrier / Progress / Budget / Policy
├── Remote MCP Server
├── Bridge WebSocket Server
└── SQLite
       │
       │ outbound WebSocket connection
       ▼
ConveneWire Bridge on each machine
├── Runtime Registry
├── Codex Adapter
├── MCP-native Adapter
└── Generic CLI Adapter
       │ loopback / stdio / local process
       ▼
Existing Runtime
Codex / WorkBuddy / Claude Code / other CLI
```

### 3.1 中央 Web

中央 Web 是协作状态权威，负责：

- Team、Room、Member 和 Agent 管理；
- Room 历史和结构化 Mention；
- Agent Presence 与能力展示；
- 将 Mention 放入目标 Agent inbox；
- 通过已认证 WebSocket 推送给目标 Bridge；
- Agent 回复、状态和 handoff 的持久化与广播；
- 最大接力深度、并发和运行时间限制；
- Discussion Wave 原子规划、并行 Run、barrier、进展投影、预算租约、下一轮决策与 finalization；
- Remote MCP tools 和 resources。

中央服务不直接访问成员机器的 Runtime、Token、工作目录或命令执行环境。

### 3.2 ConveneWire Bridge

每台需要自动接收 Team 任务的机器运行一个 Bridge。Bridge 只负责：

1. 以设备身份连接中央服务；
2. 注册本机可发布的 Runtime/Agent；
3. 接收已路由到本机 Agent 的 Mention；
4. 通过本机 Adapter 启动或恢复 Team Session；
5. 将状态、文本回复和结构化 handoff 回传中央服务。

Bridge 不保存 Room 权威历史，不提供 GUI，不接受其他成员的直接连接，也不自行路由跨机器任务。

### 3.3 MCP 的边界

中央 Web 暴露 Remote MCP Server。MCP tools 用于 Agent 主动操作 Team：

```text
team.get_context
team.get_messages
team.get_mentions
team.send_message
team.reply
team.handoff
team.get_run
```

MCP resources：

```text
team://{teamId}/room/{roomId}
team://{teamId}/room/{roomId}/thread/{threadId}
team://{teamId}/agent/{agentId}/inbox
```

MCP 不负责主动唤醒。通知或订阅只能作为能力增强，不能作为启动新 Agent Turn 的可靠契约。

## 4. 身份与能力模型

### 4.1 对象

| 对象 | 说明 | 关键字段 |
| --- | --- | --- |
| Team | 协作组织 | teamId, name |
| Room | 中央对话空间 | roomId, teamId, name, policy |
| Member | 人类成员 | memberId, displayName, role |
| Device | 运行 Bridge 的机器 | deviceId, ownerMemberId, name, publicKey, status |
| Agent | Team 中可寻址的角色 | agentId, ownerMemberId, deviceId, name, role, mode, capabilities |
| Message | Room 消息 | messageId, roomId, senderRef, content, mentions, parentId |
| Run | Agent 对一次 Mention 的处理 | runId, triggerMessageId, targetAgentId, status, replyMessageId |
| Handoff | Agent 发起的下游委派 | handoffId, parentRunId, targetAgentId, depth |
| Discussion | 中央编排的多 Agent 对话 | discussionId, goal, participants, policy, currentWave, state, reason |
| DiscussionWave | 一次 bulk-synchronous 逻辑轮次 | waveId, ordinal, phase, inputMessageId, expectedMembers, deadline, state |
| DiscussionTurn | Wave 中一个 Agent 成员执行 | turnId, waveId, memberOrdinal, speakerAgentId, runId, outputMessageId, terminalReason |
| ProgressSnapshot | 服务端权威进展投影 | goalCoverage, openQuestions, evidence, plateauCount, version |
| BudgetLedger | 多维预算与租约账本 | logicalWaves, committedAgentRunSlots, tokens, duration, cost, lease, finalizationReserve |

协议始终使用不可变 ID；`Alice/Coder` 只是可修改的显示名。

### 4.2 Integration Mode

| 模式 | 行为 |
| --- | --- |
| managed | Bridge 可通过本机机器接口自动启动或恢复 Runtime |
| manual | Agent 可通过 MCP读取和回复，但需要用户主动打开或领取任务 |

Presence：

- `ready`：Bridge 在线且 Adapter 可接受任务；
- `busy`：正在处理 Team Run；
- `degraded`：Bridge 在线但 Runtime 不可用或能力下降；
- `manual`：只能主动领取；
- `offline`：没有可用 Bridge 或活动连接。

“配置过 MCP”不等于在线。

### 4.3 Runtime Capabilities

```json
{
  "invocationMode": "managed",
  "supportsStart": true,
  "supportsResume": true,
  "supportsStreaming": true,
  "supportsInterrupt": true,
  "supportsHandoff": true
}
```

中央服务只能展示和调用 Agent 已声明的能力，不为低能力 Adapter 模拟不存在的行为。

## 5. 关键流程

### 5.1 发布 Agent

1. 用户在中央 Web 创建 Team 并生成一次性设备邀请码。
2. 本机运行 `convenewire-bridge pair <server-url> <invite-code>`。
3. Bridge 生成设备密钥，交换短期邀请码并取得设备凭据。
4. Bridge 检测或由用户配置本机 Runtime。
5. 用户选择 Agent 名称、角色和 integration mode 后发布。
6. 中央 Registry 将 Agent 绑定到 Member、Device 和 Bridge connection。

### 5.2 用户 Mention Agent

```text
Alice in Web Room
  → sends message mentioning Bob/Backend
  → server stores Message
  → router creates Run
  → inbox stores delivery
  → WebSocket pushes run.requested
  → Bob Bridge accepts
  → Codex Adapter starts Team Session
  → streaming status/reply returns to Room
```

中央服务必须先持久化再推送。Bridge 使用 `runId` 幂等接受；重复推送返回已有状态，不重复启动 Runtime。

### 5.3 Agent 回复与 Handoff

Runtime 输出普通回复时，Bridge 将其作为 `run.reply` 回传。若 Runtime 通过 MCP调用 `team.handoff`：

1. 中央服务校验目标 Agent；
2. 校验 parentRun、Room、最大深度和剩余预算；
3. 创建 child Run；
4. 由中央 Router 推送到目标 Bridge。

Agent 不直接连接其他 Bridge。默认最大 handoff depth 为 4，最大 unique agents 为 5，单次 Run 最长 20 分钟。

### 5.4 Agent-to-Agent Discussion

Discussion 与 Handoff 分开建模。Handoff 是禁止重复 Agent 的委派 DAG；Discussion 可以在后续逻辑轮次再次使用同一 Agent。一个普通逻辑轮次是 durable **Wave**：中央服务冻结统一输入锚点，原子写入 Wave 及每位合格参与者的 member Turn，再为这些 Turn 并发创建普通 Run。每个回复仍持久化为 Room Message。

控制链固定为：

```text
Agent Run Reports（非权威证据）
→ durable all-settled Wave barrier
→ Progress Evaluator（每个 Wave 一次版本化投影）
→ Policy Engine（权威决策）
→ Run Orchestration（可靠并行执行）
→ Room Message（可见对话）
```

MVP 的合格参与者必须存在、处于 enabled 状态且与 Room 属于同一 Team；presence、Owner 身份和 remote-wake capability 不改变这一资格判断。同一 Wave 的所有合格参与者共享冻结输入，Reviewer 也在该普通 Wave 中独立贡献，不能看见本 Wave 内尚未产生的同伴回复。Reviewer approval 只是 require-review policy 可消费的非权威证据，不会创建串行 review Wave；finalization 是单成员 Wave，并优先选择仍合格的 Reviewer，否则选择首位合格参与者。

回复到达即按持久化到达顺序在 Room 展示，但只有全部成员终态或 deadline 处理完成后，barrier 才能关闭。全成功记为 `completed`；至少一个成功记为 `partial`，仅按固定 participant ordinal 聚合成功结果；全部执行失败或过期则进入 `waiting_human`，不伪造进展；用户立即取消导致的全员 canceled 则保持 Discussion terminally `canceled`。

普通 Wave 关闭前，服务端以 Wave ID 派生稳定 ID，幂等写入一个 `wave_result` system Message。该 Message 按 participant ordinal 记录 member terminal state，并作为下一 Wave 的 input anchor。下一次 Run instruction 另行构造最多 24 条 Message 的 bounded transcript，其中成功 Agent 输出按 Wave/member ordinal 排列；它不会重写 Room 中已持久化的到达顺序。

普通 Wave deadline 是 Discussion 总 deadline 与 `waveTimeoutSeconds` 的较早者。deadline 到达时，未接收的 queued Run 进入 `expired`，已接收或 working Run 进入 `outcome_unknown`。Runtime 报告 `input_required` 时，当前实现将该 Run 收敛为 unknown terminal outcome，并持久化 `input_required` reason；Discussion 继续等待同 Wave 其他成员终态，之后再按 policy priority 进入 `waiting_human` 或更高优先级状态。

Agent 可报告目标满足度、置信度、问题、证据和建议，但不能直接设置下一状态或增加预算。仓库中的 `SemanticEvaluator` 目前只是 standalone 接口、规范化函数和契约测试，尚未注入 Discussion Orchestrator，因此 MVP 不会额外调用模型。未来接入时，它也只能返回规范化证据或 recommendation，不能选择 action 或写状态。中央 deterministic Orchestrator 综合系统事实、Agent Assessment、进展和预算，唯一决定 `continue`、`wait_human`、`pause`、`finalize`、`cancel` 或 `terminate`。

Discussion Budget 同时记录 logical Waves、committed member execution slots、tokens、elapsed duration 和 estimated cost，并以短租约分段授权。一个普通 Wave 只消耗一次逻辑轮次预算，但按其持久化的 expected member 数量增加 `agentRunsUsed`；该字段表示已承诺的执行容量，不保证每个 slot 都启动了物理 Runtime 进程。MVP 尚未聚合 member token/cost telemetry，未知值保持 unknown。软边界要求解释当前进展并等待扩展；硬边界停止新普通 Wave。Finalization 使用普通 Wave 不可消费的独立 reserve，确保预算耗尽后仍能输出结论、Artifact、Decision Record 或 unresolved issues。

连续多个 Wave aggregate 没有解决重要问题、增加有效证据、改变决策或降低分歧时形成 plateau。若没有高优先级未决问题，可自动 finalizing；否则进入 `waiting_human`，不能错误宣称完成。完成、暂停和本轮后停止在当前 Wave barrier 生效；立即取消同时中断全部 active member Runs。

每个 member Run 使用稳定 `turnId` 作为唯一 `orchestrationKey`。重启恢复可以精确重建缺失 Run，而不通过 input Message 与 Agent 猜测；Wave closure、进展、预算、决策和 next Wave 由 aggregate version 原子 fencing，重复 callback 不会推进两次。

详细契约见 [Discussion Orchestration Module](docs/modules/discussion-orchestration.md)、[ADR-0011](docs/adr/0011-central-orchestrator-controls-discussion.md) 与 [ADR-0012](docs/adr/0012-parallel-discussion-waves.md)。

### 5.5 离线行为

目标 Agent 离线时：

- Message 正常保存在 Room；
- Run 状态为 `queued`；
- Web UI 显示“等待目标 Agent 上线”；
- Bridge 重连后中央服务重新投递；
- 用户可以取消 queued Run。

## 6. Run 状态与可靠投递

Run 状态：

```text
queued
  → delivered
  → working
      ├── input_required
      ├── completed
      ├── failed
      ├── canceled
      └── outcome_unknown
```

规则：

- 中央服务拥有 Run 状态权威。
- Bridge 接受任务后必须回传 `run.accepted`。
- 中央服务在未收到 ACK 时允许重发同一 `runId`。
- Bridge 必须持久化最近处理的 `runId`，保证重复投递不重复执行。
- Runtime 已启动但 Bridge 无法确认结果时使用 `outcome_unknown`，不自动重跑。
- 取消请求和完成事件竞态时，以 Bridge 已持久化的第一个终态为准。
- 每个 Run 事件包含单调递增的 `sequence`；中央服务忽略旧 sequence。

Discussion 使用独立状态机，不向 Run 状态添加讨论语义：

```text
active
├── stop_requested
├── waiting_human
├── awaiting_extension
├── paused
├── finalizing → completed
├── canceled
└── finalizing → terminated
```

状态与原因分离。`goal_satisfied`、`user_requested_finish`、`discussion_plateau`、`soft_budget_exhausted`、`hard_budget_exhausted`、`policy_violation` 和 `runtime_failure` 是原因，不是状态。

Discussion state 不随单个 member Run callback 提前推进。普通 Wave 在 all-settled barrier 关闭后只提交一次 ProgressSnapshot、Budget event 和 OrchestrationDecision。`finish`、`stop_after_turn`（UI 表述为“本轮后停止”）和 `pause` 在 Wave 边界生效；`cancel` 立即作用于该 Wave 的全部 active member Runs。

## 7. Runtime Adapter

### 7.1 统一接口

```text
discover() -> RuntimeInfo[]
capabilities() -> RuntimeCapabilities
start(runContext) -> SessionRef
resume(sessionRef, runContext) -> SessionRef
events(sessionRef) -> stream RuntimeEvent
interrupt(sessionRef) -> Result
dispose(sessionRef) -> Result
```

### 7.2 Codex Adapter

- 优先使用 Codex 已提供的本机机器协议。
- 仅通过 loopback、stdio 或本地 IPC访问 Runtime。
- Codex 登录态和认证材料不发送到中央服务。
- Team Run 使用由 Bridge 管理的 Session；MVP 不保证附着到用户当前可见会话。
- Adapter 固定兼容版本并提供 contract tests。
- Native 能力不可用时可降级为 Generic CLI，但 UI 必须展示能力下降。

### 7.3 MCP-native Runtime

MCP-native 客户端通过 ConveneWire MCP Tools 主动加入和操作 Team。若客户端没有被外部启动或恢复的接口，则注册为 `manual`，不能宣称自动唤醒。

### 7.4 Generic CLI

Generic CLI Adapter 使用用户明确配置的命令模板启动进程，可收集 stdout、退出码和超时。它不提供结构化 session resume、tool telemetry 或 approval。

## 8. 安全边界

MVP 安全原则：

- Bridge 只建立到中央服务的 outbound connection。
- 中央服务不能直接访问 Runtime 端口或本机文件。
- 设备通过一次性邀请码注册，后续使用独立设备凭据。
- Member 移除、Device revoke 或 Agent disable 后立即停止新任务投递。
- 每次 Run 明确记录 requester、target Agent、trigger Message、Bridge 和结果。
- Room Context 仅向目标 Agent传递完成任务所需的最小消息窗口。
- 日志和消息进入中央服务前过滤 token、credential 和明显的本机敏感路径。
- Bridge 只允许启动 Owner 显式发布的 Runtime 配置。

现有 Runtime 的命令、网络、文件与审批策略继续由 Runtime 和 Owner 控制。Bridge 不绕过本机审批。

## 9. 技术选型

### 9.1 中央 Web

| 领域 | 选择 |
| --- | --- |
| Runtime | Node.js 22 + TypeScript |
| HTTP/MCP | Fastify + MCP TypeScript SDK |
| Realtime | WebSocket |
| Frontend | React + Vite |
| State | SQLite（MVP） |
| Validation | JSON Schema |
| Tests | Vitest + Playwright |

选择 Node.js/TypeScript 是因为中央服务是 Web 产品，Room UI、Realtime、MCP Server 和共享契约可以保持在同一类型系统中。

### 9.2 Bridge

| 领域 | 选择 |
| --- | --- |
| Language | Go |
| Distribution | 单一无界面二进制 |
| Transport | WebSocket client + HTTPS |
| Runtime control | stdio / local process / loopback |
| Local state | 小型 SQLite 或原子状态文件 |
| Tests | Go test |

选择 Go 是因为 Bridge 的职责是网络连接、进程生命周期和协议转换；单文件分发能降低客户端接入成本。Rust 和 Python 不进入 MVP 主运行链路。

### 9.3 Repository Layout

```text
apps/
  web/                 # React UI
  server/              # Fastify, Room, MCP, Bridge WS
packages/
  contracts/           # JSON Schema and generated TypeScript types
bridge/
  cmd/convenewire-bridge/
  internal/runtime/
  internal/transport/
  internal/state/
tests/
  e2e/
```

## 10. 中央服务接口

### 10.1 Web APIs

```text
POST /api/teams
POST /api/teams/:teamId/rooms
GET  /api/rooms/:roomId
POST /api/rooms/:roomId/messages
GET  /api/rooms/:roomId/messages
GET  /api/rooms/:roomId/agents
POST /api/rooms/:roomId/discussions
GET  /api/discussions/:discussionId
POST /api/discussions/:discussionId/actions
POST /api/runs/:runId/cancel
POST /api/devices/invitations
POST /api/devices/:deviceId/revoke
```

### 10.2 Realtime

```text
WS /ws/rooms
WS /ws/bridge
POST /mcp
```

Bridge 消息最小集合：

```text
bridge.hello
bridge.heartbeat
agent.publish
agent.status
run.requested
run.accepted
run.status
run.reply
run.handoff_requested
discussion.progressed
discussion.decision_made
discussion.state_changed
```

所有消息包含 `protocolVersion`、`messageId`、`timestamp` 和相关实体 ID。

## 11. MVP 路线

| 阶段 | 交付 | 完成定义 |
| --- | --- | --- |
| P0 | Contracts + Fake Bridge | Web 中可创建 Room 并模拟两个 Agent |
| P1 | Room + Mention Router | `@agent` 创建可观察 Run |
| P2 | Go Bridge + Pairing | 远端 Bridge 可发布 Agent 并保持 Presence |
| P3 | Codex Adapter | Mention 可启动一个受 Bridge 管理的 Codex Team Session |
| P4 | Streaming + Reply | Web 实时展示 Agent 状态和回复 |
| P5 | MCP Server + Skill | 运行中的 Agent 可读取 Room、回复和 handoff |
| P6 | Recovery | Bridge 重连、重复投递和中央服务重启可恢复 |
| P7 | Multi-Agent Handoff | 三个 Agent 在深度限制内完成接力 |
| P8 | Additional Runtime | 接入一个 MCP-native 或 Generic CLI Runtime |
| P9 | Adaptive Agent Discussion | Codex 与 Pi 在 durable parallel Waves 中并发贡献，后续 Wave 可在权限和预算内确定性聚焦，经 barrier、中央策略和 finalization 收敛 |

## 12. 测试与验收

### 12.1 测试矩阵

- Room：并发消息、结构化 Mention、同名 Agent、消息回复。
- Routing：Agent offline、disabled、manual、busy、重复 Mention。
- Bridge：断线重连、心跳过期、设备 revoke、协议版本不兼容。
- Delivery：ACK 丢失、重复推送、旧 sequence、取消与完成竞态。
- Runtime：启动失败、进程退出、超时、无法 resume、输出过大。
- MCP：未授权访问、错误 Room、缺失能力、manual participant。
- Handoff：未知目标、循环、深度超限、unique agents 超限。
- Discussion：parallel Wave fan-out、callback 排列、all-settled、确定性 participant selection、权限撤销、selection digest/recovery、partial/all-failed、提前完成、有效续租、低收益 plateau、高优先级未决问题、软预算扩展、硬预算与 finalization reserve。
- Discussion Control：Agent 伪造完成、standalone semantic contract 拒绝 state/action、过期决策、重复 terminal callback、logical Wave 与 committed member slot 计量、用户控制的 Wave 边界、cancel-all、Reviewer approval 可选策略。
- Discussion Recovery：`QA-010` 必须验证 Run 创建前、partial barrier、barrier 已关闭且 next Wave 已提交三个真实 restart cut point，以及 `wave_result` 重试均不重复执行或推进；通过前不宣称 recovery gate 完成。
- Security：伪造 Bridge、重放消息、越权 Room、敏感信息过滤。

### 12.2 MVP 验收

1. 中央 Web 可创建 Team、Room、Member 和 Agent。
2. 两台机器的 Bridge 可通过邀请码连接并发布 Agent。
3. Alice 在 Web Room 中 `@Bob/Backend` 后，Bob Bridge 收到唯一 Run。
4. Bob Bridge 启动一个受管理的 Codex Team Session。
5. Alice 在 Web 中实时看到 queued、working 和 completed 状态及回复。
6. Bob 离线时 Run 排队，重连后只执行一次。
7. Codex 可通过 MCP读取 Room Context 并发送回复。
8. Bob Agent 可 handoff 给 Carol Agent，且中央服务执行深度与循环限制。
9. Device revoke 后不能接收新 Run。
10. 中央服务重启后 Room、Message、Run 和 pending delivery 可恢复。
11. 用户可发起 Codex 与 Pi Discussion；初始普通 Wave 并发贡献，后续 Wave 可从最高优先级未决问题、报告者和角色确定性选择当前有权参与的子集；Room 实时展示各自回复和 barrier 状态；简单目标提前结束，复杂目标在有进展时续租，partial/all-failed、plateau 和用户控制均确定收敛，且 callback 或重启不会重选已提交成员或重复创建下一 Wave。

## 13. 后续演进

### 13.1 Governed Software-Team Execution Core

MVP 之后的受控软件团队执行遵循
[ADR-0039](docs/adr/0039-keep-repositories-client-owned.md)：Central 负责 Plan、
调度、授权、Evidence/Proof/Adoption 与 operation receipt；Client/Bridge 在
Owner 本地授权下负责 Repository path、Git remote、Git/SSH credential、
fetch/pull/push、worktree 和全部 Git command execution。Central approval
不能替代 Owner 对机器和 Repository 的最终控制。

`EXEC-005` Plan supersession/evidence carry-forward/bounded replanning、
`DISC-011` focused participant selection、`DISC-012` read-only quorum、
`QA-054` bounded-autonomy 产品验收和 `QA-055` EX-01 至 EX-14 最终审计均已
完成。当前 bounded Governed Software-Team Execution Core 主线已闭环；新增
产品范围必须重新立项，不能从 Optional Remote Evidence 隐式扩权。

### 13.2 Optional Remote Evidence Extensions

已完成的 `REPO-003`、`REPO-005` 和 `SEC-014` 作为可选扩展保留实现、
测试、迁移与验收历史。默认安装不配置 Remote Provider credential，也不
主动访问外部 Provider；扩展未启用不影响 Core readiness 或完成度。

GitHub/GitLab adapter、PR lifecycle、webhook、push、remote merge 和
provider credential Web UI 暂停，除非以后基于明确产品需求重新立项。

### 13.3 Other Future Evolution

只有在 Core Team 协作有效后才考虑：

- 独立 Team Coordinator 集群与 PostgreSQL；
- Slack、飞书、Discord 等额外人类消息入口；
- A2A interoperability；
- Artifact、Patch 和结构化结果；
- Team policy 与更细粒度的数据出站控制；
- 对用户当前可见 Runtime Session 的稳定附着；
- WAN relay 和企业身份提供方。

## 14. Clean-room 策略

- 不复制 Hermes Studio 的 BSL 源码、UI、资源或内部实现。
- 仅依据公开产品行为、开放协议与本文契约独立实现。
- 新增第三方依赖记录许可证和版本。
- Mention routing、handoff 和 recovery 使用自有 schema 与测试。
- 商业发布前执行代码 provenance 和依赖许可证审计。

## 15. 架构决策

| 编号 | 决策 |
| --- | --- |
| ADR-001 | 中央 Web 是唯一 Team 对话和协作状态权威 |
| ADR-002 | 不开发独立客户端 GUI |
| ADR-003 | MCP 负责 Agent 主动使用 Team 能力，不承担唤醒 |
| ADR-004 | WebSocket + Bridge 负责中央服务主动唤醒 |
| ADR-005 | Bridge 是轻量 Runtime Bridge，不是完整 Gateway |
| ADR-006 | 所有跨 Agent handoff 由中央 Router 调度 |
| ADR-007 | managed 与 manual participant 明确区分 |
| ADR-008 | MVP 不使用 A2A，不接管 Workspace 和 Artifact |
| ADR-009 | 中央 Web 使用 Node.js/TypeScript，Bridge 使用 Go |
| ADR-010 | Hermes Studio 仅作行为参考，采用 clean-room 自研 |
| ADR-011 | Agent 提供评估，中央 Orchestrator 依据进展、预算和策略控制 Discussion |
| ADR-012 | Discussion 使用 durable bulk-synchronous parallel Waves 与 all-settled barrier |

## 16. 参考资料

- [Hermes Studio Group Chat 运行链路](https://github.com/EKKOLearnAI/hermes-studio/blob/main/docs/cli-chat-sessions.md)
- [Hermes Studio Repository and License](https://github.com/EKKOLearnAI/hermes-studio)
- [Model Context Protocol 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [OpenAI API MCP Tools](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

一句话定义：**ConveneWire 是中央 Web 上的轻量 Team 协作层；MCP 让 Agent 使用 Team，Bridge 让 Team 唤醒 Agent。**
