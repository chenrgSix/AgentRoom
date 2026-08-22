import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpPrincipal } from "../security/auth-service.js";

export function createTeamMcpServer(principal: McpPrincipal): McpServer {
  const server = new McpServer({
    name: "agent-room",
    version: "0.1.0"
  });
  server.registerTool("team.whoami", {
    description: "Return the authenticated Agent Room Team identity."
  }, async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        agentId: principal.agentId,
        memberId: principal.memberId,
        teamId: principal.teamId
      })
    }],
    structuredContent: {
      agentId: principal.agentId,
      memberId: principal.memberId,
      teamId: principal.teamId
    }
  }));
  return server;
}
