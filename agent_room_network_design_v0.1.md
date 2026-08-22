**Agent Room Network**

局域网多同事 · 多 Agent · 多 CLI 协作网络

**产品与系统设计方案 v0.1**

设计基线：Room + A2A + MCP + Local Agent Gateway

| **项目** | **内容**                                                                            |
|----------|-------------------------------------------------------------------------------------|
| 文档状态 | Architecture / Product Design Draft                                                 |
| 日期     | 2026-08-22                                                                          |
| 目标     | 定义一套可商业化、clean-room 自研的局域网 Agent 协作产品方案                        |
| 核心命题 | 每个工程师拥有自己的 AI Agent；这些 Agent 可跨机器、跨 CLI 在同一 Team Room 中协作  |
| 协议边界 | Room 负责协作语义；A2A 负责任务委派；MCP 负责工具与资源；Gateway 负责本机执行和安全 |

声明：本文件中的许可证分析用于工程与产品风险判断，不构成法律意见。正式商业发布前应由专业法律顾问复核。

# 目录

- 1\. 执行摘要

- 2\. 背景、问题与产品机会

- 3\. 产品原则与非目标

- 4\. 核心产品模型：Team / Room / Member / Device / Agent

- 5\. 总体系统架构

- 6\. 协议分层：Room、A2A、MCP

- 7\. 核心问题：如何通知并唤醒 A 的 Codex

- 8\. Agent Gateway 设计

- 9\. Agent 发布、发现、Presence 与离线队列

- 10\. Runtime Adapter：Codex、WorkBuddy 与其他 CLI

- 11\. 多同事、多 Agent 协作与 Handoff

- 12\. Workspace、Project Identity 与 Artifact

- 13\. 安全、权限、审批与审计

- 14\. Room Coordinator 与事件模型

- 15\. 数据模型与协议对象

- 16\. 关键 API / A2A / MCP 接口草案

- 17\. UX / UI 设计

- 18\. 故障、恢复与一致性策略

- 19\. 部署拓扑与网络方案

- 20\. MVP 开发路线

- 21\. 测试、可观测性与验收标准

- 22\. Hermes Studio 许可证与 clean-room 策略

- 23\. 关键架构决策记录（ADR）

- 24\. 后续演进路线

- 附录 A：事件与状态机

- 附录 B：参考资料

# 1. 执行摘要

| **最终架构定稿：Room 协调人类协作，A2A 协调 Agent 任务，MCP 为 Agent 提供工具与资源；每台机器上的 Local Agent Gateway 是唯一对外网络边界。** |
|----------------------------------------------------------------------------------------------------------------------------------------------|

本项目拟构建一个 local-first 的 Agent 协作网络。团队成员无需统一使用同一个 AI 产品，也无需把本机代码、凭证或 CLI 暴露给同事。每个人只需运行一个本地 Agent Gateway，并选择将哪些 Agent 发布到团队。

用户在 Team Room 中通过自然的 @mention、reply、handoff 与 thread 交互。例如，Alice 可以直接输入“@Bob/Backend 检查 payment callback”，Room Coordinator 解析结构化目标，向 Bob 机器上的 Gateway 发起 A2A Task；Bob Gateway 再调用本机 Codex / Claude Code / WorkBuddy / 其他 CLI。执行过程以 Run、Artifact、Diff、Approval 等统一对象回流到 Room。

- Agent 不直接暴露到局域网；Gateway 暴露 Agent。

- Agent 归属于 Member，并运行在明确的 Device 上。

- 跨机协作默认传递 Task、Artifact、Patch、Commit 与 Context，而不是共享远程文件系统。

- A2A 解决 Agent 身份、Agent Card、Task、Streaming、Push Notification 等 Agent-to-Agent 协作问题。

- MCP 解决 Agent 使用工具、读取资源、访问业务系统、连接 WorkBuddy 等能力接入问题。

- Codex 等拥有原生机器协议的 Runtime 由 Gateway 使用 Native Adapter 驱动；不强迫所有本地 Runtime 内部统一 MCP。

- 商业版本不复制 Hermes Studio 当前 BSL 代码，采取 clean-room 自研。

# 2. 背景、问题与产品机会

## 2.1 现状

当前团队使用 AI Coding Agent 时，协作通常仍以“每个人各自拥有自己的 Agent”为主。Alice 的 Codex、Bob 的 WorkBuddy、Carol 的 Claude Code 彼此隔离。团队成员通过聊天工具、Git、PR 或人工复制粘贴在不同 Agent 之间搬运上下文。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>传统协作：<br />
<br />
Alice/Codex ──输出──&gt; Alice ──复制/转述──&gt; Bob ──输入──&gt; Bob/WorkBuddy<br />
│<br />
└──再人工搬给 Carol/Claude</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

这个模式的瓶颈不是模型能力，而是 Agent 之间缺少统一的“组织关系、发现、委派、状态、工件和安全边界”。人类因此被迫成为 Agent 之间的 USB 闪存盘。

## 2.2 产品机会

如果将“人拥有 Agent”设为一级产品模型，则团队中的 Agent 可以像其主人一样组成团队。Room 将协作从单用户 Agent 提升为 Multi-Human + Multi-Agent：

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Team Room<br />
├─ Alice<br />
│ ├─ Architect (Claude)<br />
│ └─ Coder (Codex)<br />
├─ Bob<br />
│ ├─ Backend (Codex)<br />
│ └─ WorkBuddy<br />
└─ Carol<br />
└─ Reviewer (Claude Code)</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

由此产生的产品价值不只是“多机跑 Agent”，而是跨机器委派、跨 CLI handoff、共享 Room Memory、Artifact 驱动的协作，以及明确的 Owner-based 权限模型。

# 3. 产品原则与非目标

## 3.1 设计原则

| **原则**           | **定义**                      | **设计含义**                                 |
|--------------------|-------------------------------|----------------------------------------------|
| Owner First        | Agent 永远有明确 Owner        | 远程请求不能绕过 Owner 的本机策略            |
| Gateway Boundary   | 局域网只暴露 Gateway          | CLI、Token、App Server 不直接对外暴露        |
| Artifact over FS   | 跨机传递工件而非共享磁盘      | 默认使用 Patch / Commit / File / Report      |
| Structured Routing | @mention 是结构化路由         | UI 文本与协议 identity 分离                  |
| A2A for Work       | Agent 任务通过 A2A            | Task、Streaming、Push、Agent Card 可复用标准 |
| MCP for Capability | 工具/资源统一 MCP             | 业务系统、WorkBuddy、内部工具可标准化接入    |
| Runtime Native     | 本机 Runtime 用最优接口       | Codex App Server 优先于套壳 CLI              |
| Local-first        | 代码与执行尽量留在 Owner 机器 | Room 只拿必要上下文、状态、Artifacts         |
| Observable         | Agent 自主但可观察            | Run、Tool、Approval、Diff、Lineage 可见      |

## 3.2 非目标

- MVP 不做完全去中心化 P2P 历史同步或 CRDT。

- MVP 不尝试把所有 Agent Runtime 改造成 MCP Server。

- MVP 不直接共享同事完整文件系统。

- MVP 不提供无审批的远程 shell。

- MVP 不要求 Agent 之间共享相同模型、Provider 或 CLI。

- MVP 不追求替代 Git / PR；而是把 Agent 产物更自然地送入这些既有工程流程。

# 4. 核心产品模型：Team / Room / Member / Device / Agent

## 4.1 四层身份

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Member<br />
└─ Device<br />
└─ Agent<br />
└─ Runtime<br />
<br />
示例：<br />
Bob<br />
└─ Bob-MacBook<br />
└─ Backend<br />
└─ Codex App Server</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

四层身份必须分开。否则在“Bob 的 Codex 在 Bob 的 Mac 上为 Alice 的任务创建一个隔离 worktree”这样的场景里，权限、路由、审计和 UI 很快会混成一团。

| **对象**   | **职责**                   | **示例字段**                                                  |
|------------|----------------------------|---------------------------------------------------------------|
| Member     | 人类团队成员 / Agent Owner | memberId, name, avatar, teamRole                              |
| Device     | 实际执行机器               | deviceId, ownerMemberId, hostname, os, gatewayVersion, online |
| Agent      | 团队可寻址的协作成员       | agentId, ownerMemberId, deviceId, name, role, skills          |
| Runtime    | 实际执行后端               | runtimeType, version, adapter, authMode                       |
| Room       | 协作与可见历史             | roomId, projectId, members, agents, threads                   |
| Task / Run | 一次 Agent 工作单元        | taskId, targetAgentId, status, lineage, artifacts             |

## 4.2 Agent 的产品身份

Agent 在 UI 中不应首先显示“模型名”，而应显示角色与归属。例如：

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Bob / Backend<br />
Codex · Bob-MacBook · LAN<br />
Skills: backend, tests, database<br />
Status: Ready</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

底层模型与 Runtime 是技术属性，角色才是协作属性。一个团队更自然地说“@Bob/Backend”，而不是“@gpt-5.6-codex-instance-3”。

# 5. 总体系统架构

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>┌──────────────────────────────┐<br />
│ Room Coordinator │<br />
│ Messages / Presence / Event │<br />
│ Agent Registry / Routing │<br />
│ Offline Queue / Lineage │<br />
└──────────────┬───────────────┘<br />
│<br />
A2A Task / Room realtime<br />
┌───────────────────┼───────────────────┐<br />
│ │ │<br />
┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐<br />
│Alice Gateway│ │ Bob Gateway │ │Carol Gateway│<br />
│ A2A S/C │ │ A2A S/C │ │ A2A S/C │<br />
│ Permission │ │ Permission │ │ Permission │<br />
│ Adapters │ │ Adapters │ │ Adapters │<br />
└───┬────┬────┘ └───┬────┬────┘ └───┬────┬────┘<br />
│ │ │ │ │ │<br />
Codex Claude WorkBuddy Codex Claude Custom<br />
│ │ │<br />
└──── MCP / local tools / workspace ──┘</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 5.1 Room Coordinator

- 保存 Room 可见历史与结构化事件。

- 维护 Member / Device / Agent Registry 与 Presence。

- 将 @mention / reply / handoff 解析成目标 Agent identity。

- 根据 Registry 路由 A2A Task 到目标 Gateway。

- 为离线 Agent 保存 Pending Delivery。

- 维护 Task lineage、Thread、Artifact metadata 与审计事件。

- MVP 采用单 Coordinator，避免一开始引入 CRDT / consensus。

## 5.2 Agent Gateway

- 设备身份、局域网发现与可信配对。

- 对外作为 A2A Server，接收发给本机已发布 Agent 的 Task。

- 对外/对内作为 A2A Client，可代表本机 Agent handoff 到其他 Agent。

- 维护 Agent Registry、Runtime Adapter、Workspace Registry。

- 执行 Owner 本机权限策略并呈现审批。

- 负责 Native / MCP / CLI Runtime 的生命周期。

- 将本地 Runtime 事件转换为统一 Run / Artifact / Approval 事件。

## 5.3 Runtime

Runtime 是 Codex、Claude Code、WorkBuddy、Gemini CLI、自研 Agent 等真实执行环境。Runtime 不需要理解整个团队网络；它只与本机 Gateway 交互。

# 6. 协议分层：Room、A2A、MCP

| **层**          | **负责什么**                                   | **不负责什么**           | **典型对象**                                    |
|-----------------|------------------------------------------------|--------------------------|-------------------------------------------------|
| Room 产品层     | 人类协作语义                                   | 底层 CLI 细节            | Room, Message, Mention, Thread, Member, Lineage |
| A2A             | Agent-to-Agent 身份、Task、状态、Artifact 传递 | Agent 内部工具体系       | Agent Card, Task, Message, Artifact, Streaming  |
| MCP             | Agent 使用工具与资源                           | 团队成员关系与 Room 历史 | Tools, Resources, Prompts, Tasks/Extensions     |
| Runtime Adapter | 本机真实 Agent 驱动                            | 跨机身份与发现           | Codex App Server, CLI PTY, WorkBuddy MCP        |

## 6.1 为什么 A2A 和 MCP 同时存在

A2A 更适合“谁来做这项工作、任务现在什么状态、结果是什么”；MCP 更适合“做这项工作时可以调用哪些工具与资源”。二者不是竞争关系，而是上下两层。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Human:<br />
@A/Codex 检查 payment callback<br />
│<br />
▼<br />
Room → A2A Task → A Gateway → Codex<br />
│<br />
└─ MCP → DB / Docs / GitHub / internal tools</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 6.2 为什么不让所有 Runtime 内部也强制 MCP

Codex 等 Runtime 已拥有更丰富的机器协议。Gateway 应优先使用原生协议获取 session、streaming、approval、tool events、diff 等能力；再由 Gateway 对上层转换为 A2A / Room 对象。强制 Runtime 内部也走 MCP 会丢失能力并增加不必要的协议套娃。

# 7. 核心问题：如何通知并唤醒 A 的 Codex

| **关键答案：不是 Codex 自己监听局域网，而是 A 的 Gateway 常驻监听。Room 找到的是 A/Codex 的 Agent identity；A2A 请求发给 A Gateway；Gateway 再唤醒或恢复本机 Codex。** |
|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

## 7.1 发布阶段

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>A 打开客户端<br />
↓<br />
Gateway 发现 Codex<br />
↓<br />
A 选择 [Publish to Team]<br />
↓<br />
Gateway 发布逻辑 Agent Card:<br />
name = A / Codex<br />
skills = coding, review, tests<br />
endpoint = A Gateway A2A endpoint<br />
agentId = agent:a:codex</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 7.2 Alice 发起任务

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Alice 输入：<br />
@A/Codex 修一下 auth<br />
<br />
UI 保存：<br />
mentions = [{ type: "agent", agentId: "agent:a:codex" }]<br />
<br />
Room Coordinator:<br />
agent:a:codex<br />
→ owner = A<br />
→ device = A-Mac<br />
→ A2A endpoint = https://A-Mac.local:9271/a2a<br />
→ online = true<br />
<br />
Coordinator:<br />
SendMessage / Create Task<br />
↓<br />
A Gateway</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 7.3 Gateway 唤醒 Runtime

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>A Gateway<br />
↓ lookup local registry<br />
agent:a:codex → CodexAdapter<br />
↓<br />
if app-server alive:<br />
resume/create thread<br />
else:<br />
start codex app-server<br />
create thread<br />
↓<br />
run task in approved workspace</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 7.4 状态回传

A2A 当前支持 Task 生命周期、Streaming、Polling 与 Push Notification。交互式场景优先使用 streaming；离线或长任务可使用 push notification / webhook 或 Coordinator 自己的 durable task state。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Codex event<br />
→ CodexAdapter<br />
→ Gateway<br />
→ A2A TaskStatus / Artifact update<br />
→ Room Coordinator<br />
→ Room UI<br />
<br />
A · Codex<br />
● Running<br />
✓ Read auth.ts<br />
✓ Reproduced<br />
● Running tests...</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 7.5 A 电脑离线

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Registry:<br />
A / Codex ○ Offline<br />
<br />
Alice 仍然 @A/Codex<br />
↓<br />
Room creates Pending Delivery<br />
↓<br />
A Gateway online<br />
↓ presence update<br />
↓<br />
Coordinator delivers A2A Task<br />
↓<br />
Codex starts</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

这样用户面对的是“已排队，等待 A 的设备上线”，而不是 \`ECONNREFUSED\`。后者虽然诚实，但不是产品。

# 8. Agent Gateway 设计

## 8.1 模块

| **模块**           | **职责**                                    |
|--------------------|---------------------------------------------|
| Device Identity    | 设备密钥、证书、指纹、设备 Owner            |
| Discovery          | mDNS / Bonjour 服务广播与扫描               |
| Pairing            | 人工确认、配对码、公钥交换、信任存储        |
| A2A Endpoint       | 接收/发送 Agent Tasks、Streaming、Artifacts |
| Agent Registry     | 维护已检测、已发布、已禁用 Agent            |
| Runtime Manager    | 创建、恢复、停止本地 Runtime session        |
| Adapter Host       | Codex / WorkBuddy / CLI / SDK 适配器        |
| Permission Engine  | 工作区、命令、网络、安装等授权              |
| Workspace Registry | repo identity、本地路径、revision、worktree |
| Artifact Store     | Patch、Commit、File、Report、Logs           |
| Audit Log          | 谁请求、谁执行、审批、命令、工件、结果      |

## 8.2 Gateway 是唯一网络边界

不直接将 \`codex app-server\`、WorkBuddy 本地进程或任意 CLI 端口暴露给局域网。Gateway 负责身份验证、ACL、速率限制、审计和版本兼容。即使某 Runtime 支持 WebSocket，也仅在 loopback 或本地 IPC 上使用。

# 9. Agent 发布、发现、Presence 与离线队列

## 9.1 LAN Discovery

推荐 mDNS / Bonjour 仅用于发现 Gateway，不用于发现每个 Runtime。Gateway 广播最小元信息：deviceId、displayName、protocolVersion、port、public-key fingerprint。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>_agentroom._tcp.local<br />
<br />
TXT:<br />
deviceId=bob-mac<br />
version=1<br />
fingerprint=SHA256:...<br />
port=9271</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 9.2 Agent Card

A2A 的 Agent Card 可作为 Published Agent 的对外能力描述。逻辑上每个 Agent 有独立 Card，但多个 Card 可共享同一个 Gateway endpoint。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Bob Gateway: https://bob-mac.local:9271/a2a<br />
<br />
Agent Card A:<br />
agentId = bob/backend<br />
name = Bob / Backend<br />
skills = backend, tests, database<br />
<br />
Agent Card B:<br />
agentId = bob/reviewer<br />
name = Bob / Reviewer<br />
skills = review, security</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 9.3 Presence

Room Coordinator 维护 Device Presence 与 Agent Presence。Agent 状态至少包括：offline、ready、busy、approval_required、degraded。Presence 是产品层状态，不依赖 A2A Task 本身承担。

## 9.4 离线队列

Coordinator 对离线 Agent 保存 Pending Delivery。队列项包含 sender、room、targetAgentId、task summary、createdAt、deadline、dedupeKey 和 requiredProjectIdentity。上线后再投递。

# 10. Runtime Adapter：Codex、WorkBuddy 与其他 CLI

## 10.1 Adapter 统一接口

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>interface AgentRuntimeAdapter {<br />
discover(): AgentRuntimeInfo[]<br />
capabilities(): RuntimeCapabilities<br />
startSession(ctx): Promise&lt;SessionRef&gt;<br />
resumeSession(ref): Promise&lt;void&gt;<br />
run(input): AsyncIterable&lt;RuntimeEvent&gt;<br />
interrupt(runId): Promise&lt;void&gt;<br />
approve(requestId, decision): Promise&lt;void&gt;<br />
clarify(requestId, response): Promise&lt;void&gt;<br />
collectArtifacts(runId): Promise&lt;Artifact[]&gt;<br />
dispose(sessionId): Promise&lt;void&gt;<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 10.2 Codex：Native Adapter（优先级最高）

Codex 当前公开仓库包含 app-server v2 相关协议/schema，并明确将 app-server 用于富客户端。Gateway 应使用本地 \`codex app-server\` 作为 Native Runtime 接口，获取 thread/session、notifications、approvals 与结构化事件。实验性的 app-server daemon 可作为未来远程生命周期参考，但 MVP 不应依赖其不稳定 contract。

- Gateway 检测 Codex binary 与版本。

- 仅本机启动 app-server，优先 stdio / local IPC。

- Codex auth 留在 Owner 机器，Gateway 不上传 token。

- Room 只看到统一的 Run / Tool / Artifact / Approval。

- Codex Adapter 为“黄金标准”集成，用于验证我们完整的 runtime abstraction。

## 10.3 WorkBuddy：MCP Collaboration Adapter

WorkBuddy 官方文档支持配置 MCP Server，并且其插件系统可以捆绑 MCP Server。因此第一版无需远程控制 WorkBuddy 内核：我们为 WorkBuddy 提供一个 Agent Room MCP Server / Connector，使 WorkBuddy 能读取 Room Context、领取任务、回复、handoff、发布 Artifact。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>WorkBuddy<br />
↓ MCP Client<br />
Agent Room MCP Server (local Gateway)<br />
tools:<br />
room.get_context<br />
room.get_mentions<br />
room.send_message<br />
room.handoff<br />
room.publish_artifact<br />
room.get_task</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

若未来 WorkBuddy 提供稳定的 Agent session API，再升级为 Native Adapter。Room 与 A2A 层无需修改。

## 10.4 Generic CLI

只有 stdin/stdout 的 Agent 使用 PTY / stdio Adapter，能力等级较低。我们可以支持 start、stream stdout、interrupt，但不会假装它拥有结构化 approval、diff 或 tool telemetry。

## 10.5 Integration Capability Levels

| **级别**           | **接入形态**          | **能力**                                    | **典型**       |
|--------------------|-----------------------|---------------------------------------------|----------------|
| L1 Native          | 机器协议 / app-server | Start/Resume/Stream/Approval/Diff/Artifacts | Codex          |
| L2 CLI Bridge      | PTY / stdio           | Start/Stream/Interrupt，结构化能力有限      | 未知 CLI       |
| L3 MCP Participant | MCP / Plugin          | Room 参与、Tools、Artifacts、Handoff        | WorkBuddy      |
| L4 Agent SDK       | 官方 Connector SDK    | 由第三方实现完整能力                        | 企业内部 Agent |

# 11. 多同事、多 Agent 协作与 Handoff

## 11.1 @mention

用户界面显示 \`@Bob/Backend\`，实际保存不可歧义的 \`agentId\`。名字只是 display label。

## 11.2 Reply

回复某个 Agent 消息时，Composer 自动带上 structured agent reference。这样“回复”本身就是 continuation/routing affordance。

## 11.3 Handoff

Agent 可以将任务结构化 handoff 给其他 Published Agent。Handoff 不是让模型输出一段 \`@Name\` 文本就自动执行，而是由 Gateway/Room 验证 target identity、权限、depth 与 budget 后建立新 A2A Task。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Alice<br />
└─ Task T1 → Bob/Backend<br />
└─ Handoff T2 → Carol/Reviewer<br />
└─ Feedback → Bob/Backend</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 11.4 Handoff Guardrails

| **约束**                        | **MVP 默认**                            |
|---------------------------------|-----------------------------------------|
| Max Handoff Depth               | 4                                       |
| Max Unique Agents               | 5                                       |
| Max Run Duration                | 20 min（可配置）                        |
| Max Cost / Tokens               | 按团队或 Room 策略配置                  |
| Cross-owner dangerous operation | 目标 Owner 本机审批                     |
| Loop detection                  | 检测重复 agent-task lineage / dedupeKey |

# 12. Workspace、Project Identity 与 Artifact

## 12.1 不共享路径，识别 Project

跨机器路径完全不可靠。Room 应记录 Project Identity，而不是 \`~/project\`。推荐由 repo remote + canonical URL + base revision 生成 project identity。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>ProjectIdentity<br />
repo = github.com/acme/payment-service<br />
baseRevision = a84190f<br />
projectId = SHA256(repo + rootFingerprint)</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 12.2 本机 Workspace Binding

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Bob Device<br />
projectId: payment-service<br />
localPath: /Users/bob/dev/payment-service<br />
revision: a84190f<br />
status: compatible</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 12.3 隔离 Worktree

远程 coding task 默认在本机创建隔离 worktree / branch，避免 Agent 直接污染 Owner 正在编辑的工作区。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Task T-382<br />
→ .agentroom/worktrees/T-382<br />
→ branch agent/bob/T-382<br />
→ Codex edits<br />
→ tests<br />
→ Patch / Commit Artifact</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 12.4 Artifact First

| **Artifact 类型** | **用途**                   | **跨机策略**             |
|-------------------|----------------------------|--------------------------|
| Patch             | 代码变更 review / 继续加工 | 内容寻址 + base revision |
| Commit            | Git 协作                   | hash + repo identity     |
| File              | 文档/配置/图片             | 按需传输                 |
| Test Report       | 验证证据                   | 结构化摘要 + logs ref    |
| Log Excerpt       | 问题分析                   | 最小必要片段             |
| Screenshot        | UI/浏览器证据              | 附件                     |
| Structured Result | 机器继续处理               | JSON Part / resource     |

# 13. 安全、权限、审批与审计

## 13.1 Trust Model

| **局域网 ≠ 可信边界。任何远程任务都必须通过设备身份、配对信任、Agent ACL、Workspace Scope 和 Owner Policy。** |
|---------------------------------------------------------------------------------------------------------------|

## 13.2 Pairing

- Gateway 首次发现后显示设备指纹与一次性配对码。

- 双方人工确认后交换长期设备身份密钥。

- 保存 peer trust record，可手动 revoke。

- 所有后续 Agent Card / A2A endpoint 都绑定设备身份。

## 13.3 Permission Profile

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Backend Agent<br />
<br />
Teammates may:<br />
✓ Ask questions<br />
✓ Read payment-service<br />
✓ Run tests<br />
✓ Create isolated changes<br />
<br />
Ask owner:<br />
○ Install packages<br />
○ External network<br />
○ Docker admin<br />
○ Arbitrary shell<br />
<br />
Never:<br />
✗ ~/.ssh<br />
✗ credential stores<br />
✗ unrelated repositories</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 13.4 Approval Routing

审批应回到执行机器的 Owner。Alice 发送的请求不能让 Alice 自己批准 Bob 机器上的危险命令。Room 可显示审批存在，但最终决策由 Bob Gateway 签署并回给 Runtime。

## 13.5 Audit

每个 Run 持久化：requester、target owner/device/agent、project、base revision、commands、approvals、artifacts、result、duration、error。敏感参数与 token 必须 redact。

# 14. Room Coordinator 与事件模型

## 14.1 为什么 MVP 仍需要 Coordinator

完全 P2P 会立即引入离线消息、成员一致性、历史合并、split brain、冲突解决等复杂问题。MVP 用一个 Room Coordinator 管协作状态，Agent 执行仍保持 local-first。

## 14.2 Event Log

Coordinator 建议采用 append-only event log + projection，而不是散落地修改多个状态表。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>room.created<br />
member.joined<br />
device.paired<br />
agent.published<br />
message.sent<br />
task.created<br />
task.delivered<br />
run.started<br />
approval.requested<br />
artifact.created<br />
handoff.created<br />
run.completed</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

SQLite 足以支持 MVP。未来云端或跨站点同步时，事件模型也更容易做复制与审计。

## 14.3 Realtime Channel

Room 的人类聊天、presence、typing、UI updates 可以使用 WebSocket/SSE 独立 realtime channel；Agent 任务本身使用 A2A。不要强迫 A2A 承担聊天室的所有实时 UI 语义。

# 15. 数据模型与协议对象

| **实体** | **关键字段（示意）**                                                                  |
|----------|---------------------------------------------------------------------------------------|
| Member   | id, displayName, avatar, teamRoles                                                    |
| Device   | id, ownerMemberId, name, publicKey, os, gatewayVersion, presence                      |
| Agent    | id, ownerMemberId, deviceId, name, role, runtimeType, skills, capabilities, published |
| Room     | id, teamId, projectId, name, policyId                                                 |
| Message  | id, roomId, senderRef, content, mentions\[\], parentId, timestamp                     |
| Task     | id, roomId, targetAgentId, requester, status, contextId, lineageId, deadline          |
| Run      | id, taskId, gatewayId, runtimeSessionId, state, startedAt, endedAt                    |
| Artifact | id, runId, type, contentHash, projectId, baseRevision, metadata                       |
| Approval | id, runId, ownerMemberId, action, state, expiresAt                                    |
| Handoff  | id, parentTaskId, childTaskId, sourceAgentId, targetAgentId, depth                    |

## 15.1 Task State

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>queued<br />
↓<br />
delivered<br />
↓<br />
working ───────→ input_required<br />
│ │<br />
│ └── approval/clarification → working<br />
│<br />
├── completed<br />
├── failed<br />
└── cancelled</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

# 16. 关键 API / A2A / MCP 接口草案

## 16.1 Room APIs

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>POST /rooms/:roomId/messages<br />
POST /rooms/:roomId/tasks<br />
GET /rooms/:roomId/events<br />
GET /rooms/:roomId/agents<br />
GET /rooms/:roomId/artifacts/:artifactId<br />
<br />
WS /rooms/:roomId/realtime</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 16.2 A2A Gateway

每个 Published Agent 对外拥有逻辑 Agent Card；服务 endpoint 可共享 Gateway。Coordinator 对目标 Agent 发起 A2A Message/Task。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Agent Card (conceptual)<br />
name: Bob / Backend<br />
url: https://bob-mac.local:9271/a2a<br />
capabilities:<br />
streaming: true<br />
pushNotifications: true<br />
skills:<br />
backend<br />
tests<br />
database</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 16.3 Agent Room MCP Server

用于 WorkBuddy 或其他 MCP-native participant 加入 Room。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Tools<br />
room.get_context<br />
room.get_mentions<br />
room.send_message<br />
room.handoff<br />
room.get_task<br />
room.publish_artifact<br />
room.request_agent<br />
<br />
Resources<br />
room://{roomId}/context<br />
room://{roomId}/artifact/{artifactId}<br />
room://{roomId}/thread/{threadId}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 16.4 Internal Runtime Adapter Events

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>runtime.session.started<br />
runtime.reasoning.delta<br />
runtime.tool.started<br />
runtime.tool.completed<br />
runtime.approval.requested<br />
runtime.clarification.requested<br />
runtime.workspace.changed<br />
runtime.artifact.created<br />
runtime.message.delta<br />
runtime.completed<br />
runtime.failed</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

# 17. UX / UI 设计

## 17.1 Team Room 主界面

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>┌──────────────┬──────────────────────────────────┬───────────────────┐<br />
│ ROOMS │ Payment Team │ TEAM │<br />
│ │ │ │<br />
│ # payments │ Alice │ Alice │<br />
│ # auth │ @Bob/Backend inspect retry bug │ ├ Claude ● │<br />
│ # infra │ │ └ Codex ● │<br />
│ │ Bob · Backend │ │<br />
│ │ Codex · Bob-Mac · LAN │ Bob │<br />
│ │ ┌──────────────────────────────┐ │ └ Backend ● │<br />
│ │ │ Run │ │ │<br />
│ │ │ ✓ reproduce │ │ Carol │<br />
│ │ │ ✓ inspect logs │ │ └ Reviewer ● │<br />
│ │ │ ● editing │ │ │<br />
│ │ └──────────────────────────────┘ │ │<br />
├──────────────┴──────────────────────────────────┴───────────────────┤<br />
│ @ Message team... [Send] │<br />
└──────────────────────────────────────────────────────────────────────┘</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 17.2 Mention Picker

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>PEOPLE<br />
@Alice<br />
@Bob<br />
@Carol<br />
<br />
AGENTS<br />
Alice<br />
@Alice/Claude Architect<br />
@Alice/Codex Coding<br />
Bob<br />
@Bob/Backend Backend Engineer<br />
Carol<br />
@Carol/Reviewer Reviewer<br />
<br />
ROLES<br />
@backend<br />
@reviewers<br />
@all-agents</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 17.3 Nearby Devices

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Nearby teammates<br />
<br />
Bob's MacBook Pro ● LAN<br />
Gateway 1.0<br />
Fingerprint: 7A:3C:...<br />
[Pair]<br />
<br />
Carol's Linux ● LAN<br />
Gateway 1.0<br />
[Pair]</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 17.4 Publish Agent

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Publish Agent<br />
<br />
Runtime Codex<br />
Name Backend<br />
Role Backend Engineer<br />
Workspace payment-service<br />
Permissions Team Default<br />
<br />
[Publish to Team]</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 17.5 Run Card

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Bob · Backend<br />
Codex · Bob-MacBook · LAN<br />
<br />
● Working<br />
✓ Read callback.ts<br />
✓ Reproduced race<br />
● Running tests<br />
<br />
Task T-382<br />
Base a84190f</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 17.6 Offline UX

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Bob / Backend<br />
○ Offline<br />
<br />
Task queued.<br />
Will deliver when Bob's gateway reconnects.<br />
<br />
[Cancel queued task]</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

# 18. 故障、恢复与一致性策略

| **故障**                | **策略**                                                      |
|-------------------------|---------------------------------------------------------------|
| Gateway 突然离线        | Task 标记 transport_lost；等待重连，必要时人工 retry          |
| Runtime 崩溃            | Gateway 尝试读取 session 状态；不能确定结果则 outcome_unknown |
| 重复投递                | taskId + dedupeKey；Gateway 维护幂等记录                      |
| A2A streaming 中断      | 客户端 GetTask / SubscribeTask 恢复                           |
| Owner 拒绝审批          | Task 返回 failed/cancelled + human-readable reason            |
| Project revision 不匹配 | 阻止执行或要求建立 compatible worktree                        |
| Artifact 过大           | metadata 先行，按需分块/对象存储获取                          |
| 同名 Agent              | 协议只认 agentId，UI 使用 owner/name disambiguation           |
| Room Coordinator 重启   | SQLite event log 恢复 projections                             |
| 网络抖动                | presence TTL + backoff + persistent pending delivery          |

# 19. 部署拓扑与网络方案

## 19.1 MVP：单局域网 Coordinator

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Developer LAN<br />
<br />
Alice Desktop<br />
├ Room UI<br />
├ Coordinator<br />
└ Alice Gateway<br />
<br />
Bob Desktop<br />
└ Bob Gateway<br />
<br />
Carol Desktop<br />
└ Carol Gateway</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

Coordinator 可由创建 Room 的用户机器托管。所有团队协作状态在局域网内完成。

## 19.2 第二阶段：独立 Team Coordinator

可以提供 Docker / NAS / 公司内网服务，使 Room 在成员笔记本睡眠后仍保持在线。

## 19.3 WAN

后续可提供自托管 relay、企业 VPN/Tailscale/ZeroTier 兼容或云 Coordinator。核心身份与 A2A Gateway 设计无需改变。

# 20. MVP 开发路线

| **阶段**              | **交付**                                | **完成定义**                       |
|-----------------------|-----------------------------------------|------------------------------------|
| P0 协议骨架           | Domain model + event log + fake adapter | 单机可模拟两个 Agent               |
| P1 单机多 Runtime     | Codex Native + Generic CLI              | Room 内可 @ 本机不同 Agent         |
| P2 LAN Gateway        | mDNS + pairing + device identity        | 两台机器可信连接                   |
| P3 Remote A2A         | Published Agent Card + A2A Task         | Alice 可 @Bob/Codex                |
| P4 Streaming/Approval | Run updates + owner approval            | 远程任务可观察、可审批             |
| P5 Project/Worktree   | Project identity + isolated worktree    | 跨机代码任务不污染主工作区         |
| P6 Artifact           | Patch/Commit/File transfer              | Carol 可 review Bob 的产物         |
| P7 Handoff            | Agent → Agent A2A handoff               | Bob Agent 可结构化交给 Carol Agent |
| P8 WorkBuddy          | Agent Room MCP Connector                | WorkBuddy 可作为 Room participant  |
| P9 Hardening          | audit/recovery/policy                   | 团队内部可长期试用                 |

## 20.1 MVP 最小惊艳点

真正值得演示的 MVP 不是十种 CLI，而是两台电脑：Alice 在 Room 中 @Bob/Codex，Bob Codex 在 Bob 本机 workspace 执行，Alice 实时看到 Run，完成后出现 Patch；然后 Alice 一键 @Carol/Reviewer 继续。做到这里，产品概念已经成立。

# 21. 测试、可观测性与验收标准

## 21.1 Test Matrix

- Identity / pairing：错误码、重放、撤销、设备重装。

- Routing：同名 Agent、offline、role routing、handoff loop。

- A2A：streaming 断线、poll recovery、push notification。

- Adapter：Codex session crash、CLI exit、WorkBuddy MCP unavailable。

- Workspace：revision mismatch、dirty working tree、worktree cleanup。

- Security：path traversal、credential leak、prompt-induced command escalation。

- Artifact：hash mismatch、超大文件、binary patch。

- Coordinator：重启、重复事件、offline queue durable。

## 21.2 Observability

每个 Task 生成 traceId，贯穿 Room Message → A2A Task → Gateway Run → Runtime Session → Artifact。日志分级，并默认 redact token、credential、home directory sensitive path。

## 21.3 MVP 验收

1.  两台开发机能通过 mDNS 发现并人工配对。

2.  Bob 可将本机 Codex 发布为 \`Bob/Backend\`。

3.  Alice Room 中 \`@Bob/Backend\` 后，Bob Gateway 在本机启动/恢复 Codex。

4.  Alice 能看到 working / input_required / completed 等 Task 状态。

5.  Bob 机器上的危险操作只能由 Bob 审批。

6.  Codex 改动发生在隔离 worktree，并产出 Patch Artifact。

7.  Carol Agent 可以消费该 Artifact 做 review。

8.  Bob Gateway 离线时任务可排队，上线后可靠投递。

9.  所有关键操作可审计并追溯 owner/device/agent/task/run。

# 22. Hermes Studio 许可证与 clean-room 策略

## 22.1 当前许可证结论

截至 2026-08-22，EKKOLearnAI/hermes-studio 仓库 LICENSE 声明使用 Business Source License 1.1。其 Additional Use Grant 允许非商业用途（包括个人、教育和研究）；商业使用，包括出售、授权、SaaS 托管或嵌入商业产品，需要 Licensor 的单独商业许可。Change Date 为 2029-05-10，届时变更为 Apache License 2.0。

## 22.2 对本项目的建议

| **如果本项目有任何商业化可能：不要复制 Hermes 当前实现代码；只研究公开行为、产品思路和协议边界，并独立实现。** |
|----------------------------------------------------------------------------------------------------------------|

| **内容**                   | **策略**                                       |
|----------------------------|------------------------------------------------|
| Room / Group Chat 产品思想 | 可借鉴概念，自己实现                           |
| Structured Mention         | 借鉴机制，使用自定义 schema                    |
| Handoff Chain              | 借鉴问题模型，自己定义状态机                   |
| Remote Agent / owner 关系  | 借鉴产品模型，重做数据结构                     |
| agent-relay.ts             | 不复制                                         |
| GroupChatPanel.vue         | 不复制                                         |
| mention-routing.ts         | 不复制，即使算法短也无必要引入 provenance 风险 |
| UI assets / icons / images | 不复制                                         |
| 公开标准 A2A / MCP         | 按各自开放规范独立实现                         |

## 22.3 Clean-room 工程措施

- 新仓库从零创建，禁止直接 fork Hermes。

- 实现人员依据本设计文档和公开标准开发，不将 Hermes 源码作为复制模板。

- 在 ADR 中记录每个核心协议与数据结构的设计理由。

- 第三方依赖逐一记录 SPDX / license。

- 商业发布前对代码 provenance 与许可证做一次独立审计。

# 23. 关键架构决策记录（ADR）

| **编号** | **决策**                        | **理由**                                       |
|----------|---------------------------------|------------------------------------------------|
| ADR-001  | Gateway 是唯一局域网 Agent 边界 | 避免直接暴露 CLI / Token / App Server          |
| ADR-002  | Room 与 Agent Task 分层         | 聊天与 presence 不强迫全部塞进 A2A             |
| ADR-003  | A2A 用于跨 Agent 工作委派       | 复用 Agent Card、Task、Streaming、Push         |
| ADR-004  | MCP 用于工具与 participant 接入 | WorkBuddy 等 MCP-native 产品低成本加入         |
| ADR-005  | Runtime Adapter 保留原生协议    | 保留 Codex 等完整能力                          |
| ADR-006  | Artifact over remote FS         | 减少权限与版本一致性风险                       |
| ADR-007  | Owner-side approval             | 远程 requester 不能越权批准执行                |
| ADR-008  | MVP 单 Coordinator              | 避免过早引入分布式一致性                       |
| ADR-009  | 商业版 clean-room               | 规避 Hermes BSL 商业限制与代码 provenance 风险 |

# 24. 后续演进路线

## 24.1 Role Routing

从显式 \`@Bob/Backend\` 进化到 \`@backend\` / \`@reviewers\`，Coordinator 根据 Agent Card skills、online、Owner policy、project compatibility 选择候选 Agent。

## 24.2 Team Directory

企业内维护 Agent Directory，允许不同 Room 发现受授权的团队 Agent，但仍由 Owner Gateway 执行。

## 24.3 Remote/WAN Federation

在保持 local-first 的前提下增加中继，使跨办公室、远程办公也能通过 A2A Federation 工作。

## 24.4 Thread = Task

Room 消息可升级为 Thread / Task，使大型讨论不会全部塞进一个时间线。每个 Thread 可以有自己的 participants、shared context、artifacts 和 lineage。

## 24.5 Human-to-Agent / Agent-to-Human Handoff

不仅 Agent 之间 handoff，还可将 \`input_required\` 明确指派给某个 Member，例如“需要 Bob 确认数据库迁移窗口”。

## 24.6 Enterprise Policy

团队级策略可限制可发布 Runtime、可访问仓库、最大 Agent 数、跨 Owner 网络访问、数据出站与模型 Provider。

# 附录 A：事件与状态机

## A.1 Room Event Envelope

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>{<br />
"protocol": 1,<br />
"eventId": "evt_...",<br />
"roomId": "room_...",<br />
"traceId": "trace_...",<br />
"parentEventId": "evt_...",<br />
"timestamp": "2026-08-22T...",<br />
"type": "task.created",<br />
"actor": { "type": "member", "id": "alice" },<br />
"payload": {}<br />
}</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## A.2 Task / Run Mapping

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>Room Message<br />
│<br />
├─ Mention → Task<br />
│ │<br />
│ └─ A2A Task<br />
│ │<br />
│ └─ Gateway Run<br />
│ │<br />
│ └─ Runtime Session<br />
│<br />
└─ Artifacts ← Run Results</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## A.3 Handoff Lineage

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>lineage L-19<br />
<br />
T1 Alice → Bob/Backend<br />
└─ T2 Bob/Backend → Carol/Reviewer<br />
└─ T3 Carol/Reviewer → Bob/Backend<br />
<br />
depth = 2<br />
uniqueAgents = 2</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

# 附录 B：参考资料

**\[R1\] Hermes Studio LICENSE（Business Source License 1.1；Additional Use Grant；Change Date）：**[<u>https://github.com/EKKOLearnAI/hermes-studio/blob/main/LICENSE</u>](https://github.com/EKKOLearnAI/hermes-studio/blob/main/LICENSE)

**\[R2\] A2A Protocol - Core Concepts（Agent Card、Task、Streaming、Push Notifications）：**[<u>https://a2a-protocol.org/latest/topics/key-concepts/</u>](https://a2a-protocol.org/latest/topics/key-concepts/)

**\[R3\] A2A Protocol - Agent Discovery：**[<u>https://a2a-protocol.org/latest/topics/agent-discovery/</u>](https://a2a-protocol.org/latest/topics/agent-discovery/)

**\[R4\] A2A Protocol - Specification：**[<u>https://a2a-protocol.org/dev/specification/</u>](https://a2a-protocol.org/dev/specification/)

**\[R5\] Model Context Protocol 2026-07-28 Specification Release：**[<u>https://blog.modelcontextprotocol.io/posts/2026-07-28/</u>](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

**\[R6\] OpenAI Codex app-server protocol v2 schema：**[<u>https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json</u>](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)

**\[R7\] OpenAI Codex app-server daemon（experimental）：**[<u>https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md</u>](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md)

**\[R8\] Tencent WorkBuddy MCP 文档：**[<u>https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide</u>](https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)

**\[R9\] Tencent CodeBuddy / WorkBuddy 插件参考（含 MCP Servers）：**[<u>https://www.workbuddy.ai/docs/zh/cli/plugins-reference</u>](https://www.workbuddy.ai/docs/zh/cli/plugins-reference)

资料核验日期：2026-08-22。协议和产品接口会变化，进入实现阶段应固定版本并建立 compatibility matrix。

| **一句话产品定义：每个工程师都有自己的 AI teammates；Agent 留在 Owner 的机器上，工作通过 A2A 委派，能力通过 MCP 扩展，协作发生在 Room。** |
|-------------------------------------------------------------------------------------------------------------------------------------------|
