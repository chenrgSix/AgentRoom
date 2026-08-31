import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React, { useState } from "react";

import { ArtifactPreviewPanel } from
  "../src/features/task/ArtifactPreviewPanel.js";
import type {
  ArtifactMediaType,
  ArtifactPreview,
  TaskArtifact
} from "../src/models.js";

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

const mediaByType: Record<TaskArtifact["type"], ArtifactMediaType> = {
  branch: "text/markdown",
  commit: "text/markdown",
  document: "text/markdown",
  file: "text/markdown",
  patch: "text/x-diff",
  test_result: "application/json"
};

const artifacts: TaskArtifact[] = ([
  ["patch", "Patch result"],
  ["document", "Markdown result"],
  ["test_result", "JSON result"]
] as const).map(([type, title], index) => ({
  artifactId: `artifact_preview_${index}12345678`,
  artifactRevision: index + 1,
  taskId: "task_preview_12345678",
  roomId: "room_preview_12345678",
  type,
  title,
  summary: `Untrusted ${type} evidence`,
  contentMode: "snapshot_blob",
  contentMediaType: mediaByType[type],
  contentSizeBytes: 42,
  contentSha256: String(index + 1).repeat(64),
  createdAt: "2026-08-25T10:00:00.000Z",
  path: "/Users/alice/private/worktree/secret.txt"
})) as Array<TaskArtifact & { path: string }>;

const textByType: Record<ArtifactPreview["type"], string> = {
  patch: "diff --git a/a b/a\n+<script>window.compromised=true</script>",
  document: "# Result\n<img src=x onerror=window.compromised=true>",
  test_result: "{\"status\":\"pass\",\"html\":\"<script>bad()</script>\"}"
};

test("Artifact snapshots render verified Patch, Markdown, and JSON as untrusted text", async () => {
  const dom = installDom();
  function Harness() {
    const [preview, setPreview] = useState<ArtifactPreview | null>(null);
    return (
      <ArtifactPreviewPanel
        artifacts={artifacts}
        busyId={null}
        error={null}
        locale="en"
        onClose={() => setPreview(null)}
        onPreview={(artifact) => setPreview({
          artifactId: artifact.artifactId,
          artifactRevision: artifact.artifactRevision,
          taskId: artifact.taskId,
          type: artifact.type as ArtifactPreview["type"],
          title: artifact.title,
          summary: artifact.summary,
          mediaType: mediaByType[artifact.type],
          sha256: artifact.contentSha256!,
          sizeBytes: artifact.contentSizeBytes!,
          integrity: "verified",
          trust: "untrusted",
          text: textByType[artifact.type as ArtifactPreview["type"]],
          truncated: false
        })}
        preview={preview}
      />
    );
  }

  const { cleanup, fireEvent, render, within } = await import(
    "@testing-library/react"
  );
  try {
    render(<Harness />);
    const page = within(dom.window.document.body);
    assert.ok(page.getByText(/content remains untrusted evidence/u));
    assert.equal(dom.window.document.body.textContent?.includes("/Users/alice"), false);
    const buttons = page.getAllByRole("button", { name: "Safe preview" });
    for (const [index, artifact] of artifacts.entries()) {
      fireEvent.click(buttons[index]!);
      const preview = page.getByRole("region", {
        name: "Artifact content preview"
      });
      const code = preview.querySelector("pre > code");
      assert.equal(
        code?.textContent,
        textByType[artifact.type as ArtifactPreview["type"]]
      );
      assert.equal(code?.parentElement?.dataset.mediaType, artifact.contentMediaType);
      assert.equal(dom.window.document.querySelector("script"), null);
      assert.equal(dom.window.document.querySelector("img"), null);
    }
    fireEvent.click(page.getByRole("button", { name: "Close" }));
    assert.equal(page.queryByRole("region", {
      name: "Artifact content preview"
    }), null);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("binary commit snapshots show metadata without text-preview or execution controls", async () => {
  const dom = installDom();
  const { cleanup, render, within } = await import("@testing-library/react");
  let previews = 0;
  try {
    render(<ArtifactPreviewPanel artifacts={[{ ...artifacts[0]!, type: "commit", title: "Captured commit",
      contentMediaType: "application/x-git-bundle" }]} busyId={null} error={null} locale="en"
      onClose={() => {}} onPreview={() => { previews++; }} preview={null} />);
    const page = within(dom.window.document.body);
    assert.ok(page.getByText("Captured commit"));
    assert.ok(page.getByText(/Binary Artifact metadata only/u));
    assert.equal(page.queryByRole("button", { name: "Safe preview" }), null);
    assert.equal(page.queryByRole("region", { name: "Artifact content preview" }), null);
    assert.equal(previews, 0);
  } finally { cleanup(); dom.window.close(); }
});
