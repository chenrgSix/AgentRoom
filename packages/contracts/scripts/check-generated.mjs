import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { generateContractTypes } from "../src/codegen.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const generatedRoot = path.join(packageRoot, "generated");
const expected = await generateContractTypes(packageRoot);
const actual = {
  executionTypescript: await readFile(
    path.join(generatedRoot, "typescript", "execution-plan.ts"), "utf8"
  ),
  executionGo: await readFile(
    path.join(generatedRoot, "go", "execution", "execution_plan.go"), "utf8"
  ),
  executionValidators: await readFile(
    path.join(generatedRoot, "runtime", "execution-plan-validator.cjs"), "utf8"
  ),
  bridgeRuntimeDeclaration: await readFile(
    path.join(generatedRoot, "runtime", "bridge-validator.d.ts"),
    "utf8"
  ),
  bridgeRuntimeModule: await readFile(
    path.join(generatedRoot, "runtime", "bridge-validator.mjs"),
    "utf8"
  ),
  bridgeSchema: await readFile(
    path.join(generatedRoot, "go", "runtime", "bridge-schema.json"),
    "utf8"
  ),
  bridgeStandaloneValidator: await readFile(
    path.join(generatedRoot, "runtime", "bridge-validator.cjs"),
    "utf8"
  ),
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
  ),
  workGo: await readFile(
    path.join(generatedRoot, "go", "work", "task_result.go"),
    "utf8"
  ),
  workTypescript: await readFile(
    path.join(generatedRoot, "typescript", "task-result.ts"),
    "utf8"
  ),
  goBridgeRuntimeValidator: await readFile(
    path.join(generatedRoot, "go", "runtime", "validator.go"),
    "utf8"
  )
};

for (const output of [
  "executionTypescript",
  "executionGo",
  "executionValidators",
  "bridgeRuntimeDeclaration",
  "bridgeRuntimeModule",
  "bridgeSchema",
  "bridgeStandaloneValidator",
  "typescript",
  "go",
  "goBridgeRuntimeValidator",
  "pairingTypescript",
  "pairingGo",
  "workTypescript",
  "workGo"
]) {
  if (actual[output] !== expected[output]) {
    throw new Error(
      `Generated ${output} contracts are stale; run npm run generate`
    );
  }
}

console.log("Generated TypeScript and Go contracts are current");
