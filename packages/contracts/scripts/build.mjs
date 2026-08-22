import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateContractPackage } from "../src/validation.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = path.join(packageRoot, "dist");
const result = await validateContractPackage(packageRoot);

await rm(outputRoot, { force: true, recursive: true });
await mkdir(outputRoot, { recursive: true });
await cp(
  path.join(packageRoot, "schemas"),
  path.join(outputRoot, "schemas"),
  { recursive: true }
);
await cp(
  path.join(packageRoot, "catalog.json"),
  path.join(outputRoot, "catalog.json")
);

console.log(
  `Built ${result.schemaCount} schema(s) from catalog ${result.catalogVersion}`
);
