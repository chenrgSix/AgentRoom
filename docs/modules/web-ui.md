# Web UI

## Scope

- Prefix: `WEB`
- Planned location: `apps/web/`
- Owns: browser presentation state and user interaction

The browser client is the primary Team conversation surface. It renders
authoritative server state and sends user intents; it does not contain routing,
authorization, or Run state-machine logic.

Simplified Chinese is the default presentation language. English remains
available through an in-product switch, and the selected locale is persisted
only in browser-local preferences. Protocol identifiers, commands, user data,
and server-owned payloads are never translated.

## Primary Surfaces

- Authenticated Team and Room shell.
- Ordered message timeline and thread view.
- Structured Agent mention and handoff composer.
- Agent roster with presence and capability summaries.
- Run cards with live status, replies, cancellation, and failure details.
- Dedicated Agent management workspace with roster and availability summaries.
- Managed Bridge approval, MCP setup, Device revocation, and local policy guidance.
- Narrow-screen navigation for Chat, Agent management, and locale selection.

There is no native desktop GUI in the MVP. Runtime access is provided by the
optional headless Bridge, keeping existing agent clients unchanged.

## Data Flow

HTTP reads establish a snapshot and WebSocket events advance it. Every stream
event has a cursor; gaps or reconnects trigger server reconciliation. Optimistic
messages remain visibly pending until acknowledged and are replaced by their
server-assigned identity.

The UI uses schemas and generated types from `packages/contracts/`. Capability
flags control whether start, resume, interrupt, handoff, or managed execution
controls are shown.

The current MVP separates Team conversation from the Agent control plane. The
Room view owns messages, mentions, and Runs. The Agents view owns runtime
roster, status, managed enrollment approval, MCP credentials, demo runtimes,
and trusted Devices. Fake Agents are explicitly labeled as simulations and are
not presented as production connections. Secrets are shown only in the
immediate setup result and are never returned by list APIs.

An empty installation presents a three-step Team, Room, and Agent onboarding
flow in the main workspace. Required fields use native browser validation;
actions remain visibly available unless a request is already in progress.

## Interaction and Security Rules

- Mentions select a registered Agent identity, not free-form `@text` parsing.
- Cancellation actions show their current authoritative outcome.
- Bodyless HTTP requests do not declare a JSON content type.
- Render messages, Runtime output, and failure details as untrusted content.
- Never expose device secrets or raw Runtime environment values.
- Meet keyboard navigation and visible focus requirements for core workflows.

## Verification and Tasks

Component tests cover onboarding state transitions, Chinese-default locale
persistence, Agent management navigation, enrollment approval, and capability
gating.
Browser acceptance covers message, mention, reconnect, Run progress, reply, and
cancellation flows. Work is tracked by `WEB-001` through `WEB-009` in
`docs/TASKS.md`.

## Dependencies

Team/Room, Registry, Run Orchestration, Bridge pairing APIs, and Security.
