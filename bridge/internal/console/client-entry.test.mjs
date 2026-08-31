import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createClientEntryController } from "./static/client-entry.mjs";

function fixture(t, request) {
  const dom = new JSDOM('<button id="open-client-team"></button><button id="load-client-rooms"></button><select id="client-room"></select><button id="open-client-room"></button><p id="client-entry-status"></p><p id="client-entry-help"></p>');
  t.after(() => dom.window.close());
  const elements = Object.fromEntries([...dom.window.document.querySelectorAll("[id]")].map((node) => [node.id, node]));
  const controller = createClientEntryController({elements, request});
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
