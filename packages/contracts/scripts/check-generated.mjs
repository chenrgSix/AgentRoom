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
  )
};

for (const language of ["typescript", "go"]) {
  if (actual[language] !== expected[language]) {
    throw new Error(
      `Generated ${language} contracts are stale; run npm run generate`
    );
  }
}

console.log("Generated TypeScript and Go contracts are current");
