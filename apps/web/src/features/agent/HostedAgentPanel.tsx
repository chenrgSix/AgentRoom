import React, {
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { jsonRequest } from "../../api-client.js";
import { type Locale, type TranslationKey, translate } from "../../i18n.js";
import type {
  Agent,
  HostedAgentConfiguration,
  HostedProviderTestObservation,
  Room
} from "../../models.js";

interface HostedAgentPanelProps {
  agents: Agent[];
  currentMemberIsOwner: boolean;
  locale: Locale;
  rooms: Room[];
  sessionToken: string | undefined;
  teamId: string;
  onAgentChanged?: (agent: Agent) => void;
  onOpenRoom?: ((roomId: string) => void) | undefined;
}

const provider = "openai_responses" as const;

const failureHelpKeys: Readonly<Record<string, TranslationKey>> = {
  HOSTED_PROVIDER_AUTHENTICATION_FAILED: "hostedFailureAuthentication",
  HOSTED_PROVIDER_RATE_LIMITED: "hostedFailureRateLimit",
  HOSTED_PROVIDER_UNAVAILABLE: "hostedFailureUnavailable",
  HOSTED_PROVIDER_TRANSPORT_UNKNOWN: "hostedFailureUnavailable",
  HOSTED_PROVIDER_REQUEST_REJECTED: "hostedFailureModel",
  HOSTED_CONFIGURATION_INVALID: "hostedFailureModel",
  HOSTED_PROVIDER_PROBE_TIMEOUT: "hostedFailureTimeout",
  HOSTED_PROVIDER_PROBE_CANCELED: "hostedFailureTimeout",
  HOSTED_REQUEST_ABORTED: "hostedFailureTimeout"
};

export function hostedFailureHelp(code: string | null | undefined, locale: Locale): string {
  const key = code && Object.hasOwn(failureHelpKeys, code)
    ? failureHelpKeys[code]!
    : "hostedFailureUnknown";
  return translate(locale, key);
}

const hostedPresences = new Set<HostedAgentConfiguration["presence"]>([
  "ready",
  "busy",
  "degraded",
  "offline"
]);

function hostedPresence(value: string): HostedAgentConfiguration["presence"] {
  return hostedPresences.has(value as HostedAgentConfiguration["presence"])
    ? value as HostedAgentConfiguration["presence"]
    : "degraded";
}

function projectedAgent(configuration: HostedAgentConfiguration): Agent {
  return {
    agentId: configuration.agentId,
    enabled: configuration.enabled,
    integrationMode: "hosted",
    name: configuration.name,
    presence: configuration.presence,
    role: configuration.role
  };
}

function localizedPresence(
  presence: HostedAgentConfiguration["presence"],
  locale: Locale
): string {
  if (locale === "en") return presence;
  return {
    ready: "就绪",
    busy: "忙碌",
    degraded: "受限",
    offline: "离线"
  }[presence];
}

function observationTime(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.getTime()) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(parsed);
}

function TestObservation({
  locale,
  observation
}: {
  locale: Locale;
  observation: HostedProviderTestObservation | null;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  if (!observation) return <span>{t("hostedNoTest")}</span>;
  const observedAt = observationTime(observation.observedAt, locale);
  const failureCode = observation.failureCode &&
    Object.hasOwn(failureHelpKeys, observation.failureCode)
    ? observation.failureCode
    : null;
  return (
    <span className={`hosted-test-observation ${observation.status}`}>
      <strong>
        {observation.status === "succeeded"
          ? t("hostedTestSucceeded")
          : t("hostedTestFailed")}
      </strong>
      {observation.status === "failed" && (
        <span className="hosted-failure-help">
          {hostedFailureHelp(observation.failureCode, locale)}
        </span>
      )}
      {failureCode && <code>{failureCode}</code>}
      {observedAt && (
        <time dateTime={observation.observedAt}>{observedAt}</time>
      )}
    </span>
  );
}

export function HostedAgentPanel({
  agents,
  currentMemberIsOwner,
  locale,
  onAgentChanged,
  onOpenRoom,
  rooms,
  sessionToken,
  teamId
}: HostedAgentPanelProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [configurations, setConfigurations] = useState<HostedAgentConfiguration[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionTest, setConnectionTest] =
    useState<HostedProviderTestObservation | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [profileApiKeys, setProfileApiKeys] = useState<Record<string, string>>({});
  const scopeToken = useMemo(
    () => ({ currentMemberIsOwner, sessionToken, teamId }),
    [currentMemberIsOwner, sessionToken, teamId]
  );
  const activeScope = useRef<typeof scopeToken | null>(scopeToken);
  activeScope.current = scopeToken;
  const loadedConfigurationScope = useRef<typeof scopeToken | null>(null);

  const activeRooms = rooms.filter((room) => room.teamId === teamId && !room.archivedAt);
  const selectedActiveRoomIds = selectedRoomIds.filter((roomId) =>
    activeRooms.some((room) => room.roomId === roomId)
  );

  useEffect(() => () => {
    if (activeScope.current === scopeToken) activeScope.current = null;
  }, [scopeToken]);

  useEffect(() => {
    setApiKey("");
    setProfileApiKeys({});
    setConnectionTest(null);
    setName("");
    setRole("");
    setModel("");
    setSelectedRoomIds([]);
    setBusyAction(null);
    setNotice(null);
    setError(null);
  }, [scopeToken]);

  useEffect(() => {
    if (!currentMemberIsOwner) {
      setConfigurations([]);
      loadedConfigurationScope.current = null;
      return;
    }
    let canceled = false;
    const initialLoad = loadedConfigurationScope.current !== scopeToken;
    if (initialLoad) {
      setLoading(true);
      setError(null);
    }
    void jsonRequest<HostedAgentConfiguration[]>(
      `/api/teams/${teamId}/hosted-agents`,
      { cache: "no-store" },
      sessionToken
    ).then((next) => {
      if (canceled) return;
      const exactTeam = next.filter((item) => item.teamId === teamId);
      if (initialLoad) {
        setConfigurations(exactTeam);
        setModelDrafts(Object.fromEntries(
          exactTeam.map((item) => [item.agentId, item.model])
        ));
      } else {
        const byId = new Map(exactTeam.map((item) => [item.agentId, item]));
        setConfigurations((current) => current.map((configuration) => {
          const refreshed = byId.get(configuration.agentId);
          if (!refreshed) return configuration;
          return {
            ...configuration,
            enabled: refreshed.enabled,
            presence: refreshed.presence,
            roomIds: refreshed.roomIds,
            configurationLocked: refreshed.configurationLocked,
            hasActiveWork: refreshed.hasActiveWork
          };
        }));
      }
      loadedConfigurationScope.current = scopeToken;
    }).catch(() => {
      if (!canceled) setError(t("hostedActionFailed"));
    }).finally(() => {
      if (!canceled) setLoading(false);
    });
    return () => {
      canceled = true;
    };
  }, [agents, currentMemberIsOwner, scopeToken, sessionToken, teamId]);

  useEffect(() => {
    const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
    setConfigurations((current) => current.map((configuration) => {
      const agent = byId.get(configuration.agentId);
      if (!agent || agent.integrationMode !== "hosted") return configuration;
      const nextEnabled = agent.enabled !== false;
      const nextPresence = hostedPresence(agent.presence);
      if (
        configuration.enabled === nextEnabled &&
        configuration.presence === nextPresence
      ) return configuration;
      return {
        ...configuration,
        enabled: nextEnabled,
        presence: nextPresence
      };
    }));
  }, [agents, configurations.length]);

  if (!currentMemberIsOwner) return null;

  const scopeIsActive = (actionScope: typeof scopeToken): boolean =>
    activeScope.current === actionScope;

  const replaceConfiguration = (
    next: HostedAgentConfiguration,
    actionScope: typeof scopeToken
  ): void => {
    if (!scopeIsActive(actionScope) || next.teamId !== teamId) return;
    setConfigurations((current) => {
      const exists = current.some(({ agentId }) => agentId === next.agentId);
      return exists
        ? current.map((item) => item.agentId === next.agentId ? next : item)
        : [...current, next];
    });
    setModelDrafts((current) => ({ ...current, [next.agentId]: next.model }));
    onAgentChanged?.(projectedAgent(next));
  };

  const refreshConfiguration = async (
    agentId: string,
    actionScope: typeof scopeToken,
    showRecoveryNotice = false
  ): Promise<HostedAgentConfiguration | null> => {
    const next = await jsonRequest<HostedAgentConfiguration[]>(
      `/api/teams/${teamId}/hosted-agents`,
      { cache: "no-store" },
      sessionToken
    );
    if (!scopeIsActive(actionScope)) return null;
    const exactTeam = next.filter((item) => item.teamId === teamId);
    setConfigurations(exactTeam);
    setModelDrafts(Object.fromEntries(
      exactTeam.map((item) => [item.agentId, item.model])
    ));
    const refreshed = exactTeam.find((item) => item.agentId === agentId) ?? null;
    if (refreshed) onAgentChanged?.(projectedAgent(refreshed));
    if (showRecoveryNotice) {
      setNotice(null);
      setError(t("hostedConfigurationReloaded"));
    }
    return refreshed;
  };

  const failSafely = (): void => {
    setNotice(null);
    setError(t("hostedActionFailed"));
  };

  const testConnection = async (): Promise<void> => {
    if (busyAction !== null || !model.trim() || !apiKey) return;
    const actionScope = scopeToken;
    setBusyAction("connection-test");
    setError(null);
    setNotice(null);
    setConnectionTest(null);
    try {
      const observation = await jsonRequest<HostedProviderTestObservation>(
        `/api/teams/${teamId}/hosted-agent-tests`,
        {
          cache: "no-store",
          method: "POST",
          body: JSON.stringify({ provider, model: model.trim(), apiKey })
        },
        sessionToken
      );
      if (!scopeIsActive(actionScope)) return;
      setConnectionTest(observation);
      if (observation.status === "succeeded") {
        setNotice(t("hostedConnectionTestPassed"));
      }
    } catch {
      if (scopeIsActive(actionScope)) failSafely();
    } finally {
      if (scopeIsActive(actionScope)) {
        setApiKey("");
        setBusyAction(null);
      }
    }
  };

  const createHostedAgent = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busyAction !== null || !name.trim() || !role.trim() || !model.trim() || !apiKey) return;
    const actionScope = scopeToken;
    setBusyAction("create");
    setError(null);
    setNotice(null);
    try {
      const created = await jsonRequest<HostedAgentConfiguration>(
        `/api/teams/${teamId}/hosted-agents`,
        {
          cache: "no-store",
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            role: role.trim(),
            provider,
            model: model.trim(),
            apiKey,
            roomIds: selectedActiveRoomIds
          })
        },
        sessionToken
      );
      if (!scopeIsActive(actionScope)) return;
      replaceConfiguration(created, actionScope);
      setName("");
      setRole("");
      setModel("");
      setSelectedRoomIds([]);
      setConnectionTest(null);
      setNotice(t(created.roomIds.length > 0
        ? "hostedCreatedReady"
        : "hostedCreatedWithoutRoom"));
    } catch {
      if (scopeIsActive(actionScope)) {
        setApiKey("");
        try {
          await refreshConfiguration("", actionScope);
        } catch {
          // Preserve the safe failure notice even if the read-only refresh fails.
        }
        if (scopeIsActive(actionScope)) {
          setNotice(null);
          setError(t("hostedCreateFailed"));
        }
      }
    } finally {
      if (scopeIsActive(actionScope)) {
        setApiKey("");
        setBusyAction(null);
      }
    }
  };

  const testConfigured = async (
    configuration: HostedAgentConfiguration
  ): Promise<void> => {
    const action = `test:${configuration.agentId}`;
    const actionScope = scopeToken;
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      const observation = await jsonRequest<HostedProviderTestObservation>(
        `/api/hosted-agents/${configuration.agentId}/tests`,
        { cache: "no-store", method: "POST" },
        sessionToken
      );
      if (!scopeIsActive(actionScope)) return;
      const refreshed = await refreshConfiguration(
        configuration.agentId,
        actionScope
      );
      if (!refreshed && scopeIsActive(actionScope)) {
        setConfigurations((current) => current.map((item) =>
          item.agentId === configuration.agentId
            ? { ...item, latestTest: observation }
            : item
        ));
      }
    } catch {
      if (scopeIsActive(actionScope)) failSafely();
    } finally {
      if (scopeIsActive(actionScope)) setBusyAction(null);
    }
  };

  const updateProfile = async (
    event: FormEvent,
    configuration: HostedAgentConfiguration
  ): Promise<void> => {
    event.preventDefault();
    const action = `profile:${configuration.agentId}`;
    const actionScope = scopeToken;
    const nextModel = modelDrafts[configuration.agentId]?.trim() ?? "";
    const nextApiKey = profileApiKeys[configuration.agentId] ?? "";
    if (!nextModel || (configuration.credentialRevoked && !nextApiKey)) return;
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      const updated = await jsonRequest<HostedAgentConfiguration>(
        `/api/hosted-agents/${configuration.agentId}/profile`,
        {
          cache: "no-store",
          method: "PATCH",
          body: JSON.stringify({
            expectedProfileRevision: configuration.profileRevision,
            model: nextModel,
            ...(nextApiKey ? { apiKey: nextApiKey } : {})
          })
        },
        sessionToken
      );
      if (!scopeIsActive(actionScope)) return;
      replaceConfiguration(updated, actionScope);
    } catch {
      if (scopeIsActive(actionScope)) {
        try {
          await refreshConfiguration(
            configuration.agentId,
            actionScope,
            true
          );
        } catch {
          if (scopeIsActive(actionScope)) failSafely();
        }
      }
    } finally {
      if (scopeIsActive(actionScope)) {
        setProfileApiKeys((current) => ({
          ...current,
          [configuration.agentId]: ""
        }));
        setBusyAction(null);
      }
    }
  };

  const revokeCredential = async (
    configuration: HostedAgentConfiguration
  ): Promise<void> => {
    const action = `revoke:${configuration.agentId}`;
    const actionScope = scopeToken;
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      const updated = await jsonRequest<HostedAgentConfiguration>(
        `/api/hosted-agents/${configuration.agentId}/credential/revoke`,
        {
          cache: "no-store",
          method: "POST",
          body: JSON.stringify({
            expectedProfileRevision: configuration.profileRevision
          })
        },
        sessionToken
      );
      if (!scopeIsActive(actionScope)) return;
      replaceConfiguration(updated, actionScope);
    } catch {
      if (scopeIsActive(actionScope)) {
        try {
          await refreshConfiguration(
            configuration.agentId,
            actionScope,
            true
          );
        } catch {
          if (scopeIsActive(actionScope)) failSafely();
        }
      }
    } finally {
      if (scopeIsActive(actionScope)) {
        setProfileApiKeys((current) => ({
          ...current,
          [configuration.agentId]: ""
        }));
        setBusyAction(null);
      }
    }
  };

  const setEnabled = async (
    configuration: HostedAgentConfiguration,
    enabled: boolean
  ): Promise<void> => {
    const action = `enabled:${configuration.agentId}`;
    const actionScope = scopeToken;
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      const updated = await jsonRequest<Agent>(
        `/api/agents/${configuration.agentId}`,
        {
          cache: "no-store",
          method: "PATCH",
          body: JSON.stringify({ enabled })
        },
        sessionToken
      );
      if (!scopeIsActive(actionScope)) return;
      setConfigurations((current) => current.map((item) =>
        item.agentId === configuration.agentId
          ? {
              ...item,
              enabled: updated.enabled !== false,
              presence: hostedPresence(updated.presence)
            }
          : item
      ));
      onAgentChanged?.(updated);
    } catch {
      if (scopeIsActive(actionScope)) failSafely();
    } finally {
      if (scopeIsActive(actionScope)) setBusyAction(null);
    }
  };

  return (
    <section className="control-panel hosted-agent-panel" aria-labelledby="hosted-agent-panel-title">
      <div className="panel-header hosted-agent-heading">
        <div>
          <p className="eyebrow">{t("hostedAgents")}</p>
          <h3 id="hosted-agent-panel-title">{t("hostedAgentConfig")}</h3>
        </div>
        <span>Owner</span>
      </div>
      <p className="hosted-agent-intro">{t("hostedAgentConfigHelp")}</p>
      <p className="hosted-agent-boundary"><strong>{t("hostedRemoteOnly")}</strong></p>

      <form className="hosted-create-form" onSubmit={(event) => void createHostedAgent(event)}>
        <div className="hosted-create-fields">
          <label>
            {t("hostedAgentName")}
            <input
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label>
            {t("hostedAgentRole")}
            <input
              autoComplete="off"
              onChange={(event) => setRole(event.target.value)}
              required
              value={role}
            />
          </label>
          <label>
            {t("hostedProvider")}
            <output>OpenAI Responses API</output>
          </label>
          <label>
            {t("hostedModel")}
            <input
              autoComplete="off"
              onChange={(event) => setModel(event.target.value)}
              required
              value={model}
            />
          </label>
        </div>

        <fieldset className="hosted-room-picker">
          <legend>{t("hostedRooms")}</legend>
          <small>{t("hostedRoomsHelp")}</small>
          {activeRooms.length === 0 ? (
            <p>{t("hostedNoAvailableRooms")}</p>
          ) : (
            <div>
              {activeRooms.map((room) => (
                <label key={room.roomId}>
                  <input
                    checked={selectedActiveRoomIds.includes(room.roomId)}
                    onChange={(event) => setSelectedRoomIds((current) =>
                      event.target.checked
                        ? [...current, room.roomId]
                        : current.filter((roomId) => roomId !== room.roomId)
                    )}
                    type="checkbox"
                  />
                  <span># {room.name}</span>
                </label>
              ))}
            </div>
          )}
          {activeRooms.length > 0 && selectedActiveRoomIds.length === 0 && (
            <p className="hosted-room-guidance">{t("hostedNoRoomWarning")}</p>
          )}
        </fieldset>

        <label className="hosted-key-field">
          {t("hostedApiKey")}
          <input
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            required
            type="password"
            value={apiKey}
          />
          <small>{t("hostedApiKeyHelp")}</small>
        </label>
        <p className="hosted-submit-help">{t("hostedCreateHelp")}</p>
        <div className="hosted-form-actions">
          <button disabled={busyAction !== null} type="submit">
            {busyAction === "create" ? t("hostedCreating") : t("hostedCreate")}
          </button>
        </div>
        <details className="hosted-advanced-test">
          <summary>{t("hostedAdvancedTest")}</summary>
          <p>{t("hostedAdvancedTestHelp")}</p>
          <div className="hosted-form-actions">
            <button
              disabled={busyAction !== null || !model.trim() || !apiKey}
              onClick={() => void testConnection()}
              type="button"
            >
              {busyAction === "connection-test" ? t("hostedTesting") : t("hostedTestConnection")}
            </button>
          </div>
        </details>
        {connectionTest && (
          <div className="hosted-connection-observation">
            <span>{t("hostedLatestTest")}</span>
            <TestObservation locale={locale} observation={connectionTest} />
          </div>
        )}
      </form>

      {error && <p className="hosted-feedback error" role="alert">{error}</p>}
      {notice && <p className="hosted-feedback success" role="status">{notice}</p>}

      {loading ? (
        <p className="hosted-agent-empty">{t("hostedLoading")}</p>
      ) : configurations.length === 0 ? (
        <p className="hosted-agent-empty">{t("hostedEmpty")}</p>
      ) : (
        <div className="hosted-profile-list">
          {configurations.map((configuration) => {
            const profileAction = `profile:${configuration.agentId}`;
            const testAction = `test:${configuration.agentId}`;
            const revokeAction = `revoke:${configuration.agentId}`;
            const enabledAction = `enabled:${configuration.agentId}`;
            const profileLocked = configuration.configurationLocked;
            const authorizedRooms = activeRooms.filter((room) =>
              configuration.roomIds.includes(room.roomId)
            );
            return (
              <article className="hosted-profile-card" key={configuration.agentId}>
                <header>
                  <div>
                    <h4>{configuration.name}</h4>
                    <p>{configuration.role}</p>
                  </div>
                  <span className={`status-badge ${configuration.enabled ? configuration.presence : "offline"}`}>
                    <span className={`presence-dot ${configuration.enabled ? configuration.presence : "offline"}`} />
                    {configuration.enabled
                      ? localizedPresence(configuration.presence, locale)
                      : t("hostedDisable")}
                  </span>
                </header>

                <dl className="hosted-profile-facts">
                  <div><dt>{t("hostedProvider")}</dt><dd>OpenAI Responses API</dd></div>
                  <div><dt>{t("hostedModel")}</dt><dd>{configuration.model}</dd></div>
                  <div>
                    <dt>{t("hostedRooms")}</dt>
                    <dd>{authorizedRooms.length > 0
                      ? authorizedRooms.map((room) => `# ${room.name}`).join(", ")
                      : t("hostedNoRooms")}</dd>
                  </div>
                  <div><dt>{t("hostedProfileRevision")}</dt><dd>{configuration.profileRevision}</dd></div>
                  <div>
                    <dt>{t("hostedCredential")}</dt>
                    <dd>
                      {configuration.credentialRevoked
                        ? t("hostedCredentialRevoked")
                        : configuration.credentialConfigured
                          ? t("hostedCredentialConfigured")
                          : t("hostedCredentialMissing")}
                    </dd>
                  </div>
                  <div><dt>{t("hostedPresence")}</dt><dd>{localizedPresence(configuration.presence, locale)}</dd></div>
                  <div className="hosted-latest-test">
                    <dt>{t("hostedLatestTest")}</dt>
                    <dd><TestObservation locale={locale} observation={configuration.latestTest} /></dd>
                  </div>
                </dl>

                {authorizedRooms.length === 0 ? (
                  <p className="hosted-room-guidance">{t("hostedRoomSetupHelp")}</p>
                ) : onOpenRoom && (
                  <div className="hosted-room-links">
                    {authorizedRooms.map((room) => (
                      <button
                        key={room.roomId}
                        onClick={() => onOpenRoom(room.roomId)}
                        type="button"
                      >
                        {t("hostedOpenRoom")} · # {room.name}
                      </button>
                    ))}
                  </div>
                )}

                {profileLocked && (
                  <p className="hosted-profile-fence" role="status">
                    {t("hostedActiveWorkFence")}
                  </p>
                )}

                <form className="hosted-profile-form" onSubmit={(event) => void updateProfile(event, configuration)}>
                  <label>
                    {t("hostedModel")}
                    <input
                      autoComplete="off"
                      disabled={busyAction !== null || profileLocked}
                      onChange={(event) => setModelDrafts((current) => ({
                        ...current,
                        [configuration.agentId]: event.target.value
                      }))}
                      required
                      value={modelDrafts[configuration.agentId] ?? configuration.model}
                    />
                  </label>
                  <label>
                    {t("hostedReplaceApiKey")}
                    <input
                      autoComplete="off"
                      disabled={busyAction !== null || profileLocked}
                      onChange={(event) => setProfileApiKeys((current) => ({
                        ...current,
                        [configuration.agentId]: event.target.value
                      }))}
                      required={configuration.credentialRevoked}
                      type="password"
                      value={profileApiKeys[configuration.agentId] ?? ""}
                    />
                    <small>
                      {configuration.credentialRevoked
                        ? t("hostedRevokedReplacementHelp")
                        : t("hostedReplaceApiKeyHelp")}
                    </small>
                  </label>
                  <div className="hosted-profile-actions">
                    <button
                      disabled={
                        busyAction !== null ||
                        profileLocked ||
                        (configuration.credentialRevoked &&
                          !(profileApiKeys[configuration.agentId] ?? ""))
                      }
                      type="submit"
                    >
                      {busyAction === profileAction
                        ? t("hostedSavingProfile")
                        : configuration.credentialRevoked
                          ? t("hostedRestoreCredential")
                          : t("hostedSaveProfile")}
                    </button>
                    <button
                      disabled={busyAction !== null || configuration.credentialRevoked}
                      onClick={() => void testConfigured(configuration)}
                      type="button"
                    >
                      {busyAction === testAction ? t("hostedTesting") : t("hostedRunTest")}
                    </button>
                    <button
                      disabled={busyAction !== null || configuration.credentialRevoked}
                      onClick={() => void revokeCredential(configuration)}
                      type="button"
                    >
                      {busyAction === revokeAction ? t("hostedTesting") : t("hostedRevokeCredential")}
                    </button>
                    <button
                      disabled={busyAction !== null}
                      onClick={() => void setEnabled(configuration, !configuration.enabled)}
                      type="button"
                    >
                      {busyAction === enabledAction
                        ? t("hostedTesting")
                        : configuration.enabled ? t("hostedDisable") : t("hostedEnable")}
                    </button>
                  </div>
                </form>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
