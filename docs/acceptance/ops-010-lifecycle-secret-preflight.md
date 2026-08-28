# OPS-010 Lifecycle Secret Preflight Acceptance

Date: 2026-08-28

## Outcome

The Central controller now validates the content and private-file boundary of
existing Owner recovery material in both `doctor` and `upgrade`. An empty,
malformed, symbolic-link, non-regular or group/world-accessible authority file
fails closed. Upgrade rejects it before the required backup, target Compose
validation, image build, container replacement or manifest mutation, and never
generates a replacement credential for an existing Owner.

## Physical Discovery and Recovery

During the physical `v0.4.0-qa030.1` to `v0.4.0-qa030.2` Central rehearsal, the
recorded mode-`0600` Owner recovery source was discovered with zero bytes while
the previously prepared read-only runtime copy still retained the original
validated 64-character value. The released controller's `doctor` checked only
file type and mode, so it had reported `PASS`; `upgrade` proceeded through its
backup and image build before `secret-init` rejected the empty source. The old
manifest remained intact, but replacement containers left the service down.

No new authority was generated. The exact retained runtime value was copied
back to the original source without displaying it, preserving the existing
Owner authority. Exact `v0.4.0-qa030.1` install reentry then restored the same
installation ID, private CA and origin. `status` reported the old ready
revision, and `doctor` passed HTTPS plus WebSocket readiness.

The raw file's origin is authoritative; the prepared container file is not a
general recovery or rotation interface. This bounded physical repair is not a
claim that `v0.4.0-qa030.2` passed the upgrade gate.

## Regression Evidence

- A zero-byte Owner recovery file returns `UPGRADE_SECRET_INVALID` without a
  backup script, target Compose validation/start, manifest change or secret
  regeneration.
- A malformed Owner recovery file returns `SECRET_INVALID` from `doctor`
  before network readiness.
- Existing valid 64-hex Owner and optional legacy credentials retain their
  install-reentry behavior and never enter generated configuration or output.
- Full controller tests and race tests pass, followed by Go vet and controller
  build.

## Verification Commands

```text
cd ops/agentroomctl
GOCACHE=/private/tmp/agentroom-ops010-gocache go test ./...
GOCACHE=/private/tmp/agentroom-ops010-gocache go test -race ./internal/controller
GOCACHE=/private/tmp/agentroom-ops010-gocache go vet ./...
GOCACHE=/private/tmp/agentroom-ops010-gocache go build ./cmd/agentroomctl

cd ../..
npm run lint:docs
```

## Preserved Boundary

This change does not rotate, recover, print or replace an Owner credential. It
does not implement automatic service rollback after an arbitrary target start
or forward migration failure. `QA-030`, `QA-002` and `QA-028` remain open until
a follow-up exact packaged candidate completes the same physical Device
upgrade and the schema-v3 evidence gate.
