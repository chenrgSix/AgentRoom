import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { TaskProjection } from "@convene-wire/contracts/task-result";
import type {
  ExecutionPlanDefinition,
  ExecutionPlanProjection
} from "@convene-wire/contracts/execution-plan";
import type { FastifyInstance } from "fastify";

import { BridgeConnectionRegistry } from
  "../../apps/server/src/bridge/bridge-connection-registry.js";
import { CoreRepository } from "../../apps/server/src/data/core-repository.js";
import { openDatabase } from "../../apps/server/src/data/database.js";
import { DiscussionOrchestrator } from
  "../../apps/server/src/discussion/discussion-orchestrator.js";
import { DiscussionRepository } from
  "../../apps/server/src/discussion/discussion-repository.js";
import { DiscussionSupplementalEvidenceService } from
  "../../apps/server/src/discussion/discussion-supplemental-evidence-service.js";
import { AgentService } from "../../apps/server/src/registry/agent-service.js";
import { MemberDeviceService } from "../../apps/server/src/registry/member-device-service.js";
import { DeliveryService } from "../../apps/server/src/run/delivery-service.js";
import { RunRepository } from "../../apps/server/src/run/run-repository.js";
import { RunService } from "../../apps/server/src/run/run-service.js";
import { AuthService } from "../../apps/server/src/security/auth-service.js";
import { MessageService } from "../../apps/server/src/team-room/message-service.js";
import { ContextPlanner } from "../../apps/server/src/task/context-planner.js";
import { AgentTaskRepository } from "../../apps/server/src/task/task-repository.js";

interface SeedOptions {
  databasePath: string;
  headers: Record<string, string>;
  teamId: string;
  roomId: string;
  ownerMemberId: string;
}

/** Synthetic, disposable QA data only. This helper never contacts a network. */
export async function seedProductExperience(app: FastifyInstance, options: SeedOptions): Promise<void> {
  const databasePath = await realpath(options.databasePath);
  const temporaryRoots = await Promise.all([os.tmpdir(), "/tmp"].map((root) => realpath(root).catch(() => null)));
  assert.ok(temporaryRoots.some((root) => {
    if (!root) return false;
    const relative = path.relative(root, databasePath);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
  }), "Product-experience seeding is restricted to an existing isolated temporary database");

  async function request<T = Record<string, unknown>>(
    method: "GET" | "POST", url: string, payload?: object,
    headers: Record<string, string> = options.headers
  ): Promise<T> {
    const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    // Never include credential-bearing request/response bodies in QA failures.
    assert.equal(response.statusCode, 200, `QA seed ${method} ${url} returned ${response.statusCode}`);
    return response.json() as T;
  }

  const session = await request<{ user: { userId: string } }>("GET", "/api/auth/session");
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    const auth = new AuthService(database);
    const owner = core.getMember(options.ownerMemberId);
    const room = core.getRoom(options.roomId);
    assert.ok(owner?.userId && owner.role === "owner" && owner.teamId === options.teamId);
    assert.equal(owner.userId, session.user.userId, "QA headers must belong to the supplied Team Owner");
    assert.equal(room?.teamId, options.teamId, "QA database and API Room must match");
    const existing = database.prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE room_id = ? AND title LIKE 'QA · %'")
      .get(options.roomId) as { count: number };
    assert.equal(existing.count, 0, "Seed only once in a fresh QA Room");
    const now = room!.createdAt;
    const normalizedHeaders = new Map(Object.entries(options.headers).map(([name, value]) => [name.toLowerCase(), value]));
    const bearer = /^Bearer (.+)$/u.exec(normalizedHeaders.get("authorization") ?? "")?.[1];
    const cookie = /(?:^|;\s*)(?:__Host-agentroom_session|agentroom_lan_session)=([^;]+)/u
      .exec(normalizedHeaders.get("cookie") ?? "")?.[1];
    const webCredential = bearer ?? cookie;
    assert.ok(webCredential, "QA seed requires the authenticated Owner session");
    const principal = auth.authenticateWebSession(webCredential, now);
    assert.equal(principal.userId, owner.userId);
    auth.requireRoomMember(principal, options.roomId);
    const runRepository = new RunRepository(database);
    const taskRepository = new AgentTaskRepository(database);
    const runs = new RunService(core, runRepository, auth, taskRepository);

    for (let index = 1; index <= 125; index += 1) {
      await request("POST", `/api/rooms/${options.roomId}/messages`, {
        content: `QA 历史消息 ${String(index).padStart(3, "0")} · 这是一条合成的产品体验记录，不含真实用户内容。`
      });
    }
    for (let index = 1; index <= 105; index += 1) {
      await request("POST", `/api/rooms/${options.roomId}/tasks`, {
        title: `QA · 分页任务 ${String(index).padStart(3, "0")}`,
        goal: "用于验证工作台分页、负责人筛选和历史可达性的合成任务。",
        ownerMemberId: options.ownerMemberId,
        lifecycleState: "ready"
      });
    }

    const manual = await request<{ agent: { agentId: string } }>("POST", `/api/teams/${options.teamId}/manual-agents`, {
      name: "QA恢复助手", role: "仅用于隔离验收，不连接外部运行时"
    });
    const recoveryTask = await request<TaskProjection>("POST", `/api/rooms/${options.roomId}/tasks`, {
      title: "QA · 确认未知结果后再发起新尝试",
      goal: "检查合成运行事件，明确记录外部结果，再单独授权一次新尝试。",
      ownerMemberId: options.ownerMemberId,
      assignments: [{ agentId: manual.agent.agentId, role: "primary" }],
      budgetPolicy: { maxRunAttempts: 5, maxExecutionDurationSeconds: 3600 }
    });
    const recoveryMessage = await request<{ runs: Array<{ runId: string }> }>("POST", `/api/rooms/${options.roomId}/messages`, {
      taskId: recoveryTask.taskId,
      content: "QA 合成指令：检查这次调用是否产生了外部效果；本夹具没有执行任何真实外部操作。",
      mentionAgentId: manual.agent.agentId
    });
    const recoveryRunId = recoveryMessage.runs[0]?.runId;
    assert.ok(recoveryRunId);
    // Like task-result-service.test.ts, construct a deterministic terminal state
    // only in the guarded QA DB. No Runtime process or remote call is launched.
    runRepository.applyEvent(recoveryRunId, { type: "status", sequence: 1, status: "working" }, now);
    runRepository.applyEvent(recoveryRunId, { type: "status", sequence: 2, status: "outcome_unknown" }, now);

    // Reuse the same real publication boundary exercised by artifact-routes.test.ts.
    // The synthetic Device exists only to authenticate lease/upload/seal/bind.
    const device = new MemberDeviceService(core, auth).registerOwnDevice(principal, options.teamId, "QA成果夹具设备", now);
    const workspaceRef = `workspace_${createHash("sha256").update("product-experience-qa-workspace").digest("hex")}`;
    const workspaceGeneration = createHash("sha256").update("product-experience-qa-generation").digest("hex");
    const agent = new AgentService(core, auth).publishAgent(principal, {
      teamId: options.teamId, deviceId: device.deviceId, name: "QA成果助手", role: "合成证据发布夹具",
      integrationMode: "managed", workspaceRef, workspaceGeneration,
      capabilities: {
        supportsHandoff: false, supportsInterrupt: true, supportsResume: true,
        supportsStart: true, supportsStreaming: true, supportsWorkspaceLeases: true,
        supportsArtifactPublication: true
      }, now
    });
    const evidenceTask = await request<TaskProjection>("POST", `/api/rooms/${options.roomId}/tasks`, {
      title: "QA · 核验证据并审核交付",
      goal: "打开真实 sealed Artifact 的安全预览，再基于证据审核此合成 Result。",
      ownerMemberId: options.ownerMemberId,
      completionPolicy: "accepted_result_required",
      assignments: [{ agentId: agent.agentId, role: "primary" }],
      criteria: [{ criterionKey: "criterion_qa_verified_0001", description: "交付说明有可验证的不可变内容快照。", required: true, ordinal: 1 }]
    });
    await request("POST", `/api/tasks/${evidenceTask.taskId}/control`, {
      operationId: `op_qa_activate_${randomUUID().replaceAll("-", "_")}`,
      expectedTaskRevision: evidenceTask.taskRevision,
      lifecycleState: "active"
    });
    const sourceMessage = new MessageService(core, auth).createMemberMessage(principal, {
      roomId: options.roomId, taskId: evidenceTask.taskId,
      content: "QA 合成指令：发布可验证的交付说明；不读取本机工作区。",
      mentions: [{ targetType: "agent", targetAgentId: agent.agentId, displayLabel: "QA成果助手" }], now
    });
    const evidenceRun = runs.createRunsForMessage(principal, sourceMessage.messageId, now)[0];
    assert.ok(evidenceRun);
    runRepository.applyEvent(evidenceRun.runId, { type: "status", sequence: 1, status: "delivered" }, now);
    const credential = auth.issueDeviceCredential(device.deviceId, now);
    const deviceHeaders = { authorization: `Bearer ${credential.secret}` };
    const devicePrincipal = auth.authenticateDevice(credential.secret, now);
    const nonce = randomUUID().replaceAll("-", "_");
    const lease = await request<{ leaseId: string }>("POST", "/api/bridge/workspace-leases/read-source", {
      runId: evidenceRun.runId, agentId: agent.agentId, workspaceRef, workspaceGeneration,
      idempotencyKey: `idem_qa_lease_${nonce}`
    }, deviceHeaders);
    const content = Buffer.from("# 产品体验 QA 合成交付说明\n\n- 范围：任务、证据预览和人工审核。\n- 来源：隔离夹具生成，不含真实用户数据。\n- 限制：这份文件不代表生产或真实模型验收。\n\n以下安全测试字样必须保持纯文本，不得执行：\n<script>window.qaUnsafeExecuted = true</script>\n", "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const publication = await request<{ publicationId: string }>("POST", "/api/bridge/artifact-publications", {
      leaseId: lease.leaseId, runId: evidenceRun.runId, agentId: agent.agentId,
      workspaceRef, workspaceGeneration, idempotencyKey: `idem_qa_publish_${nonce}`,
      artifactType: "document", fileName: "qa-delivery.md", mediaType: "text/markdown",
      title: "QA · 可验证交付说明", summary: "通过真实上传、封存与绑定流程产生的合成 Markdown 快照。",
      sizeBytes: content.length, sha256
    }, deviceHeaders);
    await request("POST", `/api/bridge/artifact-publications/${publication.publicationId}/chunks`, {
      offset: 0, chunkBase64: content.toString("base64"), chunkSha256: sha256
    }, deviceHeaders);
    const sealed = await request<{ publication: { state: string }; content: { sha256: string } }>("POST", `/api/bridge/artifact-publications/${publication.publicationId}/seal`, {}, deviceHeaders);
    assert.equal(sealed.publication.state, "sealed");
    assert.equal(sealed.content.sha256, sha256);
    const bound = await request<{ artifact: { artifactId: string } }>("POST", `/api/bridge/artifact-publications/${publication.publicationId}/bind`, {}, deviceHeaders);
    const preview = await request<{ integrity: string; text: string; sha256: string }>("GET", `/api/tasks/${evidenceTask.taskId}/artifacts/${bound.artifact.artifactId}/preview`);
    assert.equal(preview.integrity, "verified");
    assert.equal(preview.sha256, sha256);
    assert.equal(preview.text, content.toString("utf8"));
    runRepository.applyEvent(evidenceRun.runId, { type: "status", sequence: 2, status: "working" }, now);
    runRepository.applyReply(evidenceRun.runId, { type: "reply", sequence: 3, content: "QA 合成证据已封存，等待人工审核。" }, now);
    runRepository.applyEvent(evidenceRun.runId, { type: "status", sequence: 4, status: "completed" }, now);
    const currentTask = await request<TaskProjection>("GET", `/api/tasks/${evidenceTask.taskId}`);
    await request("POST", `/api/tasks/${evidenceTask.taskId}/results`, {
      operationId: `op_qa_result_${nonce}`, taskId: evidenceTask.taskId,
      definitionRevision: currentTask.definitionRevision, criteriaRevision: currentTask.criteriaRevision,
      proposedAtTaskRevision: currentTask.taskRevision, supersedesResultId: null, outcome: "satisfied",
      summary: "已生成一份可校验的合成交付说明，请检查快照后决定是否接受。",
      risks: ["这是隔离 QA 数据，不是实际业务交付。"], openQuestions: [],
      nextActions: [{ nextActionKey: "next_qa_review_follow_up", description: "检查后续交付的验收标准" }],
      sources: [{ evidenceRefId: "evidence_qa_artifact_0001", kind: "artifact", artifactId: bound.artifact.artifactId }],
      criterionClaims: [{ criterionKey: "criterion_qa_verified_0001", coverage: "satisfied", explanation: "真实 sealed 快照的 SHA-256 与预览字节一致。", evidenceRefIds: ["evidence_qa_artifact_0001"] }]
    });

    const planTask = await request<TaskProjection>(
      "POST", `/api/rooms/${options.roomId}/tasks`, {
        title: "QA · 审查精确执行计划",
        goal: "检查版本差异、依赖门、策略和 digest，再由人类明确决定。",
        ownerMemberId: options.ownerMemberId,
        assignments: [{ agentId: manual.agent.agentId, role: "primary" }]
      }
    );
    const planMessage = await request<{ message: { messageId: string; sequence: number } }>(
      "POST", `/api/rooms/${options.roomId}/messages`, {
        taskId: planTask.taskId,
        content: "QA 合成决策：使用受控双节点计划验证精确的人类批准界面。"
      }
    );
    const planCases = JSON.parse(await readFile(new URL(
      "../../packages/contracts/fixtures/execution-plan-cases.json",
      import.meta.url
    ), "utf8")) as {
      cases: Array<{ name: string; instance: ExecutionPlanDefinition }>;
    };
    const planTemplate = planCases.cases.find(({ name }) =>
      name === "execution: valid full plan")?.instance;
    assert.ok(planTemplate);
    const planDefinition = structuredClone(planTemplate);
    planDefinition.rootTaskId = planTask.taskId;
    planDefinition.title = "QA · 双节点验证交付计划";
    planDefinition.decision.summary =
      "先实现并独立验证，再让下游节点消费 verified_output。";
    planDefinition.decision.sources = [{
      evidenceRefId: "evidence_qa_plan_message0001",
      kind: "message",
      messageId: planMessage.message.messageId
    }];
    planDefinition.decision.sourceRevisions = [{
      evidenceRefId: "evidence_qa_plan_message0001",
      revision: planMessage.message.sequence
    }];
    for (const node of planDefinition.nodes) {
      node.agentId = manual.agent.agentId;
      node.task.ownerMemberId = options.ownerMemberId;
    }
    const currentPlanTask = await request<TaskProjection>(
      "GET", `/api/tasks/${planTask.taskId}`
    );
    const firstPlan = await request<ExecutionPlanProjection>(
      "POST", `/api/tasks/${planTask.taskId}/execution-plans`, {
        operationId: `op_qa_plan_${randomUUID().replaceAll("-", "_")}`,
        expectedRootTaskRevision: currentPlanTask.taskRevision,
        definition: planDefinition
      }
    );
    const revisedDefinition = structuredClone(planDefinition);
    revisedDefinition.title = "QA · 双节点验证交付计划（已收紧）";
    revisedDefinition.policy.maxConcurrency = 1;
    revisedDefinition.decision.items.push({
      itemKey: "human_control",
      statement: "Only the exact retained revision may receive human approval."
    });
    const revisedPlan = await request<ExecutionPlanProjection>(
      "POST", `/api/execution-plans/${firstPlan.planId}/revisions`, {
        operationId: `op_qa_plan_revision_${randomUUID().replaceAll("-", "_")}`,
        expectedRevision: firstPlan.current.revision,
        expectedRootTaskRevision: currentPlanTask.taskRevision,
        definition: revisedDefinition
      }
    );
    const planRootBeforeApproval = await request<TaskProjection>(
      "GET", `/api/tasks/${planTask.taskId}`
    );
    await request(
      "POST", `/api/execution-plans/${firstPlan.planId}/approvals`, {
        operationId: `op_qa_plan_approval_${randomUUID().replaceAll("-", "_")}`,
        expectedRevision: revisedPlan.current.revision,
        expectedDigest: revisedPlan.current.digest,
        expectedRootTaskRevision: planRootBeforeApproval.taskRevision,
        decision: "approved",
        reason: "QA Owner approves the exact synthetic plan for bounded-replanning browser acceptance."
      }
    );

    const quorumAgents = ["QA架构师", "QA安全审查", "QA最终评审"].map((name) => {
      const initial = new AgentService(core, auth).publishAgent(principal, {
        teamId: options.teamId,
        deviceId: device.deviceId,
        name,
        role: name === "QA最终评审" ? "Reviewer" : "Contributor",
        integrationMode: "managed",
        capabilities: {
          supportsHandoff: true,
          supportsInterrupt: true,
          supportsResume: false,
          supportsStart: true,
          supportsStreaming: true
        },
        runtimePolicy: { filesystemAccess: "read-only" },
        now
      });
      return new AgentService(core, auth).publishDeviceAgent(devicePrincipal, {
        agentId: initial.agentId,
        name: initial.name,
        role: initial.role,
        capabilities: {
          ...initial.capabilities,
          supportsDiscussionSupplementalEvidence: true
        },
        runtimePolicy: { filesystemAccess: "read-only" },
        now
      });
    });
    const quorumTask = await request<TaskProjection>(
      "POST", `/api/rooms/${options.roomId}/tasks`, {
        title: "QA · 审计只读 Quorum 与迟到证据",
        goal: "检查冻结参与者、封存回复和未进入决策的迟到证据。",
        ownerMemberId: options.ownerMemberId,
        assignments: quorumAgents.map(({ agentId }) => ({
          agentId,
          role: "contributor"
        }))
      }
    );
    const discussionClock = { value: now };
    const discussionRepository = new DiscussionRepository(database);
    const discussionDelivery = new DeliveryService(
      database,
      core,
      runRepository,
      new ContextPlanner(database, core, taskRepository),
      new BridgeConnectionRegistry(),
      () => discussionClock.value
    );
    const orchestrator = new DiscussionOrchestrator(
      core,
      new MessageService(core, auth),
      discussionRepository,
      runRepository,
      auth,
      taskRepository,
      () => discussionClock.value
    );
    let quorum = orchestrator.create(principal, {
      roomId: options.roomId,
      taskId: quorumTask.taskId,
      goal: "以只读 quorum 审查候选方案；迟到回复只保留为独立补充证据。",
      participantAgentIds: quorumAgents.map(({ agentId }) => agentId),
      mode: "review",
      policy: {
        allowAutomaticFinish: false,
        requireReviewer: true,
        participantSelectionMode: "question_focused",
        focusedParticipantLimit: 3,
        waveCompletionMode: "read_only_quorum",
        quorumMinimumCompleted: 2,
        quorumSoftDeadlineSeconds: 30
      }
    });
    assert.equal(quorum.scheduledRuns.length, 3);
    const deliveries = new Map(quorum.scheduledRuns.map((run) => [
      run.runId,
      discussionDelivery.dispatch(run.runId)
    ]));
    const [acceptedContributor, lateContributor, acceptedReviewer] =
      quorum.scheduledRuns;
    assert.ok(acceptedContributor && lateContributor && acceptedReviewer);
    const applyReply = (runId: string, contentValue: string,
      assessment: Record<string, unknown>, terminal: boolean) => {
      runRepository.applyEvent(runId, {
        type: "status", sequence: 1, status: "working"
      }, now);
      runRepository.applyReply(runId, {
        type: "reply", sequence: 2, content: contentValue, assessment
      }, now);
      if (terminal) {
        runRepository.applyEvent(runId, {
          type: "status", sequence: 3, status: "completed"
        }, now);
      }
    };
    applyReply(
      lateContributor.runId,
      "QA 迟到回复：此内容保留在普通消息事实中，不得进入已封存 quorum。",
      { newInformationAdded: true, recommendation: "continue" },
      false
    );
    applyReply(
      acceptedContributor.runId,
      "QA 已接纳的架构证据。",
      { newInformationAdded: true, recommendation: "continue" },
      true
    );
    applyReply(
      acceptedReviewer.runId,
      "QA 已接纳的独立评审证据。",
      { newInformationAdded: true, recommendation: "continue", reviewerApproved: true },
      true
    );
    discussionClock.value = new Date(Date.parse(now) + 31_000).toISOString();
    orchestrator.sweepDueWaves();
    const sealedDiscussion = orchestrator.get(
      principal,
      quorum.discussion.discussionId
    );
    assert.equal(sealedDiscussion.seals.length, 1);
    runRepository.applyEvent(lateContributor.runId, {
      type: "status", sequence: 3, status: "completed"
    }, discussionClock.value);
    quorum = orchestrator.onRunTerminal(lateContributor.runId)!;
    const lateOffer = deliveries.get(lateContributor.runId)?.payload
      .discussionSupplementalEvidence;
    assert.ok(lateOffer);
    const retained = new DiscussionSupplementalEvidenceService(
      core,
      discussionRepository,
      runRepository,
      discussionDelivery,
      taskRepository
    ).submit(devicePrincipal, {
      operationId: lateOffer.operationId,
      discussionId: lateOffer.discussionId,
      waveId: lateOffer.waveId,
      turnId: lateOffer.turnId,
      runId: lateContributor.runId,
      traceId: lateContributor.traceId,
      agentId: lateContributor.targetAgentId,
      sourceReplySequence: 2
    }, discussionClock.value);
    assert.equal(retained.state, "retained");
    assert.equal(orchestrator.get(
      principal,
      quorum.discussion.discussionId
    ).supplementalEvidence.length, 1);
  } finally {
    database.close();
  }
}
