import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import vm from "node:vm";
import { basePath, buildSite, publicOrigin, siteRoot } from "../build.mjs";
import { createPreviewServer } from "../preview.mjs";

const pages = ["index.html", "guide/index.html", "404.html"];
const repositoryRoot = path.dirname(siteRoot.replace(/\/$/u, ""));
let temporaryRoot;
let output;
let revision;
let html;

async function filesBelow(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    assert.ok(!entry.isSymbolicLink(), `No published symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await filesBelow(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

const attributes = (tag) => Object.fromEntries(
  [...tag.matchAll(/([\w:-]+)="([^"]*)"/gu)].map((match) => [match[1], match[2]]),
);
const tags = (body, name) => [...body.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gu"))].map((match) => match[0]);
const ids = (body) => [...body.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
const textOnly = (body) => body.replace(/<[^>]*>/gu, "").trim();

before(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "convenewire-site-test-"));
  output = path.join(temporaryRoot, "first");
  ({ revision } = await buildSite(output));
  html = Object.fromEntries(await Promise.all(pages.map(async (page) => [page, await readFile(path.join(output, page), "utf8")])));
});

after(async () => {
  // Only this test's mkdtemp-owned directory is removed, including on failure.
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test("build publishes only static pages and intentional public assets", async () => {
  assert.deepEqual(await filesBelow(output), [
    ".nojekyll", "404.html", "assets/guide.js", "assets/mark.svg", "assets/site.css",
    "guide/index.html", "index.html", "robots.txt", "sitemap.xml", "version.json",
  ]);
  for (const page of pages) {
    assert.doesNotMatch(html[page], /__(?:BASE|ORIGIN|REVISION)__|<!-- (?:HEADER|FOOTER) -->/u);
    assert.doesNotMatch(html[page], /qa-only-owner|sk-[a-zA-Z0-9]{12,}|BEGIN (?:RSA |EC )?PRIVATE KEY|\/Users\//u);
  }
});

test("build is byte-reproducible and records the exact source commit", async () => {
  const second = path.join(temporaryRoot, "second");
  const result = await buildSite(second);
  assert.equal(result.revision, revision);
  assert.match(revision, /^[a-f0-9]{40}$/u);
  for (const file of await filesBelow(output)) {
    assert.deepEqual(await readFile(path.join(output, file)), await readFile(path.join(second, file)), file);
  }
  const version = JSON.parse(await readFile(path.join(output, "version.json"), "utf8"));
  assert.deepEqual(version, { product: "ConveneWire", sourceRevision: revision, siteBase: basePath });
  for (const page of pages) assert.ok(html[page].includes(`name="source-revision" content="${revision}"`));
});

test("each page has accessible structure, unique targets and keyboard entry", () => {
  for (const [page, body] of Object.entries(html)) {
    assert.match(body, /^<!doctype html>/u, page);
    assert.match(body, /<html lang="zh-CN">/u, page);
    assert.equal(tags(body, "main").length, 1, page);
    assert.equal(tags(body, "h1").length, 1, page);
    assert.match(body, /class="skip-link" href="#main"/u, page);
    assert.equal(new Set(ids(body)).size, ids(body).length, `Duplicate ID in ${page}`);
    for (const tag of tags(body, "img")) assert.ok(Object.hasOwn(attributes(tag), "alt"), tag);
    for (const match of body.matchAll(/aria-labelledby="([^"]+)"/gu)) {
      for (const target of match[1].split(/\s+/u)) assert.ok(ids(body).includes(target), `${page}: ${target}`);
    }
    for (const match of body.matchAll(/<(a|button|summary)\b[^>]*>([\s\S]*?)<\/\1>/gu)) {
      assert.ok(textOnly(match[2]).length > 0, `Empty control in ${page}`);
    }
  }
});

test("all internal navigation, assets and fragment links resolve under the project base", async () => {
  for (const [page, body] of Object.entries(html)) {
    const currentUrl = new URL(basePath + (page === "index.html" ? "" : page), publicOrigin);
    for (const match of body.matchAll(/\b(?:href|src)="([^"]+)"/gu)) {
      const url = new URL(match[1], currentUrl);
      assert.equal(url.protocol, "https:", match[1]);
      if (url.origin !== publicOrigin) continue;
      assert.ok(url.pathname.startsWith(basePath), `${page}: ${url.pathname}`);
      let relative = decodeURIComponent(url.pathname.slice(basePath.length));
      if (!relative || relative.endsWith("/")) relative += "index.html";
      const target = path.join(output, relative);
      assert.ok((await stat(target)).isFile(), `${page}: ${target}`);
      if (url.hash) {
        assert.ok(ids(await readFile(target, "utf8")).includes(decodeURIComponent(url.hash.slice(1))), `${page}: ${url}`);
      }
    }
  }
});

test("canonical source, installation, acceptance and license links point to existing repository files", async () => {
  for (const body of Object.values(html)) {
    for (const match of body.matchAll(/href="(https:[^"]+)"/gu)) {
      const url = new URL(match[1]);
      if (url.origin === publicOrigin) continue;
      assert.equal(url.origin, "https://github.com");
      assert.ok(url.pathname.startsWith("/chenrgSix/ConveneWire"));
      const blobPrefix = "/chenrgSix/ConveneWire/blob/main/";
      if (url.pathname.startsWith(blobPrefix)) {
        const target = path.join(repositoryRoot, decodeURIComponent(url.pathname.slice(blobPrefix.length)));
        assert.ok((await stat(target)).isFile(), url.href);
      }
    }
  }
});

test("home and guide have distinct truthful share metadata without an invented fallback image", async () => {
  const titles = new Set();
  for (const page of ["index.html", "guide/index.html"]) {
    const body = html[page];
    const title = body.match(/<title>([^<]+)<\/title>/u)[1];
    titles.add(title);
    const meta = tags(body, "meta").map(attributes);
    assert.equal(meta.find((item) => item.property === "og:title")?.content, title);
    assert.equal(meta.find((item) => item.name === "twitter:title")?.content, title);
    for (const key of ["description", "twitter:description", "viewport"]) {
      assert.ok(meta.find((item) => item.name === key)?.content, `${page}: ${key}`);
    }
    assert.ok(meta.find((item) => item.property === "og:description")?.content);
    const canonical = tags(body, "link").map(attributes).find((item) => item.rel === "canonical").href;
    assert.equal(meta.find((item) => item.property === "og:url")?.content, canonical);
    assert.equal(canonical, `${publicOrigin}${basePath}${page === "index.html" ? "" : "guide/"}`);
    assert.ok(!meta.some((item) => item.property === "og:image" || item.name === "twitter:image"));
  }
  assert.equal(titles.size, 2);
  assert.match(html["404.html"], /name="robots" content="noindex"/u);
  const sitemap = await readFile(path.join(output, "sitemap.xml"), "utf8");
  assert.ok(sitemap.includes(`${publicOrigin}${basePath}guide/`));
  assert.ok(!sitemap.includes("404.html"));
});

test("product copy preserves release, authority, provider and license boundaries", () => {
  const home = textOnly(html["index.html"]);
  const guide = textOnly(html["guide/index.html"]);
  assert.match(home, /v0\.5\.0-rc\.6 预发布版/u);
  assert.match(home, /稳定 Latest 仍为 v0\.4\.2/u);
  assert.match(home, /精简的 12 资产分发/u);
  assert.match(guide, /v0\.5\.0-rc\.6 是预发布版/u);
  assert.match(guide, /稳定 Latest v0\.4\.2/u);
  assert.match(guide, /convenewire-central_\*_source\.tar\.gz/u);
  assert.match(guide, /源码包在目标主机通过 Docker Compose 构建/u);
  assert.match(guide, /评估 RC 前请备份中央数据库/u);
  for (const page of [html["index.html"], html["guide/index.html"]]) {
    assert.ok(page.includes("https://github.com/chenrgSix/ConveneWire/releases/tag/v0.5.0-rc.6"));
    assert.ok(page.includes("https://github.com/chenrgSix/ConveneWire/releases/tag/v0.4.2"));
    assert.doesNotMatch(page, /releases\/tag\/v0\.5\.0-rc\.5/u);
    assert.doesNotMatch(page, /releases\/tag\/v0\.5\.0-rc\.4/u);
    assert.doesNotMatch(page, /releases\/tag\/v0\.5\.0-rc\.3/u);
    assert.doesNotMatch(page, /releases\/tag\/v0\.4\.1/u);
  }
  assert.match(home, /Windows、macOS 或 Linux 都无需安装 CA/u);
  assert.match(home, /Bridge、Device 与执行流量仍走单独固定的 HTTPS 通道/u);
  assert.match(guide, /Windows、macOS 和 Linux 都可作为客户端/u);
  assert.match(guide, /可信局域网的浏览器 HTTP 入口无需安装 CA/u);
  assert.match(guide, /Bridge“设置”的高级浏览器信任区域/u);
  assert.match(guide, /不会自动修改系统信任/u);
  assert.match(home, /不接管你的 Git 仓库或 Git 凭据/u);
  assert.match(guide, /不接管你的 Git 仓库或 Git 凭据/u);
  assert.match(guide, /仅支持固定的 OpenAI Responses API/u);
  assert.match(guide, /不能操作电脑、访问文件、执行命令或工具/u);
  assert.match(guide, /不能提交正式 Result、审核结果或自行完成任务/u);
  assert.match(guide, /配置保存在现有数据库，API Key 加密存储/u);
  assert.match(guide, /Owner 返回网页批准/u);
  assert.match(guide, /SHA256SUMS\.sha256/u);
  assert.match(guide, /仅支持只属于当前 Team 的普通成员/u);
  assert.match(home, /非 OSI/u);
  assert.match(home, /演示仅模拟回复/u);
  assert.match(guide, /不是公网生产部署/u);
});

test("site has no application forms, credentials, analytics or model connections", async () => {
  for (const body of Object.values(html)) {
    assert.doesNotMatch(body, /<(?:form|iframe|object|embed|base)\b|\bon[a-z]+\s*=/iu);
    for (const script of tags(body, "script")) {
      assert.equal(attributes(script).src, `${basePath}assets/guide.js`);
      assert.match(script, /\bdefer\b/u);
    }
  }
  const js = await readFile(path.join(output, "assets/guide.js"), "utf8");
  assert.doesNotMatch(js, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|eval)\b|\.cookie\b|innerHTML/u);
  const css = await readFile(path.join(output, "assets/site.css"), "utf8");
  assert.doesNotMatch(css, /@import|https?:\/\//u);
  assert.ok(Buffer.byteLength(css) < 32_000, "Static CSS stays bounded");
  assert.ok(Buffer.byteLength(js) < 3_000, "Only a small progressive clipboard enhancement is shipped");
});

test("responsive and keyboard styles include narrow layouts and reduced motion", async () => {
  const css = await readFile(path.join(output, "assets/site.css"), "utf8");
  for (const rule of ["max-width:760px", "max-width:420px", "prefers-reduced-motion:reduce", ":focus-visible", ".skip-link:focus", "overflow-x:auto"]) {
    assert.ok(css.includes(rule), rule);
  }
  assert.match(html["guide/index.html"], /<pre[^>]+tabindex="0"/u);
  assert.match(html["guide/index.html"], /role="status"[^>]+aria-live="polite"/u);
  assert.ok(tags(html["index.html"], "details").length >= 5);
});

async function copyHarness(clipboard, missingTarget = false) {
  let handler;
  const status = { textContent: "" };
  const button = { hidden: true, disabled: false, dataset: { copy: "sample" }, textContent: "复制命令", addEventListener(type, callback) { assert.equal(type, "click"); handler = callback; } };
  const code = { textContent: "\n npm run dev:web\n" };
  const context = { navigator: { clipboard }, document: {
    querySelectorAll(selector) { assert.equal(selector, "button[data-copy]"); return [button]; },
    getElementById(id) { return id === "copy-status" ? status : missingTarget ? null : code; },
  } };
  vm.runInNewContext(await readFile(path.join(output, "assets/guide.js"), "utf8"), context);
  return { button, status, click: () => handler?.() };
}

test("copy controls remain hidden and guide commands remain readable without Clipboard support", async () => {
  const harness = await copyHarness(undefined);
  assert.equal(harness.button.hidden, true);
  await harness.click();
  for (const button of tags(html["guide/index.html"], "button")) {
    assert.match(button, /\bhidden\b/u);
    assert.ok(ids(html["guide/index.html"]).includes(attributes(button)["data-copy"]));
  }
  assert.match(html["guide/index.html"], /npm run dev:web/u);
});

test("copy succeeds only after explicit activation, reports status and clears pending state", async () => {
  const copied = [];
  let finish;
  const harness = await copyHarness({ writeText(value) { copied.push(value); return new Promise((resolve) => { finish = resolve; }); } });
  assert.equal(harness.button.hidden, false);
  assert.deepEqual(copied, []);
  const pending = harness.click();
  assert.equal(harness.button.disabled, true);
  assert.deepEqual(copied, ["npm run dev:web"]);
  finish();
  await pending;
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.button.textContent, "已复制");
  assert.match(harness.status.textContent, /命令已复制/u);
});

test("clipboard rejection offers manual copying without leaking technical details", async () => {
  const harness = await copyHarness({ writeText() { throw new Error("private clipboard diagnostic"); } });
  await harness.click();
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.button.textContent, "请手动复制");
  assert.match(harness.status.textContent, /手动复制/u);
  assert.doesNotMatch(harness.status.textContent, /private clipboard/u);
});

test("missing copy targets leave the page usable without performing a write", async () => {
  const harness = await copyHarness({ writeText() { assert.fail("Unexpected clipboard write"); } }, true);
  await harness.click();
  assert.equal(harness.button.disabled, false);
});

test("preview serves the base, guide and exact artifact bytes with read-only error handling", async (context) => {
  const server = createPreviewServer(output);
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const redirect = await fetch(origin, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), basePath);
  for (const file of await filesBelow(output)) {
    const response = await fetch(origin + basePath + file);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(path.join(output, file))), file);
  }
  for (const route of [basePath, `${basePath}guide/`]) assert.equal((await fetch(origin + route)).status, 200);
  assert.equal(await (await fetch(origin + basePath, { method: "HEAD" })).text(), "");
  for (const route of ["/package.json", `${basePath}.env`, `${basePath}missing/`, `${basePath}%2e%2e%2fpackage.json`, `${basePath}%broken`]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 404, route);
    assert.match(await response.text(), /返回首页/u);
  }
  assert.equal((await fetch(origin + basePath, { method: "POST", body: "not application data" })).status, 404);
  assert.equal(await (await fetch(origin + basePath + "missing", { method: "HEAD" })).text(), "");
});

test("Pages workflow tests before deploying only the exact static artifact with bounded permissions", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/pages.yml"), "utf8");
  assert.match(workflow, /node --test site\/test\/\*\.test\.mjs/u);
  assert.match(workflow, /path: site\/dist/u);
  assert.match(workflow, /needs: build/u);
  assert.match(workflow, /pages: write\s+id-token: write/u);
  assert.match(workflow, /github\.event_name != 'pull_request'/u);
  assert.doesNotMatch(workflow, /contents: write|secrets\.|npm publish|gh release|pull_request_target/u);
  for (const match of workflow.matchAll(/uses: ([^\s]+)/gu)) assert.match(match[1], /^actions\/[\w-]+@[a-f0-9]{40}$/u);
});
