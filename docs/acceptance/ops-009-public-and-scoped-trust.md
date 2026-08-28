# OPS-009 Public and Scoped Trust Acceptance

Date: 2026-08-28

## Outcome

`OPS-009` is complete at the deterministic deployment boundary. A new
`direct_https` installation defaults to `public_ca` and fails closed for an
ineligible public hostname. `private_scoped_ca` is an explicit alternative that
publishes one canonical public CA for exact-origin Bridge trust without
installing an operating-system root. `manual_ca` remains explicit advanced
compatibility only.

## Evidence Matrix

| Boundary | Evidence | Result |
| --- | --- | --- |
| public default | controller normalization selects packaged ACME for an eligible DNS origin and rejects IP/private names without fallback | PASS |
| private install | schema-v2 manifest retains installation ID, epoch, named Caddy authority and canonical DER digest; only the fixed well-known public artifact is exposed | PASS |
| prepare | controller writes exactly current plus next PKI definitions and issuers, reloads Caddy, validates the generated next root, and publishes one immutable bounded offer | PASS |
| acknowledgement gate | activation reads aggregate counts from the running Server database boundary and refuses 1-of-2 eligible Device acknowledgement without changing active trust | PASS |
| activation | a 2-of-2 acknowledgement set selects the exact next authority, verifies digest-bound readiness, advances descriptor/manifest, removes the live offer and recovery journal, and leaves one served issuer | PASS |
| rollback | injected next-chain readiness failure restores current-first two-authority overlap, preserves the live offer and epoch, and removes the completed rollback journal | PASS |
| legacy public migration | schema-v1 relabel requires a public DNS origin plus system-only HTTPS/WebSocket readiness before and after; an untrusted legacy chain remains unclassified | PASS |
| Caddy model | packaged public/private/manual/legacy profiles and the generated two-named-authority overlap adapt and provision under the pinned Caddy image | PASS |
| disclosure | controller output contains only redacted digest prefixes; offer/artifact contain no private key, Device secret or CA private material | PASS |

## Verification Commands

```text
cd ops/agentroomctl
go test ./...
go vet ./...
go build ./cmd/agentroomctl

cd ../..
npm run test:compose
npm run lint:docs
```

The focused controller suite also covers exact install reentry after epoch
advancement, one/two-authority file bounds, canonical single-CA parsing,
release drift, permissions and failure recovery.

## Preserved Boundary

This evidence does not claim a public ACME issuance on a production DNS name or
a two-physical-machine Bridge run. `QA-030` still requires a clean packaged
cross-host rehearsal that records `public_ca` or `private_scoped_ca` and proves
the Bridge host's OS trust store was not changed. `QA-002` remains blocked on
that physical gate.
