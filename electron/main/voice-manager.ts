import type { BrowserWindow } from "electron";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { VoiceCallState, VoiceConfig } from "../shared-types";

const { ipcMain } = require("electron") as typeof import("electron");
const { spawn, execFile } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs");
const http = require("node:http") as typeof import("node:http");
const net = require("node:net") as typeof import("node:net");
const os = require("node:os");
const path = require("node:path");

type VoiceManagerInternalState =
  | "idle"
  | "checking_python"
  | "installing_deps"
  | "spawning"
  | "ready"
  | "error";

type PythonInfo = {
  found: boolean;
  path?: string;
  version?: string;
};

const DEFAULT_CONFIG: VoiceConfig = {
  llmProvider: "openai",
  sttProvider: "deepgram",
  ttsProvider: "cartesia",
  ttsVoice: "",
  enableSubagents: false,
  apiKeys: {}
};
const VOICE_IDLE_TIMEOUT_SECS = 5 * 60;
const HEALTH_CHECK_INTERVAL_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const HEALTH_CHECK_FAILURE_LIMIT = 3;

export class VoiceManager {
  private mainWindow: BrowserWindow | null = null;
  private botProcess: ChildProcessWithoutNullStreams | null = null;
  private botPort: number | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private healthCheckFailures = 0;
  private state: VoiceCallState = "idle";
  private internalState: VoiceManagerInternalState = "idle";
  private pythonInfo: PythonInfo | null = null;
  private config: VoiceConfig = { ...DEFAULT_CONFIG };
  private mcpAuthToken: string | null = null;
  private ensureMcpServer: (() => Promise<string | null>) | null = null;
  private getPreferences: (() => Record<string, unknown>) | null = null;
  private updatePreferences: ((patch: Record<string, unknown>) => void) | null = null;

  init(
    mainWindow: BrowserWindow,
    getPreferences: () => Record<string, unknown>,
    updatePreferences: (patch: Record<string, unknown>) => void,
    ensureMcpServer?: () => Promise<string | null>
  ): void {
    this.mainWindow = mainWindow;
    this.getPreferences = getPreferences;
    this.updatePreferences = updatePreferences;
    this.ensureMcpServer = ensureMcpServer ?? null;

    const prefs = getPreferences();
    if (prefs.voiceConfig && typeof prefs.voiceConfig === "object") {
      this.config = this.normalizeConfig(prefs.voiceConfig as Partial<VoiceConfig>);
    }

    ipcMain.handle("voice:start", async (_event, patch?: Partial<VoiceConfig>) => this.start(patch));
    ipcMain.handle("voice:stop", async () => this.stop());
    ipcMain.handle("voice:state", () => this.state);
    ipcMain.handle("voice:getConfig", () => this.config);
    ipcMain.handle("voice:updateConfig", async (_event, patch: Partial<VoiceConfig>) => this.mergeConfig(patch));
    ipcMain.handle("voice:checkPython", async () => this.checkPython());
    ipcMain.handle("voice:installDeps", async () => this.installDeps());
    ipcMain.handle("voice:getBotPort", () => this.botPort);
    ipcMain.handle("voice:clientLog", (_event, message: string) => this.logClientMessage(message));
    ipcMain.handle("voice:webrtcOffer", (_event, endpoint: string, payload: unknown) =>
      this.requestBotJson("POST", endpoint, payload)
    );
    ipcMain.handle("voice:webrtcIce", (_event, endpoint: string, payload: unknown) =>
      this.requestBotJson("PATCH", endpoint, payload)
    );
  }

  setMcpAuthToken(token: string | null): void {
    this.mcpAuthToken = token;
  }

  async dispose(): Promise<void> {
    await this.stop();
    for (const channel of [
      "voice:start",
      "voice:stop",
      "voice:state",
      "voice:getConfig",
      "voice:updateConfig",
      "voice:checkPython",
      "voice:installDeps",
      "voice:getBotPort",
      "voice:clientLog",
      "voice:webrtcOffer",
      "voice:webrtcIce"
    ]) {
      ipcMain.removeHandler(channel);
    }
    this.mainWindow = null;
  }

  async start(configPatch?: Partial<VoiceConfig>): Promise<{ success: boolean; port?: number; error?: string }> {
    if (this.state === "listening" || this.state === "connecting") {
      return { success: this.state === "listening", port: this.botPort ?? undefined };
    }

    if (configPatch) {
      this.mergeConfig(configPatch);
    }

    this.setState("connecting");

    try {
      this.internalState = "checking_python";
      const python = await this.checkPython();
      if (!python.found) {
        this.internalState = "error";
        this.setState("error");
        return { success: false, error: "Python 3.10+ is required." };
      }

      this.internalState = "installing_deps";
      const deps = await this.installDeps();
      if (!deps.success) {
        this.internalState = "error";
        this.setState("error");
        return { success: false, error: deps.error || "Voice dependency installation failed." };
      }

      // Ensure MCP server is running for voice tool access
      if (this.ensureMcpServer && !this.mcpAuthToken) {
        try {
          const token = await this.ensureMcpServer();
          if (token) this.mcpAuthToken = token;
        } catch (err) {
          console.warn("[VoiceManager] Could not start MCP server for voice:", err);
        }
      }

      const port = await this.findFreePort();
      this.botPort = port;
      this.internalState = "spawning";
      await this.spawnBot(port);
      await this.waitForReady(port, 30_000);
      this.startHealthCheck(port);
      this.internalState = "ready";
      this.setState("listening");
      return { success: true, port };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[VoiceManager] Failed to start:", message);
      this.emitError("start_failed", message);
      await this.cleanup();
      this.internalState = "error";
      this.setState("error");
      return { success: false, error: message };
    }
  }

  async stop(): Promise<void> {
    if (this.state === "idle") return;
    await this.cleanup();
    this.internalState = "idle";
    this.setState("idle");
  }

  async checkPython(): Promise<PythonInfo> {
    if (this.pythonInfo) return this.pythonInfo;

    for (const cmd of ["python3", "python"]) {
      try {
        const version = await this.execCommand(cmd, ["--version"]);
        const match = version.trim().match(/Python (\d+)\.(\d+)/);
        if (!match) continue;
        const major = Number(match[1]);
        const minor = Number(match[2]);
        if (major > 3 || (major === 3 && minor >= 10)) {
          this.pythonInfo = { found: true, path: cmd, version: version.trim() };
          return this.pythonInfo;
        }
      } catch {
        // Try the next Python command.
      }
    }

    this.pythonInfo = { found: false };
    return this.pythonInfo;
  }

  async installDeps(): Promise<{ success: boolean; error?: string }> {
    const python = await this.checkPython();
    if (!python.found || !python.path) {
      return { success: false, error: "Python 3.10+ not found" };
    }

    const markerPath = path.join(os.homedir(), ".hydra", "voice-deps.json");
    if (fs.existsSync(markerPath)) {
      try {
        const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
        if (marker.version === this.depsVersion()) {
          return { success: true };
        }
      } catch {
        // Reinstall if marker is corrupt.
      }
    }

    const requirementsPath = path.join(this.voiceDir(), "requirements.txt");
    if (!fs.existsSync(requirementsPath)) {
      return { success: false, error: `requirements.txt not found at ${requirementsPath}` };
    }

    try {
      let installCmd = python.path;
      let installArgs = ["-m", "pip", "install", "-r", requirementsPath];

      try {
        await this.execCommand("uv", ["--version"]);
        installCmd = "uv";
        installArgs = ["pip", "install", "--python", python.path!, "-r", requirementsPath];
        this.emitInstallProgress("Using uv for voice dependencies...");
      } catch {
        this.emitInstallProgress("Using pip for voice dependencies...");
      }

      await new Promise<void>((resolve, reject) => {
        const child = spawn(installCmd, installArgs, { stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.on("data", (data: Buffer) => this.emitInstallProgress(data.toString().trim()));
        child.stderr.on("data", (data: Buffer) => this.emitInstallProgress(data.toString().trim()));
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Dependency installation failed with exit code ${code}`)));
        child.on("error", reject);
      });

      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({ version: this.depsVersion(), installedAt: new Date().toISOString() }));
      this.emitInstallProgress("Voice dependencies installed.");
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitInstallProgress(`Voice dependency install failed: ${message}`);
      return { success: false, error: message };
    }
  }

  private async spawnBot(port: number): Promise<void> {
    const python = await this.checkPython();
    if (!python.path) throw new Error("Python not found");

    const botScript = path.join(this.voiceDir(), "bot.py");
    if (!fs.existsSync(botScript)) {
      throw new Error(`Bot script not found at ${botScript}`);
    }

    const args = [
      botScript,
      "--port", String(port),
      "--host", "127.0.0.1",
      "--llm-provider", this.config.llmProvider,
      "--stt-provider", this.config.sttProvider,
      "--tts-provider", this.config.ttsProvider,
      "--idle-timeout-secs", String(VOICE_IDLE_TIMEOUT_SECS)
    ];

    if (this.mcpAuthToken) {
      args.push("--mcp-url", "http://127.0.0.1:4141/mcp");
    }

    if (this.config.ttsVoice) args.push("--tts-voice", this.config.ttsVoice);
    if (this.config.enableSubagents) args.push("--enable-subagents");

    const env = { ...process.env } as Record<string, string>;
    for (const [key, value] of Object.entries(this.config.apiKeys)) {
      if (value) env[this.apiKeyEnvName(key)] = value;
    }

    if (this.mcpAuthToken) {
      env["HYDRA_MCP_AUTH_TOKEN"] = this.mcpAuthToken;
    }

    const child = spawn(python.path, args, {
      cwd: this.voiceDir(),
      env,
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
    this.botProcess = child;

    child.stdout.on("data", (data: Buffer) => console.log("[VoiceBot]", data.toString().trim()));
    child.stderr.on("data", (data: Buffer) => console.error("[VoiceBot]", data.toString().trim()));
    child.on("exit", (code) => {
      if (this.botProcess !== child) return;
      if (this.state === "listening" || this.state === "connecting") {
        this.emitError("bot_crashed", `Voice bot exited unexpectedly (code ${code})`);
        void this.cleanup();
        this.internalState = "error";
        this.setState("error");
      }
    });
    child.on("error", (error) => {
      if (this.botProcess === child) this.emitError("bot_error", error.message);
    });
  }

  private async waitForReady(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.botProcess && this.botProcess.exitCode !== null) {
        throw new Error("Voice bot exited before becoming ready");
      }
      if (await this.healthCheck(port)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Voice bot did not become ready within ${timeoutMs / 1000}s`);
  }

  private startHealthCheck(port: number): void {
    this.healthCheckFailures = 0;
    this.healthCheckInterval = setInterval(async () => {
      if (this.state !== "listening") return;
      if (await this.healthCheck(port)) {
        this.healthCheckFailures = 0;
        return;
      }

      this.healthCheckFailures += 1;
      if (this.healthCheckFailures >= HEALTH_CHECK_FAILURE_LIMIT) {
        this.emitError("health_check_failed", "Voice bot is not responding");
        await this.cleanup();
        this.internalState = "error";
        this.setState("error");
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private healthCheck(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on("error", () => resolve(false));
      req.setTimeout(HEALTH_CHECK_TIMEOUT_MS, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private async cleanup(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.healthCheckFailures = 0;

    if (!this.botProcess) return;
    const proc = this.botProcess;
    this.botProcess = null;
    this.botPort = null;

    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => proc.on("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL");
          resolve();
        }, 3000))
      ]);
    }
  }

  private mergeConfig(patch: Partial<VoiceConfig>): void {
    this.config = this.normalizeConfig({
      ...this.config,
      ...patch,
      apiKeys: { ...this.config.apiKeys, ...(patch.apiKeys || {}) }
    });
    this.updatePreferences?.({ voiceConfig: this.config });
  }

  private normalizeConfig(value: Partial<VoiceConfig>): VoiceConfig {
    return {
      llmProvider: typeof value.llmProvider === "string" ? value.llmProvider : DEFAULT_CONFIG.llmProvider,
      sttProvider: typeof value.sttProvider === "string" ? value.sttProvider : DEFAULT_CONFIG.sttProvider,
      ttsProvider: typeof value.ttsProvider === "string" ? value.ttsProvider : DEFAULT_CONFIG.ttsProvider,
      ttsVoice: typeof value.ttsVoice === "string" ? value.ttsVoice : DEFAULT_CONFIG.ttsVoice,
      enableSubagents: typeof value.enableSubagents === "boolean" ? value.enableSubagents : DEFAULT_CONFIG.enableSubagents,
      apiKeys: value.apiKeys && typeof value.apiKeys === "object" ? { ...value.apiKeys } : {}
    };
  }

  private setState(nextState: VoiceCallState): void {
    if (this.state === nextState) return;
    this.state = nextState;
    this.emit("voice:stateChanged", this.state);
  }

  private emit(channel: string, payload: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload);
    }
  }

  private emitError(code: string, message: string): void {
    this.emit("voice:error", { code, message });
  }

  private emitInstallProgress(line: string): void {
    if (line) this.emit("voice:installProgress", line);
  }

  private logClientMessage(message: string): void {
    const text = typeof message === "string" ? message.trim() : String(message || "");
    if (text) console.log("[VoiceClient]", text.slice(0, 1000));
  }

  private requestBotJson(method: "POST" | "PATCH", endpoint: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        reject(new Error(`Invalid voice bot endpoint: ${endpoint}`));
        return;
      }

      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
        reject(new Error(`Refusing voice bot request to untrusted endpoint: ${endpoint}`));
        return;
      }

      const hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
      const body = JSON.stringify(payload ?? {});
      const req = http.request(
        {
          method,
          hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body)
          },
          timeout: 10000
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`Voice bot ${method} ${url.pathname} failed with HTTP ${res.statusCode}: ${text}`));
              return;
            }

            if (!text) {
              resolve({});
              return;
            }

            try {
              resolve(JSON.parse(text));
            } catch (error) {
              reject(error);
            }
          });
        }
      );

      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error(`Voice bot ${method} ${url.pathname} timed out`)));
      req.write(body);
      req.end();
    });
  }

  private voiceDir(): string {
    const devPath = path.join(__dirname, "..", "..", "voice");
    return fs.existsSync(devPath) ? devPath : path.join(__dirname, "voice");
  }

  private depsVersion(): string {
    try {
      const content = fs.readFileSync(path.join(this.voiceDir(), "requirements.txt"), "utf8");
      let hash = 0;
      for (let i = 0; i < content.length; i += 1) {
        hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
      }
      return `v1-${Math.abs(hash).toString(36)}`;
    } catch {
      return "v1";
    }
  }

  private async findFreePort(): Promise<number> {
    for (let port = 7860; port <= 7960; port += 1) {
      if (await this.isPortAvailable(port)) return port;
    }
    throw new Error("No free voice bot port found in range 7860-7960.");
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
      server.on("error", () => resolve(false));
    });
  }

  private apiKeyEnvName(key: string): string {
    const normalized = key.trim().toUpperCase();
    if (!normalized) return key;
    if (normalized.endsWith("_API_KEY") || normalized.includes("_")) return normalized;
    return `${normalized}_API_KEY`;
  }

  private execCommand(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 10_000 }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(stdout || stderr);
      });
    });
  }
}

export function createVoiceManager(
  mainWindow: BrowserWindow,
  getPreferences: () => Record<string, unknown>,
  updatePreferences: (patch: Record<string, unknown>) => void,
  ensureMcpServer?: () => Promise<string | null>
): VoiceManager {
  const manager = new VoiceManager();
  manager.init(mainWindow, getPreferences, updatePreferences, ensureMcpServer);
  return manager;
}
