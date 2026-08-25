import type { FormEvent } from "react";

import { type Locale, type TranslationKey, translate } from "../../i18n.js";
import type { Room, Team } from "../../models.js";

interface TeamCreateDialogProps {
  busy: boolean;
  locale: Locale;
  name: string;
  onClose: () => void;
  onNameChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void | Promise<void>;
}

export function TeamCreateDialog({
  busy,
  locale,
  name,
  onClose,
  onNameChange,
  onSubmit
}: TeamCreateDialogProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section aria-labelledby="new-team-dialog-title" aria-modal="true" className="modal-card" role="dialog">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">{t("teamSpace")}</p>
            <h3 id="new-team-dialog-title">{t("newTeam")}</h3>
          </div>
          <button aria-label={t("cancel")} onClick={onClose} type="button">×</button>
        </div>
        <p>{t("newTeamHelp")}</p>
        <form className="modal-form" onSubmit={(event) => void onSubmit(event)}>
          <label htmlFor="new-team-name">{t("newTeamName")}</label>
          <input autoComplete="off" autoFocus id="new-team-name" onChange={(event) => onNameChange(event.target.value)} required value={name} />
          <div className="modal-actions">
            <button className="secondary-action" onClick={onClose} type="button">{t("cancel")}</button>
            <button className="primary-action" disabled={busy}>{busy ? t("creating") : t("createTeam")}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

interface RoomArchiveDialogProps {
  busy: boolean;
  hasActiveWork: boolean;
  locale: Locale;
  room: Room;
  onArchive: () => void | Promise<void>;
  onClose: () => void;
}

export function RoomArchiveDialog({
  busy,
  hasActiveWork,
  locale,
  onArchive,
  onClose,
  room
}: RoomArchiveDialogProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !busy) onClose();
    }}>
      <section aria-labelledby="archive-room-dialog-title" aria-modal="true" className="modal-card archive-room-modal" role="dialog">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">{locale === "zh-CN" ? "可恢复操作" : "RECOVERABLE ACTION"}</p>
            <h3 id="archive-room-dialog-title">
              {locale === "zh-CN" ? `归档 #${room.name}` : `Archive #${room.name}`}
            </h3>
          </div>
          <button aria-label={t("cancel")} disabled={busy} onClick={onClose} type="button">×</button>
        </div>
        <p>
          {locale === "zh-CN"
            ? "房间会从普通列表隐藏，但消息、运行、讨论和稳定 ID 都会保留。之后可在资源生命周期中恢复。"
            : "The Room will leave normal navigation while Messages, Runs, Discussions, and stable IDs remain recoverable from Resource lifecycle."}
        </p>
        {hasActiveWork && (
          <p className="archive-room-blocked" role="status">
            {locale === "zh-CN"
              ? "当前仍有运行或讨论，请结束后再归档。"
              : "Finish the active Runs or Discussion before archiving."}
          </p>
        )}
        <div className="modal-actions">
          <button className="secondary-action" disabled={busy} onClick={onClose} type="button">{t("cancel")}</button>
          <button className="danger-action" disabled={busy || hasActiveWork} onClick={() => void onArchive()} type="button">
            {busy
              ? (locale === "zh-CN" ? "归档中…" : "Archiving…")
              : (locale === "zh-CN" ? "确认归档房间" : "Confirm archive")}
          </button>
        </div>
      </section>
    </div>
  );
}

interface ResourceLifecycleDialogProps {
  busy: boolean;
  locale: Locale;
  names: Record<string, string>;
  rooms: Room[];
  selectedTeam: Team | null;
  selectedTeamId: string | null;
  teams: Team[];
  onClose: () => void;
  onNameChange: (resourceId: string, value: string) => void;
  onSelectTeam: (teamId: string) => void | Promise<void>;
  onUpdateRoom: (room: Room, update: { name?: string; archived?: boolean }) => void | Promise<unknown>;
  onUpdateTeam: (team: Team, update: { name?: string; archived?: boolean }) => void | Promise<unknown>;
}

export function ResourceLifecycleDialog({
  busy,
  locale,
  names,
  onClose,
  onNameChange,
  onSelectTeam,
  onUpdateRoom,
  onUpdateTeam,
  rooms,
  selectedTeam,
  selectedTeamId,
  teams
}: ResourceLifecycleDialogProps) {
  const t = (key: TranslationKey) => translate(locale, key);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section aria-labelledby="resource-lifecycle-dialog-title" aria-modal="true" className="modal-card lifecycle-modal" role="dialog">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">{locale === "zh-CN" ? "可恢复资源" : "RECOVERABLE RESOURCES"}</p>
            <h3 id="resource-lifecycle-dialog-title">
              {locale === "zh-CN" ? "管理 Team 与房间" : "Manage Teams and Rooms"}
            </h3>
          </div>
          <button aria-label={t("cancel")} onClick={onClose} type="button">×</button>
        </div>
        <p>
          {locale === "zh-CN"
            ? "归档会从普通导航隐藏资源，但会保留消息、运行、讨论和稳定 ID；存在活动任务时会被安全拦截。"
            : "Archiving hides resources from normal navigation while retaining history and stable IDs. Active work blocks the action."}
        </p>
        {busy && teams.length === 0 ? (
          <p>{locale === "zh-CN" ? "正在载入资源…" : "Loading resources…"}</p>
        ) : (
          <div className="lifecycle-layout">
            <nav aria-label={locale === "zh-CN" ? "选择 Team" : "Select Team"} className="lifecycle-team-list">
              {teams.map((team) => (
                <button className={team.teamId === selectedTeamId ? "active" : ""} key={team.teamId} onClick={() => void onSelectTeam(team.teamId)} type="button">
                  <strong>{team.name}</strong>
                  <small>{team.archivedAt
                    ? (locale === "zh-CN" ? "已归档" : "Archived")
                    : (locale === "zh-CN" ? "使用中" : "Active")}</small>
                </button>
              ))}
            </nav>
            {selectedTeam && (
              <div className="lifecycle-resource-list">
                <section className="lifecycle-resource-row team-resource">
                  <div><strong>Team</strong><small>{selectedTeam.teamId}</small></div>
                  <input aria-label={locale === "zh-CN" ? "Team 名称" : "Team name"} onChange={(event) => onNameChange(selectedTeam.teamId, event.target.value)} value={names[selectedTeam.teamId] ?? selectedTeam.name} />
                  <div className="lifecycle-actions">
                    <button disabled={busy || !names[selectedTeam.teamId]?.trim() || names[selectedTeam.teamId] === selectedTeam.name} onClick={() => void onUpdateTeam(selectedTeam, { name: names[selectedTeam.teamId]! })} type="button">
                      {locale === "zh-CN" ? "保存名称" : "Save name"}
                    </button>
                    <button className={selectedTeam.archivedAt ? "restore-action" : "archive-action"} disabled={busy} onClick={() => void onUpdateTeam(selectedTeam, { archived: !selectedTeam.archivedAt })} type="button">
                      {selectedTeam.archivedAt
                        ? (locale === "zh-CN" ? "恢复 Team" : "Restore Team")
                        : (locale === "zh-CN" ? "归档 Team" : "Archive Team")}
                    </button>
                  </div>
                </section>
                <h4>{locale === "zh-CN" ? "房间" : "Rooms"}</h4>
                {rooms.length === 0 ? (
                  <p>{locale === "zh-CN" ? "这个 Team 还没有房间。" : "This Team has no Rooms yet."}</p>
                ) : rooms.map((room) => (
                  <section className="lifecycle-resource-row" key={room.roomId}>
                    <div>
                      <strong># {room.name}</strong>
                      <small>{room.archivedAt
                        ? (locale === "zh-CN" ? "已归档" : "Archived")
                        : (locale === "zh-CN" ? "使用中" : "Active")}</small>
                    </div>
                    <input aria-label={locale === "zh-CN" ? `${room.name} 房间名称` : `${room.name} Room name`} onChange={(event) => onNameChange(room.roomId, event.target.value)} value={names[room.roomId] ?? room.name} />
                    <div className="lifecycle-actions">
                      <button disabled={busy || !names[room.roomId]?.trim() || names[room.roomId] === room.name} onClick={() => void onUpdateRoom(room, { name: names[room.roomId]! })} type="button">
                        {locale === "zh-CN" ? "保存名称" : "Save name"}
                      </button>
                      <button className={room.archivedAt ? "restore-action" : "archive-action"} disabled={busy || Boolean(selectedTeam.archivedAt && room.archivedAt)} onClick={() => void onUpdateRoom(room, { archived: !room.archivedAt })} type="button">
                        {room.archivedAt
                          ? (locale === "zh-CN" ? "恢复房间" : "Restore Room")
                          : (locale === "zh-CN" ? "归档房间" : "Archive Room")}
                      </button>
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
