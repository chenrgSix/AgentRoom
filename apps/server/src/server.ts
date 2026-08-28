import { createServerApp } from "./app.js";
import { resolveDatabasePath } from "./data/database-location.js";
import { installGracefulShutdown } from "./graceful-shutdown.js";
import {
  assertWebAuthListener,
  loadWebAuthConfiguration
} from "./security/web-auth-config.js";
import { normalizeBridgeServerToken } from "./security/bridge-server-token.js";
import {
  ExtractiveMemoryReducerRunner
} from "./memory/memory-reducer-runner.js";

const port = Number.parseInt(process.env.AGENT_ROOM_PORT ?? "3000", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("AGENT_ROOM_PORT must be a valid TCP port");
}
const host = process.env.AGENT_ROOM_HOST ?? "127.0.0.1";
if (host.trim().length === 0 || host.length > 253 || /[\s/]/u.test(host)) {
  throw new Error("AGENT_ROOM_HOST must be a valid host or IP address");
}
const webAuth = await loadWebAuthConfiguration();
const bridgeServerToken = normalizeBridgeServerToken(
  process.env.AGENT_ROOM_BRIDGE_SERVER_TOKEN
);
const trustProxySource = process.env.AGENT_ROOM_TRUST_PROXY_HOPS?.trim();
const trustProxyHops = trustProxySource === undefined || trustProxySource === ""
  ? undefined
  : Number.parseInt(trustProxySource, 10);
if (
  trustProxyHops !== undefined &&
  (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 4)
) {
  throw new Error("AGENT_ROOM_TRUST_PROXY_HOPS must be an integer from 0 to 4");
}
assertWebAuthListener(webAuth, host, trustProxyHops);
const memoryReducerKind = process.env.AGENT_ROOM_MEMORY_REDUCER?.trim();
if (
  memoryReducerKind !== undefined && memoryReducerKind !== "" &&
  memoryReducerKind !== "extractive-v1"
) {
  throw new Error(
    "AGENT_ROOM_MEMORY_REDUCER must be empty or extractive-v1"
  );
}
const memoryReducer = memoryReducerKind === "extractive-v1"
  ? new ExtractiveMemoryReducerRunner()
  : undefined;
const deploymentTrustFile =
  process.env.AGENT_ROOM_DEPLOYMENT_TRUST_FILE?.trim() || undefined;

const app = await createServerApp({
  databasePath: resolveDatabasePath(),
  logger: true,
  webAuth,
  ...(deploymentTrustFile ? { deploymentTrustFile } : {}),
  ...(memoryReducer ? { memoryReducer } : {}),
  ...(bridgeServerToken === undefined ? {} : { bridgeServerToken }),
  ...(trustProxyHops === undefined ? {} : { trustProxyHops }),
  ...(process.env.AGENT_ROOM_WEB_ROOT
    ? { webRoot: process.env.AGENT_ROOM_WEB_ROOT }
    : {})
});

await app.listen({ host, port });
installGracefulShutdown(process, () => app.close(), (error) => {
  app.log.error(error, "Graceful shutdown failed");
  process.exitCode = 1;
});
