# Agent Room Contracts

This package is the authoritative source for cross-language wire schemas.
Generated TypeScript and Go types will consume these files in later contract
milestones; handwritten wire models are not allowed.

## Commands

```bash
npm run validate --workspace @agent-room/contracts
npm run build --workspace @agent-room/contracts
npm test --workspace @agent-room/contracts
```

`validate` checks every schema against JSON Schema 2020-12, verifies that
`catalog.json` lists the exact schema set, and runs every positive and negative
golden fixture. `build` copies the validated catalog, schemas, and fixtures to
`dist/`.

## Adding a Schema

Place the file below `schemas/`, use the `.schema.json` suffix, give it a stable
HTTPS `$id`, and add the same ID and relative path to `catalog.json`. Add valid
and invalid fixtures when the schema defines a wire contract.
