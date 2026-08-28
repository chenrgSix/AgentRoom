# ADR-0024: Rename the product to ConveneWire

- Status: Accepted
- Date: 2026-08-28
- Supersedes: none
- Amends: product identity references in ADR-0021 and ADR-0023

## Context

The product has grown beyond a single Agent room. It now includes a central
service, browser workbench, local Runtime Bridge, lifecycle controller,
versioned contracts, release packaging, and trusted multi-Agent coordination.
The new product name is **ConveneWire**: independent human and Agent
participants convene over an owned communication and execution layer.

AgentRoom has already shipped public releases. Its name appears in executable
names, package and Go module identities, environment variables, Prometheus
metrics, configuration and data paths, macOS and Windows application identity,
URL schemes, protocol tokens, HTTP headers, release assets, and historical
acceptance evidence. Treating every occurrence as replaceable branding would
break upgrades, orphan state, or rewrite the evidence for an already published
artifact.

The GitHub repository was originally hosted at `chenrgSix/AgentRoom`. The
Project Owner separately authorized moving that external hosting identity to
`chenrgSix/ConveneWire`; the source rename alone did not imply that authority.

## Decision

### Current product identity

All current human-facing product surfaces use **ConveneWire**. New source
package/module names, commands, launchers, generated release assets, container
image labels, documentation, and examples use `convenewire`, `convene-wire`,
`convene_wire`, or `CONVENE_WIRE` according to the owning ecosystem's naming
rules.

The primary distributed commands are:

- `convenewire-bridge`;
- `convenewire-bridge-desktop`; and
- `convenewirectl`.

The Node workspace scope is `@convene-wire/*`, and local Go modules use the
`convenewire.dev/*` identity.

### Stable compatibility identities

The following identifiers remain unchanged because they identify already
released protocol or installation state rather than current branding:

- Bridge output protocol value `agentroom-jsonl-v1`;
- published JSON Schema identities under `https://agentroom.dev/schemas/`;
- authenticated Server Token header `X-AgentRoom-Server-Token`;
- trusted Web session cookie `__Host-agentroom_session`, Owner recovery and
  Artifact response headers under `X-Agent-Room-*`/`X-AgentRoom-*`, and the
  `<agentroom-assessment>`/`<agentroom-clarification>` Runtime envelopes;
- existing browser local/session-storage keys and the persisted Pi session-ID
  namespace;
- existing SQLite filename, Compose project/volume identities, controller
  manifest names, and owner data/configuration directories containing
  `agentroom` or `agent-room`;
- macOS bundle identifiers, LaunchAgent label, Windows installer AppId, and the
  registered `agentroom://` URL scheme needed for in-place upgrade and existing
  pairing links;
- existing `agentroom_*` Prometheus series during one compatibility window;
  new `convenewire_*` series are authoritative and legacy series are emitted as
  aliases;
- published tag, asset, acceptance, and release-note records; and
- historical GitHub URLs, which GitHub redirects after the separately
  authorized repository-host rename.

New `CONVENE_WIRE_*` environment variables are authoritative. Released
`AGENT_ROOM_*` names remain accepted aliases. If both forms are present with
different non-empty values, startup fails instead of silently choosing one.
Generated deployment configuration writes only the new names while the
Compose model accepts both during the compatibility window.

The desktop registers and accepts `convenewire://` for new links while
continuing to accept `agentroom://`. Stable OS application identifiers are not
changed merely to make their hidden strings match the new display name.

The canonical GitHub repository is `chenrgSix/ConveneWire`. Current clone,
release, issue, installer and update-check URLs use that identity. GitHub's
redirect from `chenrgSix/AgentRoom` keeps committed historical links usable;
historical files are not rewritten solely to remove the old path. Existing
local checkout directory names are operator-owned and are not renamed.

### Historical records

`agent_room_network_design_v0.1.md` remains immutable historical context.
Published release notes, committed acceptance evidence, old asset manifests,
and statements about the artifacts they verified keep the AgentRoom name.
Current documentation labels these records as pre-ConveneWire history instead
of rewriting them.

## Alternatives

- Replace every string and path immediately: rejected because it would orphan
  installed configuration and data, break monitoring and deep links, change
  installer upgrade identity, and falsify historical release evidence.
- Change only the Web title: rejected because packages, commands, installers,
  documentation, and new release assets would continue presenting conflicting
  product identities.
- Keep AgentRoom permanently: rejected because the name no longer represents
  the wider coordination and execution system selected by the Project Owner.

## Consequences

- New users see one ConveneWire product family across Central, Web, Bridge,
  controller, documentation, and release downloads.
- Existing installations retain their state and can continue using legacy
  environment names, metrics, deep links, and hidden OS identifiers.
- Some internal and historical `agentroom` strings intentionally remain. Their
  presence is not an incomplete rename when listed by this ADR.
- A later major-version migration may retire aliases only with explicit
  operator guidance, migration tooling, and acceptance evidence.
- Release publication, local checkout directory changes, domain ownership, and
  trademark clearance remain separate external gates.

## Compatibility and Security

Environment alias resolution is closed and deterministic: conflicting new and
legacy values fail before listener, credential, database, or deployment state
is used. Compatibility never weakens authentication, TLS verification,
credential scope, Device identity, Runtime ownership, or local file
permissions.

No migration copies secrets or state into a second directory. Stable bundle,
installer, Compose, manifest, and data identities continue to select the same
owner-scoped state. New display names and command names do not create a second
authority.

## Verification

- Web, Bridge, CLI, installer, license, and current documentation surfaces show
  ConveneWire.
- Workspace package builds resolve only through `@convene-wire/*`, and Go
  builds resolve through `convenewire.dev/*`.
- New release packaging produces only `convenewire-*` archives and primary
  commands while retaining the stable installation identity required for
  upgrade.
- Server and deployment tests cover new environment names, legacy aliases, and
  conflicting-value rejection.
- Metrics tests prove authoritative `convenewire_*` and compatibility
  `agentroom_*` series carry the same values.
- Desktop tests prove both URL schemes reach the same pairing handler without
  changing stored Device identity.
- Historical v0.1, release, and acceptance records remain unchanged.
- Contract validation, workspace tests/builds, deterministic E2E, Bridge Go
  tests/vet/desktop compilation, controller Go tests/vet/build, packaging
  verification, and documentation lint pass.
