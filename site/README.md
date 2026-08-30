# ConveneWire Product Website

The public website lives at <https://chenrgsix.github.io/ConveneWire/>. It is a
static introduction and getting-started guide, not another Central deployment.
Its delivery state is recorded only as `SITE-001` in `docs/TASKS.md`.

## Local Work

Node.js 22 is sufficient; the site introduces no package dependencies.

```sh
npm run test:site
npm run build:site
npm run preview:site
git diff --check -- site
```

The preview prints an ephemeral loopback URL with the same `/ConveneWire/`
base as GitHub Pages. Stop it with Ctrl+C. It serves only `site/dist/` and does
not load application data, environments, cookies or credentials.

Edit `src/index.html`, `src/guide/index.html` and the shared header/footer;
public CSS, the brand mark and the guide's optional copy enhancement live in
`public/`. Follow `.editorconfig`. Generated `dist/` is ignored by Git.

## Publishing

`.github/workflows/pages.yml` tests, builds and publishes changes to `site/`
on `main`. GitHub Pages must use the GitHub Actions build type. A manual workflow
dispatch can republish an unchanged source commit. Pull requests test and build
without deploying. Application Release packages and tags are never changed.

Only `site/dist/` is uploaded. `version.json` and page metadata identify the
exact source revision; the same commit and build inputs produce identical
artifact bytes. The site is HTML-first, with no framework, analytics, external
fonts, application API calls, forms or model credentials. Without Clipboard
support or JavaScript, command examples remain selectable and readable.

The main page and guide distinguish current-source features from the pinned
stable download. Recheck that distinction against the actual Release before
updating version labels. Source availability is not an OSI license claim.

See [the module boundary](../docs/modules/product-website.md) and
[website acceptance](../docs/acceptance/site-001-product-website.md) for the
publication evidence and testing limits.
