# Product Website

## Scope

- Prefix: `SITE`
- Location: `site/`
- Owns: public product explanation, capability comparison and canonical links

The website is static and published to GitHub Pages for the existing ConveneWire
repository. It does not run Central, authenticate members, call model providers,
collect form submissions, load analytics or expose local acceptance data.

## Experience

Explain the product, show a representative Team/Room/Agent work surface, clarify
Central HTTP-only versus optional local Bridge capabilities, and provide a clear
installation/documentation path. Support narrow screens, keyboard navigation,
reduced motion and meaningful metadata. Reference sites inform visual rhythm,
not copied source, assets or claims.

## Compatibility and Release Claims

Use the canonical repository and installation documentation. Distinguish current
source capabilities from stable downloadable package contents. Do not invent
customer counts, benchmarks, enterprise assurances, supported providers, free
model usage or release acceptance. Never include application credentials or a
runtime deployment dependency.

## Build and Publishing

The site has an independent deterministic static build and focused tests. Its
GitHub Pages workflow publishes the tested static artifact with minimal Pages
permissions. It must not modify application Release assets or require a second
application service. Exact commands are registered with the implementation.

- `npm run test:site` runs dependency-free Node.js static/content/link,
  clipboard-control and loopback preview regression tests. The root `npm test`
  also includes this suite.
- `npm run build:site` expands the allowlisted HTML routes and shared fragments,
  copies only public static assets into `site/dist/`, and writes the exact Git
  revision to page metadata and `version.json`.
- `npm run preview:site` builds and serves that artifact on a printed
  loopback-only URL under `/ConveneWire/`; it is not an application server.
- `git diff --check -- site` checks whitespace; source formatting follows
  `.editorconfig` without a new formatter dependency.

The Pages workflow runs tests before building, uses commit-pinned actions,
uploads only `site/dist/`, and grants `pages:write`/`id-token:write` only to the
dependent deploy job. Pull requests validate without deploying. No model,
application, or personal credentials are provided to the site build.

The root and guide have distinct canonical/social metadata. When no valid
social image exists, omit image metadata rather than reference a missing or
generic asset. Installation links and stable-version claims must be rechecked
when application packages change.

Stable-version copy follows the actual verified application Release. Moving a
download link to `v0.4.2` does not promise later main-branch changes or remove
the HTTP-only Agent, provider-credential, backup and physical-acceptance limits.

## Verification

Product acceptance precedes website implementation. Static build/content/link
and accessibility structure checks precede publication; exact-commit workflow
success and independent public HTTP/asset checks prove the published artifact.
Delivery state lives only in `docs/TASKS.md`.
