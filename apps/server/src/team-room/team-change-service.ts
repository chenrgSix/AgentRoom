export interface TeamChangeCursor {
  changed: boolean;
  cursor: number;
  reset: boolean;
}

interface Waiter {
  resolve: (result: TeamChangeCursor) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TeamState {
  cursor: number;
  waiters: Set<Waiter>;
}

export class TeamChangeService {
  private readonly teams = new Map<string, TeamState>();

  public notify(teamId: string): number {
    const state = this.state(teamId);
    state.cursor += 1;
    const result = { changed: true, cursor: state.cursor, reset: false };
    for (const waiter of state.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    state.waiters.clear();
    return state.cursor;
  }

  public current(teamId: string): number {
    return this.state(teamId).cursor;
  }

  public wait(
    teamId: string,
    after: number,
    options: { signal?: AbortSignal; timeoutMilliseconds?: number } = {}
  ): Promise<TeamChangeCursor> {
    if (!Number.isSafeInteger(after) || after < 0) {
      return Promise.reject(new Error("Team change cursor must be a non-negative integer"));
    }
    const state = this.state(teamId);
    if (after !== state.cursor) {
      return Promise.resolve({
        changed: state.cursor > after,
        cursor: state.cursor,
        reset: after > state.cursor
      });
    }
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new Error("Team change wait aborted"));
    }
    return new Promise((resolve, reject) => {
      const finish = (result: TeamChangeCursor) => {
        options.signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const waiter: Waiter = {
        resolve: finish,
        timer: setTimeout(() => {
          state.waiters.delete(waiter);
          finish({ changed: false, cursor: state.cursor, reset: false });
        }, options.timeoutMilliseconds ?? 25_000)
      };
      const abort = () => {
        clearTimeout(waiter.timer);
        state.waiters.delete(waiter);
        reject(options.signal?.reason ?? new Error("Team change wait aborted"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      state.waiters.add(waiter);
    });
  }

  private state(teamId: string): TeamState {
    let state = this.teams.get(teamId);
    if (!state) {
      state = { cursor: 0, waiters: new Set() };
      this.teams.set(teamId, state);
    }
    return state;
  }
}
