import type { FastifyReply, FastifyRequest } from "fastify";
import { ExecutionContractError } from "@convene-wire/contracts/execution-validation";
import { ExecutionError } from "../execution/execution-error.js";
import { AuthorizationError } from "../security/auth-service.js";
import { bearerToken, noStore } from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerExecutionPlanRoutes({
  app, auth, clock, executionPlans, executionInputs, isolatedWorkspaces,
  executionNodeControls, repositoryCaptures, repositoryIntegrations,
  repositoryVerifications, dispatchRun, principal
}: ServerRouteContext): void {
  const options = {
    bodyLimit: 512 * 1024,
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) => noStore(reply)
  };
  // Never reflect SQLite diagnostics, input values or local source paths.
  const execute = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (error instanceof ExecutionError || error instanceof ExecutionContractError ||
        error instanceof AuthorizationError) throw error;
      throw new ExecutionError("EXECUTION_REQUEST_FAILED");
    }
  };
  const integer = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
      throw new ExecutionError("EXECUTION_INVALID_CURSOR");
    }
    return Number(value);
  };
  app.post("/api/bridge/repository-captures", options, async (request) => execute(() =>
    repositoryCaptures.begin(auth.authenticateDevice(bearerToken(request), clock()), request.body, clock())));
  app.post("/api/bridge/repository-checkpoints", options, async (request) => execute(() =>
    repositoryCaptures.seal(auth.authenticateDevice(bearerToken(request), clock()), request.body, clock())));
  app.post("/api/bridge/governed-runtime-authority", options, async (request) => execute(() =>
    isolatedWorkspaces.requireRuntimeAuthority(
      auth.authenticateDevice(bearerToken(request), clock()), request.body, clock()
    )));
  app.get<{ Params: { operationId: string } }>("/api/bridge/repository-captures/:operationId/checkpoint", options,
    async (request) => execute(() => repositoryCaptures.getForDevice(
      auth.authenticateDevice(bearerToken(request), clock()), request.params.operationId)));

  app.post("/api/bridge/repository-verifications", options, async (request) =>
    execute(() => repositoryVerifications.begin(
      auth.authenticateDevice(bearerToken(request), clock()), request.body, clock())));
  app.post("/api/bridge/verification-receipts", options, async (request) =>
    execute(() => repositoryVerifications.retain(
      auth.authenticateDevice(bearerToken(request), clock()), request.body, clock())));
  app.get<{ Params: { operationId: string } }>(
    "/api/bridge/repository-verifications/:operationId/receipt",
    options,
    async (request) => execute(() => repositoryVerifications.getForDevice(
      auth.authenticateDevice(bearerToken(request), clock()), request.params.operationId))
  );
  app.post<{ Params: { planId: string } }>(
    "/api/execution-plans/:planId/integration-approvals",
    options,
    async (request) => execute(() => repositoryIntegrations.approve(
      principal(request), request.params.planId, request.body, clock()
    ))
  );
  app.post<{ Params: { planId: string; nodeKey: string } }>(
    "/api/execution-plans/:planId/nodes/:nodeKey/retries",
    options,
    async (request) => execute(async () => {
      const result = executionNodeControls.retry(
        principal(request),
        request.params.planId,
        request.params.nodeKey,
        request.body,
        clock()
      );
      const run = await dispatchRun(result.run);
      return { ...result, run };
    })
  );
  app.get<{ Params: { operationId: string } }>(
    "/api/bridge/repository-integrations/:operationId",
    options,
    async (request) => execute(() => repositoryIntegrations.getForDevice(
      auth.authenticateDevice(bearerToken(request), clock()),
      request.params.operationId
    ))
  );
  app.post(
    "/api/bridge/integration-receipts",
    options,
    async (request) => execute(() => repositoryIntegrations.retain(
      auth.authenticateDevice(bearerToken(request), clock()),
      request.body,
      clock()
    ))
  );
  app.get<{ Params: { operationId: string } }>(
    "/api/bridge/repository-integrations/:operationId/receipt",
    options,
    async (request) => execute(() => repositoryIntegrations.receiptForDevice(
      auth.authenticateDevice(bearerToken(request), clock()),
      request.params.operationId
    ))
  );
  app.get<{ Params: { planId: string; bindingId: string } }>(
    "/api/execution-plans/:planId/inputs/:bindingId", options,
    async (request) => execute(() => executionInputs.getForMember(
      principal(request), request.params.planId, request.params.bindingId
    ))
  );
  app.get<{ Params: { planId: string; artifactId: string } }>(
    "/api/execution-plans/:planId/artifacts/:artifactId/inputs", options,
    async (request) => execute(() => executionInputs.artifactInputsForMember(
      principal(request), request.params.planId, request.params.artifactId
    ))
  );
  app.get<{ Params: { runId: string; bindingId: string } }>(
    "/api/bridge/runs/:runId/execution-inputs/:bindingId/content", options,
    async (request, reply) => execute(() => {
      const result = executionInputs.readForDevice(
        auth.authenticateDevice(bearerToken(request), clock()), request.params.runId,
        request.params.bindingId, clock()
      );
      reply.header("x-convenewire-input-id", result.binding.bindingId);
      reply.header("x-convenewire-content-sha256", result.binding.artifact.contentDigest);
      reply.header("x-content-type-options", "nosniff");
      return reply.type(result.mediaType).send(result.bytes);
    })
  );
  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/execution-plans", options,
    async (request) => execute(() => executionPlans.create(
      principal(request), request.params.taskId, request.body, clock()
    ))
  );
  app.get<{
    Params: { taskId: string }; Querystring: { afterPlanId?: string; limit?: string }
  }>(
    "/api/tasks/:taskId/execution-plans", options,
    async (request) => execute(() => executionPlans.listForTask(
      principal(request), request.params.taskId, request.query.afterPlanId,
      integer(request.query.limit, 20)
    ))
  );
  app.get<{ Params: { roomId: string }; Querystring: { afterPlanId?: string; limit?: string } }>(
    "/api/rooms/:roomId/execution-plans", options,
    async (request) => execute(() => executionPlans.list(
      principal(request), request.params.roomId, request.query.afterPlanId,
      integer(request.query.limit, 20)
    ))
  );
  app.get<{ Params: { planId: string } }>(
    "/api/execution-plans/:planId", options,
    async (request) => execute(() => executionPlans.get(principal(request), request.params.planId))
  );
  app.post<{ Params: { planId: string } }>(
    "/api/execution-plans/:planId/revisions", options,
    async (request) => execute(() => executionPlans.revise(
      principal(request), request.params.planId, request.body, clock()
    ))
  );
  app.get<{
    Params: { planId: string }; Querystring: { afterRevision?: string; limit?: string }
  }>(
    "/api/execution-plans/:planId/revisions", options,
    async (request) => execute(() => executionPlans.history(
      principal(request), request.params.planId, integer(request.query.afterRevision, 0),
      integer(request.query.limit, 20)
    ))
  );
  app.get<{ Params: { decisionId: string } }>(
    "/api/execution-decisions/:decisionId", options,
    async (request) => execute(() => executionPlans.decision(
      principal(request), request.params.decisionId
    ))
  );
  app.post<{ Params: { planId: string } }>(
    "/api/execution-plans/:planId/approvals", options,
    async (request) => execute(() => executionPlans.review(
      principal(request), request.params.planId, request.body, clock()
    ))
  );
  app.get<{
    Params: { planId: string }; Querystring: { afterRevision?: string; limit?: string }
  }>(
    "/api/execution-plans/:planId/approvals", options,
    async (request) => execute(() => executionPlans.approvalHistory(
      principal(request), request.params.planId, integer(request.query.afterRevision, 0),
      integer(request.query.limit, 20)
    ))
  );
  app.get<{ Params: { decisionId: string } }>(
    "/api/execution-decisions/:decisionId/sources", options,
    async (request) => execute(() => executionPlans.decisionSources(
      principal(request), request.params.decisionId
    ))
  );
}
