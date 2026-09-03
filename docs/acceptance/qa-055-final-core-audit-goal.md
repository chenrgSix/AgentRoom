# QA-055 Final Governed Execution Core Audit Goal

Status: planned and frozen on 2026-09-03. This document is the future
acceptance authority for `QA-055`; `docs/TASKS.md` remains the sole delivery-
state register. It may become active only after `QA-054` is accepted.

## Goal

Audit the delivered Governed Software-Team Execution Core against the complete
accepted ADR-0036 design, its recorded review resolutions and EX-01 through
EX-14. Repair every in-scope correctness, authority, recovery or documentation
finding before declaring the Core complete. Report Optional Remote Evidence
Extensions separately and do not make provider availability a Core exit gate.

## Audit Method

For every EX requirement, the audit must identify:

- the current owning implementation and authority boundary;
- contract and migration facts;
- focused positive, negative, replay/restart and concurrency evidence;
- product/E2E and physical evidence where the requirement calls for it;
- retained platform, live-provider, live-model, deployment and Release limits;
- any finding, its severity, repair commit and post-repair evidence.

Documentation claims must be checked against current code and persisted facts,
not copied from historical acceptance prose. Missing evidence is a finding.
P0/P1 Core findings must be repaired and independently regressed. Lower-risk
deferred work must be explicitly outside the accepted Core boundary or remain
open in `docs/TASKS.md`; it cannot disappear into narrative.

## Required Final Inventory

The accepted record must provide a requirement-by-requirement EX-01..EX-14
matrix, the current Core and Optional Extension task inventory, repair list,
exact commits, test commands/results, browser/physical acceptance references,
temporary-directory before/after snapshots and honest non-claims.

The final gate includes all registered schema fixtures and generated types,
all Server/Web/workspace tests, Bridge Go tests/vet and relevant race coverage,
deterministic E2E, production builds, documentation lint/whitespace checks and
at least three isolated temporary-lifecycle rounds with zero new
`agentroom-*`, `agent-room-*`, `convenewire-*` or `convene-wire-*` directories.

`QA-055` is `DONE` only when the audit itself is retained, every blocking Core
finding is repaired, the complete gate is green and the task register and
product boundary agree. This audit does not claim live LLM quality, real
GitHub/GitLab/CI availability, multiple physical computers, Windows/Linux
physical execution, deployment readiness, signed release artifacts or public
release admission unless separately evidenced.
