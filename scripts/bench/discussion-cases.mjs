// Closed tasks grounded in this repository's selector, ledger and quorum design.
// Rubrics are retained before any model answer is collected; they are human judged.
export const cases = [
  {
    id: "selector-review", category: "code_review",
    source: "00989ec:apps/server/src/discussion/discussion-participant-selector.ts",
    prompt: `Review this production finalization policy. Candidates are already filtered by current eligibility and sorted by frozen participant ordinal. Each candidate includes taskRole: primary|contributor|reviewer|null. The frozen Discussion reviewer has participant.role=reviewer. Intended preference: eligible frozen reviewer, then eligible Task primary, then original ordinal. Current code:
const reviewer = candidates.find(c => c.participant.role === 'reviewer');
if (finalization) {
  const selected = reviewer ?? candidates[0];
  return freezeSelection([selected]);
}
Identify the concrete missing behavior, give the smallest correction, and propose two regression cases. Explain whether an unavailable reviewer or a nonparticipant primary may be selected.`,
    rubric: [
      "Identifies that a later-ordinal eligible Task primary is overlooked when no reviewer is eligible",
      "Corrects preference to reviewer then taskRole primary then frozen ordinal without expanding eligibility",
      "Tests later-ordinal primary and unavailable primary/reviewer or frozen recovery; does not select an unavailable or nonparticipant Agent"
    ]
  },
  {
    id: "quorum-diagnosis", category: "problem_diagnosis",
    source: "apps/server/src/discussion/budget-ledger.ts and discussion-usage.ts",
    prompt: `Diagnose this Discussion usage report using only these retained facts. Wave expectedMembers=3; the budget ledger charged agentRunsUsed += expectedMembers. Turn A is bound to Run A, now completed. Turn B is bound to Run B, now working while cancellation is still in flight after the owner ended the Discussion. Turn C failed before any Run was created and has runId=null. Discussion createdAt=10:00:00, terminalAt=10:00:30, observedAt=10:02:00. Provider token and money telemetry is absent. A dashboard reports "3 successful Runs, 120 seconds execution, $0 cost". Correct each claim, explain why budget and actual lifecycle differ, and specify what a later observation may change.`,
    rubric: [
      "Reports two actual Runs: one completed and one still working; one unbound member slot and three debited budget slots",
      "Reports 30 seconds Discussion wall time including waits, not 120 seconds or summed execution time",
      "Keeps tokens and money unknown and allows late Run outcome changes without extending terminal Discussion wall time"
    ]
  },
  {
    id: "fallback-design", category: "solution_comparison",
    source: "docs/modules/discussion-orchestration.md and ADR-0042",
    prompt: `Compare three ways to choose Discussion members: (A) always the first two by frozen ordinal, (B) deterministic focus-question reporter/role matching with required reviewer retention, and (C) a new LLM router. Current eligible candidates in frozen order: Backend primary (0), Docs (1), Security who reported high-priority question Q-security (2), designated Reviewer (3). Focused limit=2 and review mode requires the Reviewer. Current question is Q-security: "Which security boundary protects the token exchange?" Current policy keeps all eligible members on first wave or absent/unmatched focus questions. Recommend a choice for this wave and a next-step product experiment. Address the required reviewer, which two members should run, the no-match fallback tradeoff, and what evidence is needed before claiming monetary savings or better answers.`,
    rubric: [
      "Chooses Security and designated Reviewer within the limit; identifies that ordinal-first loses both relevance and required review",
      "Preserves or explicitly treats no-match broad fallback as an experiment rather than claiming unconditional Top-N superiority",
      "Calls for single-Agent comparison and actual Run/time/answer-quality evidence; Run savings alone do not prove token/money savings or quality"
    ]
  }
];
