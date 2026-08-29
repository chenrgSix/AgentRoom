import assert from "node:assert/strict";
import test from "node:test";
import {
  pairingLinkFromHash,
  pairingOriginFromLink
} from "./static/device-pairing-launch.mjs";

const link = "convenewire://pair-device?origin=https%3A%2F%2Fteam.example&pairingSessionId=pairing_12345678&expiresAt=2026-08-28T12%3A00%3A00Z#claimSecret=secret";
const legacyLink = link.replace("convenewire://", "agentroom://");

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
