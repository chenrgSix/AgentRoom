# Team and Room Module

- Prefix: `ROOM`
- Planned location: `apps/server/`
- Owns: Team, Room, Message, membership-scoped Room history

## Purpose

This module is the central collaboration model and the only authority for Team
and Room conversation history. Every human or Agent contribution becomes a
persisted Message before routing or realtime broadcast.

## Responsibilities

- Create and read Teams and Rooms.
- Resolve authenticated users to Team Members.
- Persist Room Messages and structured Mention references.
- Provide cursor-based history pagination.
- Broadcast committed Room changes to authorized Web clients.
- Expose read/write services to Run Orchestration and MCP.

## Exclusions

- Device, Agent, and Presence lifecycle belongs to Registry.
- Mention delivery and Agent execution belong to Run Orchestration.
- Browser presentation belongs to Web UI.
- Runtime context construction beyond selecting Room messages belongs to the
  caller, subject to Room access policy.

## Core State

| Entity | Required State |
| --- | --- |
| Team | teamId, name, createdAt |
| Room | roomId, teamId, name, policy, createdAt |
| Member | referenced by Registry and Security |
| Message | messageId, roomId, senderRef, content, mentions, parentId, createdAt |
| Mention | type, targetId, displayLabel |

Message content is immutable in MVP. Deletion, editing, reactions, attachments,
and full-text search are deferred.

## Message Write Flow

1. Authenticate the actor and authorize Room membership.
2. Validate content size and structured Mention IDs.
3. Verify every Agent Mention is visible to the actor in the Room.
4. Persist Message and Mentions in one transaction.
5. Commit before emitting `message.created`.
6. Let Run Orchestration consume the committed event.

Display labels never participate in routing. A quoted or plain-text
`@Bob/Backend` without a structured Mention does not create a Run.

## History and Ordering

- The database assigns a monotonic Room sequence at commit.
- Pagination uses an opaque cursor derived from Room ID and sequence.
- Equal client timestamps do not affect ordering.
- Realtime clients deduplicate by Message ID and reconcile from HTTP history
  after reconnect.

## Failure and Security

- A message either commits with all Mention references or not at all.
- Unauthorized Room existence is not disclosed through distinct errors.
- Content is size-limited and treated as untrusted before rendering or prompt
  construction.
- Redaction occurs before persistence when Security policy identifies a secret.

## Verification

- Concurrent writes have stable order and no duplicate sequence.
- Restart preserves pagination and parent-message references.
- Cross-Team access and forged Agent IDs are rejected.
- Plain-text mentions never trigger work.
- Realtime reconnect converges to persisted history.

## Task Mapping

`ROOM-001` through `ROOM-003`, with Web delivery in `WEB-002` and
`WEB-003`.

## Dependencies

Contracts, Persistence, Security, and Registry Agent lookup.
