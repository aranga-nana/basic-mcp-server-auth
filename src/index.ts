import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import dotenv from "dotenv";

import { registerChatApp } from "./chat/registerChatApp.js";
import { validateGitHub } from "./middleware/validateGitHub.js";
import { getMcpEndpointUrl, port } from "./serverConfig.js";
import { registerJavaExpertTool } from "./tools/registerJavaExpertTool.js";
import { registerStatusTool } from "./tools/registerStatusTool.js";

dotenv.config({ path: ".env.local" });
dotenv.config();


if (!process.env.CLIENT_ID) {
  console.error("Error: CLIENT_ID environment variable must be set in .env.local or the environment.");
  process.exit(1);
}

const app = express();
app.use(express.json());
registerChatApp(app);

app.get("/", (_req, res) => {
  res.redirect("/chat");
});

// --- 1. WELL-KNOWN ENDPOINTS ---

app.get("/.well-known/mcp.json", (req, res) => {
  res.json({
    mcp_version: "2025-11-25",
    server_info: { name: "enterprise-mcp", version: "1.0.0" },
    endpoints: [{ url: getMcpEndpointUrl(req), transport: "streamable-http", auth_type: "oauth2" }]
  });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    "resource": getMcpEndpointUrl(req),
    "authorization_servers": [
        "https://github.com/login/oauth"
    ],
    "grant_types_supported": ["authorization_code", "refresh_token"],
    "authorization_endpoint": "https://github.com/login/oauth/authorize",
    "token_endpoint": "https://github.com/login/oauth/access_token",
    "client_id": process.env.CLIENT_ID,
    "scopes_supported": ["read:user", "repo"]
  });
});

// --- 2. MCP SERVER LOGIC ---

function createRequestServer(githubToken?: string) {
  const server = new McpServer({ name: "enterprise-mcp", version: "1.0.0" });
  registerStatusTool(server, githubToken);
  registerJavaExpertTool(server, githubToken);

  return server;
}

app.use("/mcp", validateGitHub); // register GitHub validation middleware for the MCP endpoint

app.post("/mcp", async (req, res) => {
  const user = res.locals.user;
  const githubToken = res.locals.githubToken;
  console.log(`all the headers: ${JSON.stringify(req.headers)}`);
  console.log(`Authenticated GitHub user: ${user.login}`);

  const server = createRequestServer(githubToken);
  const transport = new StreamableHTTPServerTransport();

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP Protocol Error:", err);
    if (!res.headersSent) res.status(500).send("Internal Server Error");
  }
});

app.listen(port, () => console.log(`Enterprise MCP Server running on :${port}`));