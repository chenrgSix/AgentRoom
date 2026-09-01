import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { TestResources } from "./resources.mjs";

export interface TestProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

export interface TestProcessOptions extends SpawnOptions {
  graceMs?: number;
  killWaitMs?: number;
}

export interface TestProcess {
  process: ChildProcess;
  terminal: Promise<TestProcessResult>;
  stop(): Promise<void>;
}

export function spawnTestProcess(
  resources: TestResources,
  command: string,
  arguments_?: string[],
  options?: TestProcessOptions
): TestProcess;
