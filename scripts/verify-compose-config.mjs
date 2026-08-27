import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const baseEnvironment = {
  ...process.env,
  AGENT_ROOM_DOMAIN: "team.example.com",
  AGENT_ROOM_HTTP_PORT: "80",
  AGENT_ROOM_OWNER_RECOVERY_TOKEN_FILE: "./deploy/secrets/owner_recovery_token",
  AGENT_ROOM_PUBLIC_ORIGIN: "https://team.example.com:9443"
};
delete baseEnvironment.AGENT_ROOM_HTTPS_PORT;

function renderCompose(environment) {
  return JSON.parse(execFileSync(
    "docker",
    ["compose", "config", "--format", "json"],
    { cwd: repositoryRoot, encoding: "utf8", env: environment }
  ));
}

function publishedPort(configuration, target) {
  const port = configuration.services.caddy.ports.find(
    (candidate) => candidate.target === target && candidate.protocol === "tcp"
  );
  assert.ok(port, `Caddy must publish TCP target ${target}`);
  return String(port.published);
}

const defaultConfiguration = renderCompose(baseEnvironment);
assert.equal(publishedPort(defaultConfiguration, 80), "80");
assert.equal(publishedPort(defaultConfiguration, 443), "9443");
assert.equal(
  defaultConfiguration.services.caddy.environment.AGENT_ROOM_PUBLIC_ORIGIN,
  "https://team.example.com:9443"
);
assert.equal(defaultConfiguration.services.agentroom.user, undefined);
assert.deepEqual(defaultConfiguration.services.agentroom.cap_drop, ["ALL"]);
assert.equal(defaultConfiguration.services["data-init"].network_mode, "none");
assert.equal(defaultConfiguration.services["data-init"].restart, "no");
assert.deepEqual(defaultConfiguration.services["data-init"].cap_drop, ["ALL"]);
assert.deepEqual(
  [...defaultConfiguration.services["data-init"].cap_add].sort(),
  ["CHOWN", "DAC_OVERRIDE", "FOWNER"]
);
assert.equal(
  defaultConfiguration.services.agentroom.depends_on["data-init"].condition,
  "service_completed_successfully"
);

const localEnvironment = {
  ...baseEnvironment,
  AGENT_ROOM_BIND_ADDRESS: "127.0.0.1"
};
const localConfiguration = renderCompose(localEnvironment);
assert.equal(
  localConfiguration.services.caddy.ports.find(({ target }) => target === 443).host_ip,
  "127.0.0.1"
);

const customEnvironment = {
  ...baseEnvironment,
  AGENT_ROOM_HTTPS_PORT: "10443",
  AGENT_ROOM_PUBLIC_ORIGIN: "https://team.example.com:10443"
};
const customConfiguration = renderCompose(customEnvironment);
assert.equal(publishedPort(customConfiguration, 443), "10443");
assert.equal(
  customConfiguration.services.caddy.environment.AGENT_ROOM_PUBLIC_ORIGIN,
  "https://team.example.com:10443"
);

const caddyfile = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
assert.match(caddyfile, /auto_https disable_redirects/u);
assert.match(caddyfile, /default_sni \{\$AGENT_ROOM_DOMAIN\}/u);
assert.match(
  caddyfile,
  /redir \{\$AGENT_ROOM_PUBLIC_ORIGIN\}\{uri\} permanent/u
);

execFileSync(
  "docker",
  [
    "compose",
    "run",
    "--rm",
    "--no-deps",
    "caddy",
    "caddy",
    "validate",
    "--config",
    "/etc/caddy/Caddyfile",
    "--adapter",
    "caddyfile"
  ],
  { cwd: repositoryRoot, env: baseEnvironment, stdio: "inherit" }
);

console.log("Central Compose defaults and Caddy configuration are valid.");
