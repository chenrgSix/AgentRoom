# WEB-044 Local Agent Provisioning Acceptance

## Result

`WEB-044` is accepted for the implemented central-Web boundary. An
authenticated Member can select only an active Device they own and an online,
enabled managed Agent on that Device, enter a 6-digit rotating or 8-digit fixed
management code, and follow the durable request through `pending`, `delivered`,
`accepted`, `rejected`, and `ready`.

The UI is not an authority boundary. The Server revalidates Team membership,
Device ownership, template ownership, integration mode, and enabled state. The
Bridge separately validates the management code, active-work fence, local
template identity, reserved Agent identity, and atomic configuration save.

## Browser Boundary

The POST body contains exactly:

- `requestId`;
- `deviceId`;
- `templateAgentId`;
- `name`;
- `role`;
- `managementCode`.

The list response and rendered history contain no management code, command,
Workspace path, environment value, credential, Provider detail, tool setting,
or permission configuration. The controlled code input is cleared after every
submission outcome. A failed offline delivery, ambiguous delivered request, or
`configuration_failed` result is recovered with the same request and Agent ID
after a newly entered code; every other rejected terminal request starts a new
identity. Devices whose active Bridge connection omits provisioning support are
not selectable.

All eight closed Bridge rejection reasons have localized code-owned messages.
An unknown value receives a generic rejection message rather than being
rendered verbatim.

## Automated Acceptance

`apps/web/test/agent-provisioning-panel.test.tsx` proves:

- foreign and offline Devices/templates are absent from the selectors;
- the 8-digit fixed-code path progresses through delivered, accepted, and
  ready;
- the 6-digit rotating-code offline path clears the code and retries with the
  same request ID;
- rejected status renders a safe localized reason;
- all closed rejection reasons have a safe projection and unknown values are
  not echoed;
- neither response history nor visible text retains either submitted code or
  local Runtime configuration.

`apps/web/test/onboarding.test.tsx` exercises the same flow through the complete
application shell: it selects the current Member's paired Device and managed
template, submits a 6-digit code, observes delivered then ready, checks the
exact request body, and confirms that the input and server projection do not
retain the code.

The final verification set on 2026-08-27 was:

- `npm test`: 135 Server, 45 Web, 4 Contracts, and 23 embedded Bridge UI tests
  passed, for 207 JavaScript/TypeScript tests plus the generated Go contract
  checks;
- `npm run build`: Server, Web production bundle, and Contracts build passed;
- `npm run validate`: 7 schemas and 64 positive/negative fixtures passed;
- `npm run test:e2e`: 4 deterministic cross-process scenarios passed; the
  explicitly opt-in live Codex/Pi scenario remained skipped;
- `go test -race ./...` and `go vet ./...` from `bridge/` passed;
- `go test -tags desktop ./cmd/agentroom-bridge-desktop` passed with only the
  existing macOS linker warnings;
- `npm run lint:docs` passed.

An additional interactive in-app-browser attempt was made against the isolated
local development server. Its browser URL policy blocked the localhost page,
so this acceptance does not claim a live screenshot or manual interactive
browser result. The component and complete-App browser-DOM acceptance above are
the executable Web evidence for this task.
