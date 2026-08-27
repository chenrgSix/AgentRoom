# QA-002 Two-Machine Managed Agent Acceptance

## Purpose and authority boundary

Prove that an Owner uses the installed Central on physical machine A to pair
one installed Bridge Device on a different physical machine B, explicitly
validates its local Codex Runtime, and completes online plus offline/reconnect
work through HTTPS. A same-host process, VM, container, Fake Runtime, Generic
Runtime, scripted Pi protocol, or uncommitted binary does not satisfy QA-002.

This procedure is also the final physical dependency of `QA-028`. It uses the
ADR-0021 session-pairing flow, not the legacy Bridge invitation or central
Server Token. The Server remains authority for Team, Device, Agent, Task and
Run state. Machine B remains authority for Codex login, executable, Workspace,
local permissions and Runtime self-test.

## Preconditions

- Machine A and machine B are distinct physical hosts. Record only sanitized
  OS and architecture descriptions; do not record a private address or user
  path.
- The Central and Bridge archives come from the same exact committed source and
  pass their repository release verifiers. Record each version and the Bridge
  archive SHA-256.
- Machine A satisfies the `agentroomctl` host prerequisites. A clean
  `direct_https` install reaches ready without editing `.env` or running
  OpenSSL. Reentry, `status`, and `doctor` pass for the same data root.
- Machine B reaches the exact HTTPS origin with system-CA trust or an explicitly
  reviewed installation trust method. It has a working local Codex login and a
  dedicated non-sensitive acceptance Workspace.
- The Owner has an authenticated Web session. No Server Token, Device
  credential, Owner recovery value, certificate key or provider credential is
  copied into the evidence workflow.

## Installation and pairing

1. On machine A, install the exact Central archive once with `agentroomctl
   install --mode direct_https`, then run `status` and `doctor`. Repeating the
   exact install command must preserve the database and Owner authority.
2. Claim initial ownership in Web, create a dedicated Team and Room named with
   the UTC acceptance date, and keep this Team isolated from unrelated Devices.
3. On machine B, verify the matching packaged Bridge archive or installed
   desktop bundle. Start Bridge Console and configure at least two local Agent
   profiles under one Device. One profile must use the local Codex preset and
   the dedicated Workspace.
4. In Web, create one Device pairing session. Open the canonical
   `agentroom://` deep link through the installed desktop registration. QR and
   manual code remain recovery paths but do not replace this deep-link check.
5. Compare the non-copyable phrase on both machines, approve the exact Device,
   and wait for consumption. Confirm Web shows exactly one active Device and at
   least two managed Agents with only opaque Workspace references and aliases.
6. In Console, explicitly run the saved Codex Runtime self-test and record only
   `RUNTIME_PROBE_OK`. Pairing or Device connectivity must not trigger this
   provider action automatically.

## Online and reconnect Runs

1. Select the Codex Agent in the dedicated Room and send a unique synthetic
   nonce instruction containing no project content. Record the resulting Run
   and trace IDs.
2. Confirm the first Run reaches `completed`, persists exactly one Agent reply,
   and one trace reconstructs its triggering Message, Run, accepted Delivery
   and contiguous Run events.
3. Stop the Bridge on machine B without revoking its Device. Send a second
   unique synthetic nonce instruction to the same Agent and confirm its Run is
   visibly `queued` before restarting Bridge.
4. Restart the installed Bridge with the same local Device state. Confirm the
   same Device reconnects, the queued Run reaches `completed`, and exactly one
   Agent reply is persisted. Do not pair a second Device and do not retry with a
   new Run ID.
5. With Bridge reconnected and no acceptance work pending, capture the internal
   Server `/api/metrics` response on machine A. The public Caddy route correctly
   hides metrics, so capture it from the trusted host/container boundary rather
   than weakening ingress policy.

## Machine-readable evidence capture

Create a temporary JSON input containing exactly the fields below. Values shown
in angle brackets are placeholders; never commit the temporary input or metrics
file.

```json
{
  "schemaVersion": 1,
  "utcStart": "<UTC RFC3339>",
  "utcEnd": "<UTC RFC3339>",
  "serverCommit": "<40 lowercase hex characters>",
  "machineA": "<sanitized OS and architecture>",
  "machineB": "<different sanitized OS and architecture>",
  "bridgeVersion": "<packaged version>",
  "bridgeArchiveSha256": "<64 lowercase hex characters>",
  "codexVersion": "<safe version only>",
  "httpsVerificationMethod": "<system CA or reviewed trust method>",
  "teamId": "team_<opaque>",
  "roomId": "room_<opaque>",
  "deviceId": "device_<opaque>",
  "agentId": "agent_<opaque>",
  "onlineRunId": "run_<opaque>",
  "onlineTraceId": "trace_<opaque>",
  "reconnectRunId": "run_<opaque>",
  "reconnectTraceId": "trace_<opaque>",
  "attestations": {
    "twoPhysicalMachines": true,
    "bridgeArchiveVerified": true,
    "desktopDeepLinkOpened": true,
    "verificationPhraseMatched": true,
    "runtimeSelfTestCode": "RUNTIME_PROBE_OK",
    "bridgeStoppedBeforeReconnectRun": true,
    "reconnectRunQueuedBeforeRestart": true,
    "sameDeviceReconnected": true,
    "installedWithoutManualEnvOrOpenSsl": true,
    "noServerTokenCopied": true,
    "noDeviceCredentialCopied": true,
    "workspaceProjectionPathFree": true
  },
  "result": "PASS"
}
```

Run the repository verifier on machine A against a read-only view of the live
SQLite database and the internally captured Prometheus text:

```sh
npm run capture:qa-002 -- \
  --input /absolute/temporary/qa-002-input.json \
  --database /absolute/data-root/data/agent-room.sqlite \
  --metrics /absolute/temporary/qa-002-metrics.txt \
  --output docs/acceptance/evidence/qa-002-YYYYMMDD.md
```

The verifier fails closed unless:

- the Team has exactly one active Device with at least two enabled managed
  Agents and the selected Agent belongs to that Device;
- both Runs, their trigger Messages, Deliveries and contiguous events use the
  exact supplied Room, Agent, Device and trace identities;
- each Delivery was accepted, each Run completed, and each trace produced
  exactly one reply event and one Agent Message;
- current metrics show a ready Server, authenticated Bridge, at least two
  managed Agents, no queued or pending acceptance work, and at least two
  completed Runs; and
- every physical/pairing/self-test/reconnect assertion is explicit and the
  output contains no credential-shaped text, private address or common home
  path.

The output file is created once with mode `0600`; the verifier never overwrites
an earlier record. Delete the temporary JSON and metrics files through the
host's approved secure-cleanup process after review.

## Review and completion

Review the generated Markdown against the two machines while they are still
available. Confirm the host descriptions really identify distinct physical
machines and the attested observations occurred; the database cannot prove
physical separation by itself.

Commit the reviewed PASS record under `docs/acceptance/evidence/`, update both
`QA-002` and `QA-028` to `DONE` in the same commit, and rerun documentation and
repository gates. A failed or partial run is useful diagnostic evidence but
cannot close either task.
