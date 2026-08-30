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

## Verification

Product acceptance precedes website implementation. Static build/content/link
and accessibility structure checks precede publication; exact-commit workflow
success and independent public HTTP/asset checks prove the published artifact.
Delivery state lives only in `docs/TASKS.md`.
