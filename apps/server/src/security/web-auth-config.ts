import { readFile } from "node:fs/promises";
import path from "node:path";
import { renamedEnvironmentValue } from "../config/environment.js";

export type WebAuthConfiguration =
  | { mode: "local" }
  | {
      mode: "trusted-team";
      ownerRecoveryToken: string;
      publicOrigin: string;
      browserOrigin?: string;
    };

export interface WebAuthEnvironmentOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  loadFile?: (filename: string) => Promise<string>;
}

function exactOrigin(source: string | undefined, label: string): URL {
  const value = source?.trim();
  if (!value) {
    throw new Error(`${label} is required in trusted-team mode`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute origin`);
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${label} must be an absolute origin`);
  }
  return parsed;
}

export function trustedWebOrigins(configuration: Extract<
  WebAuthConfiguration,
  { mode: "trusted-team" }
>): { browserOrigin: string; publicOrigin: string; secureCookies: boolean } {
  const publicOrigin = exactOrigin(
    configuration.publicOrigin,
    "CONVENE_WIRE_PUBLIC_ORIGIN"
  );
  if (publicOrigin.protocol !== "https:") {
    throw new Error("CONVENE_WIRE_PUBLIC_ORIGIN must be an absolute HTTPS origin");
  }
  const browserOrigin = exactOrigin(
    configuration.browserOrigin ?? publicOrigin.origin,
    "CONVENE_WIRE_BROWSER_ORIGIN"
  );
  if (browserOrigin.protocol === "https:") {
    if (browserOrigin.origin !== publicOrigin.origin) {
      throw new Error("HTTPS browser origin must equal CONVENE_WIRE_PUBLIC_ORIGIN");
    }
  } else if (
    browserOrigin.protocol !== "http:" ||
    browserOrigin.hostname.toLowerCase() !== publicOrigin.hostname.toLowerCase() ||
    browserOrigin.hostname === "localhost" ||
    browserOrigin.hostname === "127.0.0.1" ||
    browserOrigin.hostname === "[::1]"
  ) {
    throw new Error("HTTP browser origin must use the same non-loopback host as CONVENE_WIRE_PUBLIC_ORIGIN");
  }
  return {
    browserOrigin: browserOrigin.origin,
    publicOrigin: publicOrigin.origin,
    secureCookies: browserOrigin.protocol === "https:"
  };
}

function validateRecoveryToken(source: string): string {
  const token = source.trim();
  const length = Buffer.byteLength(token, "utf8");
  if (length < 32 || length > 512 || /[\r\n]/u.test(token)) {
    throw new Error("Owner recovery token must contain 32 to 512 bytes");
  }
  return token;
}

export async function loadWebAuthConfiguration(
  options: WebAuthEnvironmentOptions = {}
): Promise<WebAuthConfiguration> {
  const env = options.env ?? process.env;
  const mode = renamedEnvironmentValue(
    env,
    "CONVENE_WIRE_WEB_AUTH_MODE",
    "AGENT_ROOM_WEB_AUTH_MODE"
  ) || "local";
  if (mode === "local") return { mode };
  if (mode !== "trusted-team") {
    throw new Error("CONVENE_WIRE_WEB_AUTH_MODE must be local or trusted-team");
  }

  const configuredPath = renamedEnvironmentValue(
    env,
    "CONVENE_WIRE_OWNER_RECOVERY_TOKEN_FILE",
    "AGENT_ROOM_OWNER_RECOVERY_TOKEN_FILE"
  );
  if (!configuredPath) {
    throw new Error(
      "CONVENE_WIRE_OWNER_RECOVERY_TOKEN_FILE is required in trusted-team mode"
    );
  }
  const filename = path.resolve(options.cwd ?? process.cwd(), configuredPath);
  const source = await (options.loadFile ?? ((target) => readFile(target, "utf8")))(
    filename
  );
  const publicOrigin = exactOrigin(
    renamedEnvironmentValue(
      env,
      "CONVENE_WIRE_PUBLIC_ORIGIN",
      "AGENT_ROOM_PUBLIC_ORIGIN"
    ),
    "CONVENE_WIRE_PUBLIC_ORIGIN"
  ).origin;
  const configured = {
    mode,
    ownerRecoveryToken: validateRecoveryToken(source),
    publicOrigin,
    ...(env.CONVENE_WIRE_BROWSER_ORIGIN?.trim()
      ? { browserOrigin: env.CONVENE_WIRE_BROWSER_ORIGIN.trim() }
      : {})
  } as const;
  const origins = trustedWebOrigins(configured);
  return { ...configured, publicOrigin: origins.publicOrigin,
    ...(configured.browserOrigin ? { browserOrigin: origins.browserOrigin } : {}) };
}

export function assertWebAuthListener(
  configuration: WebAuthConfiguration,
  host: string,
  trustProxyHops?: number
): void {
  if (
    configuration.mode === "local" &&
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    host !== "::1"
  ) {
    throw new Error(
      "local Web authentication may listen only on a loopback address"
    );
  }
  if (
    configuration.mode === "local" &&
    trustProxyHops !== undefined &&
    trustProxyHops > 0
  ) {
    throw new Error("local Web authentication cannot trust a reverse proxy");
  }
}
