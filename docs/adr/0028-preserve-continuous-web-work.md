# ADR-0028: Preserve continuous Web work

- Status: Accepted
- Date: 2026-08-31
- Supersedes: none
- Amends: ADR-0022 and ADR-0027

## Context

The next product iteration makes Work actionable, preserves the user's place
and unsent work, and consolidates lifecycle guards that currently span session
activation and several Room refresh paths.

## Decision

### Work entry and authorized search

Allow Task creation from Work using the selected authorized Room and canonical
Task creation API. Next-action shortcuts only navigate to the relevant
Task/Run/Result/Room surface; they never execute commands or grant permission.
Current Task/Team ownership still governs review and recovery controls.

Add optional bounded `search` to Workbench queries: trimmed text of at most
100 characters matches Task titles case-insensitively; numeric or `TASK-n`
queries also match the exact Team display number. Search is a Server-side
filter over the caller's authorized Room/Task projection and participates in
the pagination fingerprint. It does not search hidden Rooms, messages,
credentials or provider data. Preserve existing requests without search.

### Navigation and unsent work

Represent selected Team, Room, Task, Work detail tab and Work filters in a
bounded allowlisted URL. Refresh, direct links and browser back/forward restore
that intent only after Server-authorized Team/Room/Task resolution. Invalid or
inaccessible targets fail closed with useful feedback and a safe fallback.
URLs contain no credentials, draft content or command receipts.

Keep drafts and failed ordinary-message submissions in this tab's session
storage, scoped to User, Team, Room and Task, with bounded content/count, a
24-hour TTL and explicit clearing on logout/session invalidation. This is not
cross-device or closed-tab recovery. Unavailable storage keeps draft editing
usable with a visible not-saved warning; it never claims durable persistence.
Persist only validated data, no auth tokens or provider keys. Revalidate current
Room access and allowed Mention identities before explicit retry. A recovered
pending message is uncertain/failed, retains its exact client message ID and
payload, and is never sent automatically. Multi-Agent Discussion commands are
not silently replayed as ordinary messages.

### Shared lifecycle ownership

Move synchronous session authority and Web-session generation handling into
one controller. Consolidate Room snapshot/delta/history commit rules and change
listening into a Room controller with an explicit context lifetime. App remains
the shell and coordinator; Server remains the sole domain authority. Protected
continuations, including derived refreshes, check the originating session and
context before subsequent requests or UI updates. History initialization is
independent from an exhausted null cursor; late snapshots merge and never
rewind a newer live checkpoint.

## Compatibility and limits

No new service, database migration, provider, search daemon, Bridge protocol or
client upgrade is required. Existing API consumers omit the additive search
field. Runtime permissions, Result authority and uncertain-outcome commands are
unchanged. Performance virtualization, an operations dashboard, push services,
website changes and application Release publication are outside this iteration.

## Verification

Use contract TypeScript/Go fixtures, Server authorization/cursor/search tests,
Web action/draft/navigation/context-race regressions, full tests, build, schemas,
deterministic E2E and docs checks. Exercise production-browser Work creation,
next-action navigation, search, draft switching/reload and direct links/history
at desktop and narrow widths using isolated synthetic data. No paid provider or
user database is used. Keep delivery state only in TASKS.
