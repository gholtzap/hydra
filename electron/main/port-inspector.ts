import type { PortListener, PortStatusGroup, PortStatusItem, TrackedPortStatus } from "../shared-types";

const { execFile } = require("node:child_process");

const TRACKED_PORT_GROUPS = [
  {
    id: "app-defaults",
    label: "3000-30xx",
    description: "Common app defaults for Next.js, React, and local web services.",
    ports: range(3000, 3099)
  },
  {
    id: "vite",
    label: "5173-517x",
    description: "Vite dev servers and adjacent ports.",
    ports: range(5173, 5179)
  },
  {
    id: "preview",
    label: "4173-417x",
    description: "Preview servers and alternate local frontend ports.",
    ports: range(4173, 4179)
  },
  {
    id: "api",
    label: "API Ports",
    description: "Popular backend ports for Python, Node, and local services.",
    ports: [...range(5000, 5005), ...range(8000, 8005), 8080, 8081, 8787, 8888]
  },
  {
    id: "tools",
    label: "Tooling",
    description: "Storybook and common bundler defaults.",
    ports: [4321, 6006]
  }
];

const TRACKED_PORTS = [...new Set(TRACKED_PORT_GROUPS.flatMap((group) => group.ports))].sort(
  (left, right) => left - right
);

async function inspectTrackedPorts(): Promise<TrackedPortStatus> {
  const scannedAt = new Date().toISOString();

  try {
    const listenersByPort = await loadListeningPorts();
    const portsByNumber = new Map<number, PortStatusItem>();

    const ports = TRACKED_PORTS.map((port) => {
      const status = summarizePort(port, listenersByPort.get(port) || []);
      portsByNumber.set(port, status);
      return status;
    });

    const groups: PortStatusGroup[] = TRACKED_PORT_GROUPS.map((group) => {
      const groupPorts = group.ports
        .map((port) => portsByNumber.get(port))
        .filter((port): port is PortStatusItem => !!port);
      return {
        id: group.id,
        label: group.label,
        description: group.description,
        totalCount: groupPorts.length,
        activeCount: groupPorts.filter((port) => port?.status === "listening").length,
        activePorts: groupPorts.filter((port) => port?.status === "listening"),
        ports: groupPorts
      };
    });

    const activePorts = ports.filter((port) => port.status === "listening");

    return {
      available: true,
      scannedAt,
      trackedPortCount: ports.length,
      activeCount: activePorts.length,
      groups,
      ports,
      activePorts
    };
  } catch (error: unknown) {
    return {
      available: false,
      scannedAt,
      trackedPortCount: TRACKED_PORTS.length,
      activeCount: 0,
      groups: TRACKED_PORT_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        description: group.description,
        totalCount: group.ports.length,
        activeCount: 0,
        activePorts: [],
        ports: []
      })),
      ports: [],
      activePorts: [],
      error: humanizePortInspectionError(error)
    };
  }
}

function summarizePort(port: number, listeners: PortListener[]): PortStatusItem {
  const sortedListeners = [...listeners].sort((left, right) => {
    const commandDelta = left.command.localeCompare(right.command);
    if (commandDelta !== 0) {
      return commandDelta;
    }

    return left.pid - right.pid;
  });

  return {
    port,
    status: sortedListeners.length ? "listening" : "closed",
    listenerCount: sortedListeners.length,
    listeners: sortedListeners,
    primaryCommand: sortedListeners[0]?.command || null,
    primaryPid: sortedListeners[0]?.pid || null,
    addressSummary: uniqueValues(sortedListeners.map((listener) => listener.address)),
    localUrl: `http://127.0.0.1:${port}`
  };
}

function loadListeningPorts(): Promise<Map<number, PortListener[]>> {
  return new Promise<Map<number, PortListener[]>>((resolve, reject) => {
    execFile(
      "lsof",
      ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
      { maxBuffer: 1024 * 1024 },
      (error: (NodeJS.ErrnoException & { code?: number | string }) | null, stdout: string, stderr: string) => {
        if (error) {
          const code = error.code as number | string | undefined;
          if ((code === 1 || code === "1") && !stdout.trim() && !stderr.trim()) {
            resolve(new Map());
            return;
          }

          reject(error);
          return;
        }

        resolve(parseLsofListeners(stdout));
      }
    );
  });
}

function parseLsofListeners(output: string): Map<number, PortListener[]> {
  const listenersByPort = new Map<number, PortListener[]>();
  const seenListeners = new Set();
  let currentPid: number | null = null;
  let currentCommand = "unknown";

  for (const rawLine of String(output || "").split(/\r?\n/)) {
    if (!rawLine) {
      continue;
    }

    const field = rawLine[0];
    const value = rawLine.slice(1);

    if (field === "p") {
      currentPid = Number.parseInt(value, 10) || null;
      continue;
    }

    if (field === "c") {
      currentCommand = value || "unknown";
      continue;
    }

    if (field !== "n") {
      continue;
    }

    const port = parsePort(value);
    if (port === null) {
      continue;
    }

    const dedupeKey = `${port}:${currentPid ?? "?"}:${value}`;
    if (seenListeners.has(dedupeKey)) {
      continue;
    }
    seenListeners.add(dedupeKey);

    const listeners = listenersByPort.get(port) || [];
    listeners.push({
      pid: currentPid || 0,
      command: currentCommand || "unknown",
      address: value
    });
    listenersByPort.set(port, listeners);
  }

  return listenersByPort;
}

function parsePort(value: string): number | null {
  const match = /:(\d+)(?:->.*)?$/.exec(String(value || ""));
  if (!match) {
    return null;
  }

  const port = Number.parseInt(match[1], 10);
  return Number.isFinite(port) ? port : null;
}

function humanizePortInspectionError(error: unknown): string {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return "Port inspection requires lsof, but it is not available on this system.";
  }

  if (error instanceof Error && error.message) {
    return `Port inspection failed: ${error.message}`;
  }

  return "Port inspection failed for an unknown reason.";
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

module.exports = {
  inspectTrackedPorts
};
