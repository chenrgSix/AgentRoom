import type { ReactNode } from "react";
import { type Locale, translate } from "../../i18n.js";
import type { Room, Team, WorkspaceView } from "../../models.js";
import { isManagementView } from "./workspace-navigation.js";

interface Props {
  activeView: WorkspaceView;
  locale: Locale;
  teams: Team[];
  teamId: string | null;
  rooms: Room[];
  roomId: string | null;
  children?: ReactNode;
  onTeam: (teamId: string) => void;
  onNewTeam: () => void;
  onNewRoom: () => void;
  onRoom: (roomId: string) => void;
  onView: (view: WorkspaceView) => void;
  onCollaboration: () => void;
}

export function WorkspaceSidebar(props: Props) {
  const { activeView, locale, teams, teamId, rooms, roomId, children } = props;
  const zh = locale === "zh-CN";
  const managing = isManagementView(activeView);
  const destinations = [
    ["agents", zh ? "智能体" : "Agents", "✦"],
    ["devices", zh ? "设备" : "Devices", "▣"],
    ["members", zh ? "团队与成员" : "Team & members", "♙"],
    ["security", zh ? "账户与安全" : "Account & security", "⚙"]
  ] as const;
  return (
    <aside className="product-sidebar" aria-label={zh ? "工作区导航" : "Workspace navigation"}>
      <div className="product-brand"><span className="brand-mark" aria-hidden="true">CW</span><strong>ConveneWire</strong></div>
      <div className="product-team-picker">
        <select aria-label={zh ? "选择团队" : "Select Team"} value={teamId ?? ""} onChange={(event) => props.onTeam(event.target.value)}>
          {!teamId && <option value="">{zh ? "选择团队" : "Select Team"}</option>}
          {teams.map((team) => <option value={team.teamId} key={team.teamId}>{team.name}</option>)}
        </select>
        <button aria-label={translate(locale, "newTeam")} title={translate(locale, "newTeam")} onClick={props.onNewTeam} type="button">＋</button>
      </div>
      <nav className="product-area-switch" aria-label={zh ? "产品区域" : "Product area"}>
        <button aria-current={!managing ? "page" : undefined} onClick={props.onCollaboration} type="button">{zh ? "协作" : "Collaboration"}</button>
        <button aria-current={managing ? "page" : undefined} onClick={() => { if (!managing) props.onView(teamId ? "agents" : "security"); }} type="button">{zh ? "管理" : "Management"}</button>
      </nav>
      {managing ? (
        <nav className="product-destinations" aria-label={zh ? "管理导航" : "Management navigation"}>
          {destinations.map(([view, name, icon]) => (
            <button key={view} disabled={!teamId && view !== "security"} aria-current={activeView === view ? "page" : undefined} onClick={() => props.onView(view)} type="button">
              <span aria-hidden="true">{icon}</span>{name}
            </button>
          ))}
        </nav>
      ) : (
        <div className="product-collaboration-nav">
          <nav className="product-destinations" aria-label={zh ? "协作导航" : "Collaboration navigation"}>
            <button className="rail-manage" aria-current={activeView === "work" ? "page" : undefined} onClick={() => props.onView("work")} type="button"><span aria-hidden="true">▦</span>{zh ? "工作" : "Work"}</button>
            <button aria-current={activeView === "room" ? "page" : undefined} onClick={() => props.onView("room")} type="button"><span aria-hidden="true">⌁</span>{translate(locale, "chat")}</button>
          </nav>
          {teamId && <div className="product-rooms">
            <div className="product-section-heading"><span>{zh ? "房间" : "ROOMS"}</span><button aria-label={zh ? "新建房间" : "New Room"} onClick={props.onNewRoom} type="button">＋</button></div>
            <select className="product-room-picker" aria-label={translate(locale, "selectRoom")} value={roomId ?? ""} onChange={(event) => props.onRoom(event.target.value)}>
              {!roomId && <option value="">{translate(locale, "chooseRoom")}</option>}
              {rooms.map((room) => <option key={room.roomId} value={room.roomId}># {room.name}</option>)}
            </select>
            <nav className="product-room-list" aria-label={zh ? "房间列表" : "Room list"}>
              {rooms.map((room) => <button key={room.roomId} aria-current={activeView === "room" && roomId === room.roomId ? "page" : undefined} onClick={() => props.onRoom(room.roomId)} type="button"><span aria-hidden="true">#</span>{room.name}</button>)}
              {rooms.length === 0 && <p>{zh ? "还没有房间" : "No Rooms yet"}</p>}
            </nav>
          </div>}
          {activeView === "room" && children}
        </div>
      )}
      <p className="product-sidebar-note">{managing
        ? (zh ? "配置在这里，对话在协作区。" : "Configure here. Continue conversations in Collaboration.")
        : (zh ? "让人与智能体，一起完成工作。" : "People and Agents, working together.")}</p>
    </aside>
  );
}
