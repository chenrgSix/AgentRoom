# Architecture Decision Records

Use an Architecture Decision Record for changes that affect component
ownership, trust boundaries, protocols, persistence, compatibility, deployment,
or runtime lifecycle.

## Naming

Use a zero-padded sequence and short kebab-case title:

```text
0001-central-web-owns-team-state.md
0002-bridge-outbound-connections-only.md
```

Never reuse a number. Superseded ADRs remain in the repository.

## Status

Use one of: `Proposed`, `Accepted`, `Superseded`, or `Rejected`. Only
`Accepted` decisions may be treated as implementation constraints.

## Template

```markdown
# ADR-NNNN: Decision title

- Status: Proposed
- Date: YYYY-MM-DD
- Supersedes: none

## Context

Describe the problem, constraints, and evidence.

## Decision

State the chosen behavior and ownership boundary.

## Alternatives

List serious alternatives and why they were not selected.

## Consequences

Record positive and negative operational effects.

## Compatibility and Security

Describe wire compatibility, migration, trust, and data exposure.

## Verification

List tests or observable evidence that prove the decision.
```
