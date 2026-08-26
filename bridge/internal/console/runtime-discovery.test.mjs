import assert from "node:assert/strict";
import test from "node:test";
import { detectedPathForDraft, runtimeDiscoveryView } from "./static/runtime-discovery.mjs";

test("missing detection never erases a manual executable path", () => {
  assert.equal(detectedPathForDraft("/custom/codex", ""), "/custom/codex");
  assert.equal(detectedPathForDraft("/custom/codex", undefined), "/custom/codex");
  assert.equal(detectedPathForDraft("/custom/codex", "/detected/codex"), "/detected/codex");
});

test("missing Codex explains terminal lookup, app contents, and installation", () => {
  const view = runtimeDiscoveryView("codex", {});
  assert.match(view.status, /PATH/);
  assert.match(view.help, /command -v codex/);
  assert.match(view.help, /where.exe codex/);
  assert.match(view.help, /ChatGPT.app/);
  assert.match(view.help, /Contents\/Resources\/codex/);
  assert.match(view.help, /不要填所在目录/);
  assert.equal(view.showCodexInstall, true);
});

test("missing Pi shows Pi-specific lookup without a Codex installation link", () => {
  const view = runtimeDiscoveryView("pi", {});
  assert.match(view.help, /command -v pi/);
  assert.equal(view.showCodexInstall, false);
});

test("found path exposes source without claiming Runtime preflight success", () => {
  const view = runtimeDiscoveryView("codex", {runtimeDiscovery: {codex: {path: "/Applications/ChatGPT.app/Contents/Resources/codex", source: "macOS App"}}});
  assert.match(view.status, /应用内置 CLI/);
  assert.match(view.help, /检测只检查文件/);
  assert.equal(view.showCodexInstall, false);
  assert.equal(runtimeDiscoveryView("pi", {detectedPi: "/local/pi"}).path, "/local/pi");
});
