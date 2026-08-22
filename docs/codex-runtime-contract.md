# Codex Runtime Contract

## Supported Invocation

The managed Bridge invokes the owner-configured argument array for
`codex exec --json -` in a fixed workspace. Agent Room never adds approval
bypass flags or weakens the owner's Codex sandbox. Only explicitly allowlisted
environment variables reach the process.

The initial compatibility baseline is `codex-cli 0.149.0-alpha.4`. This is a
tested adapter schema, not a claim that the CLI is permanently stable.

## JSONL Lifecycle

The adapter consumes newline-delimited events and recognizes this minimum
additive contract:

1. `thread.started` supplies `thread_id`.
2. `turn.started` begins work.
3. `item.completed` with `item.type = agent_message` supplies the latest reply.
4. `turn.completed` confirms a known successful outcome.
5. `turn.failed` or `error` produces a safe failed Run.

Unknown event types are ignored for forward compatibility. Malformed JSON,
missing required identifiers, non-zero exit, oversized output, or a zero exit
without `turn.completed` fails the Run without publishing raw stderr.

## Lifecycle Limits

Context cancellation interrupts the child process. Session resume, interactive
approval forwarding, structured artifacts, and handoff are not advertised in
this baseline. If this contract fails against a later Codex version, configure
the Generic CLI adapter while updating the pinned parser fixtures.

Example Bridge Agent configuration:

```json
{
  "name": "Builder",
  "role": "Codex implementer",
  "adapter": "codex",
  "command": ["codex", "exec", "--json", "--sandbox", "workspace-write", "-"],
  "workspace": "/absolute/path/to/repository",
  "envAllowlist": ["HOME", "PATH", "CODEX_HOME"]
}
```
