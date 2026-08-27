# ADR-0020: Authorize central Agent provisioning locally

- Status: Accepted
- Date: 2026-08-27
- Supersedes: none

## Context

A paired Bridge already belongs to one Team Member and publishes owner-local
Agent configurations. Creating another managed Agent currently requires opening
the Bridge Console on that machine. An authenticated Web user who owns the
Device should be able to request another Agent centrally without exposing the
Bridge's executable, Workspace, environment, Runtime credentials, or permission
configuration.

Web authentication alone is insufficient authority to mutate a member machine.
A stolen Web session must not be able to create arbitrary local Runtime
configurations. Conversely, a long manually entered secret is unsuitable for a
trusted-LAN deployment where an owner may create several Agents in succession.

## Decision

Add owner-scoped central Agent provisioning as an optional capability of an
already paired Device. Existing enrollment remains unchanged and is still the
only way to establish the `User -> Member -> Device` binding. The Bridge stores
no Web session or account credential. A Web request is authorized only when the
authenticated User resolves to the exact owning Member of the active target
Device.

The central request selects an existing managed Agent on that Device as its
local template and supplies only a new immutable Agent ID, display name, and
role. The Bridge resolves the template by stable Agent ID and clones its complete
owner-local Runtime configuration. Commands, paths, environment allowlists,
Provider state, credentials, tools, and permission details never enter the
request or central persistence.

The Device owner selects one local authorization mode:

- `disabled`: reject all central provisioning;
- `fixed`: accept a reusable eight-digit numeric management code until the
  local owner replaces or disables it;
- `rotating`: accept the current six-digit numeric code, which rotates every
  five minutes and may be reused during that interval.

Modes and fixed-code changes require the token-authenticated loopback Console,
the stopped-and-drained configuration-mutation fence, and an explicit local
save. The fixed code is stored only as a local SHA-256 digest. The rotating code
is generated locally and exposed only by authenticated local Console state.
Neither code is returned through central APIs, logs, diagnostics, or Agent
messages.

The browser sends a code with one provisioning request. The Server validates
User, Team, Member, Device, source Agent, names, request identity, and online
connection, persists no code, and forwards the bounded request over the existing
outbound Bridge WebSocket. The Bridge is the final verifier. Each verification
is bound to the exact request and proposed Agent ID, while a valid fixed code or
the current rotating code remains reusable according to its mode.

Provisioning follows:

```text
pending -> delivered -> accepted -> ready
                    \-> rejected
```

The Bridge rejects configuration mutation while enrollment, Runtime probes, or
Team work is active. On acceptance it atomically binds the Server-selected Agent
ID, replaces the local configuration, acknowledges acceptance, and rebuilds its
managed connection. The following authenticated `agent.publish` makes the
request `ready`. Exact request retries converge on the same request and Agent;
conflicting reuse is rejected.

Failed code attempts are counted locally per connection. Five consecutive
failures impose an increasing bounded delay; a successful verification or local
code change clears the counter. This prevents online guessing without making a
remote actor able to permanently disable local administration.

## Alternatives

- Let any authenticated Team Owner provision every member Device: rejected
  because Team administration is not local machine ownership.
- Send complete Runtime configuration from the Server: rejected because it
  exposes local paths and turns the central service into a remote execution
  gateway.
- Require only initial Device pairing: rejected because a later stolen Web
  session could provision new local Agents without current possession evidence.
- Make the fixed code single-use: rejected because it removes the trusted-LAN
  convenience that distinguishes it from rotating authorization.
- Infer public versus LAN deployment and force a mode: rejected because proxy,
  tunnel, and private-DNS topology cannot be inferred reliably. The Console
  explains the tradeoff and leaves the explicit choice local.

## Consequences

Central provisioning can create only a sibling of an existing local Agent. A
different Workspace, Runtime, sandbox, or environment still requires local
Bridge editing. The Web can show request status but cannot reveal or recover a
management code. An offline Device cannot accept a new request.

The new protocol is additive. Older Servers never send provisioning messages;
older Bridges reject or ignore no existing message. Existing Devices and Agent
IDs are unchanged. Disabling remote provisioning does not disable or delete
Agents that were already created.

## Compatibility and Security

The Server never persists the submitted code and must redact it before all log
and error paths. The Bridge validates the exact target Device, template Agent,
new Agent identity, display fields, local mode, code, mutation fence, and
duplicate identity before writing. Server-side Agent publication validation
continues to require the exact Team, Device owner, and Device credential.

This control protects local configuration changes, not ordinary authorized Team
work sent to existing Agents. Web account protection, Room membership, Runtime
sandboxing, tool policy, and local approval remain independent defenses.

## Verification

- Cross-Team, foreign-owner, revoked, offline, and wrong-template requests fail.
- Disabled, wrong, expired rotating, and rate-limited codes cannot write config.
- Fixed codes authorize multiple distinct requests until locally replaced.
- One rotating code authorizes requests only inside its displayed interval.
- Accepted retries preserve one Agent ID and one local Agent configuration.
- Active work and Runtime probes fence provisioning without partial writes.
- Server persistence, responses, logs, diagnostics, and Team messages contain no
  management code or local Runtime configuration.
- TypeScript and Go generated contracts plus a real WebSocket regression agree
  on request and result envelopes.
