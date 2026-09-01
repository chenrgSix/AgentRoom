import type { TestContext } from "node:test";

export interface TestResources {
  directory: string;
  defer(cleanup: () => void | Promise<void>): void;
}

export function createTestResources(
  testContext: TestContext,
  prefix: string
): Promise<TestResources>;
