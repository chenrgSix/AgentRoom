import type Database from "better-sqlite3";

interface DeferredWork {
  priority: number;
  work: () => void;
}

interface TransactionState {
  callbacks: Map<string | symbol, DeferredWork>;
  depth: number;
  managedRoot: boolean;
}

const transactionStates = new WeakMap<Database.Database, TransactionState>();

export class SqliteTransactionBoundary {
  public constructor(private readonly database: Database.Database) {}

  public immediate<T>(work: () => T): T {
    let state = transactionStates.get(this.database);
    const root = !state || state.depth === 0;
    if (!state) {
      state = { callbacks: new Map(), depth: 0, managedRoot: false };
      transactionStates.set(this.database, state);
    }
    if (root) {
      state.callbacks.clear();
      state.managedRoot = !this.database.inTransaction;
    }
    const callbacksBefore = new Map(state.callbacks);
    state.depth += 1;
    let result: T;
    try {
      result = this.database.transaction(work).immediate();
    } catch (error) {
      state.depth -= 1;
      state.callbacks = callbacksBefore;
      if (root) {
        state.callbacks.clear();
        state.managedRoot = false;
      }
      throw error;
    }
    state.depth -= 1;
    if (root) {
      const callbacks = [...state.callbacks.values()];
      state.callbacks.clear();
      state.managedRoot = false;
      for (const callback of callbacks) callback.work();
    }
    return result;
  }

  public afterCommit(
    work: () => void,
    options: { key?: string; priority?: number } = {}
  ): void {
    if (!this.database.inTransaction) {
      work();
      return;
    }
    const state = transactionStates.get(this.database);
    if (!state || state.depth === 0 || !state.managedRoot) {
      throw new Error(
        "afterCommit requires a transaction owned by SqliteTransactionBoundary"
      );
    }
    const key = options.key ?? Symbol("afterCommit");
    const priority = options.priority ?? 0;
    const existing = state.callbacks.get(key);
    if (!existing || priority > existing.priority) {
      state.callbacks.set(key, { priority, work });
    }
  }
}
