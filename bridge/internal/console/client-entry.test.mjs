import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createClientEntryController } from "./static/client-entry.mjs";

function fixture(t, request, copyText = async () => {}) {
  const dom = new JSDOM('<button id="open-client-team"></button><button id="load-client-rooms"></button><select id="client-room"></select><button id="open-client-room"></button><p id="client-entry-status"></p><p id="client-entry-help"></p><button id="prepare-private-browser"></button><dialog id="browser-trust-dialog"></dialog><code id="browser-trust-fingerprint"></code><button id="browser-trust-platform-windows"></button><button id="browser-trust-platform-macos"></button><div id="browser-trust-windows"></div><div id="browser-trust-macos" class="hidden"></div><textarea id="browser-trust-command"></textarea><textarea id="browser-trust-removal-command"></textarea><textarea id="browser-trust-macos-command"></textarea><textarea id="browser-trust-macos-removal-command"></textarea><button id="copy-browser-trust-command"></button><button id="copy-browser-trust-removal-command"></button><button id="copy-browser-trust-macos-command"></button><button id="copy-browser-trust-macos-removal-command"></button><p id="browser-trust-status"></p><button id="close-browser-trust"></button><button id="acknowledge-browser-trust"></button>');
  t.after(() => dom.window.close());
  const elements = Object.fromEntries([...dom.window.document.querySelectorAll("[id]")].map((node) => [node.id, node]));
  const controller = createClientEntryController({elements, request, copyText});
  return {elements, controller};
}
const state = {serverUrl: "https://central.example", teamId: "team_test", deviceId: "device_test", clientAccessAvailable: true};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("client entry requires explicit actions and only sends the selected Room", async (t) => {
  const calls = [];
  const {elements: e, controller} = fixture(t, async (path, options) => {
    calls.push({path, body: options?.body ? JSON.parse(options.body) : undefined});
    return {displayName: "Alice", teamName: "Design", rooms: [{roomId: "room_first", name: "<script>not html</script>"}]};
  });
  controller.render({...state, clientAccessAvailable: false});
  e["open-client-team"].click(); await flush(); assert.equal(calls.length, 0);
  assert.match(e["client-entry-help"].textContent, /确认实际主人/u);
  controller.render(state); assert.equal(calls.length, 0);
  e["open-client-team"].click(); e["open-client-team"].click(); await flush();
  assert.deepEqual(calls, [{path: "/api/client-access/open", body: {}}]);
  e["load-client-rooms"].click(); await flush();
  assert.equal(e["client-room"].querySelector("script"), null);
  e["open-client-room"].click(); await flush();
  assert.deepEqual(calls.at(-1), {path: "/api/client-access/open", body: {roomId: "room_first"}});
});

test("a pending room list cannot reappear after switching or starting re-pairing", async (t) => {
  let resolve;
  const {elements: e, controller} = fixture(t, () => new Promise((done) => { resolve = done; }));
  controller.render(state); e["load-client-rooms"].click();
  controller.render({...state, deviceId: "device_changed", enrollment: {active: true}});
  resolve({displayName: "Previous person", teamName: "Previous Team", rooms: [{roomId: "room_old", name: "Private"}]});
  await flush();
  assert.equal(e["client-room"].options.length, 0);
  assert.equal(e["open-client-team"].disabled, true);
  assert.doesNotMatch(e["client-entry-status"].textContent, /Previous|Private/u);
});

test("private browser setup is explicit, offline, copyable, and cleared on trust change", async (t) => {
  const calls = [];
  const copied = [];
  const setup = {
    caCertificateSha256: "a".repeat(64),
    windowsPowerShellCommand: "install exact CA",
    windowsRemovalPowerShellCommand: "remove exact CA",
    macosShellCommand: "install exact CA on macOS",
    macosRemovalShellCommand: "remove exact CA on macOS"
  };
  const {elements: e, controller} = fixture(t, async (...args) => calls.push(args), async (value) => copied.push(value));
  controller.render({...state, serverTrustEpoch: 2, browserTrustSetup: setup});
  assert.equal(e["prepare-private-browser"].classList.contains("hidden"), false);
  assert.equal(e["browser-trust-dialog"].hasAttribute("open"), false);
  assert.equal(calls.length, 0);

  e["prepare-private-browser"].click();
  assert.equal(e["browser-trust-dialog"].hasAttribute("open"), true);
  assert.equal(e["browser-trust-fingerprint"].textContent, "A".repeat(64));
  assert.equal(e["browser-trust-command"].value, setup.windowsPowerShellCommand);
  assert.equal(e["browser-trust-macos-command"].value, setup.macosShellCommand);
  assert.equal(calls.length, 0);
  e["copy-browser-trust-command"].click(); await flush();
  e["copy-browser-trust-removal-command"].click(); await flush();
  e["browser-trust-platform-macos"].click();
  assert.equal(e["browser-trust-windows"].classList.contains("hidden"), true);
  assert.equal(e["browser-trust-macos"].classList.contains("hidden"), false);
  e["copy-browser-trust-macos-command"].click(); await flush();
  e["copy-browser-trust-macos-removal-command"].click(); await flush();
  assert.deepEqual(copied, [
    setup.windowsPowerShellCommand,
    setup.windowsRemovalPowerShellCommand,
    setup.macosShellCommand,
    setup.macosRemovalShellCommand
  ]);
  assert.equal(calls.length, 0);

  controller.render({...state, serverTrustEpoch: 3, browserTrustSetup: {
    ...setup,
    caCertificateSha256: "b".repeat(64),
    windowsPowerShellCommand: "new CA"
  }});
  assert.equal(e["browser-trust-dialog"].hasAttribute("open"), false);
  assert.equal(e["browser-trust-fingerprint"].textContent, "");
  assert.equal(e["browser-trust-command"].value, "");
  assert.equal(e["browser-trust-removal-command"].value, "");
  assert.equal(e["browser-trust-macos-command"].value, "");
  assert.equal(e["browser-trust-macos-removal-command"].value, "");
});

test("private browser setup fails closed and reports clipboard failure honestly", async (t) => {
  const {elements: e, controller} = fixture(t, async () => assert.fail("unexpected request"), async () => {
    throw new Error("clipboard denied");
  });
  controller.render({...state, browserTrustSetup: {caCertificateSha256: "short", windowsPowerShellCommand: "unsafe"}});
  assert.equal(e["prepare-private-browser"].classList.contains("hidden"), true);
  e["prepare-private-browser"].click();
  assert.equal(e["browser-trust-dialog"].hasAttribute("open"), false);

  controller.render({...state, browserTrustSetup: {
    caCertificateSha256: "c".repeat(64),
    windowsPowerShellCommand: "install",
    windowsRemovalPowerShellCommand: "remove",
    macosShellCommand: "install macos",
    macosRemovalShellCommand: "remove macos"
  }});
  e["prepare-private-browser"].click();
  e["copy-browser-trust-command"].click(); await flush();
  assert.match(e["browser-trust-status"].textContent, /复制失败.*未执行任何系统更改/u);

  controller.render({...state, enrollment: {active: true}, browserTrustSetup: {
    caCertificateSha256: "c".repeat(64),
    windowsPowerShellCommand: "install",
    windowsRemovalPowerShellCommand: "remove",
    macosShellCommand: "install macos",
    macosRemovalShellCommand: "remove macos"
  }});
  assert.equal(e["prepare-private-browser"].classList.contains("hidden"), true);
  assert.equal(e["browser-trust-dialog"].hasAttribute("open"), false);
});

test("private browser guide is platform-neutral and retains trust, restart, removal, and no-ticket copy", () => {
  const html = readFileSync(new URL("./static/index.html", import.meta.url), "utf8");
  assert.match(html, /准备其他电脑浏览器/u);
  assert.doesNotMatch(html, /准备另一台 Windows 浏览器/u);
  assert.match(html, /Windows、macOS 或 Linux/u);
  assert.match(html, /Linux 也可以使用/u);
  assert.match(html, /不使用 sudo，也不修改系统钥匙串/u);
  assert.match(html, /持续的.*根证书信任/u);
  assert.match(html, /完整 SHA-256/u);
  assert.match(html, /完全退出并重新打开浏览器/u);
  assert.match(html, /如何从 Windows 移除此信任/u);
  assert.match(html, /如何从 macOS 移除此信任/u);
  assert.match(html, /不包含设备凭据、成员身份或房间入口/u);
});
