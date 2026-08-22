import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

interface Team {
  teamId: string;
  name: string;
  createdAt: string;
}

interface Room {
  roomId: string;
  teamId: string;
  name: string;
  createdAt: string;
}

interface Agent {
  agentId: string;
  name: string;
  role: string;
  integrationMode: "managed" | "manual" | "fake";
  presence: string;
}

interface Message {
  messageId: string;
  roomId: string;
  sequence: number;
  senderType: "member" | "agent" | "system";
  senderId: string;
  content: string;
  mentions: Array<{
    targetType: "agent";
    targetAgentId: string;
    displayLabel: string;
  }>;
  createdAt: string;
}

interface Device {
  deviceId: string;
  name: string;
  status: "active" | "revoked";
}

interface Run {
  runId: string;
  triggerMessageId: string;
  targetAgentId: string;
  state: "queued" | "delivered" | "working" | "input_required" | "completed" | "failed" | "canceled" | "expired" | "outcome_unknown";
  updatedAt: string;
}

interface LocalSession {
  userId: string;
  displayName: string;
  token: string;
}

const userKey = "agent-room.local-user";

async function jsonRequest<T>(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const body = await response.json() as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  }
  return body;
}

async function bootstrap(): Promise<LocalSession> {
  const saved = localStorage.getItem(userKey);
  const existing = saved
    ? JSON.parse(saved) as { userId: string; displayName: string }
    : null;
  const displayName = existing?.displayName ?? "Local Owner";
  const result = await jsonRequest<{
    user: { userId: string; displayName: string };
    session: { token: string };
  }>("/api/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      displayName,
      ...(existing ? { userId: existing.userId } : {})
    })
  });
  localStorage.setItem(userKey, JSON.stringify(result.user));
  return {
    userId: result.user.userId,
    displayName: result.user.displayName,
    token: result.session.token
  };
}

export function App() {
  const [session, setSession] = useState<LocalSession | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");
  const [roomName, setRoomName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [manualAgentName, setManualAgentName] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [setupOutput, setSetupOutput] = useState<string | null>(null);
  const [messageContent, setMessageContent] = useState("");
  const [mentionAgentId, setMentionAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionSetupRef = useRef<HTMLDetailsElement>(null);

  const selectedTeam = useMemo(
    () => teams.find((team) => team.teamId === selectedTeamId) ?? null,
    [selectedTeamId, teams]
  );
  const selectedRoom = useMemo(
    () => rooms.find((room) => room.roomId === selectedRoomId) ?? null,
    [rooms, selectedRoomId]
  );
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.agentId, agent])),
    [agents]
  );

  async function loadTeams(activeSession: LocalSession) {
    const next = await jsonRequest<Team[]>("/api/teams", {}, activeSession.token);
    setTeams(next);
    setSelectedTeamId((current) => current ?? next[0]?.teamId ?? null);
  }

  useEffect(() => {
    void bootstrap()
      .then(async (next) => {
        setSession(next);
        await loadTeams(next);
      })
      .catch((reason: unknown) => setError(String(reason)));
  }, []);

  useEffect(() => {
    if (!session || !selectedTeamId) {
      setRooms([]);
      setAgents([]);
      return;
    }
    setError(null);
    void Promise.all([
      jsonRequest<Room[]>(
        `/api/teams/${selectedTeamId}/rooms`,
        {},
        session.token
      ),
      jsonRequest<Agent[]>(
        `/api/teams/${selectedTeamId}/agents`,
        {},
        session.token
      ),
      jsonRequest<Device[]>(
        `/api/teams/${selectedTeamId}/devices`,
        {},
        session.token
      )
    ]).then(([nextRooms, nextAgents, nextDevices]) => {
      setRooms(nextRooms);
      setAgents(nextAgents);
      setDevices(nextDevices);
      setMentionAgentId((current) =>
        nextAgents.some((agent) => agent.agentId === current) ? current : ""
      );
      setSelectedRoomId((current) =>
        nextRooms.some((room) => room.roomId === current)
          ? current
          : nextRooms[0]?.roomId ?? null
      );
    }).catch((reason: unknown) => setError(String(reason)));
  }, [selectedTeamId, session]);

  useEffect(() => {
    if (!session || !selectedRoomId) {
      setMessages([]);
      setRuns([]);
      return;
    }
    void Promise.all([
      jsonRequest<{ items: Message[] }>(
        `/api/rooms/${selectedRoomId}/messages?limit=100`,
        {},
        session.token
      ),
      jsonRequest<Run[]>(
        `/api/rooms/${selectedRoomId}/runs`,
        {},
        session.token
      )
    ]).then(([page, nextRuns]) => {
      setMessages(page.items);
      setRuns(nextRuns);
    })
      .catch((reason: unknown) => setError(String(reason)));
  }, [selectedRoomId, session]);

  useEffect(() => {
    if (!session || !selectedTeamId || !selectedRoomId) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const [nextAgents, nextDevices, page, nextRuns] = await Promise.all([
          jsonRequest<Agent[]>(
            `/api/teams/${selectedTeamId}/agents`, {}, session.token
          ),
          jsonRequest<Device[]>(
            `/api/teams/${selectedTeamId}/devices`, {}, session.token
          ),
          jsonRequest<{ items: Message[] }>(
            `/api/rooms/${selectedRoomId}/messages?limit=100`, {}, session.token
          ),
          jsonRequest<Run[]>(
            `/api/rooms/${selectedRoomId}/runs`, {}, session.token
          )
        ]);
        if (!stopped) {
          setAgents(nextAgents);
          setDevices(nextDevices);
          setMessages(page.items);
          setRuns(nextRuns);
        }
      } catch (reason) {
        if (!stopped) setError(String(reason));
      }
    };
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [selectedRoomId, selectedTeamId, session]);

  async function createTeam(event: FormEvent) {
    event.preventDefault();
    if (!session || !teamName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await jsonRequest<{ team: Team }>("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name: teamName })
      }, session.token);
      setTeamName("");
      await loadTeams(session);
      setSelectedTeamId(created.team.teamId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !roomName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const room = await jsonRequest<Room>(
        `/api/teams/${selectedTeamId}/rooms`,
        { method: "POST", body: JSON.stringify({ name: roomName }) },
        session.token
      );
      setRoomName("");
      setRooms((current) => [...current, room]);
      setSelectedRoomId(room.roomId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createFakeAgent(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !agentName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await jsonRequest<Agent>(
        `/api/teams/${selectedTeamId}/fake-agents`,
        {
          method: "POST",
          body: JSON.stringify({ name: agentName, role: "Teammate" })
        },
        session.token
      );
      setAgentName("");
      setAgents((current) => [...current, agent]);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createManualAgent(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !manualAgentName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await jsonRequest<{
        agent: Agent;
        credential: { token: string };
      }>(`/api/teams/${selectedTeamId}/manual-agents`, {
        method: "POST",
        body: JSON.stringify({ name: manualAgentName, role: "MCP participant" })
      }, session.token);
      setAgents((current) => [...current, result.agent]);
      setManualAgentName("");
      setSetupOutput([
        `export AGENT_ROOM_MCP_TOKEN='${result.credential.token}'`,
        `codex mcp add agent-room --url ${window.location.origin}/mcp --bearer-token-env-var AGENT_ROOM_MCP_TOKEN`
      ].join("\n"));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function createBridgeInvite(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedTeamId || !deviceName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const invite = await jsonRequest<{
        code: string;
        deviceName: string;
        expiresAt: string;
      }>(`/api/teams/${selectedTeamId}/bridge-invites`, {
        method: "POST",
        body: JSON.stringify({ deviceName })
      }, session.token);
      setDeviceName("");
      setSetupOutput([
        `# Pairing code expires at ${invite.expiresAt}`,
        `agentroom-bridge pair --config bridge.json --code '${invite.code}'`
      ].join("\n"));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function revokeDevice(device: Device) {
    if (!session || !selectedTeamId || device.status !== "active") return;
    setError(null);
    try {
      const revoked = await jsonRequest<Device>(
        `/api/teams/${selectedTeamId}/devices/${device.deviceId}`,
        { method: "DELETE" },
        session.token
      );
      setDevices((current) => current.map((item) =>
        item.deviceId === revoked.deviceId ? revoked : item
      ));
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedRoomId || !messageContent.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await jsonRequest<{ message: Message; runs: Run[] }>(
        `/api/rooms/${selectedRoomId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            content: messageContent,
            ...(mentionAgentId ? { mentionAgentId } : {})
          })
        },
        session.token
      );
      setMessageContent("");
      setMentionAgentId("");
      const [page, nextRuns] = await Promise.all([
        jsonRequest<{ items: Message[] }>(
          `/api/rooms/${selectedRoomId}/messages?limit=100`,
          {},
          session.token
        ),
        jsonRequest<Run[]>(
          `/api/rooms/${selectedRoomId}/runs`,
          {},
          session.token
        )
      ]);
      setMessages(page.items);
      setRuns(nextRuns);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun(runId: string) {
    if (!session) return;
    setError(null);
    try {
      const updated = await jsonRequest<Run>(`/api/runs/${runId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "Canceled from Team Room" })
      }, session.token);
      setRuns((current) => current.map((run) =>
        run.runId === updated.runId ? updated : run
      ));
    } catch (reason) {
      setError(String(reason));
    }
  }

  function revealConnectionSetup() {
    const details = connectionSetupRef.current;
    if (!details) return;
    details.open = true;
    details.querySelector<HTMLInputElement>("input")?.focus();
  }

  return (
    <div className="app-shell">
      <aside className="team-rail" aria-label="Teams">
        <div className="brand-mark" aria-label="Agent Room">AR</div>
        <div className="team-list">
          {teams.map((team) => (
            <button
              className={team.teamId === selectedTeamId ? "team-chip active" : "team-chip"}
              key={team.teamId}
              onClick={() => setSelectedTeamId(team.teamId)}
              title={team.name}
            >
              {team.name.slice(0, 2).toUpperCase()}
            </button>
          ))}
        </div>
        <form className="quick-create" onSubmit={createTeam}>
          <input
            aria-label="New Team name"
            onChange={(event) => setTeamName(event.target.value)}
            placeholder="New Team"
            required
            value={teamName}
          />
          <button
            aria-label="Create Team"
            disabled={busy}
            title={busy ? "Creating Team" : "Create Team"}
          >+</button>
        </form>
      </aside>

      <aside className="room-sidebar">
        <header>
          <p className="eyebrow">TEAM SPACE</p>
          <h1>{selectedTeam?.name ?? "Agent Room"}</h1>
        </header>
        <div className="section-label">Rooms</div>
        <nav className="room-list" aria-label="Rooms">
          {rooms.map((room) => (
            <button
              className={room.roomId === selectedRoomId ? "room-link active" : "room-link"}
              key={room.roomId}
              onClick={() => setSelectedRoomId(room.roomId)}
            >
              <span>#</span>{room.name}
            </button>
          ))}
        </nav>
        {selectedTeam && (
          <form className="room-create" onSubmit={createRoom}>
            <input
              aria-label="New Room name"
              onChange={(event) => setRoomName(event.target.value)}
              placeholder="Add a Room"
              required
              value={roomName}
            />
            <button disabled={busy}>{busy ? "Creating…" : "Create"}</button>
          </form>
        )}
        {selectedTeam && (
          <form className="room-create agent-create" onSubmit={createFakeAgent}>
            <input
              aria-label="New Fake Agent name"
              onChange={(event) => setAgentName(event.target.value)}
              placeholder="Add a Fake Agent"
              required
              value={agentName}
            />
            <button disabled={busy}>{busy ? "Adding…" : "Add Agent"}</button>
          </form>
        )}
        {selectedTeam && (
          <details className="connection-setup" ref={connectionSetupRef}>
            <summary>Connect an Agent</summary>
            <form className="room-create" onSubmit={createManualAgent}>
              <input
                aria-label="Manual Agent name"
                onChange={(event) => setManualAgentName(event.target.value)}
                placeholder="Codex via MCP"
                required
                value={manualAgentName}
              />
              <button disabled={busy}>Create MCP token</button>
            </form>
            <form className="room-create" onSubmit={createBridgeInvite}>
              <input
                aria-label="Bridge Device name"
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="Bob's Mac"
                required
                value={deviceName}
              />
              <button disabled={busy}>Create pairing code</button>
            </form>
            {setupOutput && (
              <div className="setup-output">
                <pre>{setupOutput}</pre>
                <button type="button" onClick={() => void navigator.clipboard.writeText(setupOutput)}>Copy</button>
              </div>
            )}
            {devices.map((device) => (
              <div className="device-row" key={device.deviceId}>
                <span>{device.name}</span>
                <button
                  disabled={device.status !== "active"}
                  onClick={() => void revokeDevice(device)}
                  type="button"
                >{device.status === "active" ? "Revoke" : "Revoked"}</button>
              </div>
            ))}
          </details>
        )}
        {selectedTeam && (
          <section className="agent-panel" aria-label="Team Agents">
            <div className="section-label">Agents</div>
            {agents.length === 0 ? (
              <p className="agent-empty">No Agents have joined.</p>
            ) : agents.map((agent) => (
              <div className="agent-row" key={agent.agentId}>
                <span className={`presence-dot ${agent.presence}`} />
                <div>
                  <strong>{agent.name}</strong>
                  <small>{agent.role} · {agent.integrationMode}</small>
                </div>
                <span className="presence-label">{agent.presence}</span>
              </div>
            ))}
          </section>
        )}
        <footer>
          <span className="avatar">{session?.displayName.slice(0, 1) ?? "…"}</span>
          <div><strong>{session?.displayName ?? "Connecting"}</strong><small>Local session</small></div>
        </footer>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">ROOM</p>
            <h2>{selectedRoom ? `# ${selectedRoom.name}` : "Choose a Room"}</h2>
          </div>
          <div className="agent-summary">
            <span className="presence-dot" />
            {agents.length} Agent{agents.length === 1 ? "" : "s"}
          </div>
        </header>
        {!selectedTeam ? (
          <section className="empty-stage onboarding-stage">
            <div className="orb"><span>✦</span></div>
            <p className="eyebrow">STEP 1 OF 3</p>
            <h3>Create your first Team</h3>
            <p>
              A Team is the shared home for Rooms, people, and connected Agents.
            </p>
            <form className="onboarding-form" onSubmit={createTeam}>
              <label htmlFor="onboarding-team-name">Team name</label>
              <div>
                <input
                  autoComplete="off"
                  id="onboarding-team-name"
                  onChange={(event) => setTeamName(event.target.value)}
                  placeholder="Platform Team"
                  required
                  value={teamName}
                />
                <button disabled={busy}>{busy ? "Creating…" : "Create Team"}</button>
              </div>
              <small>Next, you will create a Room and connect an Agent.</small>
            </form>
          </section>
        ) : !selectedRoom ? (
          <section className="empty-stage onboarding-stage">
            <div className="step-badge">2</div>
            <p className="eyebrow">STEP 2 OF 3 · {selectedTeam.name}</p>
            <h3>Create a conversation Room</h3>
            <p>Rooms keep Team conversations and Agent Runs in one durable timeline.</p>
            <form className="onboarding-form" onSubmit={createRoom}>
              <label htmlFor="onboarding-room-name">Room name</label>
              <div>
                <input
                  autoComplete="off"
                  id="onboarding-room-name"
                  onChange={(event) => setRoomName(event.target.value)}
                  placeholder="general"
                  required
                  value={roomName}
                />
                <button disabled={busy}>{busy ? "Creating…" : "Create Room"}</button>
              </div>
              <small>You can add more Rooms later from the sidebar.</small>
            </form>
          </section>
        ) : messages.length === 0 ? (
          <section className="empty-stage">
            <div className="orb"><span>✦</span></div>
            <p className="eyebrow">{agents.length === 0 ? "STEP 3 OF 3" : "CENTRAL TEAM READY"}</p>
            <h3>
              {agents.length === 0
                ? "Add an Agent or start the conversation"
                : `Start the conversation in #${selectedRoom.name}`}
            </h3>
            <p>
              Messages, structured Agent mentions, Runs, and replies will appear
              here as one durable Team timeline.
            </p>
            {agents.length === 0 && (
              <div className="onboarding-actions">
                <form className="action-card" onSubmit={createFakeAgent}>
                  <span className="action-kicker">TRY IT NOW</span>
                  <strong>Add a demo Agent</strong>
                  <p>Use the in-process runtime to explore mentions and replies.</p>
                  <input
                    aria-label="Demo Agent name"
                    onChange={(event) => setAgentName(event.target.value)}
                    placeholder="Review Bot"
                    required
                    value={agentName}
                  />
                  <button disabled={busy}>{busy ? "Adding…" : "Add demo Agent"}</button>
                </form>
                <div className="action-card">
                  <span className="action-kicker">USE YOUR RUNTIME</span>
                  <strong>Connect a real Agent</strong>
                  <p>Create an MCP token or pair the Go Bridge with local Codex.</p>
                  <button onClick={revealConnectionSetup} type="button">Open connection setup</button>
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="timeline" aria-label="Room messages">
            {messages.map((message) => (
              <article className="message" key={message.messageId}>
                <span className={`avatar ${message.senderType}`}>{message.senderType === "agent" ? "A" : "U"}</span>
                <div>
                  <header>
                    <strong>{message.senderType === "agent" ? "Agent" : session?.displayName}</strong>
                    <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  </header>
                  <p>{message.content}</p>
                  {(message.mentions.length > 0 || runs.some((run) => run.triggerMessageId === message.messageId)) && (
                    <div className="message-routing">
                      {message.mentions.map((mention) => (
                        <span className="mention-pill" key={mention.targetAgentId}>
                          @{mention.displayLabel}
                        </span>
                      ))}
                      {runs.filter((run) => run.triggerMessageId === message.messageId).map((run) => (
                        <span className="run-card" key={run.runId} title={run.runId}>
                          <strong>{agentsById.get(run.targetAgentId)?.name ?? "Agent"}</strong>
                          <span className={`run-state ${run.state}`}>
                            {run.state.replace("_", " ")}
                          </span>
                          {["queued", "delivered", "working", "input_required"].includes(run.state) && (
                            <button type="button" onClick={() => void cancelRun(run.runId)}>Cancel</button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </section>
        )}
        {selectedRoom && (
          <form className="composer" onSubmit={sendMessage}>
            <select
              aria-label="Mention an Agent"
              onChange={(event) => setMentionAgentId(event.target.value)}
              value={mentionAgentId}
            >
              <option value="">No Agent mention</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  @{agent.name} · {agent.role}
                </option>
              ))}
            </select>
            <textarea
              aria-label="Message"
              onChange={(event) => setMessageContent(event.target.value)}
              placeholder={`Message #${selectedRoom.name}`}
              required
              rows={2}
              value={messageContent}
            />
            <button disabled={busy}>{busy ? "Sending…" : "Send"}</button>
          </form>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
      </main>
    </div>
  );
}
