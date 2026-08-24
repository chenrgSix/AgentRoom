import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownMessage } from "../src/MarkdownMessage.js";

test("Message Markdown renders GFM without trusting raw HTML", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://team.example/rooms/general"
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window
  });
  try {
    const html = renderToStaticMarkup(
      <MarkdownMessage content={[
        "## Result",
        "",
        "- [x] verified",
        "",
        "| Item | State |",
        "| --- | --- |",
        "| Build | pass |",
        "",
        "```ts",
        "const ready = true;",
        "```",
        "",
        "[local](/docs) [outside](https://outside.example/report)",
        "",
        "<script>window.compromised = true</script>"
      ].join("\n")} />
    );

    assert.match(html, /<h2>Result<\/h2>/u);
    assert.match(html, /<table>/u);
    assert.match(html, /<input[^>]*disabled=/u);
    assert.match(html, /class="language-ts"/u);
    assert.match(html, /href="\/docs"/u);
    assert.match(
      html,
      /href="https:\/\/outside\.example\/report" rel="noreferrer noopener" target="_blank"/u
    );
    assert.doesNotMatch(html, /script|compromised/u);
  } finally {
    dom.window.close();
  }
});

test("Streaming Markdown exposes busy state through the same renderer", () => {
  const html = renderToStaticMarkup(
    <MarkdownMessage content="**Partial** response" streaming />
  );
  assert.match(html, /aria-busy="true"/u);
  assert.match(html, /<strong>Partial<\/strong>/u);
});
