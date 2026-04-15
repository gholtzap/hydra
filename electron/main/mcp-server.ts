/**
 * MCP Server for Hydra — Embedded in the Electron main process.
 *
 * Exposes Hydra's full functionality over the MCP protocol via an HTTP
 * endpoint on localhost:4141. External MCP clients (Discord bot, voice
 * agents, etc.) connect via SSE / Streamable HTTP transport.
 *
 * Each client connection gets its own McpServer + transport instance so
 * multiple clients (Inspector, Discord bot, etc.) can connect simultaneously
 * without the "Server already initialized" error.
 */

import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import type { AppControllerHandle } from "./internal-api.js";

const http = require("node:http") as typeof import("node:http");
const { randomUUID, timingSafeEqual } = require("node:crypto") as typeof import("node:crypto");

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

const MCP_PORT = 4141;

interface SessionEntry {
  server: InstanceType<typeof McpServer>;
  transport: InstanceType<typeof StreamableHTTPServerTransport>;
}

interface HydraMcpServerOptions {
  authToken: string;
}

export class HydraMcpServer {
  private appController: AppControllerHandle;
  private authToken: string;
  private httpServer: HttpServer | null = null;
  /** Active sessions keyed by mcp-session-id */
  private sessions = new Map<string, SessionEntry>();

  constructor(appController: AppControllerHandle, options: HydraMcpServerOptions) {
    this.appController = appController;
    this.authToken = options.authToken.trim();
    if (!this.authToken) {
      throw new Error("MCP auth token is required.");
    }
  }

  // ── Per-session server factory ─────────────────────────────────

  private createSessionServer(): SessionEntry {
    const server = new McpServer(
      { name: "hydra", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    const { registerAllTools } = require("./mcp-tools/index.js") as {
      registerAllTools: (server: any, appController: any) => void;
    };
    const { registerResources } = require("./mcp-resources.js") as {
      registerResources: (server: any, appController: any) => void;
    };
    const { registerPrompts } = require("./mcp-prompts.js") as {
      registerPrompts: (server: any, appController: any) => void;
    };

    registerAllTools(server, this.appController);
    registerResources(server, this.appController);
    registerPrompts(server, this.appController);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    return { server, transport };
  }

  // ── Notifications ───────────────────────────────────────────

  /** Emit a resource-updated notification to all active sessions. */
  notifyResourceChanged(uri: string): void {
    for (const { server } of this.sessions.values()) {
      try {
        const lowLevel = (server as any).server;
        if (lowLevel && typeof lowLevel.sendResourceUpdated === "function") {
          lowLevel.sendResourceUpdated({ uri });
        }
      } catch {
        // Silently ignore — no subscribers or session closing
      }
    }
  }

  get isRunning(): boolean {
    return this.httpServer !== null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    this.httpServer = http.createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        res.setHeader("Cache-Control", "no-store");

        if (!this.isAuthorizedRequest(req)) {
          this.writeUnauthorized(res);
          return;
        }

        const url = req.url || "/";

        if (url === "/mcp" || url.startsWith("/mcp?")) {
          try {
            await this.handleMcpRequest(req, res);
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
          res.end(JSON.stringify({
            status: "ok",
            server: "hydra-mcp",
            version: "1.0.0",
            sessions: this.sessions.size,
          }));
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
          this.httpServer = null;
          console.warn(`[MCP] Port ${MCP_PORT} is in use, MCP server not started.`);
          resolve(); // Don't crash the app
        } else {
          this.httpServer = null;
          console.error("[MCP] HTTP server error:", err);
          reject(err);
        }
      });
    });
  }

  private isAuthorizedRequest(req: IncomingMessage): boolean {
    const authorization = singleHeaderValue(req.headers.authorization);
    const bearerPrefix = "Bearer ";
    if (!authorization.startsWith(bearerPrefix)) {
      return false;
    }

    const token = authorization.slice(bearerPrefix.length).trim();
    return safeTextEqual(token, this.authToken);
  }

  private writeUnauthorized(res: ServerResponse): void {
    if (res.headersSent) {
      res.end();
      return;
    }

    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="hydra-mcp"',
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  private async handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // DELETE = client closing session
    if (req.method === "DELETE" && sessionId) {
      const entry = this.sessions.get(sessionId);
      if (entry) {
        try { await entry.server.close(); } catch { /* ignore */ }
        this.sessions.delete(sessionId);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // Existing session
    if (sessionId && this.sessions.has(sessionId)) {
      await this.sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    // New session (no session ID = initialize request)
    const entry = this.createSessionServer();
    await entry.server.connect(entry.transport);
    await entry.transport.handleRequest(req, res);

    // After the initialize handshake the transport has a sessionId — store it
    const newId = (entry.transport as any).sessionId as string | undefined;
    if (newId) {
      this.sessions.set(newId, entry);
      console.log(`[MCP] New session: ${newId} (total: ${this.sessions.size})`);
    }
  }

  async stop(): Promise<void> {
    for (const { server } of this.sessions.values()) {
      try { await server.close(); } catch { /* ignore */ }
    }
    this.sessions.clear();

    if (this.httpServer) {
      return new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          this.httpServer = null;
          console.log("[MCP] Server stopped.");
          resolve();
        });
      });
    }
  }
}

function singleHeaderValue(headerValue: string | string[] | undefined): string {
  if (Array.isArray(headerValue)) {
    return headerValue.length === 1 ? headerValue[0] : "";
  }

  return typeof headerValue === "string" ? headerValue.trim() : "";
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Start the MCP server. Call this after AppController is initialized.
 */
export async function startMcpServer(
  appController: AppControllerHandle,
  options: HydraMcpServerOptions
): Promise<HydraMcpServer> {
  const server = new HydraMcpServer(appController, options);
  await server.start();
  return server;
}
