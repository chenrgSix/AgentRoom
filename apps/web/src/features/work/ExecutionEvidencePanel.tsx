import type { ExecutionEvidencePage } from
  "@convene-wire/contracts/execution-plan";
import type { TaskProjection } from "@convene-wire/contracts/task-result";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  captureWebSessionScope,
  HttpRequestError,
  isStaleWebSessionError,
  jsonRequest
} from "../../api-client.js";
import type { Locale } from "../../i18n.js";
import type { Member } from "../../models.js";
import {
  clearPendingEvidenceCommand,
  type EvidenceCommandKind,
  type EvidenceCommandScope,
  type PendingEvidenceCommand,
  readPendingEvidenceCommand,
  savePendingEvidenceCommand
} from "./evidence-command-receipt.js";

interface ExecutionEvidencePanelProps {
  currentMember: Member | null;
  locale: Locale;
  onChanged: () => void;
  task: TaskProjection;
  token: string | undefined;
}

type Plan = ExecutionEvidencePage["plans"][number];
type Node = Plan["nodes"][number];

function t(zh: string, en: string, locale: Locale): string {
  return locale === "zh-CN" ? zh : en;
}

function display(value: string | null | undefined): string {
  return value ? value.replaceAll("_", " ") : "—";
}

function short(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function operationId(): string {
  const value = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `op_${value.replaceAll("-", "_")}`;
}

function commandKey(planId: string, nodeKey: string, kind: EvidenceCommandKind): string {
  return `${planId}:${nodeKey}:${kind}`;
}

function sameTemplate(
  pending: PendingEvidenceCommand,
  template: object | null
): boolean {
  return template !== null &&
    JSON.stringify(pending.template) === JSON.stringify(template);
}

function outcome(value: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    passed: ["通过", "Passed"],
    failed: ["失败", "Failed"],
    timeout: ["超时", "Timed out"],
    outcome_unknown: ["结果未知", "Outcome unknown"],
    canceled: ["已取消", "Canceled"],
    succeeded: ["已集成", "Integrated"],
    conflict: ["目标冲突", "Target conflict"]
  };
  const label = labels[value];
  return label ? t(label[0], label[1], locale) : display(value);
}

export function ExecutionEvidencePanel({
  currentMember,
  locale,
  onChanged,
  task,
  token
}: ExecutionEvidencePanelProps) {
  const scope = useMemo(() => ({
    taskId: task.taskId,
    memberId: currentMember?.memberId ?? null,
    token,
    isCurrentSession: captureWebSessionScope()
  }), [currentMember?.memberId, task.taskId, token]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const mounted = useRef(true);
  const requestId = useRef(0);
  const [loaded, setLoaded] = useState<{
    scope: typeof scope;
    page: ExecutionEvidencePage;
  } | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Record<string, PendingEvidenceCommand>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const currentPage = loaded?.scope === scope ? loaded.page : null;
  const selected = currentPage?.plans.find(({ planId }) =>
    planId === selectedPlanId) ?? currentPage?.plans[0] ?? null;
  const canManage = Boolean(currentMember && currentMember.teamId === task.teamId &&
    (currentMember.role === "owner" || currentMember.memberId === task.ownerMemberId));

  const isCurrent = useCallback(() => mounted.current &&
    activeScope.current === scope && scope.isCurrentSession(), [scope]);

  const commandScope = useCallback((
    plan: Plan,
    node: Node,
    kind: EvidenceCommandKind
  ): EvidenceCommandScope | null => currentMember ? {
    memberId: currentMember.memberId,
    teamId: task.teamId,
    taskId: task.taskId,
    planId: plan.planId,
    nodeKey: node.nodeKey,
    kind
  } : null, [currentMember, task.taskId, task.teamId]);

  const reconcilePending = useCallback((page: ExecutionEvidencePage) => {
    if (!currentMember) {
      setPending({});
      return;
    }
    const next: Record<string, PendingEvidenceCommand> = {};
    try {
      for (const plan of page.plans) for (const node of plan.nodes) {
        for (const kind of ["remote_adoption", "integration_approval"] as const) {
          const currentCommandScope = commandScope(plan, node, kind)!;
          const retained = readPendingEvidenceCommand(currentCommandScope);
          if (!retained) continue;
          const confirmed = kind === "remote_adoption"
            ? node.remote?.adoptionState === "adopted"
            : node.integration.approval !== null;
          const template = kind === "remote_adoption"
            ? node.remote?.commandTemplate ?? null
            : node.integration.commandTemplate;
          if (confirmed || !sameTemplate(retained, template)) {
            clearPendingEvidenceCommand(retained);
          } else {
            next[commandKey(plan.planId, node.nodeKey, kind)] = retained;
          }
        }
      }
      setPending(next);
      setStorageError(null);
    } catch (reason) {
      setPending({});
      setStorageError(String(reason));
    }
  }, [commandScope, currentMember]);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setError(null);
    try {
      const page = await jsonRequest<ExecutionEvidencePage>(
        `/api/tasks/${task.taskId}/execution-evidence?limit=50`, {}, token
      );
      if (!isCurrent() || currentRequest !== requestId.current ||
        page.taskId !== task.taskId) return;
      setLoaded({ scope, page });
      setSelectedPlanId((current) => page.plans.some(({ planId }) =>
        planId === current) ? current : page.plans[0]?.planId ?? null);
      reconcilePending(page);
    } catch (reason) {
      if (isCurrent() && currentRequest === requestId.current &&
        !isStaleWebSessionError(reason)) setError(String(reason));
    }
  }, [isCurrent, reconcilePending, scope, task.taskId, token]);

  useEffect(() => {
    mounted.current = true;
    setLoaded(null);
    setSelectedPlanId(null);
    setConfirmations({});
    setPending({});
    setCommandError(null);
    setStorageError(null);
    void load();
    return () => {
      mounted.current = false;
      requestId.current += 1;
    };
  }, [load]);

  async function submit(
    plan: Plan,
    node: Node,
    kind: EvidenceCommandKind,
    retry = false
  ): Promise<void> {
    const template = kind === "remote_adoption"
      ? node.remote?.commandTemplate ?? null
      : node.integration.commandTemplate;
    const currentCommandScope = commandScope(plan, node, kind);
    const key = commandKey(plan.planId, node.nodeKey, kind);
    if (!template || !currentCommandScope || !canManage || storageError || busy ||
      (!retry && !confirmations[key]) ||
      (kind === "remote_adoption" && currentMember?.role !== "owner")) return;
    const command = retry && pending[key]
      ? pending[key]!
      : {
          version: 1 as const,
          scope: currentCommandScope,
          operationId: operationId(),
          template: template as unknown as Record<string, unknown>
        };
    if (!sameTemplate(command, template)) return;
    try {
      savePendingEvidenceCommand(command);
      setPending((current) => ({ ...current, [key]: command }));
    } catch (reason) {
      setStorageError(String(reason));
      return;
    }
    setBusy(key);
    setCommandError(null);
    try {
      const path = kind === "remote_adoption"
        ? `/api/execution-plans/${plan.planId}/remote-evidence-adoptions`
        : `/api/execution-plans/${plan.planId}/integration-approvals`;
      await jsonRequest(path, {
        method: "POST",
        body: JSON.stringify({ operationId: command.operationId, ...command.template })
      }, token);
      if (!isCurrent()) return;
      await load();
      if (isCurrent()) {
        setConfirmations((current) => ({ ...current, [key]: false }));
        onChanged();
      }
    } catch (reason) {
      if (!isCurrent() || isStaleWebSessionError(reason)) return;
      if (reason instanceof HttpRequestError) {
        try {
          clearPendingEvidenceCommand(command);
          setPending((current) => {
            const next = { ...current };
            delete next[key];
            return next;
          });
        } catch (storageReason) {
          setStorageError(String(storageReason));
        }
      }
      setCommandError(t(
        `操作结果未确认：${String(reason)}。请先检查权威状态；网络中断后只能重试同一命令。`,
        `The operation was not confirmed: ${String(reason)}. Check authoritative state first; after a transport loss only the exact command may be retried.`,
        locale
      ));
      await load();
    } finally {
      if (isCurrent()) setBusy(null);
    }
  }

  if (!currentPage && !error) {
    return <p role="status">{t("正在载入证据链…", "Loading evidence chain…", locale)}</p>;
  }

  return <section className="work-evidence-surface">
    <header className="work-evidence-toolbar">
      <div>
        <h4>{t("执行证据与仓库控制", "Execution evidence and repository control", locale)}</h4>
        <p>{t(
          "只显示 Server 保留的来源、证明、采用与集成事实。",
          "Only Server-retained source, proof, adoption, and integration facts are shown.",
          locale
        )}</p>
      </div>
      {currentPage && currentPage.plans.length > 0 && <label>
        {t("执行计划", "Execution plan", locale)}
        <select onChange={(event) => {
          setSelectedPlanId(event.target.value);
          setConfirmations({});
          setCommandError(null);
        }} value={selected?.planId ?? ""}>
          {currentPage.plans.map((plan) => <option key={plan.planId} value={plan.planId}>
            {plan.planId} · r{plan.planRevision} · {display(plan.state)}
          </option>)}
        </select>
      </label>}
      <button onClick={() => void load()} type="button">
        {t("检查权威状态", "Check authoritative state", locale)}
      </button>
    </header>
    {error && <p className="work-evidence-error" role="alert">{error}</p>}
    {commandError && <p className="work-evidence-warning" role="alert">{commandError}</p>}
    {storageError && <p className="work-evidence-error" role="alert">{t(
      `无法安全保存操作：${storageError}。新操作已禁用。`,
      `The operation cannot be stored safely: ${storageError}. New actions are disabled.`,
      locale
    )}</p>}
    {!selected && currentPage && <p>{t("当前 Task 没有执行计划。", "This Task has no execution plan.", locale)}</p>}
    {selected && <>
      <dl className="work-evidence-plan-identity">
        <div><dt>Plan</dt><dd>{selected.planId}</dd></div>
        <div><dt>{t("修订", "Revision", locale)}</dt><dd>r{selected.planRevision} · c{selected.controlRevision}</dd></div>
        <div><dt>Digest</dt><dd>{selected.planDigest}</dd></div>
      </dl>
      {selected.nodes.length === 0 && <p>{t(
        "当前 Plan 尚未获批，因此还没有 compiled Task 或执行证据。",
        "This Plan is not approved yet, so it has no compiled Tasks or execution evidence.",
        locale
      )}</p>}
      <div className="work-evidence-nodes">
        {selected.nodes.map((node) => {
          const remoteKey = commandKey(selected.planId, node.nodeKey, "remote_adoption");
          const integrationKey = commandKey(selected.planId, node.nodeKey, "integration_approval");
          const source = node.remote?.source ?? node.stages.at(-1)?.source ?? null;
          const candidate = node.remote?.commitObservation.commit ??
            node.integration.commandTemplate?.candidateCommit ??
            node.integration.approval?.candidateCommit ??
            node.integration.receipt?.receipt.candidateCommit ?? null;
          const resultingCommit = node.stages.find((stage) =>
            stage.gate === "integrated_commit")?.proofs.find((proof) =>
            proof.kind === "integration_receipt")?.resultingCommit ??
            (node.integration.receipt?.receipt.state === "succeeded"
              ? node.integration.receipt.receipt.candidateCommit : null);
          return <article className="work-evidence-node" key={node.nodeKey} tabIndex={0}>
            <header>
              <div><h5>{node.nodeKey}</h5><span>{node.taskId}</span></div>
              <span>{display(node.runtime?.state ?? "not started")}</span>
            </header>
            <section aria-label={t("下一步", "Next action", locale)} className="work-evidence-next">
              <strong>{t("安全下一步", "Safe next action", locale)}</strong>
              <span>{display(node.nextAction.kind)} · {display(node.nextAction.actorKind)}</span>
              <small>{node.nextAction.reasonCode}</small>
            </section>
            <div className="work-evidence-grid">
              <section>
                <h6>{t("候选来源", "Candidate source", locale)}</h6>
                {!source ? <p>{t("尚无保留来源", "No retained source", locale)}</p> : <dl>
                  <div><dt>{t("种类", "Kind", locale)}</dt><dd>{display(source.kind)}</dd></div>
                  <div><dt>Source</dt><dd>{source.sourceEvidenceId}</dd></div>
                  <div><dt>Digest</dt><dd>{short(source.sourceDigest)}</dd></div>
                  <div><dt>Commit</dt><dd>{short(source.commit ?? candidate)}</dd></div>
                  <div><dt>Tree</dt><dd>{short(source.tree)}</dd></div>
                </dl>}
                {source && <ul>{source.artifactPins.map((pin) => <li key={`${pin.artifactId}:${pin.artifactRevision}`}>
                  <strong>{pin.outputSlot} · {display(pin.kind)}</strong>
                  <span>{pin.artifactId} r{pin.artifactRevision} · {short(pin.contentDigest)} · {pin.byteLength} B</span>
                </li>)}</ul>}
              </section>
              <section>
                <h6>{t("验证 / CI 证明", "Verification / CI proof", locale)}</h6>
                {node.verifications.length === 0 ? <p>{t("尚无验证回执", "No verification receipts", locale)}</p> : <ul>
                  {node.verifications.map((verification) => {
                    const receipt = verification.receipt;
                    const id = verification.kind === "local_verification"
                      ? receipt.verificationId : receipt.observationId;
                    return <li key={`${verification.kind}:${id}`}>
                      <strong>{verification.kind === "remote_ci"
                        ? receipt.checkKey : receipt.profileId}</strong>
                      <span>{outcome(receipt.outcome, locale)} · {short(
                        verification.kind === "remote_ci"
                          ? receipt.receiptDigest : verification.receiptDigest
                      )}</span>
                    </li>;
                  })}
                </ul>}
                {node.remote && <>
                  <p>{t("远程采用", "Remote adoption", locale)}: {display(node.remote.adoptionState)}</p>
                  {node.remote.blockerCodes.length > 0 && <ul className="work-evidence-blockers">
                    {node.remote.blockerCodes.map((code) => <li key={code}>{code}</li>)}
                  </ul>}
                </>}
              </section>
              <section>
                <h6>{t("采用与 Gate", "Adoption and gates", locale)}</h6>
                {node.stages.length === 0 ? <p>{t("尚未采用任何 Gate 证据", "No gate evidence adopted", locale)}</p> : <ol>
                  {node.stages.map((stage) => <li key={stage.gate}>
                    <strong>{display(stage.gate)}</strong>
                    <span>{display(stage.adoption.authority.service)} · {stage.adoption.authority.actorMemberId ?? stage.adoption.authority.agentId ?? stage.adoption.authority.deviceId ?? "system"}</span>
                    <span>adoption {short(stage.adoption.adoptionDigest)} · proof set {short(stage.adoption.proofSetDigest)}</span>
                    <span>materialization {short(stage.materializationDigest)}</span>
                  </li>)}
                </ol>}
              </section>
              <section>
                <h6>{t("仓库集成", "Repository integration", locale)}</h6>
                <p>{outcome(node.integration.state, locale)}</p>
                <dl>
                  <div><dt>{t("目标", "Target", locale)}</dt><dd>{node.integration.target
                    ? `${node.integration.target.repositoryId} · ${node.integration.target.targetRef}` : "—"}</dd></div>
                  <div><dt>{t("期望提交", "Expected commit", locale)}</dt><dd>{short(node.integration.target?.expectedCommit)}</dd></div>
                  <div><dt>{t("候选提交", "Candidate commit", locale)}</dt><dd>{short(candidate)}</dd></div>
                  <div><dt>{t("结果提交", "Resulting commit", locale)}</dt><dd>{short(resultingCommit)}</dd></div>
                  <div><dt>{t("阻塞原因", "Blocker", locale)}</dt><dd>{node.integration.blockerCode ?? "—"}</dd></div>
                </dl>
                {node.integration.approval && <p>{t("批准者", "Approved by", locale)}: {node.integration.approval.approvedByMemberId} · {short(node.integration.approval.approvalDigest)}</p>}
                {node.integration.receipt && <p>Receipt: {short(node.integration.receipt.receiptDigest)} · {outcome(node.integration.receipt.receipt.state, locale)}</p>}
              </section>
            </div>
            {node.remote?.commandTemplate && currentMember?.role === "owner" && <section className="work-evidence-command">
              <label><input checked={Boolean(confirmations[remoteKey])} onChange={(event) =>
                setConfirmations((current) => ({ ...current, [remoteKey]: event.target.checked }))} type="checkbox" />
                {t("我确认采用此计划修订、来源和完整 CI proof set。", "I confirm adoption of this plan revision, source, and complete CI proof set.", locale)}
              </label>
              <button disabled={busy !== null || storageError !== null ||
                (!pending[remoteKey] && !confirmations[remoteKey])} onClick={() =>
                void submit(selected, node, "remote_adoption", Boolean(pending[remoteKey]))} type="button">
                {pending[remoteKey]
                  ? t("用同一命令重试远程采用", "Retry exact remote adoption command", locale)
                  : t("明确采用远程证据", "Explicitly adopt remote evidence", locale)}
              </button>
              {pending[remoteKey] && <p>{t("上次响应未知；请先检查权威状态。", "Previous response is unknown; check authoritative state first.", locale)}</p>}
            </section>}
            {node.integration.commandTemplate && canManage && <section className="work-evidence-command">
              <label><input checked={Boolean(confirmations[integrationKey])} onChange={(event) =>
                setConfirmations((current) => ({ ...current, [integrationKey]: event.target.checked }))} type="checkbox" />
                {t("我确认候选提交、验证回执、目标 ref 与 expected commit 的精确 CAS。", "I confirm the exact candidate, verification receipts, target ref, and expected-commit CAS.", locale)}
              </label>
              <button disabled={busy !== null || storageError !== null ||
                (!pending[integrationKey] && !confirmations[integrationKey])} onClick={() =>
                void submit(selected, node, "integration_approval", Boolean(pending[integrationKey]))} type="button">
                {pending[integrationKey]
                  ? t("用同一命令重试集成批准", "Retry exact integration approval command", locale)
                  : t("批准精确目标集成", "Approve exact-target integration", locale)}
              </button>
              {pending[integrationKey] && <p>{t("上次响应未知；请先检查权威状态。", "Previous response is unknown; check authoritative state first.", locale)}</p>}
            </section>}
          </article>;
        })}
      </div>
    </>}
  </section>;
}
