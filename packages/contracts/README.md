# Agent Room Contracts

This package is the authoritative source for cross-language wire schemas.
Generated TypeScript and Go types consume these files; handwritten wire models
are not allowed. Node.js 22 and Go 1.26.7 are required.

## Commands

```bash
npm run validate --workspace @agent-room/contracts
npm run generate --workspace @agent-room/contracts
npm run check:generated --workspace @agent-room/contracts
npm run check:types --workspace @agent-room/contracts
npm run build --workspace @agent-room/contracts
npm test --workspace @agent-room/contracts
```

`validate` checks every schema against JSON Schema 2020-12, verifies that
`catalog.json` lists the exact schema set, and runs every positive and negative
golden fixture. `generate` refreshes the checked-in TypeScript and Go message
types; `check:generated` rejects drift. `test` also validates every fixture with
the Go JSON Schema implementation. `build` copies schemas, fixtures, and current
generated types to `dist/`.

## Adding a Schema

Place the file below `schemas/`, use the `.schema.json` suffix, give it a stable
HTTPS `$id`, and add the same ID and relative path to `catalog.json`. Add valid
and invalid fixtures when the schema defines a wire contract.
