# ADR-0042: Explain and measure Discussion selection

- Status: Accepted
- Date: 2026-09-05
- Supersedes: none
- Amends: DISC-011 selection and Web read projection

## Context

Focused selection already narrows matched questions. First Waves, absent
questions and unmatched questions deliberately retain all eligible members.
The budget ledger counts reserved member slots, not observed Run creation or
provider spending. Current finalization overlooks an eligible Task primary
when its frozen Reviewer is unavailable.

## Decision

New finalization selects the eligible frozen Reviewer, then the current Task
primary among eligible frozen participants, then the lowest frozen ordinal.
Contribution eligibility, reviewer requirements and broad fallbacks remain
unchanged. Selection cannot grant execution authority.

New Wave selection snapshots use version 2 and retain a bounded reason for
every selected member: explicit all-member policy, absent focus questions,
unmatched focus questions, question reporter, role match, required Reviewer,
or finalizer Reviewer/primary/ordinal fallback. Matched question IDs and role
terms are frozen and included in the digest. Version 1 canonical bytes and
recovery remain unchanged; historical explanations are never reconstructed
from current Agent roles. Migration 0087 widens the existing SQLite version
constraint to accept v1/v2 using a transactional table rebuild and foreign-key
verification. It copies every historical row and selection JSON byte unchanged,
restores indexes and immutable triggers, and does not amend migration 0084.
Downgrading the Server after v2 Waves exist requires restoring the pre-upgrade
backup; older selectors cannot validate v2 snapshots.

The authenticated Discussion read projection adds observed usage: distinct
bound Run counts by actual lifecycle state, missing/unmatched records, member
slots without a Run, and elapsed wall time ending at Discussion terminal time.
Quorum completion does not convert still-running work into completed work.
Budget slots retain their existing semantics. Tokens and monetary cost remain
unknown until complete provider telemetry is available. No Bridge envelope or
cross-language schema changes are needed.

The Web explains frozen decisions and labels usage precisely. Older snapshots
and Servers remain readable without invented explanations or zero costs.

A local opt-in benchmark compares one ordinary Agent Run with one two-member
Discussion and its finalizer, using the same runtime/model and fixed inputs.
Code review, diagnosis and design comparison each have a predeclared rubric.
Three pairs allow at most 12 model Runs, without automatic retries, external
tools, repository writes or provider judges. Reports retain answers, task and
source identity, observed time, Run outcomes and telemetry limitations. Rubric
coverage and manual review are distinguished from statistical success claims.

## Alternatives and consequences

Forcing Top-N on unmatched questions is deferred until representative evidence
supports the tradeoff. Embeddings, model routing and model judges are outside
this iteration. A three-task sample is a reproducible starting point, not proof
that multi-Agent Discussion outperforms one Agent or reduces monetary cost.

## Verification

Regression gates cover the real orchestration finalizer, unchanged broad
fallbacks, v1/v2 persistence and tamper rejection, actual versus planned Runs,
terminal and late lifecycle facts, localized Web rendering and old records.
The bounded benchmark, complete relevant suites and real browser acceptance
are recorded under QA-065/QA-066 in the sole task register.
