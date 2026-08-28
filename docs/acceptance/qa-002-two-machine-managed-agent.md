# QA-002 Two-Machine Managed Agent Acceptance

## Purpose and authority boundary

Prove that an Owner uses the installed Central on physical machine A to pair
one installed Bridge Device on a different physical machine B, explicitly
validates its local Codex Runtime, and completes online plus offline/reconnect
work through HTTPS. A same-host process, VM, container, Fake Runtime, Generic
Runtime, scripted Pi protocol, or uncommitted binary does not satisfy QA-002.

This procedure is also the final physical dependency of `QA-028`. It uses the
ADR-0021 session-pairing flow plus the ADR-0023 TLS profile, not the legacy
Bridge invitation, central Server Token, manual OS CA import, or leaf pin. The
Server remains authority for Team, Device, Agent, Task and Run state. Machine B
remains authority for Codex login, executable, Workspace, local permissions,
Runtime self-test and its exact-origin Bridge trust store.

Status: `BLOCKED` on `QA-031` and a fresh schema-v4 physical record. The
[schema-v3 physical evidence](evidence/qa-002-20260828.md) remains a sanitized
historical record, but its verifier did not prove that the selected Runs,
heartbeat and metrics belonged to the current packaged Bridge connection or
persist an explicit human review receipt. It therefore cannot close this gate.

## Preconditions

- Machine A and machine B are distinct physical hosts. Record only sanitized
  OS and architecture descriptions; do not record a private address or user
  path.
- The Central and Bridge archives come from the same exact committed source and
  pass their repository release verifiers. Record each version and the Bridge
  archive SHA-256.
- Machine A satisfies the `agentroomctl` host prerequisites. A clean
  `direct_https` install reaches ready without editing `.env` or running
  OpenSSL. The omitted TLS profile selects `public_ca`; an explicit private run
  selects `private_scoped_ca`. Reentry, `status`, and `doctor` pass for the same
  data root, installation ID, origin and trust epoch.
- Machine B reaches the exact HTTPS origin either through normal public system
  trust or the pairing-scoped private CA delivered by the canonical link. No
  root is imported into its OS trust store, no leaf fingerprint is typed, and
  no AgentRoom claim, poll, WebSocket, or authenticated HTTP request uses a
  verification-disabled transport. It has a working local Codex login and a
  dedicated non-sensitive acceptance Workspace.
- The Owner has an authenticated Web session. No Server Token, Device
  credential, Owner recovery value, certificate key or provider credential is
  copied into the evidence workflow.

## Installation and pairing

1. On machine A, install the exact Central archive once with `agentroomctl
   install --mode direct_https` for the default public-CA case, or add the
   post-`OPS-009` explicit `--tls-profile private_scoped_ca` option for a private
   origin. Then run `status` and `doctor`. Repeating the exact install command
   must preserve the database, Owner authority, installation ID, TLS profile and
   trust epoch. Public issuance failure must not fall back to a local CA.
2. Claim initial ownership in Web, create a dedicated Team and Room named with
   the UTC acceptance date, and keep this Team isolated from unrelated Devices.
3. On machine B, verify the matching packaged Bridge archive or installed
   desktop bundle. Start Bridge Console and configure at least two local Agent
   profiles under one Device. One profile must use the local Codex preset and
   the dedicated Workspace.
4. In Web, create one Device pairing session. Open the canonical
   `agentroom://` deep link through the installed desktop registration. QR and
   manual code remain recovery paths for public/system-trusted origins but do
   not replace this deep-link check. A private-scoped first pairing must carry
   the exact origin/install/epoch/digest descriptor through the link; its short
   code alone is intentionally insufficient.
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

The verifier accepts schema version 3 only. It rejects older shapes,
`manual_ca`, a TLS profile/verification-method mismatch, either missing
no-manual-CA assertion, and any false assertion before reading evidence into a
PASS record. It also requires exactly one consumed pairing session for the
supplied Team and Device, matches its initial Bridge version, independently
matches the current packaged version to the latest authenticated
`bridge.hello`, and proves the selected public or private-scoped TLS profile
from persisted pairing facts. An in-place Bridge upgrade therefore preserves
the Device and pairing identity instead of forcing a second pairing.
Private-scoped evidence additionally requires the complete stored descriptor
and the claiming Bridge's scoped-trust capability, without rendering the
origin, installation identity, epoch, or CA digest.

```json
{
  "schemaVersion": 3,
  "utcStart": "<UTC RFC3339>",
  "utcEnd": "<UTC RFC3339>",
  "serverCommit": "<40 lowercase hex characters>",
  "machineA": "<sanitized OS and architecture>",
  "machineB": "<different sanitized OS and architecture>",
  "pairingBridgeVersion": "<initial pairing version>",
  "bridgeVersion": "<current packaged version>",
  "bridgeArchiveSha256": "<64 lowercase hex characters>",
  "codexVersion": "<safe version only>",
  "tlsProfile": "<public_ca or private_scoped_ca>",
  "httpsVerificationMethod": "<public system CA or Bridge exact-origin private CA>",
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
    "noManualCaInstalled": true,
    "noApplicationTlsVerificationBypass": true,
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
- exactly one consumed pairing session binds that Team and Device to the
  supplied initial Bridge version and TLS profile; private-scoped evidence also
  proves the complete stored descriptor and Bridge capability while public
  evidence proves no private descriptor was attached;
- the latest authenticated Bridge hello for that same Device binds the current
  packaged version independently of the immutable pairing version;
- both Runs, their trigger Messages, Deliveries and contiguous events use the
  exact supplied Room, Agent, Device and trace identities;
- each Delivery was accepted, each Run completed, and each trace produced
  exactly one reply event and one Agent Message;
- current metrics show a ready Server, authenticated Bridge, at least two
  managed Agents, no queued or pending acceptance work, and at least two
  completed Runs; and
- every physical/pairing/self-test/reconnect assertion is explicit and the
  selected TLS profile is `public_ca` or `private_scoped_ca`; and
- human-observed attestations confirm no OS CA import or verification-disabled
  application request, while the output contains no credential-shaped text,
  private address, complete CA digest, certificate material or common home
  path.

The output file is created once with mode `0600`; the verifier never overwrites
an earlier record. Delete the temporary JSON and metrics files through the
host's approved secure-cleanup process after review.

## Review and completion

Review the generated Markdown against the two machines while they are still
available. Confirm the host descriptions really identify distinct physical
machines and the attested observations occurred; the database cannot prove
physical separation by itself.

The [2026-08-28 schema-v3 record](evidence/qa-002-20260828.md) is retained as
historical diagnostic evidence. A post-completion audit demonstrated that its
accepted UTC window could be moved away from the persisted pairing and Run
activity without causing the verifier to fail. `QA-002`, `QA-028`, and
`QA-030` therefore remain blocked until a schema-v4 record binds every selected
observation to one bounded window and carries an explicit human review receipt.
A run that installs a Caddy root into machine B's OS trust store or manually
enters a leaf fingerprint is always partial/advanced compatibility evidence,
even if every application request succeeds.
