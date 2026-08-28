# BRG-047 Reasoning Consent Entry

## Scope

This change makes the existing local reasoning-summary permission discoverable
after Bridge setup. It does not change the permission default, shared content,
central protocol, configuration format, endpoint scope, or authenticated save
handler defined by `BRG-031`.

## Behavior

- The Settings **Privacy** card shows the current summary-sharing state and its
  own contextual action.
- A running idle Bridge offers **Stop Bridge** with copy that says stopping does
  not change the current permission.
- Active Runs disable that stop action. A dedicated authenticated endpoint also
  rechecks pairing, self-tests, preflight, and active Runs under the lifecycle
  lock before stopping, closing the UI-to-stop race without changing the
  ordinary Overview stop behavior.
- After stop, editing stays disabled until the backend connection worker has
  exited. The polled state then changes the action to **Change consent**.
- **Change consent** opens the existing connection-settings modal and focuses
  its endpoint-scoped checkbox. There is still one authenticated mutation
  handler, and changing the server origin still clears consent.
- Unpaired, enrollment, Runtime self-test, and preflight states remain fenced
  with a specific local explanation.

## Deterministic evidence

On 2026-08-28, the implementation passed:

- focused Console consent and embedded-UI tests;
- five pure Bridge UI state projections covering running, active Run, draining,
  ready, unpaired, and concurrent-interaction boundaries;
- `go test ./...`, `go test -race ./internal/console`, and `go vet ./...` in
  `bridge/`;
- Windows/amd64 compilation of the complete Console test package;
- desktop-tag test, vet, and build gates;
- `npm test`: 154 Server, 62 Web, contract, 31 Bridge UI, and two QA evidence
  checks;
- `npm run build`, `npm run lint:docs`, and `git diff --check`.

Task-scoped Go caches were used because the execution sandbox cannot write the
shared user caches. Desktop compilation retained the existing macOS
deployment-target linker warnings and completed successfully.

## Browser acceptance

The isolated `TestPairingBrowserFixture` used temporary configuration, fake
credentials, and no central or Runtime network calls. At a 1280 by 720 viewport,
the real embedded page verified:

1. Settings shows **Stop Bridge** beside Privacy while the fake Bridge is
   running and states that consent is unchanged.
2. Clicking stop changes the local status to stopped and replaces the action
   with **Change consent**.
3. Clicking **Change consent** opens the existing connection modal with
   `connection-share-reasoning-summaries` as the active focused element.
4. The unchecked default remains visible, the modal fits without overflow, and
   no permission was saved during inspection.

This is implementation and shared-GUI browser acceptance, not publication of a
new Desktop package.
