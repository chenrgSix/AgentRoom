const agentCodexPolicyID = "agent-codex-session-ownership-policy";
const agentPiPolicyID = "agent-pi-permission-policy";
const enrollmentCodexPolicyID = "codex-session-ownership-policy";

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
