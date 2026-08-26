# BRG-035 Codex Task Session Guide Acceptance

## Scope

`BRG-035` replaces the dense Codex ownership warning with a concise summary
and an embedded Bridge guide. The guide is available from the Console header,
first enrollment, and the per-Agent Codex editor. It explains:

- the difference between an AgentRoom Task, Run, and native Codex session;
- the Task Session reuse and recreation boundaries;
- recovery for `CODEX_SESSION_IN_USE` and
  `CODEX_SESSION_RESUME_FAILED`; and
- that the current Bridge does not share an App Server daemon with Codex
  Desktop or CLI.

## Automated evidence

- `session-guide.test.mjs` covers native modal open/close, Escape handling,
  focus restoration, and the non-native dialog fallback.
- `TestEmbeddedUIExposesOperationsWithoutAutomaticUpdateChecks` proves all
  three guide entry points, both safe Runtime codes, the no-shared-daemon
  statement, and the existing selection-scoped Runtime descriptions are
  embedded together.

## Local browser acceptance

The fake-credential `TestPairingBrowserFixture` served the actual embedded
Console without central network calls or saved configuration changes.

At `1280x720`, the guide opened as a native modal, moved focus to the close
button, kept its header and confirmation action visible while the content
scrolled, and had no horizontal overflow (`page clientWidth = scrollWidth =
1280`; `dialog clientWidth = scrollWidth = 758`).

At `390x844`, the title and close button remained on one row, the three term
cards collapsed to one column, and the page and dialog remained free of
horizontal overflow (`390 = 390` and `350 = 350`). Opening the guide from an
in-progress Codex Agent editor preserved the draft and restored focus to that
exact inline entry point. Escape closed the guide and restored focus to the
header entry point.

This is isolated local UI acceptance. It does not claim that Codex Desktop
currently supports connecting to an externally managed App Server daemon.
