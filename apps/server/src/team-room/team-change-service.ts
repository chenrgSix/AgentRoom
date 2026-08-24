export interface TeamChangeCursor {
  changed: boolean;
  cursor: number;
  reset: boolean;
  team: boolean;
  roomIds: string[];
  runRoomIds: string[];
}

export type TeamChangeHint =
  | { kind: "team" }
  | { kind: "room"; roomId: string }
  | { kind: "run"; roomId: string };

interface Waiter {
  resolve: (result: TeamChangeCursor) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TeamState {
  cursor: number;
  waiters: Set<Waiter>;
  history: Array<{ cursor: number; hint: TeamChangeHint }>;
}

const changeHistoryLimit = 256;

export class TeamChangeService {
  private readonly teams = new Map<string, TeamState>();

  public notify(teamId: string, hint: TeamChangeHint = { kind: "team" }): number {
    const state = this.state(teamId);
    state.cursor += 1;
    state.history.push({ cursor: state.cursor, hint });
    if (state.history.length > changeHistoryLimit) state.history.shift();
    const result = this.result(state, state.cursor - 1);
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
      return Promise.resolve(this.result(state, after));
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
          finish({
            changed: false,
            cursor: state.cursor,
            reset: false,
            team: false,
            roomIds: [],
            runRoomIds: []
          });
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
      state = { cursor: 0, waiters: new Set(), history: [] };
      this.teams.set(teamId, state);
    }
    return state;
  }

  private result(state: TeamState, after: number): TeamChangeCursor {
    if (after > state.cursor) {
      return {
        changed: false,
        cursor: state.cursor,
        reset: true,
        team: true,
        roomIds: [],
        runRoomIds: []
      };
    }
    const changes = state.history.filter(({ cursor }) => cursor > after);
    if (after < state.cursor && (
      changes.length === 0 || changes[0]?.cursor !== after + 1
    )) {
      return {
        changed: true,
        cursor: state.cursor,
        reset: true,
        team: true,
        roomIds: [],
        runRoomIds: []
      };
    }
    return {
      changed: changes.length > 0,
      cursor: state.cursor,
      reset: false,
      team: changes.some(({ hint }) => hint.kind === "team"),
      roomIds: [...new Set(changes.flatMap(({ hint }) =>
        hint.kind === "room" ? [hint.roomId] : []
      ))],
      runRoomIds: [...new Set(changes.flatMap(({ hint }) =>
        hint.kind === "run" ? [hint.roomId] : []
      ))]
    };
  }
}
