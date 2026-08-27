export interface Team {
  teamId: string;
  name: string;
  createdAt: string;
  archivedAt?: string | null;
}

export interface Member {
  memberId: string;
  teamId: string;
  userId: string | null;
  displayName: string;
  role: "owner" | "member";
  createdAt: string;
}

export interface RoomCollaborationPolicy {
  allowDiscussion: boolean;
  allowAll: boolean;
  allowAgentMentions: boolean;
  maxAgentMentionDepth: number;
}

export const defaultRoomCollaborationPolicy: RoomCollaborationPolicy = {
  allowDiscussion: true,
  allowAll: true,
  allowAgentMentions: true,
  maxAgentMentionDepth: 4
};

export interface Room {
  roomId: string;
  teamId: string;
  name: string;
  collaborationPolicy?: RoomCollaborationPolicy;
  settingsRevision: number;
  createdAt: string;
  archivedAt?: string | null;
}

export interface Agent {
  agentId: string;
  ownerMemberId?: string;
  deviceId?: string | null;
  enabled?: boolean;
  name: string;
  role: string;
  integrationMode: "managed" | "manual" | "fake";
  presence: string;
  runtimePolicy?: {
    filesystemAccess: "read-only" | "workspace-write" | "local-policy";
  } | null;
}

export interface Message {
  messageId: string;
  roomId: string;
  taskId: string;
  sequence: number;
  senderType: "member" | "agent" | "system";
  senderId: string;
  content: string;
  parentMessageId: string | null;
  mentions: Array<{
    targetType: "agent";
    targetAgentId: string;
    displayLabel: string;
  }>;
  createdAt: string;
}

export interface RoomMessagePage {
  items: Message[];
  nextCursor: string | null;
  syncCursor?: string;
}

export interface RoomParticipants {
  memberIds: string[];
  agentIds: string[];
}

export interface RoomSettings {
  room: Room;
  participants: RoomParticipants;
}

export interface TeamChangeCursor {
  changed: boolean;
  cursor: number;
  reset: boolean;
  team?: boolean;
  roomIds?: string[];
  runRoomIds?: string[];
}

export interface Device {
  deviceId: string;
  ownerMemberId?: string;
  name: string;
  status: "active" | "revoked";
  supportsAgentProvisioning?: boolean;
}

export type AgentProvisionRequestStatus =
  | "pending"
  | "delivered"
  | "accepted"
  | "ready"
  | "rejected";

export interface AgentProvisionRequest {
  requestId: string;
  teamId: string;
  deviceId: string;
  templateAgentId: string;
  agentId: string;
  requestedByMemberId: string;
  name: string;
  role: string;
  status: AgentProvisionRequestStatus;
  rejectionReason: string | null;
  createdAt: string;
  deliveredAt: string | null;
  respondedAt: string | null;
  readyAt: string | null;
  updatedAt: string;
}

export interface Run {
  runId: string;
  taskId: string;
  triggerMessageId: string;
  targetAgentId: string;
  state: "queued" | "delivered" | "working" | "input_required" | "completed" | "failed" | "canceled" | "expired" | "outcome_unknown";
  updatedAt: string;
}

export type DiscussionState =
  | "active"
  | "stop_requested"
  | "waiting_human"
  | "awaiting_extension"
  | "paused"
  | "finalizing"
  | "completed"
  | "canceled"
  | "terminated";

export interface DiscussionView {
  discussion: {
    discussionId: string;
    taskId: string;
    goal: string;
    state: DiscussionState;
    stateReason: string | null;
    currentTurn: number;
    currentWave: number;
    progress: {
      confidence: number | null;
      openQuestions: Array<{
        id: string;
        question: string;
        importance: "low" | "medium" | "high";
      }>;
      plateauCount: number;
    };
    budget: {
      turnsUsed: number;
      durationSeconds: number;
    };
  };
  participants: Array<{
    agentId: string;
    role: "participant" | "reviewer";
  }>;
  waves: Array<{
    waveId: string;
    ordinal: number;
    phase: "contribution" | "review" | "finalization";
    state: "open" | "completed" | "partial" | "failed" | "canceled";
    expectedMembers: number;
  }>;
  turns: Array<{
    turnId: string;
    kind: "discussion" | "finalization";
    speakerAgentId: string;
    runId: string | null;
    state: "planned" | "queued" | "working" | "completed" | "failed" | "canceled";
    waveId: string | null;
    waveMemberOrdinal: number | null;
    terminalReason: string | null;
  }>;
}

export type AgentTaskState =
  | "open"
  | "working"
  | "blocked"
  | "review"
  | "completed"
  | "canceled";

export interface AgentTask {
  taskId: string;
  roomId: string;
  parentTaskId: string | null;
  title: string;
  goal: string;
  state: AgentTaskState;
  primaryAgentId: string | null;
  isDefault: boolean;
  updatedAt: string;
}

export type ArtifactMediaType =
  | "text/x-diff"
  | "text/markdown"
  | "application/json";

export interface TaskArtifact {
  artifactId: string;
  artifactRevision: number;
  taskId: string;
  roomId: string;
  type: "commit" | "branch" | "file" | "patch" | "test_result" | "document";
  title: string;
  summary: string;
  contentMode: "reference_only" | "snapshot_blob";
  contentMediaType: ArtifactMediaType | null;
  contentSizeBytes: number | null;
  contentSha256: string | null;
  createdAt: string;
}

export interface TaskArtifactPage {
  revision: number;
  artifacts: TaskArtifact[];
}

export interface ArtifactPreview {
  artifactId: string;
  artifactRevision: number;
  taskId: string;
  type: "patch" | "test_result" | "document";
  title: string;
  summary: string;
  mediaType: ArtifactMediaType;
  sha256: string;
  sizeBytes: number;
  integrity: "verified";
  trust: "untrusted";
  text: string;
  truncated: boolean;
}

export interface TaskClarification {
  clarificationId: string;
  taskId: string;
  roomId: string;
  requestingRunId: string;
  targetAgentId: string;
  question: string;
  choices: string[];
  state: "waiting" | "resumed" | "canceled";
  questionMessageId: string;
  answerMessageId: string | null;
  continuationRunId: string | null;
}

export interface MemoryCandidate {
  candidateId: string;
  roomId: string;
  scopeKind: "room" | "task";
  scopeId: string;
  taskId: string | null;
  type: string;
  content: string;
  sourceMessageIds: string[];
  checkpointId: string;
  sourceDigest: string;
  state: "pending" | "accepted" | "rejected";
  acceptedMemoryId: string | null;
  reviewedByMemberId: string | null;
  rejectionReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface LocalSession {
  userId: string;
  displayName: string;
  token?: string;
}

export type AuthMode = "local" | "trusted-team";
export type AuthGateState =
  | "loading"
  | "local_bootstrap"
  | "setup_required"
  | "sign_in_required"
  | "claim_required"
  | "authenticated";

export interface AuthenticatedUser {
  userId: string;
  displayName: string;
  createdAt?: string;
}

export type AuthStatus = {
  mode: AuthMode;
  state: Exclude<AuthGateState, "loading" | "claim_required">;
  user?: AuthenticatedUser;
  session?: { expiresAt: string };
};

export interface MemberInvitation {
  invitationId: string;
  teamId: string;
  displayName: string;
  expiresAt: string;
  claimUrl: string;
}

export interface MentionSearch {
  end: number;
  query: string;
  start: number;
}

export type WorkspaceView = "room" | "agents" | "members";
export type ConnectionMode = "managed" | "mcp" | "demo";
export type Theme = "dark" | "light";
