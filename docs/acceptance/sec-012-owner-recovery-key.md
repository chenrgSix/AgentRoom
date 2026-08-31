# SEC-012: Owner Login Recovery Key Replacement

Date: 2026-08-31. Boundary: Central/Web only, under ADR-0032. No production
credential, deployment file, container, client installation or Release changed.

## Behavior and Security Evidence

Migration 0056 preserves the legacy deployment-file login until the installation
Owner explicitly replaces it. The database stores only the new SHA-256 verifier,
revision and timestamp. Hosted wrapping still uses the original deployment
root; no provider envelope is rewritten. Exact-Owner authority is distinct from
being another Team's Owner.

Six focused Server tests exercise the actual Fastify routes and temporary
SQLite files: anonymous/Bearer/foreign-Origin/other-Owner denial, malformed and
stale input, legacy login, current-session retention, other-Owner-session
revocation, unchanged ordinary member sessions, same-operation retry without
repeat revocation, competing updates, transaction rollback on revocation
failure, old-key denial, same-User recovery, restart, online backup restore,
plaintext absence and unchanged Hosted decryption/keyring bytes. The offline
operator test executes the SQL extracted from the actual deployment runbook.

Seven focused Web tests cover locally generated key format, explicit private
copying, required saved-key confirmation, header-only submission, no URL or
browser-storage persistence, clearing on success/close/disposal, same-candidate
retry, conflict preservation even after clipboard failure, safe error copy,
keyboard focus trapping/restoration and installation-Owner-only entry without
requiring any Team. The final test connects the actual App to real Fastify and
temporary SQLite: replace, preserve the Cookie, reject the old key, log out and
recover the same Owner with the new key.

## Browser Evidence

The production Web build was served by the disposable product-experience
preview. Its public synthetic Owner credential was used only on localhost.
Browser checks covered the visible entry, authorized settings read, Chinese
dark and English light copy, initial close-button focus, Escape and restored
trigger focus. Widths 1280, 720 and 390 pixels retain contained dialogs; measured
page width equals viewport width at 720 and 390. No warning/error console
entries were observed. The Browser credential-change boundary was respected:
no new credential was generated or submitted through the actual browser;
the complete mutation flow is verified by the App/Fastify test above.

- [Chinese desktop](assets/sec-012/zh-desktop.jpg)
- [Chinese mobile](assets/sec-012/zh-mobile.jpg)
- [English light desktop](assets/sec-012/en-light-desktop.jpg)

The preview process and temporary browser tab were closed after verification;
the preview removes its own disposable databases during shutdown.

## Commands

```sh
node --import tsx --test apps/server/test/owner-recovery-settings.test.ts
# From apps/web:
node --import tsx --test test/owner-recovery-settings.test.tsx
# From repository root; use an isolated writable GOCACHE when required:
npm test
npm run test:e2e
npm run build
npm run validate
npm run lint:docs
git diff --check
```

Full `npm test`: 706 pass (352 Server, 227 Web, 14 Contracts, 51 Bridge UI,
45 QA evidence, 2 product-experience and 15 website checks), plus generated
contract/type and Go validation. Focused tests: 6 Server and 7 Web pass.
Production builds, 9 schemas with 133
fixtures and Markdown/whitespace checks pass. Deterministic E2E: 6 pass, 1
explicit live-provider scenario skipped. The first full-suite attempt stopped
at the sandbox's shared Go cache permission; an isolated writable cache avoids
changing shared ownership. The initial migration regression identified one
additional hard-coded expected migration list, updated from 55 to 56 without
weakening its foreign-key preservation assertions.

No claim is made about a production deployment, real-provider invocation,
physical client acceptance or a new published version. Existing v0.4.2 does not
contain this feature. The original deployment file remains necessary for
Hosted decryption; database restores require the matching saved login key or
the explicitly documented offline operator procedure.
