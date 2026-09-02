import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionEvidencePage } from
  "@convene-wire/contracts/execution-plan";
import type { TaskProjection } from "@convene-wire/contracts/task-result";
import { JSDOM } from "jsdom";
import React from "react";

import { ExecutionEvidencePanel } from
  "../src/features/work/ExecutionEvidencePanel.js";
import type { Member } from "../src/models.js";

const timestamp = "2026-09-03T08:00:00.000Z";
const task = {
  taskId: "task_evidence_surface0001",
  taskDisplayNumber: 64,
  teamId: "team_evidence_surface0001",
  roomId: "room_evidence_surface0001",
  parentTaskId: null,
  title: "Inspect execution evidence",
  goal: "See exact proof authority",
  lifecycleState: "active",
  schedulingState: "enabled",
  priority: "high",
  ownerMemberId: "member_evidence_owner0001",
  createdByMemberId: "member_evidence_owner0001",
  completionPolicy: "accepted_result_required",
  completionResultId: null,
  isDefault: false,
  taskRevision: 4,
  definitionRevision: 1,
  criteriaRevision: 1,
  criteria: [], assignments: [],
  budgetPolicy: { maxRunAttempts: 8, maxExecutionDurationSeconds: 7200 },
  budgetUsage: { usageRevision: 0, runAttempts: 1,
    executionDurationSeconds: 20, providerTokens: null, providerCostUsd: null },
  attentionReasons: [], nextAction: null, dueAt: null,
  createdAt: timestamp, updatedAt: timestamp
} as TaskProjection;
const owner: Member = {
  memberId: task.ownerMemberId,
  teamId: task.teamId,
  userId: "user_evidence_owner0001",
  displayName: "Owner",
  role: "owner",
  createdAt: timestamp
};

const remoteTemplate = {
  providerBindingId: "providerbinding_evidence0001",
  planRevision: 1,
  nodeKey: "Remote",
  expectedPlanDigest: "a".repeat(64),
  expectedControlRevision: 2,
  sourceEvidenceId: "sourceevidence_remote0001"
};
const integrationTemplate = {
  candidateCommit: "2".repeat(40),
  candidateTree: "3".repeat(40),
  deadline: "2026-09-03T08:05:00.000Z",
  inputDigest: "4".repeat(64),
  materializationDigest: "5".repeat(64),
  nodeKey: "Local",
  planId: "plan_evidence_surface0001",
  planRevision: 1,
  target: {
    repositoryId: "repo_evidence0001",
    targetRef: "refs/heads/main",
    expectedCommit: "1".repeat(40)
  },
  verificationReceipts: [{
    verificationId: "verification_evidence0001",
    receiptDigest: "6".repeat(64)
  }]
};

function source(kind: "remote_commit" | "repository_checkpoint") {
  return {
    version: 1,
    sourceEvidenceId: kind === "remote_commit"
      ? "sourceevidence_remote0001" : "sourceevidence_local0001",
    kind,
    sourceDigest: "7".repeat(64),
    artifactPins: [{
      outputSlot: "patch",
      artifactId: "artifact_evidence0001",
      artifactRevision: 1,
      kind: "patch",
      contentDigest: "8".repeat(64),
      byteLength: 42
    }],
    createdAt: timestamp,
    repositoryId: "repo_evidence0001",
    commit: kind === "remote_commit" ? "9".repeat(40) : "2".repeat(40),
    tree: "3".repeat(40),
    inputDigest: "4".repeat(64),
    origin: kind === "remote_commit" ? {
      kind: "remote_observation",
      providerBindingId: remoteTemplate.providerBindingId,
      providerRepositoryId: "owner/repository",
      observationId: "observation_evidence0001",
      observationDigest: "b".repeat(64),
      commitBundleArtifactId: "artifact_bundle_evidence0001"
    } : {
      kind: "repository_checkpoint",
      checkpointId: "checkpoint_evidence0001",
      checkpointDigest: "c".repeat(64),
      captureOperationId: "op_capture_evidence0001",
      bindingId: "repobind_evidence0001"
    }
  };
}

function page(remoteAdopted = false): ExecutionEvidencePage {
  const remoteSource = source("remote_commit");
  const localSource = source("repository_checkpoint");
  return {
    version: 1,
    taskId: task.taskId,
    plans: [{
      planId: integrationTemplate.planId,
      planRevision: 1,
      planDigest: remoteTemplate.expectedPlanDigest,
      controlRevision: 2,
      state: "running",
      nodes: [{
        nodeKey: "Remote",
        taskId: "task_remote_node0001",
        runtime: null,
        requiredVerificationProfiles: [{
          profileId: "profile_remote_ci0001", revision: 1, digest: "d".repeat(64)
        }],
        stages: remoteAdopted ? [{
          gate: "verified_output",
          materializationDigest: "e".repeat(64),
          source: remoteSource,
          proofs: [{ kind: "ci_observation_receipt", operationId: "op_ci_evidence0001",
            proofDigest: "f".repeat(64), providerBindingId: remoteTemplate.providerBindingId,
            observationId: "ciobservation_evidence0001", checkKey: "unit", attempt: 1,
            profileId: "profile_remote_ci0001", profileRevision: 1,
            profileDigest: "d".repeat(64) }],
          adoption: {
            version: 1, adoptionId: "adoption_evidence0001",
            adoptionDigest: "0".repeat(64), operationId: "op_adopt_evidence0001",
            operationDigest: "1".repeat(64), planId: integrationTemplate.planId,
            planRevision: 1, nodeKey: "Remote", gate: "verified_output",
            sourceEvidenceId: remoteSource.sourceEvidenceId,
            sourceDigest: remoteSource.sourceDigest, sourceExecution: null,
            proofs: [{ kind: "ci_observation_receipt", operationId: "op_ci_evidence0001",
              proofDigest: "f".repeat(64), providerBindingId: remoteTemplate.providerBindingId,
              observationId: "ciobservation_evidence0001", checkKey: "unit", attempt: 1,
              profileId: "profile_remote_ci0001", profileRevision: 1,
              profileDigest: "d".repeat(64) }],
            proofSetDigest: "2".repeat(64), nodeContractDigest: "3".repeat(64),
            resolvedInputSetDigest: "4".repeat(64), createdAt: timestamp,
            authority: { service: "remote_evidence_adoption",
              actorMemberId: owner.memberId, providerBindingId: remoteTemplate.providerBindingId,
              bindingDigest: "5".repeat(64), approvalOperationId: "op_approve_plan0001",
              planDigest: remoteTemplate.expectedPlanDigest, roomId: task.roomId,
              taskId: task.taskId, definitionRevision: 1, criteriaRevision: 1 }
          }
        }] : [],
        verifications: [{
          kind: "remote_ci",
          receipt: {
            version: 1, operationId: "op_ci_evidence0001",
            observationId: "ciobservation_evidence0001",
            providerBindingId: remoteTemplate.providerBindingId,
            repositoryId: "repo_evidence0001", providerRepositoryId: "owner/repository",
            sourceEvidenceId: remoteSource.sourceEvidenceId,
            commit: "9".repeat(40), tree: "3".repeat(40), checkKey: "unit",
            profileId: "profile_remote_ci0001", profileRevision: 1,
            profileDigest: "d".repeat(64), attempt: 1, outcome: "passed",
            providerObservationDigest: "6".repeat(64), receiptDigest: "f".repeat(64),
            observedAt: timestamp
          }
        }],
        remote: {
          commitObservation: {
            version: 1, operationId: "op_remote_evidence0001",
            observationId: "observation_evidence0001",
            providerBindingId: remoteTemplate.providerBindingId,
            repositoryId: "repo_evidence0001", providerRepositoryId: "owner/repository",
            taskId: task.taskId, objectFormat: "sha1", baseCommit: "1".repeat(40),
            commit: "9".repeat(40), tree: "3".repeat(40), pullRequest: null,
            bundleArtifactId: "artifact_bundle_evidence0001", bundleDigest: "7".repeat(64),
            bundleByteLength: 100, patchArtifactId: "artifact_evidence0001",
            patchArtifactRevision: 1, patchOutputSlot: "patch", patchDigest: "8".repeat(64),
            patchByteLength: 42, inputDigest: "4".repeat(64),
            providerObservationDigest: "b".repeat(64), observationDigest: "c".repeat(64),
            observedAt: timestamp
          },
          source: remoteSource,
          ciReceipts: [],
          adoptionState: remoteAdopted ? "adopted" : "ready",
          blockerCodes: [],
          commandTemplate: remoteAdopted ? null : remoteTemplate
        },
        integration: { state: "not_required", target: null, approval: null,
          receipt: null, blockerCode: null, commandTemplate: null },
        nextAction: remoteAdopted
          ? { kind: "none", actorKind: "none", reasonCode: "NO_ACTION" }
          : { kind: "adopt_remote_evidence", actorKind: "team_owner",
            reasonCode: "REMOTE_ADOPTION_READY" }
      }, {
        nodeKey: "Local",
        taskId: "task_local_node0001",
        runtime: { state: "awaiting_result", blockerCode: null,
          dispatchGeneration: 1, runId: "run_evidence_local0001",
          lastRunState: "completed", projectionRevision: 3, updatedAt: timestamp },
        requiredVerificationProfiles: [{ profileId: "profile_local0001",
          revision: 1, digest: "d".repeat(64) }],
        stages: [],
        verifications: [{
          kind: "local_verification",
          receipt: { verificationId: "verification_evidence0001", outcome: "passed",
            profileId: "profile_local0001" },
          receiptDigest: "6".repeat(64), recordedAt: timestamp
        }],
        remote: null,
        integration: { state: "approval_ready", target: integrationTemplate.target,
          approval: null, receipt: null, blockerCode: null,
          commandTemplate: integrationTemplate },
        nextAction: { kind: "approve_integration", actorKind: "task_owner",
          reasonCode: "INTEGRATION_APPROVAL_READY" }
      }]
    }]
  } as unknown as ExecutionEvidencePage;
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://team.example.com/"
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    navigator: { configurable: true, value: dom.window.navigator },
    sessionStorage: { configurable: true, value: dom.window.sessionStorage },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  return dom;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function renderPanel(render: typeof import("@testing-library/react")["render"]) {
  return render(<ExecutionEvidencePanel currentMember={owner} locale="en-US"
    onChanged={() => undefined} task={task} token="token" />);
}

test("proof surface renders local and remote authority as text and submits exact templates", async () => {
  const dom = installDom();
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  let state = page();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (path.endsWith("/remote-evidence-adoptions")) state = page(true);
      return json({ ok: true });
    }
    return json(state);
  }) as typeof fetch;
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    renderPanel(render);
    const screen = within(dom.window.document.body);
    await screen.findByText("Execution evidence and repository control");
    assert.ok(screen.getByText("remote commit"));
    assert.ok(screen.getByText("unit"));
    assert.ok(screen.getByText("REMOTE_ADOPTION_READY"));
    assert.equal(dom.window.document.querySelector("script"), null);

    fireEvent.click(screen.getByLabelText(
      "I confirm adoption of this plan revision, source, and complete CI proof set."
    ));
    fireEvent.click(screen.getByRole("button", { name: "Explicitly adopt remote evidence" }));
    await waitFor(() => assert.match(
      dom.window.document.body.textContent ?? "", /Remote adoption: adopted/u
    ));
    assert.equal(posts[0]?.path,
      `/api/execution-plans/${integrationTemplate.planId}/remote-evidence-adoptions`);
    assert.deepEqual(Object.fromEntries(Object.entries(posts[0]!.body)
      .filter(([key]) => key !== "operationId")), remoteTemplate);
    assert.match(String(posts[0]!.body.operationId), /^op_[A-Za-z0-9_-]{8,128}$/u);

    fireEvent.click(screen.getByLabelText(
      "I confirm the exact candidate, verification receipts, target ref, and expected-commit CAS."
    ));
    fireEvent.click(screen.getByRole("button", { name: "Approve exact-target integration" }));
    assert.equal(posts[1]?.path,
      `/api/execution-plans/${integrationTemplate.planId}/integration-approvals`);
    assert.deepEqual(Object.fromEntries(Object.entries(posts[1]!.body)
      .filter(([key]) => key !== "operationId")), integrationTemplate);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("transport loss retains one exact command across remount and structured rejection clears it", async () => {
  const dom = installDom();
  const bodies: Record<string, unknown>[] = [];
  let outcome: "cut" | "ok" | "reject" = "cut";
  let state = page();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (outcome === "cut") throw new TypeError("network cut");
      if (outcome === "reject") return json({ error: { message: "stale proof" } }, 409);
      if (String(input).endsWith("/remote-evidence-adoptions")) state = page(true);
      return json({ ok: true });
    }
    return json(state);
  }) as typeof fetch;
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    const first = renderPanel(render);
    let screen = within(dom.window.document.body);
    await screen.findByText("Execution evidence and repository control");
    fireEvent.click(screen.getByLabelText(
      "I confirm adoption of this plan revision, source, and complete CI proof set."
    ));
    fireEvent.click(screen.getByRole("button", { name: "Explicitly adopt remote evidence" }));
    await screen.findByRole("button", { name: "Retry exact remote adoption command" });
    assert.equal(dom.window.sessionStorage.length, 1);
    const firstOperation = bodies[0]!.operationId;

    first.unmount();
    renderPanel(render);
    screen = within(dom.window.document.body);
    await screen.findByRole("button", { name: "Retry exact remote adoption command" });
    outcome = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Retry exact remote adoption command" }));
    await waitFor(() => assert.match(
      dom.window.document.body.textContent ?? "", /Remote adoption: adopted/u
    ));
    assert.equal(bodies[1]!.operationId, firstOperation);
    assert.deepEqual(bodies[1], bodies[0]);

    outcome = "reject";
    fireEvent.click(screen.getByLabelText(
      "I confirm the exact candidate, verification receipts, target ref, and expected-commit CAS."
    ));
    const integrationButton = screen.getByRole("button", {
      name: "Approve exact-target integration"
    }) as HTMLButtonElement;
    await waitFor(() => assert.equal(integrationButton.disabled, false));
    fireEvent.click(integrationButton);
    await screen.findByText(/stale proof/u);
    assert.equal(dom.window.sessionStorage.length, 0);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("ordinary members can inspect proof but cannot see owner commands", async () => {
  const dom = installDom();
  globalThis.fetch = (async () => json(page())) as typeof fetch;
  const { cleanup, render, within } = await import("@testing-library/react");
  try {
    render(<ExecutionEvidencePanel currentMember={{ ...owner, role: "member",
      memberId: "member_evidence_viewer0001" }} locale="zh-CN"
      onChanged={() => undefined} task={task} token="token" />);
    const screen = within(dom.window.document.body);
    await screen.findByText("执行证据与仓库控制");
    assert.ok(screen.getByText("REMOTE_ADOPTION_READY"));
    assert.equal(screen.queryByRole("button", { name: "明确采用远程证据" }), null);
    assert.equal(screen.queryByRole("button", { name: "批准精确目标集成" }), null);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("draft plans render an explicit no-compiled-evidence state", async () => {
  const dom = installDom();
  const draft = page();
  draft.plans[0]!.state = "draft";
  draft.plans[0]!.nodes = [];
  globalThis.fetch = (async () => json(draft)) as typeof fetch;
  const { cleanup, render, within } = await import("@testing-library/react");
  try {
    renderPanel(render);
    const screen = within(dom.window.document.body);
    await screen.findByText(
      "This Plan is not approved yet, so it has no compiled Tasks or execution evidence."
    );
    assert.equal(screen.queryAllByRole("article").length, 0);
  } finally {
    cleanup();
    dom.window.close();
  }
});
