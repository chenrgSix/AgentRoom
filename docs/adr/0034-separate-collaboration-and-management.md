# ADR-0034: Separate collaboration and management in the Central Web

- Status: Accepted
- Date: 2026-08-31
- Extends: ADR-0022, ADR-0027, ADR-0028, ADR-0032

## Context

The Central currently mixes Room navigation, Agent inventory, Hosted credentials,
Device pairing and local provisioning in one long workspace. Everyday conversation
and occasional configuration need different navigation and information density.

## Decision

Provide two areas in the existing authenticated Web shell: Collaboration and
Management. Collaboration retains the default Workbench, first-class Task detail
and Room conversation. Management has separate Agents, Devices, Team and members,
and Account and security destinations. Account settings remain reachable without
a selected Team. Existing Agent/member links continue to work; Device/security
views extend the same allowlisted, access-checked navigation mechanism.

Inventory is the default management surface. Agent creation, single-Agent Hosted
configuration, Device pairing and invitation/recovery are explicit on-demand
flows. Reuse existing configuration and pairing controllers, permission checks,
revision fences and secret clearing. Device registration is not an online signal.
Local Runtime settings stay on the client; Central Hosted Agents remain HTTP-only.

An area switch remembers the current Collaboration destination in memory for the
same session and Team, including its Task, tab and filters. Room synchronization
and scoped draft/outbox ownership remain with their existing controllers. Returning
to Collaboration restores that destination without submitting work. History and
external links still resolve current access, not remembered authority. Switching
Team or identity must not restore the previous context or transient credentials.

## Compatibility and Verification

This is browser presentation only: no Server API, contract, schema, client,
deployment or hosting changes. No Release or live installation update is implied.

Verify direct/history navigation, same-context return, drafts, creation and scoped
configuration, Owner/member visibility, safe secret disposal and bounded dialogs.
Run focused and full regressions plus isolated production-browser acceptance at
desktop and narrow widths in Chinese/English and light/dark themes. Synthetic
provider acceptance must not be represented as live-provider or physical-client
acceptance.
