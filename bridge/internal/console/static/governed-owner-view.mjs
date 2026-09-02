export function governedOwnerPresentation(state = {}) {
  const bindings = array(state.bindings);
  const grants = array(state.grants);
  const runtimeProfiles = array(state.runtimeProfiles);
  const verificationProfiles = array(state.verificationProfiles);
  const cleanupGrants = array(state.cleanupGrants);
  return {
    summary: `${bindings.length} 个仓库绑定 · ${grants.length} 个 Task grant · ${runtimeProfiles.length} 个 Runtime profile · ${verificationProfiles.length} 个 verifier profile · ${cleanupGrants.length} 个 cleanup grant`,
    groups: [
      group("仓库绑定", bindings.map((binding) => ({
        primary: binding.alias || binding.bindingId,
        secondary: `${binding.repositoryId} · ${binding.bindingId}`,
        status: binding.revokedAt ? "已撤销" : `revision ${binding.revision}`
      }))),
      group("Task grants", grants.map((grant) => ({
        primary: grant.grantId,
        secondary: `${grant.taskId} · ${grant.nodeKey} · ${array(grant.operations).join(", ")}`,
        status: grant.revokedAt ? "已撤销" : `有效至 ${localTime(grant.expiresAt)}`,
        revocation: governedGrantRevocation(grant)
      }))),
      group("Runtime profiles", runtimeProfiles.map((profile) => ({
        primary: profile.spec?.profileId,
        secondary: `${profile.spec?.agentId} · ${profile.spec?.permissionProfile}`,
        status: profile.revokedAt ? "已撤销" : profile.platform
      }))),
      group("Verification profiles", verificationProfiles.map((profile) => ({
        primary: profile.profileId,
        secondary: `timeout ${profile.timeoutMilliseconds} ms · output ${profile.outputLimitBytes} B`,
        status: profile.revokedAt ? "已撤销" : `revision ${profile.revision}`
      }))),
      group("Cleanup grants", cleanupGrants.map((grant) => ({
        primary: grant.spec?.grantId,
        secondary: `${grant.spec?.runId} · ${grant.spec?.workspaceRef}`,
        status: grant.revokedAt ? "已撤销" : `有效至 ${localTime(grant.spec?.expiresAt)}`
      })))
    ]
  };
}

export function governedGrantRevocation(grant = {}) {
  if (grant.revokedAt || grant.revision !== 1 || typeof grant.grantId !== "string" ||
      !grant.grantId || typeof grant.digest !== "string" || !grant.digest) return null;
  return {
    path: `/api/governed-task-grants/${encodeURIComponent(grant.grantId)}/revoke`,
    body: {expectedRevision: 1, expectedDigest: grant.digest, confirm: true}
  };
}

function group(title, rows) {
  return {title, rows};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function localTime(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "无效时间" : parsed.toLocaleString();
}
