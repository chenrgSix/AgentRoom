# SITE-001 Product Website Acceptance

## Scope and Product Gate

The product experience gate was completed in commit
`dd77675e4b9a71bdc2546ee3e94b43eaae43f8ab` before any `site/` implementation.
[QA-040](qa-040-product-experience.md) records the application build, 540 passing
tests, six deterministic E2Es, Go/Compose checks and production-browser primary
flows. Website work does not replace that evidence or publish an application
Release.

The independently built static website contains a product introduction,
capability comparison, getting-started guide and useful 404 page. Its fixed
public base is <https://chenrgsix.github.io/ConveneWire/>.

## Local Static Verification

`npm run test:site` passes 15 tests covering:

- exact public-file isolation, byte-reproducible output and Git revision stamps;
- unique headings/landmarks/IDs, keyboard entry and meaningful control labels;
- internal routes, anchors, assets and existing repository documentation links;
- distinct canonical/share metadata for the home page and guide;
- stable v0.4.1 versus current-source capabilities, HTTP-only Hosted authority,
  Owner pairing approval, recovery scope and non-OSI license boundaries;
- absence of application forms, analytics, provider calls, credentials,
  external runtime resources and browser application storage;
- responsive/reduced-motion/focus style contracts and HTML-first navigation;
- explicit clipboard activation, pending/success/failure feedback, missing
  targets and usable no-Clipboard fallback;
- real loopback HTTP serving of exact artifact bytes, base-path routing,
  HEAD/404 handling, malformed/traversal path refusal and rejection of writes;
- test-before-build deployment wiring, commit-pinned actions, static-only
  artifact upload and deploy-job-only Pages/OIDC permissions.

The suite uses Node.js built-ins, temporary-directory isolation and guaranteed
cleanup. It does not require application packages, a model account or network
access beyond its ephemeral loopback HTTP test.

The website was also built with `npm run build:site`, with documentation and
whitespace checks. Local preview and final hosting are separate steps; a local
build alone is not publication evidence.

## Content and Privacy Review

Primary links lead to the canonical repository, stable v0.4.1 Release, Central
controller guide, Bridge guide, module documentation, QA-040, issues and license.
The guide does not imply that v0.4.1 contains Hosted Agents or later product
improvements. Source-only local startup is explicitly not internet deployment.

API Keys are encrypted in the existing database, not all profile metadata.
Central Hosted calls the fixed OpenAI Responses endpoint; it has no computer
tools or formal Result/review authority. Local Bridge remains optional and
bounded by its Runtime configuration. Remote calls can send allowed context
outside the self-hosted Central and can incur provider usage.

There are no application credentials, preview fixtures, customer data, forms,
tracking scripts, external font loads or model calls in the artifact. The
illustrated work surface is explicitly labeled as an interface example, not
proof of actual customers or runtime outcomes.

One optional branded social-card generation attempt failed at the provider
connection. There was no existing valid card. Image metadata was omitted rather
than publishing a broken or generic fallback; home and guide retain their own
title/description/canonical metadata.

## Verification Limits

Static structure and style contracts are not a claim of complete WCAG
conformance or physical-device visual certification. No separate website browser
interaction/screenshot audit was performed. The application's real-browser
evidence belongs to QA-040 and must not be represented as website visual QA.
Live model-provider, native desktop and two-physical-machine acceptance remain
outside this iteration. Website hosting does not ship new application packages.
