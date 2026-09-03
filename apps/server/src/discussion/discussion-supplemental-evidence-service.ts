import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { DeliveryService } from "../run/delivery-service.js";
import type { RunRepository } from "../run/run-repository.js";
import type { DevicePrincipal } from "../security/auth-service.js";
import type { AgentTaskRepository } from "../task/task-repository.js";
import {
  discussionSupplementalEvidenceDigest
} from "./discussion-quorum.js";
import type { DiscussionRepository } from "./discussion-repository.js";
import type { DiscussionSupplementalEvidence } from "./discussion-types.js";
import { hashDiscussionReply } from "./progress-evaluator.js";

export interface SupplementalEvidenceSubmission {
  operationId: string;
  discussionId: string;
  waveId: string;
  turnId: string;
  runId: string;
  traceId: string;
  agentId: string;
  sourceReplySequence: number;
}

export type SupplementalEvidenceSubmissionResult =
  | { state: "retained"; evidence: DiscussionSupplementalEvidence }
  | { state: "not_late"; reason: "wave_open" | "accepted_member" };

export class DiscussionSupplementalEvidenceService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly discussions: DiscussionRepository,
    private readonly runs: RunRepository,
    private readonly deliveries: DeliveryService,
    private readonly tasks: AgentTaskRepository
  ) {}

  public submit(
    principal: DevicePrincipal,
    input: SupplementalEvidenceSubmission,
    now: string
  ): SupplementalEvidenceSubmissionResult {
    if (
      !Number.isSafeInteger(input.sourceReplySequence) ||
      input.sourceReplySequence < 1
    ) {
      throw new Error("Supplemental evidence reply sequence is invalid");
    }
    const run = this.runs.getRun(input.runId);
    const turn = this.discussions.getTurn(input.turnId);
    const wave = this.discussions.getWave(input.waveId);
    const discussion = this.discussions.get(input.discussionId);
    const delivery = this.deliveries.getByRun(input.runId);
    const offer = delivery?.payload.discussionSupplementalEvidence;
    if (
      !run || !turn || !wave || !discussion || !delivery || !offer ||
      offer.version !== 1 || offer.operationId !== input.operationId ||
      offer.discussionId !== input.discussionId ||
      offer.waveId !== input.waveId || offer.turnId !== input.turnId ||
      run.traceId !== input.traceId || run.targetAgentId !== input.agentId ||
      turn.discussionId !== input.discussionId || turn.waveId !== input.waveId ||
      turn.runId !== input.runId || turn.speakerAgentId !== input.agentId ||
      wave.discussionId !== input.discussionId ||
      discussion.roomId !== run.roomId || discussion.taskId !== run.taskId ||
      delivery.deviceId !== principal.deviceId
    ) {
      throw new Error("Supplemental evidence identity does not match its offer");
    }
    this.assertCurrentAuthority(principal, discussion, input.agentId);
    const existing = this.discussions.getSupplementalEvidenceByOperation(
      input.operationId
    );
    if (existing) {
      if (
        existing.discussionId !== input.discussionId ||
        existing.waveId !== input.waveId || existing.turnId !== input.turnId ||
        existing.runId !== input.runId || existing.agentId !== input.agentId ||
        existing.sourceReplySequence !== input.sourceReplySequence ||
        existing.deviceId !== principal.deviceId
      ) {
        throw new Error("Supplemental evidence operation identity was reused");
      }
      return { state: "retained", evidence: existing };
    }
    const seal = this.discussions.getWaveSeal(input.waveId);
    if (!seal) return { state: "not_late", reason: "wave_open" };
    if (seal.acceptedMembers.some(({ turnId }) => turnId === input.turnId)) {
      return { state: "not_late", reason: "accepted_member" };
    }
    if (
      run.state !== "completed" || turn.state !== "completed" ||
      !turn.outputMessageId || !turn.replyHash
    ) {
      throw new Error("Supplemental evidence requires a completed canonical reply");
    }
    const reply = this.runs.listEvents(input.runId).find(({ sequence, event }) =>
      sequence === input.sourceReplySequence && event.type === "reply"
    );
    const projection = this.runs.getReplyMessageProjection(
      input.runId,
      input.sourceReplySequence
    );
    const message = this.core.getMessage(turn.outputMessageId);
    if (
      !reply || reply.event.type !== "reply" || !projection || !message ||
      projection.messageId !== turn.outputMessageId ||
      message.senderType !== "agent" || message.senderId !== input.agentId ||
      message.roomId !== discussion.roomId || message.taskId !== discussion.taskId ||
      reply.event.content !== message.content ||
      hashDiscussionReply(message.content) !== turn.replyHash
    ) {
      throw new Error("Supplemental evidence source reply is not canonical");
    }
    const unsigned = {
      operationId: input.operationId,
      sealId: seal.sealId,
      discussionId: input.discussionId,
      waveId: input.waveId,
      turnId: input.turnId,
      runId: input.runId,
      agentId: input.agentId,
      deviceId: principal.deviceId,
      sourceReplySequence: input.sourceReplySequence,
      sourceMessageId: message.messageId,
      sourceMessageSequence: message.sequence,
      replyHash: turn.replyHash,
      submittedAt: now
    };
    const evidence = this.discussions.retainSupplementalEvidence({
      evidenceId: createOpaqueId("supplement"),
      ...unsigned,
      evidenceDigest: discussionSupplementalEvidenceDigest(unsigned)
    });
    return { state: "retained", evidence };
  }

  private assertCurrentAuthority(
    principal: DevicePrincipal,
    discussion: NonNullable<ReturnType<DiscussionRepository["get"]>>,
    agentId: string
  ): void {
    const agent = this.core.getAgent(agentId);
    const device = this.core.getDevice(principal.deviceId);
    const room = this.core.getRoom(discussion.roomId);
    const task = this.tasks.get(discussion.taskId);
    if (
      !agent || !agent.enabled || agent.integrationMode !== "managed" ||
      agent.teamId !== principal.teamId ||
      agent.ownerMemberId !== principal.ownerMemberId ||
      agent.deviceId !== principal.deviceId ||
      agent.runtimePolicy?.filesystemAccess !== "read-only" ||
      agent.capabilities.supportsDiscussionSupplementalEvidence !== true ||
      !device || device.status !== "active" || device.teamId !== principal.teamId ||
      !room || room.teamId !== principal.teamId ||
      !room.collaborationPolicy.allowDiscussion ||
      !this.core.isRoomAgent(room.roomId, agentId) ||
      !task || task.roomId !== room.roomId ||
      task.state === "completed" || task.state === "canceled" ||
      task.lifecycleState === "completed" || task.lifecycleState === "canceled" ||
      (!task.isDefault && !task.assignments.some(({ agentId: assigned }) =>
        assigned === agentId
      )) || discussion.policy.waveCompletionMode !== "read_only_quorum"
    ) {
      throw new Error("Supplemental evidence authority is no longer current");
    }
  }
}
