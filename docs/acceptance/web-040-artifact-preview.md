# WEB-040 Artifact Snapshot Preview Acceptance

Date: 2026-08-25

## Scope

This acceptance covers the Member-authorized browser preview of canonical
`snapshot_blob` Task Artifacts. It does not admit arbitrary files, HTML
execution, Workspace writes, or production deployment.

## Automated Evidence

- `artifact-preview-service.test.ts` proves strict UTF-8 decoding and the
  200,000-character response bound.
- `artifact-routes.test.ts` publishes, seals, and binds a real Patch snapshot,
  then proves the Member preview rechecks metadata and bytes, returns
  `no-store` plus `nosniff`, excludes storage/Workspace paths, rejects a
  reference-only Artifact, and denies a different Team.
- `artifact-preview.test.tsx` renders Patch, Markdown, and JSON fixtures as
  escaped plain text. Deliberate script and image markup creates no executable
  DOM nodes, and an extra absolute-path field is never presented.
- The full Web suite preserves onboarding, Task clarification, Discussion,
  Memory review, trusted authentication, message, and responsive behavior.

## Real-Browser Evidence

An isolated local Server and Web client were started against a temporary Team.
The seed used the real Workspace lease, publication, chunk, seal, and canonical
bind services to create Patch, Markdown, and JSON snapshots under one Task.

In the Codex in-app browser:

- all three cards loaded through the real Member preview endpoint;
- each preview exposed the exact expected media type and text;
- deliberate `<script>` and `<img onerror>` strings remained visible text while
  both executable script and image DOM-node counts stayed zero;
- the semantic-trust warning remained visible for every preview;
- no `/Users/` absolute path appeared in rendered page text;
- at a 390 by 844 viewport, document and body scroll width both remained 390,
  and the preview stayed inside its 334-pixel client width;
- closing the preview removed its region; and
- the browser reported zero warning or error console entries.

This is local real-browser acceptance, not evidence of production admission or
cross-origin deployment configuration.
