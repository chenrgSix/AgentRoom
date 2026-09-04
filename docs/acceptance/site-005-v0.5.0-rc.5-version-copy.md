# SITE-005 v0.5.0-rc.5 Public Version Copy

Date: 2026-09-04

Status: accepted. The goal was frozen before changing public copy. Delivery
state lives only in `docs/TASKS.md`.

## Goal

After `v0.5.0-rc.5` is publicly verified, identify it as the current
prerelease in README, product home and getting-started guide while preserving
`v0.4.2` as stable Latest.

The copy must explain in ordinary language that trusted-LAN browser use can run
without HTTPS or CA setup, while direct private HTTPS remains an optional
advanced deployment mode. It must not imply that Bridge or machine-authority
traffic becomes HTTP.

## Scope And Acceptance

- update current-prerelease links and explanatory copy in `README.md` and
  `site/src/` only after the Release is public;
- update static release-boundary tests to require rc.5 and reject stale rc.4
  links;
- preserve stable Latest, Client-owned Git, licensing, backup, unsigned-package
  and physical-platform boundaries;
- pass site tests/build, docs lint and whitespace checks; and
- verify the Pages run used the exact source commit and every deployed public
  file matches its exact local build bytes.

No application binary, Release asset, tag, Central deployment, credential,
trust store or repository is changed by this task.

## Acceptance Evidence

README, home and guide identify the already public `v0.5.0-rc.5` prerelease,
retain `v0.4.2` as stable Latest and give ordinary users three truthful choices:
trusted-LAN browser HTTP without CA installation, advanced private HTTPS with
explicit trust under Bridge **Settings**, or public HTTPS with normal system
trust. The copy keeps Bridge, Device and execution traffic on their independent
pinned HTTPS channel and retains the Client-owned repository/Git boundary.

All 15 static tests passed before commit, the exact-commit site build recorded
source `dcf189b9958f29dee24c64708c29eff04cf9772f`, the 376-file documentation
gate reported zero findings and whitespace checks passed. Product Website run
[33858104201](https://github.com/chenrgSix/ConveneWire/actions/runs/33858104201)
built and deployed that exact source successfully.

Independent credential-free HTTPS downloads of home, guide, custom 404, guide
JavaScript, product mark, CSS, robots, sitemap and version metadata matched all
nine local build files byte for byte. Public `version.json` named the same full
source revision. The task-owned comparison root was physically removed; the
four historical-prefix snapshots in `/private/tmp` and the inspected macOS
user temporary directory were identical before and after, both with digest
`bed355887a38ea05bae4e42adf5ffc3a727a419065e1ed31cec0f517f66f47d0`.

Post-copy CI run
[33858104095](https://github.com/chenrgSix/ConveneWire/actions/runs/33858104095)
passed Repository, Go, native macOS Desktop and native Windows Desktop for the
same exact source on its first attempt.
