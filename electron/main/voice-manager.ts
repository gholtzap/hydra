/**
 * VoiceManager — manages the Pipecat Python voice bot subprocess.
 *
 * Responsibilities:
 * 1. Detect Python 3.10+ on the system
 * 2. Install pipecat dependencies on first use
 * 3. Spawn/kill the Python bot subprocess
 * 4. Monitor bot health via /health endpoint
 * 5. Bridge IPC between renderer and bot lifecycle
 */

import type { BrowserWindow } from "electron";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { VoiceCallState, VoiceConfig } from "../shared-types";

const { ipcMain } = require("electron") as typeof import("electron");
const { spawn, execFile } = require("node:child_process") as typeof import("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http") as typeof import("node:http");
const net = require("node:net") as typeof import("node:net");
const os = require("node:os");

interface PythonInfo {
  found: boolean;
  path?: string;
  version?: string;
}

type VoiceManagerInternalState =
  | "idle"
  | "checking_python"
  | "installing_deps"
  | "spawning"
  | "ready"
  | "error";

const DEFAULT_CONFIG: VoiceConfig = {
  llmProvider: "openai",
  sttProvider: "deepgram",
  ttsProvider: "cartesia",
  ttsVoice: "",
  enableSubagents: false,
  apiKeys: {},
};

// ---------------------------------------------------------------------------
// VoiceManager
// ---------------------------------------------------------------------------

export class VoiceManager {
  private mainWindow: BrowserWindow | null = null;
  private botProcess: ChildProcessWithoutNullStreams | null = null;
  private botPort: number | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private state: VoiceCallState = "idle";
  private internalState: VoiceManagerInternalState = "idle";
  private pythonInfo: PythonInfo | null = null;
  private config: VoiceConfig;
  private getPreferences: (() => Record<string, unknown>) | null = null;
  private updatePreferences: ((patch: Record<string, unknown>) => void) | null = null;

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  init(
    mainWindow: BrowserWindow,
    getPreferences: () => Record<string, unknown>,
    updatePreferences: (patch: Record<string, unknown>) => void,
  ): void {
    this.mainWindow = mainWindow;
    this.getPreferences = getPreferences;
    this.updatePreferences = updatePreferences;

    // Load saved config from preferences
    const prefs = getPreferences();
    if (prefs.voiceConfig && typeof prefs.voiceConfig === "object") {
      this.config = { ...DEFAULT_CONFIG, ...(prefs.voiceConfig as Partial<VoiceConfig>) };
    }

    // Register IPC handlers
    ipcMain.handle("voice:start", async (_event, configPatch?: Partial<VoiceConfig>) => {
      return this.start(configPatch);
    });
    ipcMain.handle("voice:stop", async () => this.stop());
    ipcMain.handle("voice:state", () => this.state);
    ipcMain.handle("voice:getConfig", () => this.config);
    ipcMain.handle("voice:updateConfig", async (_event, patch: Partial<VoiceConfig>) => {
      this.mergeConfig(patch);
    });
    ipcMain.handle("voice:checkPython", async () => this.checkPython());
    ipcMain.handle("voice:installDeps", async () => this.installDeps());
    ipcMain.handle("voice:getBotPort", () => this.botPort);
  }

  async dispose(): Promise<void> {
    await this.stop();
    ipcMain.removeHandler("voice:start");
    ipcMain.removeHandler("voice:stop");
    ipcMain.removeHandler("voice:state");
    ipcMain.removeHandler("voice:getConfig");
    ipcMain.removeHandler("voice:updateConfig");
    ipcMain.removeHandler("voice:checkPython");
    ipcMain.removeHandler("voice:installDeps");
    ipcMain.removeHandler("voice:getBotPort");
    this.mainWindow = null;
  }

  // ── Start / Stop ──────────────────────────────────────────────

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
      const pyInfo = await this.checkPython();
      if (!pyInfo.found) {
        this.internalState = "error";
        this.setState("error");
        return { success: false, error: "Python 3.10+ is required. Install from python.org or via brew install python3." };
      }

      this.internalState = "installing_deps";
      const depsResult = await this.installDeps();
      if (!depsResult.success) {
        this.internalState = "error";
        this.setState("error");
        return { success: false, error: depsResult.error || "Voice dependency installation failed." };
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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

  // ── Python detection ──────────────────────────────────────────

  async checkPython(): Promise<PythonInfo> {
    if (this.pythonInfo) return this.pythonInfo;

    for (const cmd of ["python3", "python"]) {
      try {
        const version = await this.execCommand(cmd, ["--version"]);
        const match = version.trim().match(/Python (\d+)\.(\d+)/);
        if (match) {
          const major = parseInt(match[1], 10);
          const minor = parseInt(match[2], 10);
          if (major > 3 || (major === 3 && minor >= 10)) {
            this.pythonInfo = { found: true, path: cmd, version: version.trim() };
            return this.pythonInfo;
          }
        }
      } catch {
        // Try next command
      }
    }

    this.pythonInfo = { found: false };
    return this.pythonInfo;
  }

  // ── Dependency installation ───────────────────────────────────

  async installDeps(): Promise<{ success: boolean; error?: string }> {
    const pyInfo = await this.checkPython();
    if (!pyInfo.found || !pyInfo.path) {
      return { success: false, error: "Python 3.10+ not found" };
    }

    // Check if already installed via marker file
    const markerPath = this.depsMarkerPath();
    if (fs.existsSync(markerPath)) {
      try {
        const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
        if (marker.version === this.depsVersion()) {
          return { success: true };
        }
      } catch {
        // Marker corrupt, reinstall
      }
    }

    const requirementsPath = path.join(this.voiceDir(), "requirements.txt");
    if (!fs.existsSync(requirementsPath)) {
      return { success: false, error: `requirements.txt not found at ${requirementsPath}` };
    }

    this.emitInstallProgress("Installing voice dependencies...");

    try {
      // Try uv first, then pip
      let installCmd: string;
      let installArgs: string[];

      try {
        await this.execCommand("uv", ["--version"]);
        installCmd = "uv";
        installArgs = ["pip", "install", "-r", requirementsPath];
        this.emitInstallProgress("Using uv for fast installation...");
      } catch {
        installCmd = pyInfo.path;
        installArgs = ["-m", "pip", "install", "-r", requirementsPath];
        this.emitInstallProgress("Using pip for installation...");
      }

      await new Promise<void>((resolve, reject) => {
        const child = spawn(installCmd, installArgs, {
          stdio: ["pipe", "pipe", "pipe"],
        });

        child.stdout.on("data", (data: Buffer) => {
          const line = data.toString().trim();
          if (line) this.emitInstallProgress(line);
        });

        child.stderr.on("data", (data: Buffer) => {
          const line = data.toString().trim();
          if (line) this.emitInstallProgress(line);
        });

        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Dependency installation failed with exit code ${code}`));
        });

        child.on("error", reject);
      });

      // Write marker file
      const markerDir = path.dirname(markerPath);
      if (!fs.existsSync(markerDir)) {
        fs.mkdirSync(markerDir, { recursive: true });
      }
      fs.writeFileSync(markerPath, JSON.stringify({
        version: this.depsVersion(),
        installedAt: new Date().toISOString(),
      }));

      this.emitInstallProgress("Dependencies installed successfully.");
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitInstallProgress(`Installation failed: ${message}`);
      return { success: false, error: message };
    }
  }

  // ── Bot subprocess management ─────────────────────────────────

  private async spawnBot(port: number): Promise<void> {
    const pyInfo = await this.checkPython();
    if (!pyInfo.found || !pyInfo.path) {
      throw new Error("Python not found");
    }

    const botScript = path.join(this.voiceDir(), "bot.py");
    if (!fs.existsSync(botScript)) {
      throw new Error(`Bot script not found at ${botScript}`);
    }

    const args = [
      botScript,
      "--port", String(port),
      "--host", "localhost",
      "--mcp-url", "http://127.0.0.1:4141/mcp",
      "--llm-provider", this.config.llmProvider,
      "--stt-provider", this.config.sttProvider,
      "--tts-provider", this.config.ttsProvider,
    ];

    if (this.config.ttsVoice) {
      args.push("--tts-voice", this.config.ttsVoice);
    }

    if (this.config.enableSubagents) {
      args.push("--enable-subagents");
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const [key, value] of Object.entries(this.config.apiKeys)) {
      if (value) {
        env[this.apiKeyEnvName(key)] = value;
      }
    }

    this.botProcess = spawn(pyInfo.path, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.voiceDir(),
    }) as ChildProcessWithoutNullStreams;

    this.botProcess.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      console.log("[VoiceBot]", text.trim());
    });

    this.botProcess.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      console.error("[VoiceBot]", text.trim());
    });

    this.botProcess.on("exit", (code) => {
      console.log(`[VoiceManager] Bot process exited with code ${code}`);
      if (this.state === "listening" || this.state === "connecting") {
        this.emitError("bot_crashed", `Voice bot exited unexpectedly (code ${code})`);
        this.cleanup();
        this.internalState = "error";
        this.setState("error");
      }
    });

    this.botProcess.on("error", (err) => {
      console.error("[VoiceManager] Bot process error:", err);
      this.emitError("bot_error", err.message);
    });
  }

  private async waitForReady(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    const pollInterval = 500;

    while (Date.now() - start < timeoutMs) {
      // Check if process died
      if (this.botProcess && this.botProcess.exitCode !== null) {
        throw new Error("Bot process exited before becoming ready");
      }

      const healthy = await this.healthCheck(port);
      if (healthy) return;

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Bot did not become ready within ${timeoutMs / 1000}s`);
  }

  private startHealthCheck(port: number): void {
    this.healthCheckInterval = setInterval(async () => {
      const healthy = await this.healthCheck(port);
      if (!healthy && this.state === "listening") {
        console.warn("[VoiceManager] Health check failed");
        this.emitError("health_check_failed", "Voice bot is not responding");
        await this.cleanup();
        this.setState("error");
      }
    }, 5000);
  }

  private healthCheck(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/health`, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on("error", () => resolve(false));
      req.setTimeout(3000, () => {
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

    if (this.botProcess) {
      const proc = this.botProcess;
      this.botProcess = null;
      this.botPort = null;

      // Graceful shutdown: SIGTERM, then force kill after 3s
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => proc.on("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(() => {
            if (proc.exitCode === null) proc.kill("SIGKILL");
            resolve();
          }, 3000)),
        ]);
      }
    }
  }

  // ── Config management ─────────────────────────────────────────

  private mergeConfig(patch: Partial<VoiceConfig>): void {
    if (patch.apiKeys) {
      this.config.apiKeys = { ...this.config.apiKeys, ...patch.apiKeys };
    }
    const { apiKeys: _, ...rest } = patch;
    Object.assign(this.config, this.normalizeConfigPatch(rest));

    // Persist to preferences
    if (this.updatePreferences) {
      this.updatePreferences({ voiceConfig: this.config });
    }
  }

  // ── State management ──────────────────────────────────────────

  private setState(newState: VoiceCallState): void {
    if (this.state === newState) return;
    const prev = this.state;
    this.state = newState;
    console.log(`[VoiceManager] ${prev} → ${newState}`);
    this.emit("voice:stateChanged", this.state);
  }

  getState(): VoiceCallState {
    return this.state;
  }

  // ── IPC helpers ───────────────────────────────────────────────

  private emit(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  private emitError(code: string, message: string): void {
    this.emit("voice:error", { code, message });
  }

  private emitInstallProgress(line: string): void {
    this.emit("voice:installProgress", line);
  }

  // ── Utilities ─────────────────────────────────────────────────

  private voiceDir(): string {
    // In development, voice/ is at the repo root
    // In production, it's bundled alongside the electron app
    const devPath = path.join(__dirname, "..", "..", "voice");
    if (fs.existsSync(devPath)) return devPath;
    return path.join(__dirname, "voice");
  }

  private depsMarkerPath(): string {
    return path.join(os.homedir(), ".hydra", "voice-deps.json");
  }

  private depsVersion(): string {
    // Use requirements.txt content hash as version
    const reqPath = path.join(this.voiceDir(), "requirements.txt");
    try {
      const content = fs.readFileSync(reqPath, "utf-8");
      // Simple hash
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
      }
      return `v1-${Math.abs(hash).toString(36)}`;
    } catch {
      return "v1";
    }
  }

  private async findFreePort(): Promise<number> {
    for (let port = 7860; port <= 7960; port += 1) {
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }

    throw new Error("No free voice bot port found in range 7860-7960.");
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, "localhost", () => {
        server.close(() => resolve(true));
      });
      server.on("error", () => resolve(false));
    });
  }

  private apiKeyEnvName(key: string): string {
    const normalized = key.trim().toUpperCase();
    if (!normalized) return key;
    if (normalized.endsWith("_API_KEY") || normalized.includes("_")) {
      return normalized;
    }
    return `${normalized}_API_KEY`;
  }

  private normalizeConfigPatch(patch: Omit<Partial<VoiceConfig>, "apiKeys">): Partial<VoiceConfig> {
    const next: Partial<VoiceConfig> = {};
    if (typeof patch.llmProvider === "string") next.llmProvider = patch.llmProvider;
    if (typeof patch.sttProvider === "string") next.sttProvider = patch.sttProvider;
    if (typeof patch.ttsProvider === "string") next.ttsProvider = patch.ttsProvider;
    if (typeof patch.ttsVoice === "string") next.ttsVoice = patch.ttsVoice;
    if (typeof patch.enableSubagents === "boolean") next.enableSubagents = patch.enableSubagents;
    return next;
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVoiceManager(
  mainWindow: BrowserWindow,
  getPreferences: () => Record<string, unknown>,
  updatePreferences: (patch: Record<string, unknown>) => void,
): VoiceManager {
  const manager = new VoiceManager();
  manager.init(mainWindow, getPreferences, updatePreferences);
  return manager;
}
