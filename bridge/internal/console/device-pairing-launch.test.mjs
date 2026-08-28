import assert from "node:assert/strict";
import test from "node:test";
import {pairingLinkFromHash} from "./static/device-pairing-launch.mjs";

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
