import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  validateContractFixtures,
  validateContractPackage
} from "../src/validation.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = path.join(packageRoot, "dist");
const result = await validateContractPackage(packageRoot);
const fixtures = await validateContractFixtures(packageRoot);

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
await cp(
  path.join(packageRoot, "fixtures"),
  path.join(outputRoot, "fixtures"),
  { recursive: true }
);
await cp(
  path.join(packageRoot, "generated"),
  path.join(outputRoot, "generated"),
  { recursive: true }
);

console.log(
  `Built ${result.schemaCount} schema(s) and ` +
  `${fixtures.fixtureCount} fixture(s) from catalog ${result.catalogVersion}`
);
