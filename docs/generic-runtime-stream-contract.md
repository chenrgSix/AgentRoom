# Generic Runtime Stream Contract

## Opt-in Boundary

Generic Runtime stdout is final-only by default. Streaming is enabled only
when the owner adds this exact configuration field:

```json
{
  "name": "Local Worker",
  "role": "Implementer",
  "adapter": "generic",
  "runtimeKind": "generic",
  "command": ["/absolute/path/to/runtime", "--agentroom-jsonl"],
  "workspace": "/absolute/path/to/project",
  "outputProtocol": "agentroom-jsonl-v1",
  "envAllowlist": ["HOME", "PATH"]
}
```

The Bridge still sends the bounded Run instruction on stdin and expects the
process to exit for every Run. The configured executable, arguments,
workspace, environment allowlist, and local permissions remain owner-controlled.

## JSONL Events

Stdout contains exactly one JSON object per line. A producer may emit these
public assistant events:

```json
{"type":"assistant.delta","delta":"Partial answer"}
{"type":"assistant.delta","delta":"Replacement after a tool","reset":true}
{"type":"reply.final","text":"Authoritative final answer"}
```

- `assistant.delta.delta` is a non-empty UTF-8 string. `reset: true` replaces
  the current provisional answer before appending the supplied delta.
- `reply.final.text` is a non-empty UTF-8 string and must occur exactly once.
  It replaces any provisional interpretation as the authoritative Room reply.
- Other well-formed JSON event types are treated as private Runtime control
  events and never cross the Bridge boundary.
- No assistant event may follow `reply.final`.

## Safety and Failure

The Bridge caps the complete JSONL stream at 512 KB and assistant/final text at
20 KB. Provisional output retains a 64-rune safety tail so split credentials
and the private `agentroom-assessment` envelope can be removed before emission.
The durable Runtime executor applies the same redaction again before sending a
Bridge message.

Malformed JSON, a missing or duplicate final reply, an empty delta/final reply,
assistant output after the final reply, oversized output, provider tool-call
markup in assistant text, or a nonzero process exit fails the Run without
publishing raw stdout or stderr. Stderr contributes only the existing bounded
failure category, exit code, and presence flag.

Plain stdout Runtimes must omit `outputProtocol`; their existing 20 KB
final-only behavior and capability downgrade remain unchanged.
