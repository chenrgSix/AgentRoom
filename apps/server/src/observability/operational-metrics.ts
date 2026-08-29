import type Database from "better-sqlite3";

import type { BridgeConnectionRegistry } from "../bridge/bridge-connection-registry.js";
import {
  defaultBuildIdentity,
  type BuildIdentity
} from "./build-identity.js";

interface CountRow {
  label: string;
  count: number;
}

interface ValueRow {
  value: number | null;
}

export interface OperationalSnapshot {
  activeBridgeConnections: number;
  agentPresence: Record<string, number>;
  managedAgents: number;
  deliveryRetries: number;
  oldestPendingDeliveryAgeSeconds: number;
  pendingDeliveries: number;
  queueDepth: number;
  runEventLagSeconds: number;
  runOutcomes: Record<string, number>;
}

function secondsBetween(now: string, then: string | null): number {
  if (!then) return 0;
  return Math.max(0, (Date.parse(now) - Date.parse(then)) / 1_000);
}

function recordCounts(rows: CountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map(({ label, count }) => [label, count]));
}

export class OperationalMetrics {
  private readonly httpRequests = new Map<string, number>();

  public constructor(
    private readonly database: Database.Database,
    private readonly bridges: BridgeConnectionRegistry,
    private readonly clock: () => string,
    private readonly buildIdentity: BuildIdentity = defaultBuildIdentity()
  ) {}

  public databaseReady(): boolean {
    try {
      const row = this.database.prepare("SELECT 1 AS value").get() as ValueRow;
      return row.value === 1;
    } catch {
      return false;
    }
  }

  public recordHttpRequest(method: string, statusCode: number): void {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const key = `${method.toUpperCase()}|${statusClass}`;
    this.httpRequests.set(key, (this.httpRequests.get(key) ?? 0) + 1);
  }

  public snapshot(): OperationalSnapshot {
    const now = this.clock();
    const runOutcomes = recordCounts(this.database.prepare(`
      SELECT state AS label, count(*) AS count
      FROM runs GROUP BY state ORDER BY state
    `).all() as CountRow[]);
    const agentPresence = recordCounts(this.database.prepare(`
      SELECT presence AS label, count(*) AS count
      FROM agents GROUP BY presence ORDER BY presence
    `).all() as CountRow[]);
    const delivery = this.database.prepare(`
      SELECT
        count(*) FILTER (
          WHERE d.state = 'pending' AND r.state = 'queued'
        ) AS pending,
        coalesce(sum(max(d.send_count - 1, 0)), 0) AS retries,
        min(d.created_at) FILTER (
          WHERE d.state = 'pending' AND r.state = 'queued'
        ) AS oldest
      FROM run_deliveries d
      JOIN runs r ON r.run_id = d.run_id
    `).get() as { pending: number; retries: number; oldest: string | null };
    const latestActiveEvent = this.database.prepare(`
      SELECT max(e.created_at) AS latest
      FROM run_events e
      JOIN runs r ON r.run_id = e.run_id
      WHERE r.state IN ('delivered', 'working', 'input_required')
    `).get() as { latest: string | null };
    const managedAgents = this.database.prepare(`
      SELECT count(*) AS value
      FROM agents
      WHERE integration_mode = 'managed' AND enabled = 1
    `).get() as ValueRow;

    return {
      activeBridgeConnections: this.bridges.activeCount(),
      agentPresence,
      managedAgents: managedAgents.value ?? 0,
      deliveryRetries: delivery.retries,
      oldestPendingDeliveryAgeSeconds: secondsBetween(now, delivery.oldest),
      pendingDeliveries: delivery.pending,
      queueDepth: runOutcomes.queued ?? 0,
      runEventLagSeconds: secondsBetween(now, latestActiveEvent.latest),
      runOutcomes
    };
  }

  public renderPrometheus(): string {
    const snapshot = this.snapshot();
    const lines = [
      "# HELP convenewire_build_info Exact release and source identity of this Central process.",
      "# TYPE convenewire_build_info gauge",
      `convenewire_build_info{release_version="${this.buildIdentity.releaseVersion}",source_commit="${this.buildIdentity.sourceCommit}"} 1`,
      "# HELP convenewire_up Whether the central service database is ready.",
      "# TYPE convenewire_up gauge",
      `convenewire_up ${this.databaseReady() ? 1 : 0}`,
      "# HELP convenewire_bridge_connections Active authenticated Bridge connections.",
      "# TYPE convenewire_bridge_connections gauge",
      `convenewire_bridge_connections ${snapshot.activeBridgeConnections}`,
      "# HELP convenewire_managed_agents Enabled managed Agents.",
      "# TYPE convenewire_managed_agents gauge",
      `convenewire_managed_agents ${snapshot.managedAgents}`,
      "# HELP convenewire_run_queue_depth Runs waiting for a Runtime delivery.",
      "# TYPE convenewire_run_queue_depth gauge",
      `convenewire_run_queue_depth ${snapshot.queueDepth}`,
      "# HELP convenewire_delivery_pending Pending durable deliveries for queued Runs.",
      "# TYPE convenewire_delivery_pending gauge",
      `convenewire_delivery_pending ${snapshot.pendingDeliveries}`,
      "# HELP convenewire_delivery_oldest_age_seconds Age of the oldest pending delivery.",
      "# TYPE convenewire_delivery_oldest_age_seconds gauge",
      `convenewire_delivery_oldest_age_seconds ${snapshot.oldestPendingDeliveryAgeSeconds}`,
      "# HELP convenewire_delivery_retries_total Durable delivery sends after the first attempt.",
      "# TYPE convenewire_delivery_retries_total counter",
      `convenewire_delivery_retries_total ${snapshot.deliveryRetries}`,
      "# HELP convenewire_run_event_lag_seconds Age of the latest event on active Runs.",
      "# TYPE convenewire_run_event_lag_seconds gauge",
      `convenewire_run_event_lag_seconds ${snapshot.runEventLagSeconds}`
    ];
    for (const [state, count] of Object.entries(snapshot.runOutcomes)) {
      lines.push(`convenewire_runs{state="${state}"} ${count}`);
    }
    for (const [presence, count] of Object.entries(snapshot.agentPresence)) {
      lines.push(`convenewire_agents{presence="${presence}"} ${count}`);
    }
    for (const [key, count] of [...this.httpRequests.entries()].sort()) {
      const [method, statusClass] = key.split("|");
      lines.push(
        `convenewire_http_requests_total{method="${method}",status_class="${statusClass}"} ${count}`
      );
    }
    const legacyLines = lines.map((line) => line.replaceAll(
      "convenewire_",
      "agentroom_"
    ));
    return `${[...lines, ...legacyLines].join("\n")}\n`;
  }
}
