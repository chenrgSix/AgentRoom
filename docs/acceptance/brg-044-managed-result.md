# BRG-044 managed Result acceptance

Date: 2026-08-28

## Delivered boundary

`agentroom-bridge result propose` selects one configured Agent and exact Run.
It accepts one bounded Result contract as inline JSON, validates every required
field, revision, closed source kind, source identity, claim link and list bound,
and requires at least one event from the selected Run. The command has no
proposal-file, Workspace-path, review, acceptance or Task-completion option.

The Device-authenticated `/api/bridge/results` route accepts only
`managed_agent`, Agent ID, Run ID and the strict Result proposal. Central
authority rebinds the Device credential to the managed Agent, Team, current
Task assignment, exact Run and persisted Run event. It also reuses TASK-013
scope and revision checks for every Artifact, Message, Memory, Discussion and
criterion evidence edge.

An uncertain HTTP response triggers one replay of the same structured request.
The stable operation ID returns the original immutable Result and version.
Neither a final Runtime reply nor a successful Run creates a Result
implicitly.

## Negative and recovery evidence

The Go client tests reject unknown local-path fields before transport, require
all proposal fields, reject a foreign Run event and prove that response-loss
retry preserves the request body, Device bearer and optional central Server
Token. The Server HTTP test rejects an invalid credential, a credential from a
different Device and a local Workspace field, proves exact retry equality, and
proves a Device credential cannot call the human review route.

## Verification

- `go test ./internal/result ./cmd/agentroom-bridge` passes focused client and
  CLI cases.
- `go test ./...` passes every Bridge Go package.
- `go vet ./...` passes the complete Bridge module.
- `npm run build --workspace @agent-room/server` passes strict TypeScript.
- `npm test --workspace @agent-room/server` passes 146 Server tests.

This closes only the managed proposal transport. Human review and Task
completion remain central Member commands. `MCP-006` separately owns the manual
Agent read/proposal tools, and `WEB-046`/`WEB-047` own browser presentation.
