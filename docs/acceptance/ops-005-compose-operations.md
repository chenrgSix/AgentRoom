# OPS-005 Central Compose Operations Acceptance

## Result

- Date: 2026-08-23
- Result: **PASS for the documented single-host trusted-team boundary**
- Scope: operator configuration, static Compose validation, bounded logs, and
  lifecycle runbooks

## Configuration Evidence

`docker compose --env-file deploy/.env.example config --format json` rendered
the three expected services and five private named volumes. The rendered Server
has no published port, uses `/data/agent-room.sqlite`, and both long-running
containers use the `json-file` driver with a 10 MB by 5-file default rotation.
Caddy alone publishes TCP 80/443.

The CI workflow now renders the central Compose profile and syntax-checks both
backup and restore scripts on every main push and pull request. Local validation
also passed `bash -n`, maintained Markdown lint, and `git diff --check`.

## Operator Coverage

The deployment and recovery runbooks now explicitly cover:

- host runtime, DNS, firewall, ACME, and port prerequisites;
- release-tag checkout, environment fields, and persistent database location;
- secret initialization, Owner setup, health, logs, and fault ownership;
- off-host backup and independently retained digest expectations;
- application-and-database version alignment during upgrade or rollback;
- safe `stop`/`down` behavior and the destructive effect of `down -v`.

## Boundaries

This acceptance does not claim Linux public-ACME runtime evidence, automatic
backup scheduling or retention, high availability, public metrics, immutable
container digests, or Owner-driven member/session revocation. Existing runtime
container, proxy, backup, and 67 MB restore evidence remains recorded in
`ops-004-data-005-compose.md`; physical two-machine behavior remains `QA-002`.
