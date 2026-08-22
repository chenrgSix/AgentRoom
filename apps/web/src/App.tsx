import { type FormEvent, useEffect, useMemo, useState } from "react";

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

interface Run {
  runId: string;
  triggerMessageId: string;
  targetAgentId: string;
  state: "queued" | "delivered" | "working" | "input_required" | "completed" | "failed" | "canceled" | "outcome_unknown";
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");
  const [roomName, setRoomName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [messageContent, setMessageContent] = useState("");
  const [mentionAgentId, setMentionAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedTeam = useMemo(
    () => teams.find((team) => team.teamId === selectedTeamId) ?? null,
    [selectedTeamId, teams]
  );
  const selectedRoom = useMemo(
    () => rooms.find((room) => room.roomId === selectedRoomId) ?? null,
    [rooms, selectedRoomId]
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
      )
    ]).then(([nextRooms, nextAgents]) => {
      setRooms(nextRooms);
      setAgents(nextAgents);
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
            value={teamName}
          />
          <button disabled={busy || !teamName.trim()} title="Create Team">+</button>
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
              value={roomName}
            />
            <button disabled={busy || !roomName.trim()}>Create</button>
          </form>
        )}
        {selectedTeam && (
          <form className="room-create agent-create" onSubmit={createFakeAgent}>
            <input
              aria-label="New Fake Agent name"
              onChange={(event) => setAgentName(event.target.value)}
              placeholder="Add a Fake Agent"
              value={agentName}
            />
            <button disabled={busy || !agentName.trim()}>Add Agent</button>
          </form>
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
        {messages.length === 0 ? (
          <section className="empty-stage">
            <div className="orb"><span>✦</span></div>
            <p className="eyebrow">CENTRAL TEAM READY</p>
            <h3>{selectedRoom ? `Start the conversation in #${selectedRoom.name}` : "Create a Team and Room"}</h3>
            <p>
              Messages, structured Agent mentions, Runs, and replies will appear
              here as one durable Team timeline.
            </p>
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
                        <span className={`run-state ${run.state}`} key={run.runId}>
                          {run.state.replace("_", " ")}
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
              rows={2}
              value={messageContent}
            />
            <button disabled={busy || !messageContent.trim()}>Send</button>
          </form>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
      </main>
    </div>
  );
}
