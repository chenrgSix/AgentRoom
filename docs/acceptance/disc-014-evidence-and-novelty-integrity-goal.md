# DISC-014 Evidence and Novelty Integrity Goal

Status: accepted on 2026-09-05 against the goal frozen before implementation.
This document remains the implementation and acceptance authority for
`DISC-014`; `docs/TASKS.md` remains the sole delivery-state register.

## Goal

Prevent an Agent's opaque evidence label or lexical restatement from
fabricating Discussion progress. Preserve every valid structured assessment on
its immutable Turn for audit, but distinguish claimed references from evidence
that the Server can resolve inside the owning Room and Task. Only newly
verified evidence may reset plateau. Treat a bounded, strongly similar reply as
repetition when it adds no independently verified question, evidence or
disagreement delta.

The implementation remains deterministic and local. It does not call an
embedding service, semantic model or LLM judge, and it does not grant evidence,
Task Result, execution, repository, verification or integration authority.

## Evidence Boundary

- `AgentAssessment.newEvidenceRefs` remains an optional string list and the
  parsed assessment remains on the immutable Discussion Turn as the claimed
  report.
- `ProgressSnapshot.evidenceRefs` remains the bounded claimed-reference union
  for compatibility and audit. A separate additive `verifiedEvidenceRefs`
  projection contains only references resolved by Central.
- Supported concrete references are Message, Run, Artifact, Result, Memory and
  Discussion IDs. The resolved record must belong to the exact Discussion Room
  and Task; unknown kinds, missing records and cross-Room or cross-Task records
  remain claims only.
- Legacy ProgressSnapshot JSON loads with an empty verified set. Existing
  claimed strings are never upgraded into verified evidence by shape or prefix.
- Verification failure does not reject or erase an Agent reply. It prevents
  that claim from increasing `newEvidence` or resetting plateau.

## Lexical Novelty Boundary

- Exact normalized SHA-256 reply history remains the first duplicate check.
- A second local comparison uses Unicode NFKC/lowercase alphanumeric character
  shingles, a minimum content length, a conservative length-ratio gate and a
  fixed high similarity threshold. It is intended only for near copies, not
  semantic equivalence.
- Each settled Wave compares against at most the ten newest accepted replies
  from earlier Waves and earlier members in frozen participant order. Quorum-
  excluded and supplemental late replies never enter the comparison.
- The recent source replies are reconstructed from durable accepted Turn and
  Message facts. No reply body or reversible lexical sketch is duplicated into
  ProgressSnapshot, and restart recomputation produces the same result.
- A near duplicate can still make progress through a newly resolved important
  question, newly verified evidence or changed disagreement. Agent self-report
  alone cannot override the lexical duplicate finding.

## Prompt and Web Boundary

Later instructions expose only verified evidence in the Progress section and
label transcript Message IDs so an Agent can cite a concrete prior Message.
Claimed-only references are not amplified into later prompts.

The public Discussion object gains only an additive internal progress field;
the existing Web progress model and controls do not display or mutate evidence
references. No user decision or layout changes, screenshots or browser
acceptance are required.

## Non-Goals

This slice does not change Reviewer, finalizer, focused participant, quorum,
lease or policy preset behavior. It does not infer semantic sameness, fetch a
URL, accept free-form evidence labels as proof, adopt evidence into an
execution Plan, or alter Task Result evidence authority.

## Required Evidence

`DISC-014` may become `DONE` only when focused tests prove:

1. all six supported reference kinds resolve only inside the exact Room and
   Task, while missing, unknown and cross-scope references remain claimed only;
2. claimed-only references persist on the Turn and Progress audit union but do
   not increase verified evidence or reset plateau;
3. legacy/reopened ProgressSnapshot JSON defaults verified evidence to empty
   without promoting historic claims;
4. exact duplicates, English reorderings and Chinese near copies are treated
   as repetition, while short, materially different and substantially extended
   replies remain novel;
5. callback permutations, current-Wave ordering, accepted quorum filtering and
   restart recovery retain one deterministic ProgressSnapshot;
6. verified evidence and independent question/disagreement deltas still reset
   plateau, and later Prompt progress includes only verified references;
7. focused and full Server tests, Server build, maintained documentation and
   whitespace checks pass without a Web model or page change.

## Acceptance Evidence

- 79 focused Discussion tests cover supported reference resolution, scope
  rejection, claimed-only audit retention, legacy reopen behavior, exact and
  lexical repetition, independent progress deltas, frozen member order, quorum
  filtering, restart behavior and Prompt projection. The Orchestrator fixture
  resolves Message, Run, Artifact, Result, Memory and Discussion references
  through real SQLite repositories, and a restart between Waves reconstructs
  lexical comparison from accepted durable replies.
- The full Server suite passes 608 tests with no failures and removes its owned
  temporary root.
- The Server TypeScript build passes. Markdown lint passes across 380
  maintained files, and `git diff --check` reports no whitespace errors.
- No Web model, control or page changed because the verified projection is an
  additive Server-owned progress fact with no new user decision.
