# QA-016 Recoverable Runtime Output Streaming Acceptance

## Result

- Date: 2026-08-24
- Result: **PASS**
- Scope: `CON-005`, `BRG-023`, `RUN-007`, and `WEB-029`

The central service now exposes safe, resumable Runtime output while a Run is
active. The final Runtime reply remains the only durable Agent Message in the
Room timeline. Pi uses this capability; Codex and owner-authored Generic
Runtimes retain final-only behavior until their adapters declare streaming
support.

## End-to-End Evidence

`npm run test:e2e` starts an isolated central service, compiles and pairs a real
Go Bridge, and runs a deterministic Pi protocol process. The test observes a
persisted `output` event before any `reply`, verifies that no provisional text
is appended to Room Messages, resumes the Run event stream from the output
sequence, and then observes exactly one final Agent Message. The same Bridge
process also proves Generic Runtime final-only completion and active Run
cancellation. The deterministic suite passed two tests with the credentialed
Codex/Pi live test explicitly skipped.

## Contract and Bridge Evidence

- `npm run validate` validated 7 schemas and 32 fixtures. Generated TypeScript
  and Go contracts are current, and all 4 contract tests passed.
- `go test ./...` passed every ordinary Bridge package.
- `go test -race ./internal/runtime ./internal/delivery
  ./internal/connection` passed the streaming, durable replay, delivery, and
  cancellation paths under the race detector.
- `go vet ./...` passed. The desktop-tagged Bridge test also passed; the linker
  emitted only the existing macOS deployment-target warnings.
- Pi adapter regressions prove output is emitted before the final reply,
  batching retains a safety tail, tool-use boundaries cause a reset, split
  credentials and assessment envelopes remain private, and provider tool
  protocol fragments fail closed.
- Runtime executor regressions prove redacted output is persisted before send,
  survives duplicate replay, and retains the authoritative final reply and
  terminal status sequence.

## Central Service and Web Evidence

- All 96 Server tests passed. They cover authenticated Device ownership,
  contiguous sequence enforcement, duplicate suppression, bounded and redacted
  output persistence, reset events, cursor reads, restart recovery, terminal
  and cancellation fencing, and one final Room Message projection.
- All 14 Web tests passed. Reducer tests cover ordered resume, missing sequence
  gaps, reset boundaries, terminal clearing, and final-reply sealing. The
  component test observes the provisional bubble and confirms that it is
  replaced by one durable final message.
- `npm run build` passed the Server, Web, and generated-contract builds.

## Recovery and Security Boundaries

The Bridge persists each safe delta before transport and replays it with its
original Run sequence after reconnect. The Server persists output in
`run_events`, exposes only authorized cursor reads, rejects foreign Device and
Agent identities, ignores duplicates and output arriving after any terminal
state, and never projects an output delta into `messages`. Both Bridge and
Server apply credential redaction before durable storage.

## Remaining Physical Gate

This acceptance uses a deterministic Pi protocol subprocess and a real compiled
Bridge, not a credentialed external Pi session. `npm run test:e2e:live` remains
an explicit operator-controlled physical gate. No production release or
credentialed Runtime claim is implied by this local acceptance.
