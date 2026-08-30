import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const siteRoot = fileURLToPath(new URL("./", import.meta.url));
export const publicOrigin = "https://chenrgsix.github.io";
export const basePath = "/ConveneWire/";

// All source and destination files are allowlisted beneath this isolated site.
// No application data, credentials, .env files or build directories are copied.
export async function buildSite(output = path.join(siteRoot, "dist")) {
  const header = await readFile(path.join(siteRoot, "src/_header.html"), "utf8");
  const footer = await readFile(path.join(siteRoot, "src/_footer.html"), "utf8");
  const pages = ["index.html", "guide/index.html", "404.html"];
  let revision = process.env.GITHUB_SHA;
  if (!revision) revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: siteRoot, encoding: "utf8" }).trim();
  assert.match(revision, /^[a-f0-9]{40}$/u, "The site must identify its exact source revision");
  await mkdir(output, { recursive: true });
  for (const page of pages) {
    const source = await readFile(path.join(siteRoot, "src", page), "utf8");
    const body = source.replaceAll("<!-- HEADER -->", header).replaceAll("<!-- FOOTER -->", footer)
      .replaceAll("__BASE__", basePath).replaceAll("__ORIGIN__", publicOrigin).replaceAll("__REVISION__", revision);
    assert.doesNotMatch(body, /__(?:BASE|ORIGIN|REVISION)__|<!-- (?:HEADER|FOOTER) -->/u);
    const target = path.join(output, page);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  await mkdir(path.join(output, "assets"), { recursive: true });
  for (const entry of await readdir(path.join(siteRoot, "public"), { withFileTypes: true })) {
    assert.ok(entry.isFile() && /\.(?:css|js|svg|png|webp)$/u.test(entry.name), "Only public static assets are allowed");
    await cp(path.join(siteRoot, "public", entry.name), path.join(output, "assets", entry.name));
  }
  await writeFile(path.join(output, ".nojekyll"), "");
  await writeFile(path.join(output, "version.json"), JSON.stringify({ product: "ConveneWire", sourceRevision: revision, siteBase: basePath }, null, 2) + "\n");
  await writeFile(path.join(output, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${publicOrigin}${basePath}sitemap.xml\n`);
  await writeFile(path.join(output, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${publicOrigin}${basePath}</loc></url><url><loc>${publicOrigin}${basePath}guide/</loc></url></urlset>\n`);
  return { output, revision };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSite();
  process.stdout.write(`Built static ConveneWire site at ${result.output}\nSource ${result.revision}\n`);
}
