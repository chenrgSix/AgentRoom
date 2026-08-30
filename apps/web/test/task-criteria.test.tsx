import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React, { useState } from "react";

import { TaskCreateDialog } from "../src/features/task/TaskControls.js";
import { appendCriteriaTemplate, parseTaskCriteria } from "../src/features/task/task-criteria.js";

test("criteria become bounded canonical required criteria without silently truncating", () => {
  assert.deepEqual(parseTaskCriteria("  First verifiable result.\r\n\nSecond result.  "), [
    { criterionKey: "criterion_web_00000001", description: "First verifiable result.", required: true, ordinal: 1 },
    { criterionKey: "criterion_web_00000002", description: "Second result.", required: true, ordinal: 2 }
  ]);
  assert.deepEqual(parseTaskCriteria("\n  "), []);
  assert.throws(() => parseTaskCriteria(Array(101).fill("One criterion").join("\n")), /at most 100/u);
  assert.throws(() => parseTaskCriteria("a".repeat(2001)), /2,000/u);
  assert.equal(parseTaskCriteria("a".repeat(2000))[0]?.description.length, 2000);
  assert.equal(appendCriteriaTemplate("My own requirement", ["Evidence supplied", "Limitations recorded"]), "My own requirement\nEvidence supplied\nLimitations recorded");
  assert.equal(appendCriteriaTemplate("Evidence supplied", ["Evidence supplied", "Limitations recorded"]), "Evidence supplied\nLimitations recorded");
});

test("delivery templates append to the user's criteria and invalid criteria block creation", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  function Harness() {
    const [criteria, setCriteria] = useState("Keep my original acceptance requirement.");
    return <TaskCreateDialog busy={false} criteria={criteria} goal="Find evidence" locale="en" onClose={() => undefined} onCriteriaChange={setCriteria} onGoalChange={() => undefined} onSubmit={(event) => event.preventDefault()} onTitleChange={() => undefined} roomName="research" title="Research task" />;
  }
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<Harness />);
    const page = within(dom.window.document.body);
    const disclosure = dom.window.document.querySelector("details")!;
    disclosure.open = true;
    fireEvent.click(page.getByRole("button", { name: "+ Research criteria" }));
    const field = page.getByRole("textbox", { name: "Acceptance criteria" }) as HTMLTextAreaElement;
    assert.ok(field.value.startsWith("Keep my original acceptance requirement.\n"));
    assert.equal(parseTaskCriteria(field.value).length, 4);
    fireEvent.click(page.getByRole("button", { name: "+ Research criteria" }));
    assert.equal(parseTaskCriteria(field.value).length, 4, "reapplying a template does not duplicate criteria");
    fireEvent.change(field, { target: { value: "x".repeat(2001) } });
    assert.ok(page.getByRole("alert"));
    assert.equal((page.getByRole("button", { name: "Create and switch" }) as HTMLButtonElement).disabled, true);
    fireEvent.change(field, { target: { value: "" } });
    assert.equal((page.getByRole("button", { name: "Create and switch" }) as HTMLButtonElement).disabled, false);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Task dialog traps keyboard focus, blocks Escape while busy, and restores its opener", async () => {
  const dom = new JSDOM("<!doctype html><html><body><button id='opener'>New Task</button></body></html>");
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    const opener = dom.window.document.getElementById("opener")!;
    opener.focus();
    let closed = 0;
    const props = { busy: false, goal: "Inspect evidence", locale: "en" as const, onClose: () => { closed += 1; }, onGoalChange: () => undefined, onSubmit: (event: React.FormEvent) => event.preventDefault(), onTitleChange: () => undefined, roomName: "qa", title: "A task" };
    const view = render(<TaskCreateDialog {...props} />);
    const dialog = within(dom.window.document.body).getByRole("dialog");
    const first = within(dialog).getAllByRole("button", { name: "Cancel" })[0]!;
    const last = within(dialog).getByRole("button", { name: "Create and switch" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    assert.equal(dom.window.document.activeElement, first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    assert.equal(dom.window.document.activeElement, last);
    fireEvent.keyDown(dialog, { key: "Escape" });
    assert.equal(closed, 1);
    view.rerender(<TaskCreateDialog {...props} busy />);
    fireEvent.keyDown(dialog, { key: "Escape" });
    assert.equal(closed, 1);
    view.unmount();
    assert.equal(dom.window.document.activeElement, opener);
  } finally { cleanup(); dom.window.close(); }
});
