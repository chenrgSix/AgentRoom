# QA-065 Discussion benchmark review packet

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
this exact payload/model/quota request on 2026-09-05. The bounded real invocation
is now explicitly authorized; the original rejection remains historical evidence.

The offline runner instead builds the actual Go Bridge and uses the real local
Server, SQLite and authenticated APIs with a generated synthetic executable.
It cannot choose a provider executable or inherit provider authentication.
All six arms complete with 1/3 Run counts; its timings and canned responses are
plumbing evidence only and are deleted with the owned fixture. Adapter tests
reject tool calls, provider failure, malformed output and missing executables
while suppressing diagnostics and hidden reasoning. This path is included in
`npm test` through `npm run test:discussion-benchmark`.

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
