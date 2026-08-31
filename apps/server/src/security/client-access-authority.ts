import type Database from "better-sqlite3";

export interface ClientAccessScope {
  grantId: string;
  teamId: string;
  memberId: string;
}

export interface ClientAccessAuthority {
  grant_id: string;
  device_id: string;
  credential_id: string;
  member_id: string;
  team_id: string;
  user_id: string;
  display_name: string;
  team_name: string;
}

/** Re-read mutable authority, including credential rotation, on every request. */
export function clientAccessAuthority(
  database: Database.Database, grantId: string, now: string
): ClientAccessAuthority | undefined {
  return database.prepare(`
    SELECT g.grant_id, g.device_id, g.credential_id, g.member_id, g.team_id,
           g.user_id, m.display_name, t.name AS team_name
    FROM client_access_grants g
    JOIN devices d ON d.device_id = g.device_id AND d.team_id = g.team_id
      AND d.owner_member_id = g.member_id AND d.status = 'active'
    JOIN device_credentials dc ON dc.credential_id = g.credential_id
      AND dc.device_id = g.device_id AND dc.revoked_at IS NULL
      AND (dc.expires_at IS NULL OR dc.expires_at > ?)
    JOIN team_members m ON m.member_id = g.member_id AND m.team_id = g.team_id
      AND m.user_id = g.user_id
    JOIN teams t ON t.team_id = g.team_id AND t.archived_at IS NULL
    JOIN team_members issuer ON issuer.member_id = g.issued_by_member_id
      AND issuer.team_id = g.team_id AND issuer.role = 'owner'
    WHERE g.grant_id = ? AND g.revoked_at IS NULL
  `).get(now, grantId) as ClientAccessAuthority | undefined;
}
