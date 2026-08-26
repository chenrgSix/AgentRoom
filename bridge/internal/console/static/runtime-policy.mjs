const agentCodexPolicyID = "agent-codex-session-ownership-policy";
const agentPiPolicyID = "agent-pi-permission-policy";
const enrollmentCodexPolicyID = "codex-session-ownership-policy";

const preserveAndRetryCopy = "若会话正被其他客户端使用，Bridge 会保留原绑定并提示稍后重试，不会另建会话。";
const startNewCopy = "仅在明确识别到其他客户端占用时，Bridge 会新建会话并重新注入当前 Task 上下文；旧 Codex 会话不会被删除，但 AgentRoom 后续会切换到新会话。其他恢复错误仍会安全停止。";

function setDescription(control, descriptionID) {
  if (descriptionID) {
    control.setAttribute("aria-describedby", descriptionID);
    return;
  }
  control.removeAttribute("aria-describedby");
}

export function applyEnrollmentCodexPolicy(enabled, control) {
  setDescription(control, enabled ? enrollmentCodexPolicyID : "");
}

export function applyAgentRuntimePolicy(kind, control, codexPolicy, piPolicy) {
  const codex = kind === "codex";
  codexPolicy.classList.toggle("hidden", !codex);
  piPolicy.classList.toggle("hidden", codex);
  setDescription(control, codex ? agentCodexPolicyID : agentPiPolicyID);
}

export function codexSessionConflictPolicyDescription(policy) {
  return policy === "start_new" ? startNewCopy : preserveAndRetryCopy;
}

export function applyCodexSessionConflictPolicy(policy, copy) {
  copy.textContent = codexSessionConflictPolicyDescription(policy);
}
