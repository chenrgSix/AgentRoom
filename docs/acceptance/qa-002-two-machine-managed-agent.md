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

Status: `DONE`. The reviewed
[2026-08-30 schema-v4 physical record](evidence/qa-002-20260830-schema-v4.md)
binds two distinct physical hosts, the exact `v0.4.1-qa035.1` Central and
Windows Bridge artifacts, current authenticated Bridge observation, bounded
heartbeat and metrics, online and offline/reconnect Runs, and the explicit
human review receipt. The older
[schema-v3 physical evidence](evidence/qa-002-20260828.md) remains a sanitized
historical diagnostic only.

## Preconditions

- Machine A and machine B are distinct physical hosts. Record only sanitized
  OS and architecture descriptions; do not record a private address or user
  path.
- The Central and Bridge packages come from the same exact committed source and
  pass their repository release verifiers. Keep the downloaded Windows
  installer, matching desktop ZIP and Release `SHA256SUMS` beside the temporary
  capture input; record both outer SHA-256 digests only as independently
  checked inputs.
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
   `convenewire://` deep link through the installed desktop registration. The
   retained `agentroom://` parser is upgrade compatibility only and does not
   satisfy this current-build check. QR and manual code remain recovery paths
   for public/system-trusted origins but do not replace this deep-link check. A
   private-scoped first pairing must carry the exact origin/install/epoch/digest
   descriptor through the link; its short code alone is intentionally
   insufficient.
5. Compare the non-copyable phrase on both machines, approve the exact Device,
   and wait for consumption. Confirm Web shows exactly one active Device and at
   least two managed Agents with only opaque Workspace references and aliases.
6. In Console, explicitly run the saved Codex Runtime self-test and record only
   `RUNTIME_PROBE_OK`. Pairing or Device connectivity must not trigger this
   provider action automatically. Confirm the installed Runtime launch does not
   show an unexpected terminal or console window.

## Reconnect and online Runs

1. Stop the Bridge on machine B without revoking its Device. Send a unique
   synthetic nonce instruction containing no project content to the Codex Agent
   and confirm its Run is visibly `queued`. Record the reconnect Run and trace
   IDs.
2. Restart the installed Bridge with the same local Device state. Confirm the
   same Device reconnects on the current packaged version, the queued Run
   reaches `completed`, and exactly one Agent reply is persisted. Do not pair a
   second Device and do not retry with a new Run ID.
3. Without restarting Bridge again, send a second unique synthetic nonce
   instruction to the same Codex Agent. Record the online Run and trace IDs.
4. Confirm the online Run reaches `completed`, persists exactly one Agent
   reply, and one trace reconstructs its triggering Message, Run, accepted
   Delivery and contiguous Run events.
5. Keep this Bridge connection running with no acceptance work pending. Capture
   the internal Server `/api/metrics` response on machine A no more than 30
   seconds after the persisted Device heartbeat, then perform and timestamp the
   human review. The public Caddy route correctly hides metrics, so capture it
   from the trusted host/container boundary rather than weakening ingress
   policy. A later restart invalidates this capture and requires both Runs to be
   repeated against the newer connection epoch.

## Machine-readable evidence capture

Create a temporary JSON input containing exactly the fields below. Values shown
in angle brackets are placeholders; never commit the temporary input or metrics
file.

The verifier accepts schema version 4 only. It rejects older shapes,
`manual_ca`, a TLS profile/verification-method mismatch, either missing
no-manual-CA assertion, and any false assertion before reading evidence into a
PASS record. The evidence window is at most 24 hours and contains the consumed
pairing, current packaged `bridge.hello`, matching connection epoch, fresh
heartbeat, selected Runs, metrics capture and later human review. The reconnect
Run must be created while Bridge is offline and accepted only after the latest
hello; the online Run must be created and completed on that same connection.
An in-place Bridge upgrade therefore preserves the Device and pairing identity
instead of forcing a second pairing while still proving current-build work.
Private-scoped evidence additionally requires the complete stored descriptor
and the claiming Bridge's scoped-trust capability, without rendering the
origin, installation identity, epoch, or CA digest.

```json
{
  "schemaVersion": 4,
  "utcStart": "<UTC RFC3339>",
  "utcEnd": "<UTC RFC3339>",
  "metricsCapturedAt": "<UTC RFC3339>",
  "serverCommit": "<40 lowercase hex characters>",
  "machineA": "<sanitized OS and architecture>",
  "machineB": "<different sanitized OS and architecture>",
  "pairingBridgeVersion": "<initial pairing version>",
  "bridgeVersion": "<current packaged version>",
  "bridgeArchiveSha256": "<64 lowercase hex characters>",
  "bridgeDesktopArchiveSha256": "<64 lowercase hex characters>",
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
    "canonicalConveneWireDeepLinkOpened": true,
    "verificationPhraseMatched": true,
    "runtimeSelfTestCode": "RUNTIME_PROBE_OK",
    "runtimeLaunchHadNoUnexpectedConsoleWindow": true,
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
  "review": {
    "reviewedAt": "<UTC RFC3339 at or after metrics capture>",
    "reviewerRole": "machine-b operator",
    "physicalHostsConfirmed": true,
    "currentBuildExecutionConfirmed": true,
    "evidenceWindowConfirmed": true,
    "attestationsConfirmed": true,
    "result": "PASS"
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
  --bridge-installer /absolute/release/convenewire-bridge-desktop_VERSION_windows_amd64_setup.exe \
  --bridge-desktop-archive /absolute/release/convenewire-bridge-desktop_VERSION_windows_amd64.zip \
  --release-checksums /absolute/release/SHA256SUMS \
  --output docs/acceptance/evidence/qa-002-YYYYMMDD.md
```

The verifier fails closed unless:

- the supplied non-symlink Windows installer and desktop ZIP have the exact
  current Bridge version in their closed Release filenames, both computed
  SHA-256 digests equal their reviewed inputs and unique entries in the
  downloaded Release `SHA256SUMS`, every ZIP member path is safe, and the ZIP
  contains exactly one expected managed executable;
- the internally captured metrics contain exactly one
  `convenewire_build_info` whose v-prefixed Release version matches the current
  Bridge package and whose full source commit matches `serverCommit`;
- the Team has exactly one active Device with at least two enabled managed
  Agents and the selected Agent belongs to that Device;
- exactly one consumed pairing session binds that Team and Device to the
  supplied initial Bridge version and TLS profile; private-scoped evidence also
  proves the complete stored descriptor and Bridge capability while public
  evidence proves no private descriptor was attached;
- the latest authenticated Bridge hello for that same Device binds the current
  packaged version, exact source commit and startup-computed executable digest
  independently of the immutable pairing version; the digest equals the safely
  inspected executable inside the selected desktop ZIP, and current Device
  presence uses the same connection epoch with an available adapter. This is an
  authenticated process observation, not remote hardware attestation;
- the persisted heartbeat precedes metrics capture by no more than 30 seconds;
- `metricsCapturedAt` matches the metrics snapshot file modification time within
  five seconds, preventing an old snapshot from being relabeled as current;
- both Runs, their trigger Messages, Deliveries and contiguous events use the
  exact supplied Room, Agent, Device and trace identities;
- the reconnect Run was created before the latest hello but sent, accepted and
  completed after it, while the online Run was created, sent, accepted and
  completed after that hello;
- each Delivery was accepted, each Run completed, and each trace produced
  exactly one reply event and one Agent Message;
- current metrics show a ready Server, authenticated Bridge, at least two
  managed Agents, no queued or pending acceptance work, and at least two
  completed Runs; and
- every persisted and supplied timestamp falls within one window no longer than
  24 hours, metrics follow all machine evidence, and review follows metrics;
- every physical/pairing/self-test/reconnect assertion is explicit, the
  installed canonical deep link used `convenewire://`, and the selected TLS
  profile is `public_ca` or `private_scoped_ca`;
- human-observed attestations confirm no OS CA import or verification-disabled
  application request, and the explicit review receipt confirms the physical
  hosts, current-build execution, evidence window and attestations; and
- the output contains no credential-shaped text, private address, complete CA
  digest, certificate material or common home path.

The output file is created once with mode `0600`; the verifier never overwrites
an earlier record. Delete the temporary JSON and metrics files through the
host's approved secure-cleanup process after review. Retain or remove the
public Release assets according to the normal package-retention policy; they
contain no acceptance credential.

## Review and completion

Review the proposed input against the two machines while they are still
available. Confirm the host descriptions really identify distinct physical
machines and the attested observations occurred; the database cannot prove
physical separation by itself. Add the review timestamp, reviewer role and all
four explicit confirmations before running the verifier. The generated
Markdown embeds that review receipt and is then committed without modification.

The [2026-08-28 schema-v3 record](evidence/qa-002-20260828.md) is retained as
historical diagnostic evidence. A post-completion audit demonstrated that its
accepted UTC window could be moved away from the persisted pairing and Run
activity without causing the verifier to fail. The replacement
[schema-v4 record](evidence/qa-002-20260830-schema-v4.md) closes that gap: its
22-minute window contains pairing, current-build hello, both Runs, heartbeat,
metrics and review, and the verifier reports `PASS`. A run that installs a
Caddy root into machine B's OS trust store or manually enters a leaf
fingerprint remains partial/advanced compatibility evidence even if every
application request succeeds.

## Current exact release

[`v0.4.0`](../releases/v0.4.0.md) remains the current stable historical
baseline. The exact schema-v4 acceptance candidate is the unpublished Draft
prerelease `v0.4.1-qa035.1` at commit
`152892e59e90fe17799274009141b07714262378`. Main CI run `33294027654` and
Release workflow run `33294193123` passed on that commit. The physical record
uses the matching Central archive, Windows installer and desktop ZIP, and the
installed canonical `convenewire://` entry; it does not treat the legacy
`agentroom://` compatibility handler as acceptance evidence.
