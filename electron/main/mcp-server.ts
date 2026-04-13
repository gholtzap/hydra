/**
 * MCP Server for Hydra — Embedded in the Electron main process.
 *
 * Exposes Hydra's full functionality over the MCP protocol via an HTTP
 * endpoint on localhost:4141. External MCP clients (Discord bot, voice
 * agents, etc.) connect via SSE / Streamable HTTP transport.
 */

import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import type { AppControllerHandle } from "./internal-api.js";

const http = require("node:http") as typeof import("node:http");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");

const {
  McpServer,
} = require("@modelcontextprotocol/sdk/server/mcp.js") as {
  McpServer: typeof import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
};

const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js") as {
  StreamableHTTPServerTransport: typeof import("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
};

const { InternalApi } = require("./internal-api.js") as {
  InternalApi: typeof import("./internal-api.js").InternalApi;
};

const MCP_PORT = 4141;

export class HydraMcpServer {
  private appController: AppControllerHandle;
  private mcpServer: InstanceType<typeof McpServer>;
  private httpServer: HttpServer | null = null;
  private transport: InstanceType<typeof StreamableHTTPServerTransport> | null = null;
  private api: InstanceType<typeof InternalApi>;

  constructor(appController: AppControllerHandle) {
    this.appController = appController;
    this.api = new InternalApi(appController);

    this.mcpServer = new McpServer(
      { name: "hydra", version: "1.0.0" },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    this.registerTools();
    this.registerResources();
    this.registerPrompts();
  }

  // ── Tool registration ───────────────────────────────────────────

  private registerTools(): void {
    const { registerAllTools } = require("./mcp-tools/index.js") as {
      registerAllTools: (server: any, appController: any) => void;
    };
    registerAllTools(this.mcpServer, this.appController);
  }

  // ── Resource registration ─────────────────────────────────────

  private registerResources(): void {
    const { registerResources } = require("./mcp-resources.js") as {
      registerResources: (server: any, appController: any) => void;
    };
    registerResources(this.mcpServer, this.appController);
  }

  // ── Prompt registration ───────────────────────────────────────

  private registerPrompts(): void {
    const { registerPrompts } = require("./mcp-prompts.js") as {
      registerPrompts: (server: any, appController: any) => void;
    };
    registerPrompts(this.mcpServer, this.appController);
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await this.mcpServer.connect(this.transport);

    this.httpServer = http.createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        // CORS headers for local clients
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
        res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = req.url || "/";

        if (url === "/mcp" || url.startsWith("/mcp?")) {
          try {
            await this.transport!.handleRequest(req, res);
          } catch (err) {
            console.error("[MCP] Transport error:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Internal server error" }));
            }
          }
          return;
        }

        // Health check endpoint
        if (url === "/health" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", server: "hydra-mcp", version: "1.0.0" }));
          return;
        }

        // 404 for anything else
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    );

    return new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(MCP_PORT, "127.0.0.1", () => {
        console.log(`[MCP] Hydra MCP server listening on http://127.0.0.1:${MCP_PORT}/mcp`);
        resolve();
      });

      this.httpServer!.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.warn(`[MCP] Port ${MCP_PORT} is in use, MCP server not started.`);
          resolve(); // Don't crash the app
        } else {
          console.error("[MCP] HTTP server error:", err);
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    try {
      await this.mcpServer.close();
    } catch {
      // Ignore close errors
    }
    if (this.httpServer) {
      return new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          console.log("[MCP] Server stopped.");
          resolve();
        });
      });
    }
  }
}

/**
 * Start the MCP server. Call this after AppController is initialized.
 */
export async function startMcpServer(appController: AppControllerHandle): Promise<HydraMcpServer> {
  const server = new HydraMcpServer(appController);
  await server.start();
  return server;
}
