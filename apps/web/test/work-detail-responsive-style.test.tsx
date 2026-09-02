import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("Task tabs retain a visible touch target when the detail grid scrolls", () => {
  assert.match(styles, /\.work-tabs \{[^}]*min-height: 38px;[^}]*align-items: center;/);
  assert.match(styles, /\.work-tabs button \{[^}]*min-height: 28px;/);
});

test("Task detail navigation has explicit light-theme contrast", () => {
  assert.match(styles, /:root\[data-theme="light"\] \.work-detail-header h3 \{ color: #303b2a; \}/);
  assert.match(styles, /:root\[data-theme="light"\] \.work-tabs \{[^}]*background: #eef3e8;/);
  assert.match(styles, /:root\[data-theme="light"\] \.work-tabs button\[aria-selected="true"\] \{[^}]*color: #3f541c;/);
});
