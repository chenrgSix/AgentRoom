# QA-040: Product experience acceptance

## Scope and source

- Date: 2026-08-31
- Product: ConveneWire; ADR-0027, WEB-051/052/053 and SEC-011
- Accepted source: the product implementation committed with this evidence,
  following `9276ed8`, `a2af488` and `8047c81`. Subsequent website-only changes
  do not widen this product acceptance.
- Environment: macOS arm64, Node 22.23.1, Go 1.26.7; production Vite output
  served by the real Fastify application, with isolated temporary SQLite data.
- No user database, real API key, paid provider or external Agent was used.

## Automated evidence

| Check | Result |
| --- | --- |
| `npm run validate` | 9 schemas and 125 fixtures passed |
| `npm run build` | Server, Web, generated contracts and type checks passed |
| `npm test` | 540 passed: Server 328, Web 122, contracts 14, Bridge UI 42, QA policy/evidence 32, product fixture 2 |
| Final Web regression after layout correction | 122 passed; Web build/type check passed |
| `npm run test:e2e` | 6 deterministic cross-process tests passed; 1 opt-in live Codex/Pi test intentionally skipped |
| `npm run test:compose` | Default/custom ports and Caddy profiles validated |
| Bridge `go test ./...` and `go vet ./...` | 22 tested packages passed; no Bridge source change |
| Central controller tests, vet and build | 2 tested packages passed; temporary binary built; no controller change |
| `npm run lint:docs`, `git diff --check` | Passed |

The Vite bundle-size advisory remains: the main bundle is approximately
586 kB minified / 179 kB gzip. It is not a build or runtime failure; this
iteration does not claim a performance budget, large-Team scalability or
complete bundle splitting.

### Regression cuts

- Existing-member recovery: hash-only storage, one-use/expiry/revocation,
  exact capability revocation, preserved User/Member/Room/Task/Device identity,
  current issuer authority, single-Team ordinary-member restriction, Owner and
  cross-Team negatives, Origin and replay rejection, old session replacement.
- Long polling reauthenticates after waiting; revoked sessions and archived
  Teams cannot receive a stale successful change response.
- Protected HTTP success, error and parsing results are fenced by session
  generation. Old Team responses and issued MCP credentials cannot reappear
  after another member signs in; old cleanup cannot unlock a new pending action.
- Run recovery preserves the exact operation ID, revision and acknowledgement
  reason across same-tab reload/detail re-entry after response loss. Corrupted,
  unreadable or non-persisting session storage blocks submission. Switched-Run
  evidence is synchronously isolated, and loading/failed evidence disables
  recovery commands.
- Work paging deduplicates entries, fences Team/filter changes, retains already
  loaded pages during refresh, and waits for in-flight load-more requests.
- Six 100-message history pages remain reachable; live message 601 preserves
  all loaded entries. Historical pages never advance the live checkpoint.
- Criteria templates append without overwriting, enforce canonical limits and
  never grant completion authority. Task dialog Tab/Escape/focus restoration is
  covered by regression tests.

## Production-browser evidence

`CONVENE_WIRE_PRODUCT_PREVIEW=1 npm run preview:product-experience` starts two
loopback-only QA servers. The trusted fixture uses the test constructor's
localhost Origin and Chromium's localhost Secure-cookie behavior; production
configuration still requires HTTPS. This is not public TLS admission evidence.

The fixture seeds 125 history messages, 105 paging Tasks, an unknown-outcome
attempt and a real uploaded, sealed and bound Markdown Artifact plus a proposed
Result. Model HTTP responses are simulated entirely in process; no request is
forwarded to a provider. All test identities and credentials are synthetic.

Observed in the in-app Chromium browser against the production build:

1. Empty installation proceeds through Team, Room and distinct Central/local/
   demonstration choices. Central creation explains its no-computer boundary;
   Room grants default unchecked. Invalid credentials show safe guidance and
   clear the key. A validated configuration links to its authorized Room.
2. A structured Mention creates a Run and a durable streamed/final simulated
   provider reply without a Bridge. A separate demonstration Agent replies
   without a model. The local path lands at the existing Device pairing flow.
3. Owner recovery opens member administration; an issued member code can be
   revoked and replaced. Copying the replacement, signing out and claiming it
   returns to the same ordinary member. The roster still contains two members;
   Owner configuration and recovery controls are absent for that member.
4. Work loads 100 then all 108 seeded items; owner filtering updates the list.
   Room history loads older entries back to message 001 without losing newer
   messages. The scroll anchor remains stable after prepending history.
5. A Task accepts handwritten criteria plus the three-item research template.
   At 390 px, the expanded dialog is scrollable and its create button remains
   usable. Escape closes it and restores focus to the original New Task button.
6. Result evidence opens directly in the Task detail. The real SHA-256-verified
   Markdown snapshot displays a literal script sample as text, with no script
   element in the preview. A reasoned acceptance with the separate completion
   option produces an accepted Result and completed Task.
7. An unknown-outcome Run initially disables new execution. Recording the
   inspected outcome leaves one attempt; a separate explicit authorization
   creates exactly one second attempt with retry lineage. The original remains
   unknown and the manual fixture's second attempt remains queued, not falsely
   completed.
8. Chinese/English and dark/light views work. Tested widths are desktop
   1280 px, 720 px and 390 px, with no horizontal document overflow. Desktop
   header actions wrap as complete controls rather than splitting their labels.
   Final local/trusted browser error and warning logs are empty.

## Limits and cleanup

- Run receipts cover same-tab navigation/reload, not closed tabs, cleared
  browser data or cross-browser recovery. They are not authorization tokens.
- Recovery intentionally excludes multi-Team users and all Owner identities;
  this is not SSO or a general identity-administration system.
- This does not certify a paid production model, native Windows/macOS GUI,
  installer upgrade, physical two-machine operation or a new release package.
  Existing release/QA-038 gates remain separate.
- Bridge binaries, Runtime permissions, deployment topology and existing
  installation commands are unchanged. No additional Agent service is needed.
- The preview harness removes only its own temporary databases/artifact blobs
  on normal shutdown. The task-specific Go cache/binary was removed after
  verification; it is reproducible. No user data was removed.

The product gate precedes SITE-001 implementation. Website build and public
GitHub Pages verification are recorded separately.

## Post-push CI confirmation

The [implementation CI run](https://github.com/chenrgSix/ConveneWire/actions/runs/33325890848)
for `654a2e1de1a42044314e896c1904f9a6a2461c22` completed successfully after the
website-only addition. Repository (contracts/build/tests/E2E/docs/Compose), Go,
Desktop Windows and Desktop macOS jobs all passed. The root test command now
also includes the website's 15 tests; the 540-test product gate above remains
the pre-website evidence. Native CI builds and package smoke checks do not
replace physical interactive acceptance or change application Release assets.
