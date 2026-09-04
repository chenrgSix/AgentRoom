# SITE-005 v0.5.0-rc.5 Public Version Copy

Date: 2026-09-04

Status: active. The goal was frozen before changing public copy. Delivery state
lives only in `docs/TASKS.md`.

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
