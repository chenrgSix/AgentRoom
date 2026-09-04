import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
const visualSystem = await readFile(
  new URL("../src/visual-system.css", import.meta.url),
  "utf8"
);

test("Graphite visual authority loads after legacy layout styles", () => {
  const legacy = main.indexOf('import "./styles.css";');
  const shell = main.indexOf('import "./features/navigation/product-shell.css";');
  const graphite = main.indexOf('import "./visual-system.css";');
  assert.ok(legacy >= 0);
  assert.ok(shell > legacy);
  assert.ok(graphite > shell);
  assert.match(visualSystem, /presentation authority for shared color, type, surface and interaction/);
});

test("dark and light themes expose one closed semantic token vocabulary", () => {
  const required = [
    "canvas", "sidebar", "surface", "surface-raised", "surface-inset",
    "border", "text", "text-secondary", "text-muted", "accent", "focus",
    "success", "warning", "danger", "info"
  ];
  for (const token of required) {
    assert.match(visualSystem, new RegExp(`--cw-${token}:`));
  }
  assert.match(visualSystem, /:root\[data-theme="light"\] \{/);
  assert.match(visualSystem, /--cw-accent: #7c83ff;/);
  assert.match(visualSystem, /--cw-success: #42cf91;/);
  assert.doesNotMatch(visualSystem, /--cw-(?:accent|focus): #[a-f\d]{2}(?:d[0-9a-f]|e[0-9a-f])/i);
});

test("brand interaction and success state remain visually distinct", () => {
  assert.match(
    visualSystem,
    /\.product-destinations button\[aria-current\][^}]*background: var\(--cw-accent-soft\)/s
  );
  assert.match(
    visualSystem,
    /\.presence-dot,[^}]*\.run-dot\.completed[^}]*background: var\(--cw-success\)/s
  );
  assert.match(
    visualSystem,
    /\.hosted-feedback\.success[^}]*background: var\(--cw-success-soft\)/s
  );
  assert.match(
    visualSystem,
    /\.run-dot\.working,[^}]*\.run-dot\.delivered[^}]*background: var\(--cw-accent\)/s
  );
  assert.match(
    visualSystem,
    /\.agent-avatar,[^}]*\.device-icon,[^}]*\.participant-avatar\.human,[^}]*\.integration-badge,[^}]*\.current-user-badge[^}]*background: var\(--cw-accent-soft\)/s
  );
});

test("critical compact controls stay legible and responsive", () => {
  assert.match(
    visualSystem,
    /\.work-priority,[^}]*\.work-detail-badges span,[^}]*\.work-facts dt[^}]*font-size: 11px;/s
  );
  assert.match(visualSystem, /@media \(max-width: 760px\)/);
  assert.match(visualSystem, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(visualSystem, /outline-color: var\(--cw-focus\);/);
});
