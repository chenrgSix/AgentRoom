import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { generateContractTypes } from "../src/codegen.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const generatedRoot = path.join(packageRoot, "generated");
const output = await generateContractTypes(packageRoot);

await Promise.all([
  mkdir(path.join(generatedRoot, "typescript"), { recursive: true }),
  mkdir(path.join(generatedRoot, "runtime"), { recursive: true }),
  mkdir(path.join(generatedRoot, "go", "pairing"), { recursive: true }),
  mkdir(path.join(generatedRoot, "go", "runtime"), { recursive: true }),
  mkdir(path.join(generatedRoot, "go", "execution"), { recursive: true }),
  mkdir(path.join(generatedRoot, "go", "work"), { recursive: true })
]);
await Promise.all([
  writeFile(path.join(generatedRoot, "go", "runtime", "execution-schema.json"), output.goExecutionSchema),
  writeFile(path.join(generatedRoot, "go", "runtime", "execution.go"), output.goExecutionRuntime),
  writeFile(
    path.join(generatedRoot, "typescript", "execution-plan.ts"),
    output.executionTypescript
  ),
  writeFile(
    path.join(generatedRoot, "go", "execution", "execution_plan.go"),
    output.executionGo
  ),
  writeFile(
    path.join(generatedRoot, "runtime", "execution-plan-validator.cjs"),
    output.executionValidators
  ),
  writeFile(
    path.join(generatedRoot, "runtime", "bridge-validator.cjs"),
    output.bridgeStandaloneValidator
  ),
  writeFile(
    path.join(generatedRoot, "runtime", "bridge-validator.mjs"),
    output.bridgeRuntimeModule
  ),
  writeFile(
    path.join(generatedRoot, "runtime", "bridge-validator.d.ts"),
    output.bridgeRuntimeDeclaration
  ),
  writeFile(
    path.join(generatedRoot, "go", "runtime", "bridge-schema.json"),
    output.bridgeSchema
  ),
  writeFile(
    path.join(generatedRoot, "go", "runtime", "validator.go"),
    output.goBridgeRuntimeValidator
  ),
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
  ),
  writeFile(
    path.join(generatedRoot, "typescript", "task-result.ts"),
    output.workTypescript
  ),
  writeFile(
    path.join(generatedRoot, "go", "work", "task_result.go"),
    output.workGo
  )
]);

console.log("Generated deterministic TypeScript and Go contract types");
