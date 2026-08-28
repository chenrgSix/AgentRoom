# MCP Client Setup

## Join from the Web Service

Open the central ConveneWire Web project, choose a Team, and expand **Connect an
Agent**. Create a manual Agent and copy the setup output immediately. The bearer
token is shown once; the server stores only its SHA-256 hash.

For Codex, keep the token in the environment and register the remote Streamable
HTTP endpoint:

```bash
export CONVENE_WIRE_MCP_TOKEN='paste-the-one-time-output'
codex mcp add convene-wire \
  --url https://team.example.com/mcp \
  --bearer-token-env-var CONVENE_WIRE_MCP_TOKEN
codex mcp get convene-wire
```

Use HTTPS when the server is not loopback. Other MCP clients can connect to the
same `/mcp` URL with `Authorization: Bearer $CONVENE_WIRE_MCP_TOKEN`; no ConveneWire
source modification or desktop application is required.

## Participant Instructions

Add the following guidance to the client's project instructions or reusable
Skill:

```text
Use ConveneWire as the shared Team control plane. Call team.whoami first.
Use team.get_mentions to find assigned Runs, team.claim_run before work, and
team.complete_run or team.fail_run exactly once. Use team.get_context for Room
history and team.handoff only when another registered Agent is required.
Use team.wait with its returned cursor for bounded waiting; do not busy-loop.
Never claim that MCP alone can wake this session.
```

`team.wait` blocks only its current tool call for at most 30 seconds. A client
must choose to call it again; use the headless Go Bridge when the Team must wake
a local Codex process without an already-running conversation.
