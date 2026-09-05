import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestResources } from "../test/resources.mjs";
import { spawnTestProcess } from "../test/child-process.mjs";

async function invoke(t, source, missing = false, exhausted = false) {
  const resources = await createTestResources(t, "convenewire-bench-adapter-");
  const fake = path.join(resources.directory, "fake-codex");
  if (exhausted) {
    for (let index = 0; index < 12; index += 1) {
      await writeFile(path.join(resources.directory, `invocation-${index}`), "");
    }
  }
  if (!missing) {
    await writeFile(fake, `#!${process.execPath}\n${source}\n`);
    await chmod(fake, 0o700);
  }
  const child = spawnTestProcess(resources, process.execPath,
    [path.resolve("scripts/bench/codex-answer.mjs"), fake, "synthetic-model", resources.directory],
    { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.process.stdout.on("data", (chunk) => { stdout += chunk; });
  child.process.stderr.on("data", (chunk) => { stderr += chunk; });
  child.process.stdin.end("fixed prompt");
  const result = await child.terminal;
  return { ...result, stdout, stderr };
}

test("benchmark adapter emits only final text, suppressing diagnostics and usage internals", async (t) => {
  const result = await invoke(t, `
console.error("PRIVATE_DIAGNOSTIC");
console.log(JSON.stringify({type:"item.completed",item:{type:"reasoning",text:"PRIVATE_REASONING"}}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Answer"}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:100}}));`);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "Answer\n");
  assert.equal(result.stderr, "");
});

test("tool use, provider failure, malformed output and spawn failure invalidate a response", async (t) => {
  for (const source of [
    'console.log(JSON.stringify({type:"item.completed",item:{type:"command_execution"}}));',
    'console.log(JSON.stringify({type:"turn.failed",error:{message:"PRIVATE_PROVIDER_ERROR"}}));',
    'console.log("malformed");'
  ]) {
    const result = await invoke(t, source);
    assert.equal(result.code, 1);
    assert.ok(!result.stderr.includes("PRIVATE_PROVIDER_ERROR"));
  }
  const missing = await invoke(t, "", true);
  assert.equal(missing.code, 1);
});


test("the shared invocation cap prevents another provider process from starting", async (t) => {
  const result = await invoke(t, 'console.log("MUST_NOT_RUN");', false, true);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /invocation limit reached/u);
});
