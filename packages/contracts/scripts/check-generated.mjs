import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { generateContractTypes } from "../src/codegen.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const generatedRoot = path.join(packageRoot, "generated");
const expected = await generateContractTypes(packageRoot);
const actual = {
  go: await readFile(
    path.join(generatedRoot, "go", "bridge_messages.go"),
    "utf8"
  ),
  typescript: await readFile(
    path.join(generatedRoot, "typescript", "bridge-messages.ts"),
    "utf8"
  ),
  pairingGo: await readFile(
    path.join(generatedRoot, "go", "pairing", "session.go"),
    "utf8"
  ),
  pairingTypescript: await readFile(
    path.join(generatedRoot, "typescript", "pairing-session.ts"),
    "utf8"
  )
};

for (const output of ["typescript", "go", "pairingTypescript", "pairingGo"]) {
  if (actual[output] !== expected[output]) {
    throw new Error(
      `Generated ${output} contracts are stale; run npm run generate`
    );
  }
}

console.log("Generated TypeScript and Go contracts are current");
