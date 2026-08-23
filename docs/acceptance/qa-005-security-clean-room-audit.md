# QA-005 Security and Clean-Room Audit

## Result

- Date: 2026-08-23
- Audited commit: `73c374e`
- Result: **PASS within the documented trusted Owner deployment boundary**
- Open critical findings: **0**
- Toolchain: Node.js 22.23.1, npm 10.9.8, Go 1.26.7,
  `govulncheck` 1.7.0

This result does not promote the MVP bootstrap flow to public multi-user
authentication and does not close the separate two-physical-machine QA-002
acceptance.

## Supply-Chain Checks

The first official npm audit found one moderate Ajv `$data` ReDoS advisory in
8.17.1. The repository did not enable `$data`, but the direct dependency was
upgraded to 8.20.0 in `73c374e`. The locked graph now resolves every Ajv
consumer to 8.20.0, and production plus full npm audits report zero known
vulnerabilities.

`govulncheck` reported no reachable vulnerabilities in either the Bridge or Go
Contracts module. `go vet ./...` passed in both modules.

## Clean-Room Procedure

The committed tree was exported with `git archive` into a new temporary
directory containing neither Git metadata nor existing dependencies. The
following checks passed after `npm ci` against the official registry:

- Schema validation: 7 schemas and 29 fixtures.
- TypeScript/Web/Contracts production builds.
- Workspace tests: 46 Server, 1 Web, 4 JavaScript Contracts tests, plus Go
  Contracts tests.
- E2E: three-Agent Remote MCP handoff and real Server-to-Go-Bridge Generic
  Runtime flow; the explicit credential-using Codex/Pi test remained skipped.
- Bridge `go test ./...`, `go build`, and five CGO-free audit archives for
  macOS amd64/arm64, Linux amd64/arm64, and Windows amd64.
- Markdown lint: 30 maintained files, zero issues.

Both sampled archive formats contained the Bridge binary, OS launcher,
`README.md`, `LICENSE`, `NOTICE`, and `COMMERCIAL-LICENSE.md`. All five archives
produced SHA-256 digests. No credential/private-key filename was tracked. A
content scan matched only the intentionally synthetic redaction fixtures and
found no candidate real credential.

## Security Findings and Boundaries

| Severity | Finding | Disposition |
| --- | --- | --- |
| Moderate, fixed | Ajv 8.17.1 `$data` ReDoS advisory | Upgraded and audited at 8.20.0 |
| High if misdeployed | `/api/bootstrap` is local Owner bootstrap, not public login | Supported only behind Owner-restricted HTTPS proxy; public multi-user auth remains post-MVP |
| Moderate | Portable Bridge binaries are unsigned | Documented warning; signing/notarization remains release hardening |
| Low | `/api/metrics` exposes aggregate workload signals without app auth | Contains no IDs/content/secrets; restrict at reverse proxy |

No critical issue is open inside the documented single-Owner, trusted-team MVP
boundary. Publishing Web bootstrap directly to an untrusted network would be
outside that boundary and invalidates this PASS result.

## Release Decision

Security and clean-room evidence is sufficient for the current source release
and unsigned Bridge preview artifacts. A broader production release remains
gated by QA-002 physical two-machine evidence, native multi-user Web
authentication when required, and platform signing/notarization.
