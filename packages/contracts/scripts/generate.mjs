import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { generateContractTypes } from "../src/codegen.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const generatedRoot = path.join(packageRoot, "generated");
const output = await generateContractTypes(packageRoot);

await Promise.all([
  mkdir(path.join(generatedRoot, "typescript"), { recursive: true }),
  mkdir(path.join(generatedRoot, "go", "pairing"), { recursive: true })
]);
await Promise.all([
  writeFile(
    path.join(generatedRoot, "typescript", "bridge-messages.ts"),
    output.typescript
  ),
  writeFile(
    path.join(generatedRoot, "go", "bridge_messages.go"),
    output.go
  ),
  writeFile(
    path.join(generatedRoot, "typescript", "pairing-session.ts"),
    output.pairingTypescript
  ),
  writeFile(
    path.join(generatedRoot, "go", "pairing", "session.go"),
    output.pairingGo
  )
]);

console.log("Generated deterministic TypeScript and Go contract types");
