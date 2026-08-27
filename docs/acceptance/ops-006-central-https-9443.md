# OPS-006 Central HTTPS 9443 Acceptance

Date: 2026-08-27

## Scope

The central Compose deployment now publishes Caddy HTTPS on configurable
external port 9443 by default. Server port 3000 remains private. Explicit HTTP
requests redirect to the exact configured public origin, including a custom
port. Caddy also presents the configured certificate to IP clients that omit
SNI.

## Automated Evidence

- `npm run test:compose` passed for default port 9443, custom port 10443, exact
  public-origin projection, and pinned Caddy 2.11.4 configuration validation.
- `GOCACHE=/tmp/agentroom-ops006-go-cache npm test` passed 129 Server tests, 42
  Web tests, four Contracts tests with Go checks, and 23 Bridge UI tests.
- `npm run build`, `npm run validate`, and `npm run lint:docs` passed.
- `docker compose build --pull agentroom` passed after `OPS-007` restored the
  required trademark policy to the Docker build context.

## Live LAN Evidence

The ignored local deployment configuration used:

```dotenv
AGENT_ROOM_DOMAIN=192.168.1.132
AGENT_ROOM_PUBLIC_ORIGIN=https://192.168.1.132:9443
AGENT_ROOM_HTTPS_PORT=9443
```

- `docker compose ps --all` showed `agentroom` healthy, `caddy` running with
  `0.0.0.0:9443->443/tcp`, and `secret-init` exited successfully.
- A CA-verified request to
  `https://192.168.1.132:9443/api/health/ready` returned `{"status":"ready"}`.
- `http://192.168.1.132/api/health/ready` returned `301` with exact location
  `https://192.168.1.132:9443/api/health/ready`.
- A TLS client without IP SNI received the Caddy local certificate after the
  configured default-SNI fallback was added.
- The exported local root certificate had SHA-256 fingerprint
  `24:2B:28:82:DB:7A:54:17:43:83:77:BB:19:11:06:BF:1F:54:94:50:4F:C1:C2:C6:C1:51:30:CC:36:EF:31:C3`.

The pre-existing loopback database remained untouched. A read-only inventory
recorded three Teams, eight Rooms, 91 Messages, and seven Devices; migration to
trusted-team identity remains a separate owner-selection decision. Physical
Windows root installation and Bridge connection remain part of `QA-002` rather
than being inferred from this Mac-side LAN acceptance.
