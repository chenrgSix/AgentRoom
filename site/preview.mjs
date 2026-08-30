import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { basePath, siteRoot } from "./build.mjs";

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain" };

export function createPreviewServer(output = path.join(siteRoot, "dist")) {
  const root = path.resolve(output);
  return createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    try {
      const url = new URL(request.url, "http://localhost");
      if (!["GET", "HEAD"].includes(request.method)) throw new Error("Read-only preview");
      if (url.pathname === "/") {
        response.writeHead(302, { location: basePath }); response.end(); return;
      }
      if (!url.pathname.startsWith(basePath)) throw new Error("Outside site base");
      const relative = decodeURIComponent(url.pathname.slice(basePath.length));
      const file = path.resolve(root, relative || "index.html");
      if (file !== root && !file.startsWith(root + path.sep)) throw new Error("Outside public root");
      const target = (await stat(file)).isDirectory() ? path.join(file, "index.html") : file;
      const bytes = await readFile(target);
      response.writeHead(200, { "content-type": types[path.extname(target)] ?? "application/octet-stream" });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      const bytes = await readFile(path.join(root, "404.html")).catch(() => "Not found");
      response.end(request.method === "HEAD" ? undefined : bytes);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createPreviewServer();
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(`ConveneWire website preview: http://127.0.0.1:${server.address().port}${basePath}\n`);
  });
  process.once("SIGTERM", () => server.close());
  process.once("SIGINT", () => server.close());
}
