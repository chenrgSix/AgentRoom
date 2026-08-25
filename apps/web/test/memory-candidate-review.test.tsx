import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React, { useState } from "react";

import { MemoryCandidateReview } from "../src/features/task/MemoryCandidateReview.js";
import type { MemoryCandidate } from "../src/models.js";

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window }
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true
  });
  return dom;
}

const candidates: MemoryCandidate[] = [
  {
    candidateId: "candidate_room_1234567890",
    roomId: "room_review_1234567890",
    scopeKind: "room",
    scopeId: "room_review_1234567890",
    taskId: null,
    type: "decision",
    content: "Use SQLite for durable Team state.",
    sourceMessageIds: ["message_source_1234567890"],
    checkpointId: "checkpoint_review_1234567890",
    sourceDigest: "a".repeat(64),
    state: "pending",
    acceptedMemoryId: null,
    reviewedByMemberId: null,
    rejectionReason: null,
    createdAt: "2026-08-25T09:00:00.000Z",
    reviewedAt: null
  },
  {
    candidateId: "candidate_task_1234567890",
    roomId: "room_review_1234567890",
    scopeKind: "task",
    scopeId: "task_review_1234567890",
    taskId: "task_review_1234567890",
    type: "result",
    content: "The migration passed its focused tests.",
    sourceMessageIds: ["message_result_1234567890"],
    checkpointId: "checkpoint_review_1234567890",
    sourceDigest: "a".repeat(64),
    state: "pending",
    acceptedMemoryId: null,
    reviewedByMemberId: null,
    rejectionReason: null,
    createdAt: "2026-08-25T09:00:00.000Z",
    reviewedAt: null
  }
];

test("Memory candidate review exposes provenance and converges after review", async () => {
  const dom = installDom();
  const reviewed: string[] = [];
  function Harness() {
    const [visible, setVisible] = useState(candidates);
    const finish = (candidate: MemoryCandidate) => {
      reviewed.push(candidate.candidateId);
      setVisible((current) => current.filter(({ candidateId }) =>
        candidateId !== candidate.candidateId
      ));
    };
    return (
      <MemoryCandidateReview
        busyId={null}
        candidates={visible}
        locale="zh-CN"
        onAccept={finish}
        onReject={finish}
        tasks={[{
          taskId: "task_review_1234567890",
          roomId: "room_review_1234567890",
          parentTaskId: null,
          title: "迁移验收",
          goal: "验证迁移",
          state: "review",
          primaryAgentId: null,
          isDefault: false,
          updatedAt: "2026-08-25T09:00:00.000Z"
        }]}
      />
    );
  }

  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<Harness />);
    const page = within(dom.window.document.body);
    assert.equal(page.getByText("2 条记忆待成员审核").textContent, "2 条记忆待成员审核");
    assert.ok(page.getByText("迁移验收"));
    fireEvent.click(page.getAllByText("1 条来源消息")[0]!);
    assert.match(page.getByText(/message_sour/u).textContent ?? "", /message_sour/u);

    fireEvent.click(page.getAllByRole("button", { name: "接受为长期记忆" })[0]!);
    assert.equal(page.getByText("1 条记忆待成员审核").textContent, "1 条记忆待成员审核");
    fireEvent.click(page.getByRole("button", { name: "拒绝" }));
    assert.equal(page.queryByRole("region", { name: "待审核记忆" }), null);
    assert.deepEqual(reviewed.sort(), candidates.map(({ candidateId }) => candidateId).sort());
  } finally {
    cleanup();
    dom.window.close();
  }
});
