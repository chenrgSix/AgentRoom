import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const baseEnvironment = {
  ...process.env,
  AGENT_ROOM_DOMAIN: "",
  AGENT_ROOM_PUBLIC_ORIGIN: "",
  CONVENE_WIRE_DOMAIN: "team.example.com",
  CONVENE_WIRE_HTTP_PORT: "80",
  CONVENE_WIRE_OWNER_RECOVERY_TOKEN_FILE: "./deploy/secrets/owner_recovery_token",
  CONVENE_WIRE_PUBLIC_ORIGIN: "https://team.example.com:9443",
  CONVENE_WIRE_CADDY_TLS_PROFILE_FILE: "./deploy/tls/public-ca.caddy",
  CONVENE_WIRE_CADDY_PKI_PROFILE_FILE: "./deploy/tls/pki-none.caddy"
};
delete baseEnvironment.CONVENE_WIRE_HTTPS_PORT;

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
  defaultConfiguration.services.caddy.environment.CONVENE_WIRE_PUBLIC_ORIGIN,
  "https://team.example.com:9443"
);
assert.match(
  defaultConfiguration.services.caddy.volumes.find(
    ({ target }) => target === "/etc/caddy/tls-profile.caddy"
  ).source,
  /deploy\/tls\/public-ca\.caddy$/u
);
assert.equal(defaultConfiguration.services.agentroom.user, undefined);
assert.deepEqual(defaultConfiguration.services.agentroom.cap_drop, ["ALL"]);
assert.equal(
  defaultConfiguration.services.agentroom.environment.CONVENE_WIRE_WEB_AUTH_MODE,
  "trusted-team"
);
assert.equal(
  defaultConfiguration.services.agentroom.environment.CONVENE_WIRE_HOST,
  "0.0.0.0"
);
assert.equal(defaultConfiguration.services["data-init"].network_mode, "none");
assert.equal(defaultConfiguration.services["data-init"].restart, "no");
assert.deepEqual(defaultConfiguration.services["data-init"].cap_drop, ["ALL"]);
assert.deepEqual(
  [...defaultConfiguration.services["data-init"].cap_add].sort(),
  ["CHOWN", "DAC_OVERRIDE", "FOWNER"]
);
const secretInitProgram = defaultConfiguration.services["secret-init"].command.at(-1);
assert.match(secretInitProgram, /CONVENE_WIRE_/u);
assert.match(secretInitProgram, /conflicts with legacy AGENT_ROOM_/u);
assert.equal(
  defaultConfiguration.services.agentroom.depends_on["data-init"].condition,
  "service_completed_successfully"
);

const localEnvironment = {
  ...baseEnvironment,
  CONVENE_WIRE_BIND_ADDRESS: "127.0.0.1"
};
const localConfiguration = renderCompose(localEnvironment);
assert.equal(
  localConfiguration.services.caddy.ports.find(({ target }) => target === 443).host_ip,
  "127.0.0.1"
);

const customEnvironment = {
  ...baseEnvironment,
  CONVENE_WIRE_HTTPS_PORT: "10443",
  CONVENE_WIRE_PUBLIC_ORIGIN: "https://team.example.com:10443"
};
const customConfiguration = renderCompose(customEnvironment);
assert.equal(publishedPort(customConfiguration, 443), "10443");
assert.equal(
  customConfiguration.services.caddy.environment.CONVENE_WIRE_PUBLIC_ORIGIN,
  "https://team.example.com:10443"
);

const caddyfile = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
assert.match(caddyfile, /auto_https disable_redirects/u);
assert.match(caddyfile, /default_sni \{\$CONVENE_WIRE_DOMAIN\}/u);
assert.match(caddyfile, /reverse_proxy agentroom:3000/u);
assert.match(
  caddyfile,
  /redir \{\$CONVENE_WIRE_PUBLIC_ORIGIN\}\{uri\} permanent/u
);
assert.match(caddyfile, /import \/etc\/caddy\/tls-profile\.caddy/u);
assert.match(caddyfile, /import \/etc\/caddy\/pki-profile\.caddy/u);
assert.match(
  caddyfile,
  /Content-Security-Policy "[^"]*img-src 'self' data:;[^"]*object-src 'none'[^"]*"/u
);
assert.doesNotMatch(caddyfile, /img-src[^;]*(?:https?:|\*)/u);

const publicProfile = readFileSync(
  new URL("../deploy/tls/public-ca.caddy", import.meta.url),
  "utf8"
);
assert.match(publicProfile, /issuer acme/u);
assert.doesNotMatch(publicProfile, /tls internal/u);

const privateProfile = readFileSync(
  new URL("../deploy/tls/private-scoped-ca.caddy", import.meta.url),
  "utf8"
);
assert.match(privateProfile, /issuer internal/u);
assert.match(privateProfile, /ca \{\$CONVENE_WIRE_PRIVATE_CA_ID:local\}/u);
assert.match(privateProfile, /\.well-known\/convenewire\/bridge-ca\.pem/u);
assert.match(privateProfile, /bridge-ca\.pem/u);
assert.match(privateProfile, /\/run\/agentroom\/trust/u);

const legacyEnvironment = {
  ...process.env,
  AGENT_ROOM_DOMAIN: "legacy.example.com",
  AGENT_ROOM_HTTP_PORT: "8080",
  AGENT_ROOM_HTTPS_PORT: "10443",
  AGENT_ROOM_OWNER_RECOVERY_TOKEN_FILE: "./deploy/secrets/owner_recovery_token",
  AGENT_ROOM_PUBLIC_ORIGIN: "https://legacy.example.com:10443",
  AGENT_ROOM_CADDY_TLS_PROFILE_FILE: "./deploy/tls/public-ca.caddy",
  AGENT_ROOM_CADDY_PKI_PROFILE_FILE: "./deploy/tls/pki-none.caddy"
};
for (const name of Object.keys(baseEnvironment)) {
  if (name.startsWith("CONVENE_WIRE_")) legacyEnvironment[name] = "";
}
const legacyConfiguration = renderCompose(legacyEnvironment);
assert.equal(publishedPort(legacyConfiguration, 80), "8080");
assert.equal(publishedPort(legacyConfiguration, 443), "10443");
assert.equal(
  legacyConfiguration.services.caddy.environment.CONVENE_WIRE_PUBLIC_ORIGIN,
  "https://legacy.example.com:10443"
);
assert.equal(
  legacyConfiguration.services.agentroom.environment.CONVENE_WIRE_PUBLIC_ORIGIN,
  "https://legacy.example.com:10443"
);

const legacyProfile = readFileSync(
  new URL("../deploy/tls/legacy-auto.caddy", import.meta.url),
  "utf8"
);
assert.doesNotMatch(legacyProfile, /issuer acme|tls internal/u);

for (const profile of ["public-ca", "private-scoped-ca", "internal-ca", "legacy-auto"]) {
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
    {
      cwd: repositoryRoot,
      env: {
        ...baseEnvironment,
        CONVENE_WIRE_CADDY_TLS_PROFILE_FILE: `./deploy/tls/${profile}.caddy`
      },
      stdio: "inherit"
    }
  );
}

const overlapDirectory = mkdtempSync(path.join(tmpdir(), "convenewire-caddy-overlap-"));
try {
  const overlapProfile = path.join(overlapDirectory, "private-overlap.caddy");
  const overlapPKIProfile = path.join(overlapDirectory, "private-overlap-pki.caddy");
  writeFileSync(overlapProfile, `tls {
  issuer internal {
    ca convenewire-1-0123456789abcdef
  }
  issuer internal {
    ca convenewire-2-0123456789abcdef
  }
}

handle /.well-known/convenewire/bridge-ca.pem {
  rewrite * /bridge-ca.pem
  root * /run/agentroom/trust
  header Content-Type application/x-pem-file
  header Cache-Control "public, max-age=300"
  file_server
}
`);
  writeFileSync(overlapPKIProfile, `pki {
  ca convenewire-1-0123456789abcdef
  ca convenewire-2-0123456789abcdef
}
`);
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
    {
      cwd: repositoryRoot,
      env: {
        ...baseEnvironment,
        CONVENE_WIRE_CADDY_TLS_PROFILE_FILE: overlapProfile,
        CONVENE_WIRE_CADDY_PKI_PROFILE_FILE: overlapPKIProfile
      },
      stdio: "inherit"
    }
  );
} finally {
  rmSync(overlapDirectory, { recursive: true, force: true });
}

console.log("Central Compose defaults and Caddy configuration are valid.");
