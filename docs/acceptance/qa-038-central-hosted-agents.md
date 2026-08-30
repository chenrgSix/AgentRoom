# QA-038 Central Hosted Agent Acceptance

## Result

- Date: 2026-08-30
- Status: `PARTIAL`
- Scope: completed feature implementation plus deterministic local admission

The optional Central Hosted Agent feature is implemented and its repository,
HTTP E2E, Compose, backup, Server, Web and unchanged-Bridge deterministic gates
pass. `QA-038` remains `ACTIVE` because production-browser and release-package
admission are explicitly unverified below; that evidence is not substituted by
component tests or build success.

Post-implementation audit repairs and refreshed local deterministic evidence
are recorded in [QA-039](qa-039-hosted-agent-audit-fixes.md). They do not change
this record's remaining production-browser and release-package admission.

## Goal and authority boundary

After Central starts, an Owner may explicitly configure a Device-free Hosted
Agent in the existing Web application. Central calls the fixed OpenAI Responses
HTTPS endpoint directly, while the existing Server process, SQLite database and
Central image remain the complete deployment unit. Leaving Hosted Agents
unconfigured does not affect ordinary managed, manual or Fake Agents.

The implemented Hosted Agent is text-only. It has no Bridge, Device, Workspace,
filesystem, shell, browser, desktop, Docker or host-computer authority. It may
participate in an authorized Room through ordinary Mention, exact handoff and
Discussion Run paths, but it has no formal Result, Task-completion, Member,
Device or MCP authority. Provider credentials are configured by an Owner and
stored as authenticated encrypted versions in the existing SQLite database;
safe API and Web projections do not return the plaintext key.

## Related commits

| Commit | Evidence boundary |
| --- | --- |
| `e3b7956` | freezes ADR-0026 and the Hosted Agent delivery tasks |
| `2910cbb` | adds authenticated Hosted credential envelopes |
| `a4565c1` | registers Device-free Hosted Agents and derived Presence |
| `b7f158b` | makes reply and terminal Run completion atomic |
| `cf02608` | adds the bounded fixed-origin Responses streaming adapter |
| `7222672` | introduces Hosted persistence as migration 0052 |
| `3f05a71` | adds Owner configuration services and HTTP APIs |
| `2c38267` | restores revoked-credential failure closure |
| `cad06bf` | restores migration 0052 byte-for-byte and adds corrective 0053 |
| `413e8a1` | schedules, cancels and recovers durable Hosted Runs |
| `02d6f25` | adds the Owner-only Hosted Agent Web configuration surface |
| `20bfecc` | proves one Device-free Mention across a real Central HTTP listener |
| `04e7f6a` | proves encrypted Hosted state survives online backup and restore |
| `9cf4af2` | proves timeout, intent uniqueness, zero Delivery/Result and replay-safe recovery |
| `539757b` | proves Team/Room/identity/authority fences and metrics redaction |

Migration 0052 remains byte-for-byte identical to the migration first committed
in `7222672`. Corrective migration 0053 alone replaces the Hosted invocation
state trigger so timestamps may remain equal within one clock tick while still
rejecting time reversal and invalid lifecycle transitions.

## Confirmed deterministic evidence

| Boundary | Evidence | Result |
| --- | --- | --- |
| migration chain | `migration-runner.test.ts` and `hosted-agent-migration.test.ts` cover empty/upgrade/idempotent migration, foreign-key restoration, rollback and migration immutability across versions 0052 and 0053 | 10/10 pass |
| Server | complete `@convene-wire/server` test suite | 255/255 pass |
| Server build | strict TypeScript Server build | pass |
| Web | complete `@convene-wire/web` test suite, including the Owner-only Hosted configuration panel | 71/71 pass |
| Web build | production Web build | pass |
| repository schemas | root `npm run validate`, including generated contract drift checks | 9 schemas and 125 fixtures pass |
| repository build | root `npm run build` across implemented workspaces | pass; existing Vite chunk-size warning only |
| repository tests | root `npm test` with task-scoped Go caches | pass |
| black-box HTTP | `central-hosted-agent.test.ts` starts a random-port Central listener, uses ordinary HTTP APIs, creates an explicit Room and Hosted Agent, streams a Mention reply and proves no Bridge or plaintext-key dependency | 1/1 pass |
| deterministic E2E | complete `npm run test:e2e` | 6 pass, 1 explicit live Codex/Pi opt-in skip, 0 fail |
| provider transport | injected fake HTTPS Responses streams cover connection testing and Hosted execution through the fixed endpoint contract | pass without a paid provider credential |
| configured backup | the configuration suite backs up a live encrypted Hosted profile, finds no historical or current plaintext keys in the backup and resolves the current credential after reopening the copy; recovery coverage also restores a queued Run plus prepared invocation intent from an online backup and completes it once | pass |
| execution invariants | focused recovery tests directly assert one intent per Run, `dispatching` before HTTPS, zero Bridge Delivery, zero formal Result, deadline abort, `outcome_unknown` and no replay | pass |
| authority isolation | Server/API negatives cover cross-Team/Room, stale revision, active-work mutation, integration-mode conversion, provider-degraded isolation and denial of Result, Task, ambiguity, Member, Device and MCP authority | pass |
| Compose | default, loopback, custom and legacy profiles plus five Caddy validations | pass; topology remains Server plus Caddy |
| Central lifecycle | live, ready and combined health stay ready with Bridge `not_configured`; online SQLite backup passes integrity verification through migration 0053 | pass |
| unchanged Bridge | Go test, vet and race suites plus macOS desktop-tag test and build | pass; no Bridge source change |
| existing auxiliary gates | embedded Bridge UI and sanitized QA evidence suites | 42/42 and 32/32 pass |

The first final root-test attempt observed one existing Web onboarding element
query failure. The complete Web suite then passed 71/71 and the unchanged second
root `npm test` passed, so no product or test code was altered to hide the
observation.

The fake provider is a deterministic test double supplied to the Server's HTTPS
transport seam. These results therefore prove request, streaming, persistence,
recovery and projection behavior without contacting or claiming compatibility
with a paid or production provider account.

The Server API suites additionally cover exact Hosted handoff, bounded
Discussion, post-dispatch cancellation, queued expiry and crash recovery. A
prepared intent may run once after restart; `dispatching` or `streaming` work
converges to `outcome_unknown` without replay. Those behaviors are not inferred
from the single black-box Mention scenario.

## Remaining production-admission gates

The following evidence remains explicit and must not be inferred from the
deterministic implementation gates:

- `PENDING` — production-browser acceptance at desktop, 720 px and 390 px,
  including keyboard operation, state transitions, no overflow and zero
  credential/provider-detail leakage in the console or network-visible UI
  payloads. The in-app browser could not reach the local development origin and
  no connected Chrome session was available, so this gate was not simulated;
- `PENDING` — release-package and physical-platform admission, including Central
  OCI archives, Bridge release packages and native Windows installer evidence.

No real provider call, paid credential, production-provider admission, Release
publication or physical-machine evidence is claimed by this partial record.
Those omissions do not add a new service, deployment variable or client upgrade
requirement to the implemented optional feature.
