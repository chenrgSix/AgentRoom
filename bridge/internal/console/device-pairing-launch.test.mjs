import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  configuredPairingEntryView,
  configuredPairingLaunchView,
  maximumPairingLinkBytes,
  pairingLinkFromHash,
  pairingOriginFromLink
} from "./static/device-pairing-launch.mjs";

const link = "convenewire://pair-device?origin=https%3A%2F%2Fteam.example&pairingSessionId=pairing_12345678&expiresAt=2026-08-28T12%3A00%3A00Z#claimSecret=secret";
const legacyLink = link.replace("convenewire://", "agentroom://");
const httpsLink = link.replace("convenewire://pair-device?origin=https%3A%2F%2Fteam.example&", "https://team.example/device-pairing?");

test("desktop pairing consumes HTTPS and loopback links without losing their proof", () => {
  for (const candidate of [httpsLink, httpsLink.replace("https://team.example", "http://127.0.0.1:3000"), httpsLink.replace("https://team.example", "http://[::1]:3000")]) {
    assert.equal(pairingLinkFromHash(`#${new URLSearchParams({pairingLink: candidate})}`), candidate);
    assert.equal(pairingOriginFromLink(candidate), new URL(candidate).origin);
  }
  for (const candidate of [
    httpsLink.replace("https://", "http://"),
    httpsLink.replace("team.example/", "user@team.example/"),
    httpsLink.replace("/device-pairing?", "/other?"),
    httpsLink.replace("?", "?origin=https%3A%2F%2Fevil.example&"),
    httpsLink.replace("?", "?pairingSessionId=pairing_other123&"),
    link.replace("pair-device?", "pair-device/?"),
    link.replace("pair-device?", "user@pair-device?")
  ]) assert.equal(pairingLinkFromHash(`#${new URLSearchParams({pairingLink: candidate})}`), "");
});

test("nested fragment bounds admit the Go private-CA fixture and reject oversized decoded links", () => {
  const origin = "https://" + "!".repeat(2040);
  const candidate = "convenewire://pair-device?" + new URLSearchParams({
    origin, pairingSessionId: "pairing_" + "s".repeat(128), expiresAt: "2026-08-31T12:00:00.123456789Z"
  }) + "#" + new URLSearchParams({
    claimSecret: "c".repeat(128), trustMode: "private_scoped_ca", trustOrigin: origin,
    installationId: "install_" + "i".repeat(128), trustEpoch: "2147483647", caCertificateSha256: "a".repeat(64)
  });
  const hash = `#${new URLSearchParams({pairingLink: candidate})}`;
  assert.ok(candidate.length > 8192 && candidate.length <= maximumPairingLinkBytes);
  assert.ok(hash.length > maximumPairingLinkBytes);
  assert.equal(pairingLinkFromHash(hash), candidate);
  assert.equal(pairingOriginFromLink(candidate), origin);
  for (const oversized of [link + "x".repeat(maximumPairingLinkBytes), link + "界".repeat(maximumPairingLinkBytes / 2)]) {
    assert.equal(pairingLinkFromHash(`#${new URLSearchParams({pairingLink: oversized})}`), "");
  }
});

test("actual embedded page consumes first-load and same-document activations and clears the URL", () => {
  const source = readFileSync(new URL("./static/app.js", import.meta.url), "utf8");
  const controllers = source.slice(source.indexOf("const query = new URLSearchParams"), source.indexOf("const pageCopy ="));
  const listeners = new Map();
  const storage = new Map();
  const errors = [];
  const rendered = [];
  const location = {pathname: "/", search: "?token=local-only", hash: `#${new URLSearchParams({pairingLink: httpsLink})}`};
  const elements = {
    "device-pairing-link": {value: ""}, "server-url": {value: ""},
    "auth-warning": {classList: {remove() { assert.fail("token lost"); }}}
  };
  const context = vm.createContext({
    URLSearchParams, pairingLinkFromHash, pairingOriginFromLink, elements,
    window: {location, addEventListener: (event, handler) => listeners.set(event, handler)},
    history: {replaceState(_state, _unused, url) { assert.equal(url, "/"); location.hash = ""; location.search = ""; }},
    sessionStorage: {setItem: (key, value) => storage.set(key, value), getItem: (key) => storage.get(key)},
    showError: (error) => errors.push(error.message), renderConfiguredPairingLaunch: (state) => rendered.push(state)
  });
  vm.runInContext(controllers, context);
  assert.equal(elements["device-pairing-link"].value, httpsLink);
  assert.equal(elements["server-url"].value, "https://team.example");
  assert.equal(location.hash, "");
  vm.runInContext("currentState = {configured: true, enrollment: {active: false}}", context);
  location.hash = `#${new URLSearchParams({pairingLink: legacyLink})}`;
  listeners.get("hashchange")();
  assert.equal(vm.runInContext("pendingPairingLink", context), legacyLink);
  assert.equal(elements["device-pairing-link"].value, legacyLink);
  assert.equal(location.hash, "");
  assert.equal(rendered.length, 1);
  vm.runInContext("currentState.enrollment.active = true", context);
  location.hash = `#${new URLSearchParams({pairingLink: httpsLink})}`;
  listeners.get("hashchange")();
  assert.equal(vm.runInContext("pendingPairingLink", context), legacyLink);
  assert.equal(location.hash, "");
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes("claimSecret"));
});

test("desktop launch fragment returns the exact nested Device pairing link", () => {
  assert.equal(pairingLinkFromHash(`#pairingLink=${encodeURIComponent(link)}`), link);
  assert.equal(
    pairingLinkFromHash(`#pairingLink=${encodeURIComponent(legacyLink)}`),
    legacyLink
  );
});

test("desktop launch fragment rejects ambiguous or unrelated values", () => {
  for (const hash of [
    "", "#pairingLink=https%3A%2F%2Fteam.example", "#other=value",
    `#pairingLink=${encodeURIComponent(link)}&other=value`,
    `#pairingLink=${encodeURIComponent(link)}&pairingLink=${encodeURIComponent(link)}`
  ]) assert.equal(pairingLinkFromHash(hash), "");
});

test("pairing link projects its exact Central origin for local prefill", () => {
  assert.equal(pairingOriginFromLink(link), "https://team.example");
  assert.equal(pairingOriginFromLink(legacyLink), "https://team.example");
  const loopback = link.replace(
    "https%3A%2F%2Fteam.example",
    "http%3A%2F%2F127.0.0.1%3A3000"
  );
  assert.equal(pairingOriginFromLink(loopback), "http://127.0.0.1:3000");
});

test("pairing origin prefill rejects ambiguous or unsafe link origins", () => {
  for (const candidate of [
    "not a link",
    link.replace("https%3A%2F%2Fteam.example", "http%3A%2F%2Fteam.example"),
    link.replace("https%3A%2F%2Fteam.example", "https%3A%2F%2Fuser%40team.example"),
    link.replace("https%3A%2F%2Fteam.example", "https%3A%2F%2Fteam.example%2Fpath"),
    link.replace("&pairingSessionId=", "&origin=https%3A%2F%2Fother.example&pairingSessionId="),
    link.replace("&expiresAt=", "&unexpected=value&expiresAt=")
  ]) assert.equal(pairingOriginFromLink(candidate), "");
});

test("configured pairing entry accepts a complete link including another Central for review", () => {
  const state = {
    configured: true,
    serverUrl: "https://team.example",
    enrollment: {active: false}
  };
  assert.deepEqual(configuredPairingEntryView(link, state), {
    canContinue: true,
    error: ""
  });
  assert.equal(configuredPairingEntryView("", state).canContinue, false);
  assert.match(
    configuredPairingEntryView("not a link", state).error,
    /完整/
  );
  assert.deepEqual(configuredPairingEntryView(link, {...state, serverUrl: "https://other.example"}), {
    canContinue: true, error: ""
  });
});

test("configured pairing entry remains closed outside an idle configured client", () => {
  assert.deepEqual(configuredPairingEntryView(link, {configured: false}), {
    canContinue: false,
    error: ""
  });
  const active = configuredPairingEntryView(link, {
    configured: true,
    serverUrl: "https://team.example",
    enrollment: {active: true}
  });
  assert.equal(active.canContinue, false);
  assert.match(active.error, /正在进行/);
});

test("configured pairing launch requires an explicit idle same-Central confirmation", () => {
  const base = {
    configured: true,
    paired: true,
    bridgeRunning: false,
    serverUrl: "https://team.example",
    enrollment: {active: false, canRequest: true, blockedReason: ""}
  };
  assert.deepEqual(configuredPairingLaunchView(link, base), {
    show: true,
    mode: "replace",
    canConfirm: true,
    showStop: false,
    blockedReason: ""
  });
  assert.deepEqual(configuredPairingLaunchView(link, {
    ...base,
    bridgeRunning: true,
    enrollment: {active: false, canRequest: false, blockedReason: "请先停止 Bridge。"}
  }), {
    show: true,
    mode: "replace",
    canConfirm: false,
    showStop: true,
    blockedReason: "请先停止 Bridge。"
  });
  const active = configuredPairingLaunchView(link, {
    ...base,
    bridgeRunning: true,
    agents: [{activeRuns: 1}],
    enrollment: {active: false, canRequest: false, blockedReason: "请先停止 Bridge。"}
  });
  assert.equal(active.showStop, false);
  assert.match(active.blockedReason, /不会中断/);
  assert.equal(configuredPairingLaunchView(link, {...base, paired: false}).mode, "complete");
});

test("configured pairing launch offers an explicit Central switch but never an active attempt", () => {
  const base = {
    configured: true,
    paired: true,
    bridgeRunning: false,
    serverUrl: "https://other.example",
    enrollment: {active: false, canRequest: true, blockedReason: ""}
  };
  const different = configuredPairingLaunchView(link, base);
  assert.equal(different.show, true);
  assert.equal(different.mode, "switch");
  assert.equal(different.canConfirm, true);
  assert.equal(different.blockedReason, "");
  assert.equal(configuredPairingLaunchView(link, {...base, bridgeRunning: true}).canConfirm, false);
  assert.equal(configuredPairingLaunchView(link, {...base, bridgeRunning: true}).showStop, true);
  assert.equal(configuredPairingLaunchView(link, {...base, agents: [{activeRuns: 1}]}).canConfirm, false);
  assert.equal(configuredPairingLaunchView(link, {...base, paired: false}).mode, "switch");
  assert.equal(configuredPairingLaunchView(link, {
    ...base,
    serverUrl: "https://team.example",
    enrollment: {active: true, canRequest: false, blockedReason: ""}
  }).show, false);
  assert.equal(configuredPairingLaunchView(link, {...base, configured: false}).show, false);
});

test("actual confirmation page reviews origins, freezes identity, sends explicit consent and clears proof", async () => {
  const source = readFileSync(new URL("./static/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./static/index.html", import.meta.url), "utf8");
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    textContent: "", value: "", disabled: false,
    classList: {add() {}, remove() {}, toggle() {}}
  }]));
  const requests = [];
  const state = {configured: true, paired: true, deviceId: "device_original", serverUrl: "http://127.0.0.1:3000",
    bridgeRunning: false, enrollment: {active: false, canRequest: true}};
  const context = vm.createContext({
    elements, configuredPairingLaunchView, pairingOriginFromLink, currentState: state,
    pendingPairingLink: link, pairingReview: null, expectedPairingDeviceId: null, enrollmentActionRunning: false,
    showError(error) { if (error) throw error; }, refresh: async () => {},
    request: async (path, options) => requests.push({path, body: JSON.parse(options.body)})
  });
  for (const [start, end] of [
    ["function renderConfiguredPairingLaunch(", "async function refresh("],
    ["function closePairingModal(", "async function requestEnrollment("]
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  vm.runInContext("renderConfiguredPairingLaunch(currentState)", context);
  assert.equal(elements["pairing-modal-title"].textContent, "切换 Central 并重新配对");
  assert.equal(elements["pairing-current-central"].textContent, state.serverUrl);
  assert.equal(elements["pairing-target-central"].textContent, "https://team.example");
  assert.equal(elements["confirm-reenrollment"].textContent, "确认切换并配对");
  assert.equal(requests.length, 0);
  state.deviceId = "device_changed";
  vm.runInContext("renderConfiguredPairingLaunch(currentState)", context);
  assert.equal(elements["confirm-reenrollment"].disabled, true);
  await vm.runInContext("requestConfiguredDevicePairing()", context);
  assert.equal(requests.length, 0);
  state.deviceId = "device_original";
  state.serverUrl = "https://unexpected.example";
  await vm.runInContext("requestConfiguredDevicePairing()", context);
  assert.equal(requests.length, 0);
  state.serverUrl = "http://127.0.0.1:3000";
  await vm.runInContext("requestConfiguredDevicePairing()", context);
  assert.deepEqual(requests, [{path: "/api/device-pairing/restart", body: {
    pairingLink: link, confirmNewDevice: true, expectedDeviceId: "device_original",
    expectedServerUrl: state.serverUrl, confirmCentralSwitch: true
  }}]);
  assert.equal(context.pendingPairingLink, "");
  assert.equal(context.pairingReview, null);
  for (const paired of [true, false]) {
    state.paired = paired;
    context.pendingPairingLink = link;
    vm.runInContext("renderConfiguredPairingLaunch(currentState)", context);
    if (!paired) {
      await vm.runInContext("requestConfiguredDevicePairing()", context);
      assert.equal(requests.at(-1).path, "/api/device-pairing/start");
      assert.equal(requests.at(-1).body.confirmCentralSwitch, true);
      assert.equal(requests.at(-1).body.expectedDeviceId, undefined);
    } else {
      vm.runInContext("closePairingModal()", context);
      assert.equal(context.pendingPairingLink, "");
      assert.equal(context.pairingReview, null);
    }
  }
});

test("both Settings entry buttons open the same proof-clearing link dialog without pairing", () => {
  const source = readFileSync(new URL("./static/app.js", import.meta.url), "utf8");
  const handlers = new Map();
  let cleared = 0;
  let opened = 0;
  let focused = 0;
  const elements = Object.fromEntries(["use-pairing-link", "switch-central"].map((id) => [id, {
    addEventListener(event, handler) { assert.equal(event, "click"); handlers.set(id, handler); }
  }]));
  elements["pairing-link-modal-backdrop"] = {classList: {remove(value) { assert.equal(value, "hidden"); opened++; }}};
  elements["configured-pairing-link"] = {focus() { focused++; }};
  const context = vm.createContext({elements, closePairingLinkModal() { cleared++; }});
  const start = source.indexOf('for (const id of ["use-pairing-link", "switch-central"])');
  vm.runInContext(source.slice(start, source.indexOf('elements["configured-pairing-link"].addEventListener', start)), context);
  assert.equal(handlers.size, 2);
  assert.equal(opened, 0);
  for (const handler of handlers.values()) handler();
  assert.equal(cleared, 2);
  assert.equal(opened, 2);
  assert.equal(focused, 2);
});
