import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { createTeamMcpServer } from "../mcp/mcp-server.js";
import { bearerToken } from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerMcpRoutes({
  app,
  auth,
  clock,
  core,
  delivery,
  handoffs,
  manualRuns,
  manualTaskWork,
  messages,
  taskArtifacts,
  teamWait
}: ServerRouteContext): void {
  app.post("/mcp", async (request, reply) => {
    const mcpPrincipal = auth.authenticateMcp(bearerToken(request), clock());
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("MCP client disconnected"));
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    const server = createTeamMcpServer(mcpPrincipal, {
      clock,
      core,
      delivery,
      handoffs,
      manualRuns,
      manualTaskWork,
      messages,
      taskArtifacts,
      wait: {
        wait: (principal, input) => teamWait.wait(principal, {
          ...input,
          signal: controller.signal
        })
      }
    });
    const transportOptions = {
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    } as unknown as StreamableHTTPServerTransportOptions;
    const transport = new StreamableHTTPServerTransport(transportOptions);
    try {
      await server.connect(transport as unknown as Transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
      await transport.close();
      await server.close();
    }
  });
  app.get("/mcp", async (_request, reply) => reply.code(405).send({
    jsonrpc: "2.0",
    error: { code: -32_000, message: "Method not allowed" },
    id: null
  }));
  app.delete("/mcp", async (_request, reply) => reply.code(405).send({
    jsonrpc: "2.0",
    error: { code: -32_000, message: "Method not allowed" },
    id: null
  }));
}
