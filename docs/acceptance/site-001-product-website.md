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
Live model-provider, interactive native desktop and two-physical-machine
acceptance remain outside this iteration. Website hosting does not ship new
application packages.

## Public Deployment Evidence

- Date: 2026-08-31, Asia/Shanghai.
- Website source: `654a2e1de1a42044314e896c1904f9a6a2461c22`.
- [GitHub Pages workflow](https://github.com/chenrgSix/ConveneWire/actions/runs/33325890898)
  completed successfully: static test/build and dependent Pages deployment.
- [Repository CI for the same commit](https://github.com/chenrgSix/ConveneWire/actions/runs/33325890848)
  completed successfully: Repository, Go, Desktop Windows and Desktop macOS.
  This includes native CI build/package smoke checks, not interactive physical
  desktop acceptance or a new Release.
- Pages uses the `workflow` build type with HTTPS enforcement. The repository's
  previously empty homepage now points to the deployed product website.
- Unauthenticated public GET verification completed at
  `2026-08-30T17:41:20.745Z` (2026-08-31 01:41:20 Asia/Shanghai).

Both the [home page](https://chenrgsix.github.io/ConveneWire/) and
[guide](https://chenrgsix.github.io/ConveneWire/guide/) return HTTP 200 and identify
the exact website source above. Each of the following public files returned
HTTP 200 and matched the corresponding exact-commit local build byte for byte:

| Public file | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 13829 | `802e3c01959993e441fd0264fcfb86b0785446ecdd3c54f02da056b75e5e3605` |
| `guide/index.html` | 13218 | `b2cb428aab7f3a72b7d54493e8c2184bed08ed4fb2430a4e620732214538f8c2` |
| `404.html` | 2343 | `99745bb3b3b8ab83a693db42ffc05bd13e1fe16f43c30761bfd910a0f56e2561` |
| `assets/site.css` | 18161 | `754b8c7f5ca6e10d461f35357b08d0c130e2c4a1af6f89e4045872ec78b38ab4` |
| `assets/guide.js` | 911 | `5dc84907aa45803cf2b34865086fbfee00794a3b750986ef31d94c05402adf24` |
| `assets/mark.svg` | 339 | `137f3b79ae54eee6a188e37809c39df24a088b608124c4d863b23c66b06d0357` |
| `version.json` | 126 | `459a18ec0565bec669286d4178e792e1d5ba8a85455d22c65d0b00fbe51e8d44` |
| `robots.txt` | 84 | `1bf4151d1b8bd01e3cbd2c9642c79293f1c380d69421e556990b6e2039eca8d8` |
| `sitemap.xml` | 239 | `71fdc01a04b39f2b803c6984ffbfa06b080f0c48639b34db10081e9a2105d50b` |

Missing-page, `.env` and `api/teams` probes return HTTP 404 with the custom
return-home page, not an application endpoint. The nine distinct GitHub links
in the site were independently fetched without authentication and all returned
HTTP 200. The source-clone URL redirects to the same canonical repository.

The stable application Release was rechecked after deployment and remains
`v0.4.1`, published `2026-08-30T07:09:11Z`; its assets were not changed.
