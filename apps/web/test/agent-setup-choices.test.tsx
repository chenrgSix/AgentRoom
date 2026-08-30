import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentSetupChoices, type AgentSetupTarget } from "../src/features/agent/AgentSetupChoices.js";

test("Agent entry paths explain installation, capability, and demo boundaries in both languages", () => {
  const zh = renderToStaticMarkup(
    <AgentSetupChoices currentMemberIsOwner locale="zh-CN" onSelect={() => {}} />
  );
  assert.match(zh, /创建中央 Agent/u);
  assert.match(zh, /无需安装 Bridge、pi 或 Codex/u);
  assert.match(zh, /不能操作电脑/u);
  assert.match(zh, /需要在执行工作的电脑安装客户端/u);
  assert.match(zh, /仅模拟回复，不调用真实模型/u);
  const en = renderToStaticMarkup(
    <AgentSetupChoices currentMemberIsOwner locale="en" onSelect={() => {}} />
  );
  assert.match(en, /Create a Central Agent/u);
  assert.match(en, /No Bridge, pi, or Codex installation/u);
  assert.match(en, /Cannot operate a computer/u);
  assert.match(en, /Simulated replies only/u);
});

test("entry choices dispatch distinct routes and keep Central setup restricted to Owners", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://team.example.com/"
  });
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
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    const selected: AgentSetupTarget[] = [];
    const view = render(
      <AgentSetupChoices currentMemberIsOwner locale="zh-CN" onSelect={(target) => selected.push(target)} />
    );
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "创建中央 Agent" }));
    fireEvent.click(page.getByRole("button", { name: "连接本机 Agent" }));
    fireEvent.click(page.getByRole("button", { name: "先体验演示" }));
    assert.deepEqual(selected, ["hosted", "local", "demo"]);
    view.rerender(
      <AgentSetupChoices currentMemberIsOwner={false} locale="zh-CN" onSelect={(target) => selected.push(target)} />
    );
    const centralButton = page.getByRole("button", { name: "创建中央 Agent" });
    assert.equal(centralButton.hasAttribute("disabled"), true);
    fireEvent.click(centralButton);
    assert.deepEqual(selected, ["hosted", "local", "demo"]);
    assert.match(page.getByText(/中央 Agent 由 Team Owner 配置/u).textContent ?? "", /请联系 Owner/u);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("entry cards collapse on narrow screens and expose keyboard focus", async () => {
  const css = await readFile(new URL("../src/features/agent/agent-setup.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.agent-setup-choices \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
  assert.match(css, /button:focus-visible/u);
  assert.match(css, /\.agent-setup-destination:focus/u);
  assert.doesNotMatch(css, /min-width:\s*[4-9]\d\dpx/u);
});
