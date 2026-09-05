# QA-065 Discussion benchmark review packet

This record preserves the executed version 1 baseline and its fixed payloads.
After reviewing it, the Owner requested removal of token and cost accounting.
[ADR-0043](../adr/0043-remove-discussion-token-cost-accounting.md) governs the
current product and version 2 report, which omit those metric fields. The
historical report, answers and review below are unchanged evidence.

## Invocation and data boundary

The prepared command is `npm run bench:discussion`. It invokes the local
Codex CLI against OpenAI using the existing signed-in account and an explicit
`gpt-5.4-mini` model with low reasoning effort. A different model requires an
explicit `CONVENE_WIRE_BENCH_MODEL` override and a new comparison identity.
This packet requests no model installation, credentials export or Release.

Three fixed project-derived tasks run in both arms: one ordinary Agent Run
versus two independent contributions and one Reviewer finalizer. At most 12
Runs and 20 minutes of model work are allowed; each invocation has a 300-second
ceiling. A shared atomic 12-slot invocation quota also prevents a thirteenth
provider process, even if scheduling regresses. The first failure stops remaining attempts; there are no automatic
retries. The same executable, explicit model and task input are used in both
arms. Pair order alternates, and every arm has its own disposable Room.

The outgoing content consists of the exact task text below, a common instruction
to answer in English under 350 words from provided facts without tools or file
changes, existing Server-generated Role/Discussion/assessment instructions, and
answers generated earlier in that isolated task. No existing Team messages,
customer data or source checkout is mounted into the model workspace. The CLI
uses an empty owned workspace, read-only sandbox and ephemeral sessions. Tool
use invalidates the response. Credentials are used by the CLI for authentication
and are not inserted into prompts or copied into reports.

The code-review snippet is a reduced reproduction of the pre-fix selector;
the other tasks use explicit constructed observations and design constraints.
These are project-grounded closed-input tasks, not production-user trials.
This small baseline does not measure open-ended repository work, matched versus
unmatched fallback policy variants, statistical superiority or monetary ROI.

Reports under ignored `var/discussion-benchmark/` retain source commit, dirty
state, benchmark file hashes, prompt hash, model configuration, raw final and
intermediate answers, actual Run outcomes and elapsed wall time. Actual provider
model identity, tokens and currency remain unavailable unless observed; requested
model identity is not provider attestation. The three rubric items for each
answer must be reviewed manually with evidence. No LLM judge or keyword score
is presented as task success.

## Execution evidence

Automatic approval review rejected the live invocation on 2026-09-05 before
execution, requesting explicit authorization for these payloads, the OpenAI
model destination and account-quota use. No live model result or cost saving is
claimed for that rejected attempt. The Owner subsequently replied “确认” to
this exact payload/model/quota request on 2026-09-05. The authorized invocation
then completed all six arms and 12 real Runs without retries; the original
rejection remains historical evidence.

The offline runner instead builds the actual Go Bridge and uses the real local
Server, SQLite and authenticated APIs with a generated synthetic executable.
It cannot choose a provider executable or inherit provider authentication.
All six arms complete with 1/3 Run counts; its timings and canned responses are
plumbing evidence only and are deleted with the owned fixture. Adapter tests
reject tool calls, provider failure, malformed output and missing executables
while suppressing diagnostics and hidden reasoning. This path is included in
`npm test` through `npm run test:discussion-benchmark`.

## Real comparison and answer review

The real invocation used clean source `24cbc83755a5c786b4fbb3134a7d566a18bd5921`,
Codex CLI `0.153.3`, requested `gpt-5.4-mini` and low reasoning effort through
the generic Bridge adapter. It completed on 2026-09-05 in 176 seconds including
fixture preparation. All 12 Runs completed, all three Discussions used the
Reviewer finalizer, and their observed usage independently reports three
completed Runs each. No tool-using response or runtime failure was accepted.

The [reviewed evidence](evidence/qa-065-discussion-benchmark-2026-09-05.json)
retains the exact original task inputs, prompt/source hashes, all intermediate
and final answers, actual Run states, frozen v2 selection reasons and timings.
Only predeclared rubric decisions and review provenance were added to the
original report. Its SHA-256 is
`cf26dc76e2d9c1bfd80022fc4c23f2da5e394e9a243eda4bc74ac137dba510b7`.
The original remains under ignored `var/discussion-benchmark/`.

| Fixed task | Single Agent Runs / wall time | Discussion Runs / wall time | Rubric items passed, single / Discussion |
| --- | --- | --- | --- |
| Code review | 1 / 20.750 s | 3 / 35.622 s | 2 of 3 / 2 of 3 |
| Problem diagnosis | 1 / 17.981 s | 3 / 39.384 s | 1 of 3 / 1 of 3 |
| Solution comparison | 1 / 16.450 s | 3 / 35.563 s | 2 of 3 / 2 of 3 |
| Total | 3 / 55.181 s | 9 / 110.569 s | 5 of 9 / 5 of 9 |

The Codex task agent reviewed the retained answers directly against the fixed
rubrics without additional provider calls. This was not blind review or
independent human review. Each composite item requires its full content;
equivalent descriptions of Run accounting and implications across an answer
are credited consistently. Per-item evidence explains both passes and misses.

- Both code-review answers fix the preference expression but allow a
  nonparticipant primary and omit an availability/recovery regression. The
  frozen-participant premise could be more explicit in this prompt, so the
  nonparticipant interpretation alone is not strong evidence; the missing
  regression independently fails the same rubric item. The finalizer repeats
  the contribution's mistake rather than correcting it.
- Both diagnosis answers distinguish expected slots from real Run outcomes,
  but neither states the 30-second Discussion wall time and its terminal
  freeze. Recognizing that 120 seconds of execution is unsupported does not
  satisfy the required corrected metric.
- Both comparison answers choose Security plus the required Reviewer and
  preserve broad fallback as a coverage tradeoff. Their next experiment
  compares deterministic routing with an LLM router; neither supplies the
  required single-Agent baseline and actual Run evidence.

Neither arm meets every item on any of these three tasks. Discussion consumes
three times the Runs and approximately twice the summed wall time in this
sample, with equal rubric coverage. This supports keeping the current
Discussion v1 scope frozen; it does not establish that Discussion is generally
worse or estimate production-user task success. The sample has only three
constructed tasks, one attempt per arm and one requested model/effort. The
ordinary Run and Discussion role/context wrappers differ as part of the product
comparison. Alternative selector/finalizer strategies were not exercised.

Provider-attested model identity, tokens and monetary cost remain unavailable;
Run counts and observed wall time cannot establish monetary savings. More
routing architecture is not justified by this result. A future evidence set
would need clearer closed-input boundaries and representative tasks where
independent expertise can affect the answer, with the single-Agent control
retained; no additional model runs are authorized or started by this record.

The runner reports cleanup, a physical check confirms its exact owned root
`/private/tmp/convene-wire-test-run-xqarJS` no longer exists, and a read-only
process check finds no remaining benchmark wrapper, fixture or test process.
No persistent Team, credentials, workspace or model subprocess remains from
the owned fixture. The original local report and reviewed evidence are retained.

## Fixed task payloads and rubrics

### selector-review

Category: code_review. Reference: `00989ec:apps/server/src/discussion/discussion-participant-selector.ts`.

```text
Review this production finalization policy. Candidates are already filtered by current eligibility and sorted by frozen participant ordinal. Each candidate includes taskRole: primary|contributor|reviewer|null. The frozen Discussion reviewer has participant.role=reviewer. Intended preference: eligible frozen reviewer, then eligible Task primary, then original ordinal. Current code:
const reviewer = candidates.find(c => c.participant.role === 'reviewer');
if (finalization) {
  const selected = reviewer ?? candidates[0];
  return freezeSelection([selected]);
}
Identify the concrete missing behavior, give the smallest correction, and propose two regression cases. Explain whether an unavailable reviewer or a nonparticipant primary may be selected.
```

Manual rubric:

- Identifies that a later-ordinal eligible Task primary is overlooked when no reviewer is eligible
- Corrects preference to reviewer then taskRole primary then frozen ordinal without expanding eligibility
- Tests later-ordinal primary and unavailable primary/reviewer or frozen recovery; does not select an unavailable or nonparticipant Agent

### quorum-diagnosis

Category: problem_diagnosis. Reference: `apps/server/src/discussion/budget-ledger.ts and discussion-usage.ts`.

```text
Diagnose this Discussion usage report using only these retained facts. Wave expectedMembers=3; the budget ledger charged agentRunsUsed += expectedMembers. Turn A is bound to Run A, now completed. Turn B is bound to Run B, now working while cancellation is still in flight after the owner ended the Discussion. Turn C failed before any Run was created and has runId=null. Discussion createdAt=10:00:00, terminalAt=10:00:30, observedAt=10:02:00. Provider token and money telemetry is absent. A dashboard reports "3 successful Runs, 120 seconds execution, $0 cost". Correct each claim, explain why budget and actual lifecycle differ, and specify what a later observation may change.
```

Manual rubric:

- Reports two actual Runs: one completed and one still working; one unbound member slot and three debited budget slots
- Reports 30 seconds Discussion wall time including waits, not 120 seconds or summed execution time
- Keeps tokens and money unknown and allows late Run outcome changes without extending terminal Discussion wall time

### fallback-design

Category: solution_comparison. Reference: `docs/modules/discussion-orchestration.md and ADR-0042`.

```text
Compare three ways to choose Discussion members: (A) always the first two by frozen ordinal, (B) deterministic focus-question reporter/role matching with required reviewer retention, and (C) a new LLM router. Current eligible candidates in frozen order: Backend primary (0), Docs (1), Security who reported high-priority question Q-security (2), designated Reviewer (3). Focused limit=2 and review mode requires the Reviewer. Current question is Q-security: "Which security boundary protects the token exchange?" Current policy keeps all eligible members on first wave or absent/unmatched focus questions. Recommend a choice for this wave and a next-step product experiment. Address the required reviewer, which two members should run, the no-match fallback tradeoff, and what evidence is needed before claiming monetary savings or better answers.
```

Manual rubric:

- Chooses Security and designated Reviewer within the limit; identifies that ordinal-first loses both relevance and required review
- Preserves or explicitly treats no-match broad fallback as an experiment rather than claiming unconditional Top-N superiority
- Calls for single-Agent comparison and actual Run/time/answer-quality evidence; Run savings alone do not prove token/money savings or quality
