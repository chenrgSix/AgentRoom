import type { ServerRouteContext } from "./route-context.js";

export function registerSystemRoutes({
  app,
  operationalMetrics
}: ServerRouteContext): void {
  app.get("/api/health/live", async () => ({
    status: "alive",
    uptimeSeconds: Math.floor(process.uptime())
  }));
  app.get("/api/health/ready", async (_request, reply) => {
    const ready = operationalMetrics.databaseReady();
    if (!ready) void reply.code(503);
    return { status: ready ? "ready" : "unavailable" };
  });
  app.get("/api/health", async () => {
    const databaseReady = operationalMetrics.databaseReady();
    const snapshot = databaseReady ? operationalMetrics.snapshot() : null;
    const bridgeConfigured = (snapshot?.managedAgents ?? 0) > 0;
    const bridgeReady = (snapshot?.activeBridgeConnections ?? 0) > 0;
    return {
      status: !databaseReady
        ? "unavailable"
        : bridgeConfigured && !bridgeReady ? "degraded" : "ready",
      checks: {
        database: databaseReady ? "ready" : "unavailable",
        bridge: !bridgeConfigured
          ? "not_configured"
          : bridgeReady ? "ready" : "degraded"
      }
    };
  });
  app.get("/api/metrics", async (_request, reply) => {
    void reply.type("text/plain; version=0.0.4; charset=utf-8");
    return operationalMetrics.renderPrometheus();
  });
}
