import { createServerApp } from "./app.js";
import { renamedEnvironmentValue } from "./config/environment.js";
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
import { resolveBuildIdentity } from "./observability/build-identity.js";

const environmentValue = (
  suffix: string
): string | undefined => renamedEnvironmentValue(
  process.env,
  `CONVENE_WIRE_${suffix}`,
  `AGENT_ROOM_${suffix}`
);

const port = Number.parseInt(environmentValue("PORT") ?? "3000", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CONVENE_WIRE_PORT must be a valid TCP port");
}
const host = environmentValue("HOST") ?? "127.0.0.1";
if (host.trim().length === 0 || host.length > 253 || /[\s/]/u.test(host)) {
  throw new Error("CONVENE_WIRE_HOST must be a valid host or IP address");
}
const webAuth = await loadWebAuthConfiguration();
const bridgeServerToken = normalizeBridgeServerToken(
  environmentValue("BRIDGE_SERVER_TOKEN")
);
const trustProxySource = environmentValue("TRUST_PROXY_HOPS");
const trustProxyHops = trustProxySource === undefined || trustProxySource === ""
  ? undefined
  : Number.parseInt(trustProxySource, 10);
if (
  trustProxyHops !== undefined &&
  (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 4)
) {
  throw new Error("CONVENE_WIRE_TRUST_PROXY_HOPS must be an integer from 0 to 4");
}
assertWebAuthListener(webAuth, host, trustProxyHops);
const memoryReducerKind = environmentValue("MEMORY_REDUCER");
if (
  memoryReducerKind !== undefined && memoryReducerKind !== "" &&
  memoryReducerKind !== "extractive-v1"
) {
  throw new Error(
    "CONVENE_WIRE_MEMORY_REDUCER must be empty or extractive-v1"
  );
}
const memoryReducer = memoryReducerKind === "extractive-v1"
  ? new ExtractiveMemoryReducerRunner()
  : undefined;
const deploymentTrustFile =
  environmentValue("DEPLOYMENT_TRUST_FILE");
const deploymentTrustRotationFile =
  environmentValue("DEPLOYMENT_TRUST_ROTATION_FILE");
const webRoot = environmentValue("WEB_ROOT");
const buildIdentity = resolveBuildIdentity(
  environmentValue("RELEASE_VERSION"),
  environmentValue("SOURCE_COMMIT")
);

const app = await createServerApp({
  buildIdentity,
  databasePath: resolveDatabasePath(),
  logger: true,
  webAuth,
  ...(deploymentTrustFile ? { deploymentTrustFile } : {}),
  ...(deploymentTrustRotationFile ? { deploymentTrustRotationFile } : {}),
  ...(memoryReducer ? { memoryReducer } : {}),
  ...(bridgeServerToken === undefined ? {} : { bridgeServerToken }),
  ...(trustProxyHops === undefined ? {} : { trustProxyHops }),
  ...(webRoot ? { webRoot } : {})
});

await app.listen({ host, port });
installGracefulShutdown(process, () => app.close(), (error) => {
  app.log.error(error, "Graceful shutdown failed");
  process.exitCode = 1;
});
