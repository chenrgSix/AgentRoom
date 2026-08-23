import { readFile } from "node:fs/promises";
import path from "node:path";

export type WebAuthConfiguration =
  | { mode: "local" }
  | {
      mode: "trusted-team";
      ownerRecoveryToken: string;
      publicOrigin: string;
    };

export interface WebAuthEnvironmentOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  loadFile?: (filename: string) => Promise<string>;
}

function trustedOrigin(source: string | undefined): string {
  const value = source?.trim();
  if (!value) {
    throw new Error("AGENT_ROOM_PUBLIC_ORIGIN is required in trusted-team mode");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("AGENT_ROOM_PUBLIC_ORIGIN must be an absolute HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("AGENT_ROOM_PUBLIC_ORIGIN must be an absolute HTTPS origin");
  }
  return parsed.origin;
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
  const mode = env.AGENT_ROOM_WEB_AUTH_MODE?.trim() || "local";
  if (mode === "local") return { mode };
  if (mode !== "trusted-team") {
    throw new Error("AGENT_ROOM_WEB_AUTH_MODE must be local or trusted-team");
  }

  const configuredPath = env.AGENT_ROOM_OWNER_RECOVERY_TOKEN_FILE?.trim();
  if (!configuredPath) {
    throw new Error(
      "AGENT_ROOM_OWNER_RECOVERY_TOKEN_FILE is required in trusted-team mode"
    );
  }
  const filename = path.resolve(options.cwd ?? process.cwd(), configuredPath);
  const source = await (options.loadFile ?? ((target) => readFile(target, "utf8")))(
    filename
  );
  return {
    mode,
    ownerRecoveryToken: validateRecoveryToken(source),
    publicOrigin: trustedOrigin(env.AGENT_ROOM_PUBLIC_ORIGIN)
  };
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
