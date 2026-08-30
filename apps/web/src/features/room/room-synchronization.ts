import { captureWebSessionScope, isStaleWebSessionError, jsonRequest, StaleWebSessionError } from "../../api-client.js";
import type { Agent, AgentTask, Device, DiscussionView, LocalSession, Member, MemoryCandidate, Message, RoomMessagePage, RoomSettings } from "../../models.js";
import { createSingleFlight, teamChangeRefreshScope, type RunEventRecord } from "../../room-sync.js";
import type { Run, TeamChangeCursor } from "../../models.js";

export interface RoomSnapshot {
  runs: Run[];
  discussions: DiscussionView[];
  tasks: AgentTask[];
  memoryCandidates: MemoryCandidate[];
  settings?: RoomSettings;
  registry?: { agents: Agent[]; members: Member[]; devices: Device[] };
  outputs?: Map<string, RunEventRecord[]>;
}

export interface RoomSynchronizationOptions {
  teamId: string;
  roomId: string;
  session: LocalSession;
  isCurrentContext: () => boolean;
  onMessages: (messages: Message[]) => void;
  onHistory: (state: { olderCursor: string | null; loading: boolean; error: string | null }) => void;
  onSnapshot: (snapshot: RoomSnapshot) => void;
  onEvents: (runs: Run[], events: Map<string, RunEventRecord[]>) => void;
  loadOutputs: (runs: Run[]) => Promise<Map<string, RunEventRecord[]>>;
  refreshWorkbench: () => Promise<void>;
  onError: (reason: unknown) => void;
}

/** One Room lifetime owns all checkpoints, reads and change listeners. */
export class RoomSynchronization {
  private readonly isCurrentSession = captureWebSessionScope();
  private readonly lifetime = new AbortController();
  private changeRequest: AbortController | null = null;
  private cursor: string | null = null;
  private sequence = 0;
  private olderCursor: string | null = null;
  private historyInitialized = false;
  private historyPending = false;
  private requestVersion = 0;
  private snapshotVersion = 0;
  private runsVersion = 0;
  private settingsVersion = 0;
  private registryVersion = 0;
  private snapshot: RoomSnapshot = { runs: [], discussions: [], tasks: [], memoryCandidates: [] };
  private timers = new Map<number, () => void>();
  private fallbackTimer: number | null = null;
  private started = false;
  private refreshRoom = createSingleFlight(() => this.reconcile("room"));
  private refreshFull = createSingleFlight(() => this.reconcile("full"));
  private refreshEvents = createSingleFlight(() => this.reconcile("events"));
  private refreshWork = createSingleFlight(async () => {
    this.requireCurrent();
    await this.options.refreshWorkbench();
  });

  public constructor(private readonly options: RoomSynchronizationOptions) {}

  public isCurrent = (): boolean => !this.lifetime.signal.aborted &&
    this.isCurrentSession() && this.options.isCurrentContext();

  private requireCurrent(): void {
    if (!this.isCurrent()) throw new StaleWebSessionError();
  }

  private async read<T>(path: string, signal = this.lifetime.signal): Promise<T> {
    this.requireCurrent();
    const result = await jsonRequest<T>(path, { signal }, this.options.session.token);
    this.requireCurrent();
    return result;
  }

  private roomPath(suffix: string): string { return `/api/rooms/${this.options.roomId}/${suffix}`; }

  private async candidates(): Promise<MemoryCandidate[]> {
    try { return await this.read(this.roomPath("memory-candidates")); }
    catch (reason) { this.requireCurrent(); return []; }
  }

  private async readRoom(): Promise<RoomSnapshot> {
    const [runs, discussions, tasks, memoryCandidates] = await Promise.all([
      this.read<Run[]>(this.roomPath("runs")),
      this.read<DiscussionView[]>(this.roomPath("discussions")),
      this.read<AgentTask[]>(this.roomPath("tasks")), this.candidates()
    ]);
    return { runs, discussions, tasks, memoryCandidates };
  }

  private async outputs(runs: Run[], version: number): Promise<Map<string, RunEventRecord[]> | undefined> {
    this.requireCurrent();
    if (version < this.runsVersion) return undefined;
    const result = await this.options.loadOutputs(runs);
    this.requireCurrent();
    return result;
  }

  private commitSnapshot(version: number, snapshot: RoomSnapshot): void {
    this.requireCurrent();
    let changed = false;
    const updates: Partial<RoomSnapshot> = {};
    if (version >= this.snapshotVersion) {
      this.snapshotVersion = version;
      this.snapshot = { ...this.snapshot, discussions: snapshot.discussions, tasks: snapshot.tasks,
        memoryCandidates: snapshot.memoryCandidates };
      changed = true;
    }
    if (version >= this.runsVersion) {
      this.runsVersion = version;
      this.snapshot = { ...this.snapshot, runs: snapshot.runs };
      if (snapshot.outputs) updates.outputs = snapshot.outputs;
      changed = true;
    }
    // An action refresh does not read settings or the registry. A late initial
    // read may still initialize them without replaying its older Task/Run lists.
    if (snapshot.settings && version >= this.settingsVersion) {
      this.settingsVersion = version;
      updates.settings = snapshot.settings;
      changed = true;
    }
    if (snapshot.registry && version >= this.registryVersion) {
      this.registryVersion = version;
      updates.registry = snapshot.registry;
      changed = true;
    }
    if (changed) this.options.onSnapshot({ ...this.snapshot, ...updates });
  }

  private commitEvents(version: number, runs: Run[], outputs: Map<string, RunEventRecord[]>): void {
    this.requireCurrent();
    if (version < this.runsVersion) return;
    this.runsVersion = version;
    this.snapshot = { ...this.snapshot, runs };
    this.options.onEvents(runs, outputs);
  }

  private commitMessages(items: Message[], cursor: string | null, sequence: number, tail?: RoomMessagePage): void {
    this.requireCurrent();
    this.options.onMessages(items);
    if (tail && !this.historyInitialized) {
      this.historyInitialized = true;
      this.olderCursor = tail.olderCursor ?? null;
      this.publishHistory(false, null);
    }
    if (sequence >= this.sequence) {
      this.sequence = sequence;
      this.cursor = cursor ?? this.cursor;
    }
  }

  private publishHistory(loading: boolean, error: string | null): void {
    if (this.isCurrent()) this.options.onHistory({ olderCursor: this.olderCursor, loading, error });
  }

  public async start(): Promise<void> {
    if (this.started || !this.isCurrent()) return;
    this.started = true;
    const version = ++this.requestVersion;
    try {
      const [page, snapshot, settings] = await Promise.all([
        this.read<RoomMessagePage>(this.roomPath("messages?limit=100&tail=true")),
        this.readRoom(), this.read<RoomSettings>(this.roomPath("settings"))
      ]);
      const outputs = await this.outputs(snapshot.runs, version);
      this.commitMessages(page.items, page.syncCursor ?? null, page.items.at(-1)?.sequence ?? 0, page);
      this.commitSnapshot(version, { ...snapshot, settings, ...(outputs ? { outputs } : {}) });
    } catch (reason) { this.reportError(reason); }
    if (!this.isCurrent()) return;
    // Initial failure still enables reconciliation, but not a second authority.
    document.addEventListener("visibilitychange", this.visibilityChanged);
    this.fallbackTimer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void this.refreshFull();
    }, 30_000);
    void this.listen();
  }

  /** A user action can finish while the initial snapshot waits for Run output. */
  public async refreshAfterAction(): Promise<void> {
    this.requireCurrent();
    const version = ++this.requestVersion;
    const [page, snapshot] = await Promise.all([
      this.read<RoomMessagePage>(this.roomPath("messages?limit=100&tail=true")), this.readRoom()
    ]);
    this.commitMessages(page.items, page.syncCursor ?? null, page.items.at(-1)?.sequence ?? 0, page);
    this.commitSnapshot(version, snapshot);
  }

  public async loadOlder(): Promise<void> {
    if (!this.isCurrent() || !this.olderCursor || this.historyPending) return;
    this.historyPending = true;
    this.publishHistory(true, null);
    let error: string | null = null;
    try {
      const page = await this.read<RoomMessagePage>(this.roomPath(`messages?limit=100&beforeCursor=${encodeURIComponent(this.olderCursor)}`));
      this.options.onMessages(page.items);
      this.olderCursor = page.olderCursor ?? null;
    } catch (reason) {
      if (!isStaleWebSessionError(reason)) error = String(reason);
    } finally {
      this.historyPending = false;
      this.publishHistory(false, error);
    }
  }

  private async reconcile(scope: "events" | "room" | "full"): Promise<void> {
    const version = ++this.requestVersion;
    try {
      if (scope === "events") {
        const runs = await this.read<Run[]>(this.roomPath("runs"));
        const outputs = await this.outputs(runs, version);
        if (outputs) this.commitEvents(version, runs, outputs);
        return;
      }
      let cursor = this.cursor;
      let sequence = this.sequence;
      let tail: RoomMessagePage | undefined;
      const messages: Message[] = [];
      for (let index = 0; index < 10; index += 1) {
        const page = await this.read<RoomMessagePage>(this.roomPath(cursor
          ? `messages?limit=100&cursor=${encodeURIComponent(cursor)}` : "messages?limit=100&tail=true"));
        if (index === 0 && !cursor) tail = page;
        messages.push(...page.items);
        sequence = Math.max(sequence, page.items.at(-1)?.sequence ?? 0);
        cursor = page.nextCursor ?? page.syncCursor ?? cursor;
        if (!page.nextCursor) break;
      }
      const [snapshot, registry] = await Promise.all([
        this.readRoom(), scope === "full" ? this.readRegistry() : Promise.resolve(null)
      ]);
      const outputs = await this.outputs(snapshot.runs, version);
      this.commitMessages(messages, cursor, sequence, tail);
      this.commitSnapshot(version, { ...snapshot, ...registry, ...(outputs ? { outputs } : {}) });
    } catch (reason) { this.reportError(reason); }
  }

  private async readRegistry() {
    const root = `/api/teams/${this.options.teamId}`;
    const [agents, members, devices, settings] = await Promise.all([
      this.read<Agent[]>(`${root}/agents`), this.read<Member[]>(`${root}/members`),
      this.read<Device[]>(`${root}/devices`), this.read<RoomSettings>(this.roomPath("settings"))
    ]);
    return { registry: { agents, members, devices }, settings };
  }

  private reportError(reason: unknown): void {
    if (this.isCurrent() && !isStaleWebSessionError(reason)) this.options.onError(reason);
  }

  private delay(milliseconds: number): Promise<void> {
    if (!this.isCurrent()) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => { this.timers.delete(timer); resolve(); }, milliseconds);
      this.timers.set(timer, resolve);
    });
  }

  private async listen(): Promise<void> {
    let cursor = 0;
    while (this.isCurrent()) {
      if (document.visibilityState === "hidden") { await this.delay(1_000); continue; }
      this.changeRequest = new AbortController();
      try {
        const change = await this.read<TeamChangeCursor>(`/api/teams/${this.options.teamId}/changes?after=${cursor}`, this.changeRequest.signal);
        cursor = change.cursor;
        if (change.changed || change.reset) {
          await this.refreshWork();
          this.requireCurrent();
          const scope = teamChangeRefreshScope(change, this.options.roomId);
          if (scope === "full") await this.refreshFull();
          else if (scope === "room") await this.refreshRoom();
          else if (scope === "events") await this.refreshEvents();
        } else await this.delay(250);
      } catch {
        if (!this.isCurrent() || this.changeRequest.signal.aborted) return;
        await this.refreshFull();
        await this.delay(2_000);
      }
    }
  }

  private visibilityChanged = (): void => {
    if (!this.isCurrent()) return;
    // Keep the listener alive while hidden; its request remains bounded by
    // the Server wait, then the next iteration pauses until visible again.
    if (document.visibilityState !== "hidden") void this.refreshFull();
  };

  public stop(): void {
    this.lifetime.abort();
    this.changeRequest?.abort();
    for (const [timer, resolve] of this.timers) { window.clearTimeout(timer); resolve(); }
    this.timers.clear();
    if (this.fallbackTimer !== null) window.clearInterval(this.fallbackTimer);
    document.removeEventListener("visibilitychange", this.visibilityChanged);
  }
}
