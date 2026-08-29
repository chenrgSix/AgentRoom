# CON-017 Runtime schema enforcement acceptance

- Date: 2026-08-29
- Scope: deterministic cross-language implementation evidence
- Result: PASS

## Authority boundary

A bounded transport/resource preflight runs before JSON materialization. After
that admission gate, the maintained JSON Schema, not a second hand-written
business subset, is authoritative for every Bridge WebSocket frame in Central
and every Central WebSocket frame in Bridge. Business authorization and Run
state checks still follow schema validation and remain authoritative.

## Implementation evidence

- the protocol 1.0 envelope requires `protocolVersion`, `messageId`,
  `timestamp`, `type` and `payload`, and rejects unknown top-level fields;
- `run.reply.content` is bounded to 20,000 Unicode code points in schema and
  Server, including astral characters without UTF-16 drift;
- error code, message and top-level field bounds agree across schema and
  Server, while `details` is the deliberate allowlisted-service extension;
- timestamps use the canonical intersection accepted by generated Go types:
  uppercase `T`/`Z`, non-leap seconds and at most nanosecond precision;
- `agent.publish` uses the implemented 80-code-point name/role domain bound in
  schema, TypeScript, Go and SQLite, and the declared `agent.status` frame is
  identity/epoch checked and applied instead of disconnecting a valid client;
- generation emits a checked-in Ajv standalone validator for TypeScript and a
  dereferenced embedded schema compiled once at Go process startup;
- generated raw decoders retain number lexemes before JavaScript coercion,
  normalize schema-declared integers and numbers consistently, and decode every
  accepted Go root into its exact generated message type;
- every declared wire integer has explicit interoperable bounds within
  `[-9007199254740991, 9007199254740991]`; mathematical integer spellings such
  as `1e0` and `1.0` normalize, while unsafe, fractional and underflow values
  fail closed before business code;
- the cross-language preflight admits at most depth 64, 8,192 JSON value nodes,
  4,096 number tokens, 256 ASCII characters per number token and exponent
  magnitude 512. These are Runtime resource limits, so an otherwise
  schema-valid open extension outside them is rejected;
- WebSocket protocol frames are text-only and must be strict UTF-8; the raw
  lexical preflight also rejects lone, reversed or mismatched Unicode surrogate
  escapes before either language materializes a JSON string;
- per-message canonical property metadata rejects ASCII and Unicode
  case-folding aliases before Go's case-insensitive decoder can bind them;
- generated-output checks fail when either validator or generated wire types
  drift from the catalogued schemas;
- both Runtime boundaries run resource admission and schema validation before
  their first type-specific business parse and return only a stable rejection,
  never source payload or validator diagnostics.

## Compatibility and negative regressions

Shared raw fixtures run through generated TypeScript and Go Runtime decoders.
They cover exact integer spellings, high-precision fractions hidden by ordinary
`JSON.parse`, safe-integer endpoints, declared-number underflow, minimum
subnormal rounding, `-0`, deep cursors/revisions, Error details, Unicode
case-fold aliases, escaped surrogate pairs and the resource limits above. The
same corpus rejects lone/mismatched surrogate escapes and proves finite
compatible extension numbers remain ordinary numbers while unsafe or
non-finite extension numbers remain opaque and re-serialize without numeric
drift. It also proves future bounded Error categories remain schema-valid while
Central's business allowlist may map them to `unknown`. Every valid root in the
existing fixture suite is decoded into its exact generated Go message type.
Server WebSocket and Go connection tests prove invalid data does not reach Run
persistence or business unmarshalling.

## Verification boundary

Contracts validation, deterministic generation, TypeScript/Go tests, Server
build/WebSocket tests, Bridge tests and vet are included in the `QA-036` local
gate record. A future protocol version still requires a separately accepted
compatibility decision; this task does not make arbitrary envelope fields
forward-compatible.
