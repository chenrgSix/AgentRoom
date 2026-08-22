# Web UI

## Scope

- Prefix: `WEB`
- Planned location: `apps/web/`
- Owns: browser presentation state and user interaction

The browser client is the primary Team conversation surface. It renders
authoritative server state and sends user intents; it does not contain routing,
authorization, or Run state-machine logic.

## Primary Surfaces

- Authenticated Team and Room shell.
- Ordered message timeline and thread view.
- Structured Agent mention and handoff composer.
- Agent roster with presence and capability summaries.
- Run cards with live status, replies, cancellation, and failure details.
- Device pairing, revocation, and local policy guidance.

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

The current MVP provides Team and Room creation, Fake Agent registration,
durable message history, stable-ID Agent selection, live Run status, Agent
presence, one-time MCP setup output, and Bridge pairing/revoke controls. Secrets
are shown only in the immediate setup result and are never returned by list APIs.

An empty installation presents a three-step Team, Room, and Agent onboarding
flow in the main workspace. Required fields use native browser validation;
actions remain visibly available unless a request is already in progress.

## Interaction and Security Rules

- Mentions select a registered Agent identity, not free-form `@text` parsing.
- Cancellation actions show their current authoritative outcome.
- Render messages, Runtime output, and failure details as untrusted content.
- Never expose device secrets or raw Runtime environment values.
- Meet keyboard navigation and visible focus requirements for core workflows.

## Verification and Tasks

Component tests cover onboarding state transitions and capability gating.
Browser acceptance covers message, mention, reconnect, Run progress, reply, and
cancellation flows. Work is tracked by `WEB-001` through `WEB-007` in
`docs/TASKS.md`.

## Dependencies

Team/Room, Registry, Run Orchestration, Bridge pairing APIs, and Security.
