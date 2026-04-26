/**
 * Shared keybinding configuration and accelerator helpers.
 *
 * This module is consumed by both the Electron main process and the renderer.
 * It avoids preload-local imports so the preload script can stay sandbox-safe.
 */
import type {
  AcceleratorDisplayParts,
  KeybindingEventSnapshot,
  KeybindingLabels,
  KeybindingMap
} from "./shared-types";

type PlatformHost = typeof globalThis & {
  navigator?: {
    platform?: string;
  };
  process?: {
    platform?: string;
  };
};

function defaultPlatform(): string {
  const host = globalThis as PlatformHost;
  const processPlatform = host.process?.platform;
  if (typeof processPlatform === "string" && processPlatform.trim()) {
    return processPlatform;
  }

  const navigatorPlatform = host.navigator?.platform;
  if (typeof navigatorPlatform === "string" && navigatorPlatform.trim()) {
    return navigatorPlatform;
  }

  return "unknown";
}

function isMacPlatform(platform: string): boolean {
  const normalized = platform.trim().toLowerCase();
  return normalized === "darwin" || normalized.includes("mac");
}

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  "open-folder": "CmdOrCtrl+O",
  "create-folder": "CmdOrCtrl+Shift+N",
  "new-session": "CmdOrCtrl+Shift+A",
  "new-session-alt": "CmdOrCtrl+N",
  "open-wiki": "CmdOrCtrl+Shift+W",
  "quick-switcher": "CmdOrCtrl+K",
  "command-palette": "CmdOrCtrl+Shift+P",
  "next-unread": "CmdOrCtrl+]",
  "open-lazygit": "CmdOrCtrl+Shift+G",
  "open-tokscale": "CmdOrCtrl+Shift+T",
  "open-launcher": "CmdOrCtrl+C",
  "build-and-run-app": "CmdOrCtrl+Shift+B",
  "search-project-sessions": "CmdOrCtrl+F",
  "navigate-section-left": "CmdOrCtrl+ArrowLeft",
  "navigate-section-right": "CmdOrCtrl+ArrowRight",
  "navigate-section-up": "CmdOrCtrl+ArrowUp",
  "navigate-section-down": "CmdOrCtrl+ArrowDown"
};

export const KEYBINDING_LABELS: KeybindingLabels = {
  "open-folder": "Open Folder",
  "create-folder": "Create Folder",
  "new-session": "New Session",
  "new-session-alt": "New Session (Alt)",
  "open-wiki": "Open Wiki",
  "quick-switcher": "Quick Switcher",
  "command-palette": "Command Palette",
  "next-unread": "Next Unread Session",
  "open-lazygit": "Open Lazygit",
  "open-tokscale": "Open Token Usage",
  "open-launcher": "Open Launcher",
  "build-and-run-app": "Build and Run App",
  "search-project-sessions": "Search Project Sessions",
  "navigate-section-left": "Navigate Section Left",
  "navigate-section-right": "Navigate Section Right",
  "navigate-section-up": "Navigate Session Up",
  "navigate-section-down": "Navigate Session Down"
};

export function resolveKeybindings(
  overrides?: Partial<KeybindingMap>
): KeybindingMap {
  return { ...DEFAULT_KEYBINDINGS, ...(overrides || {}) };
}

export function acceleratorDisplayParts(
  accelerator: string,
  platform: string = defaultPlatform()
): AcceleratorDisplayParts {
  const isMac = isMacPlatform(platform);
  const parts = accelerator.split("+");
  const display: string[] = [];

  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === "cmdorctrl" || normalized === "commandorcontrol") {
      display.push(isMac ? "\u2318" : "Ctrl");
    } else if (normalized === "cmd" || normalized === "command" || normalized === "meta") {
      display.push(isMac ? "\u2318" : "Win");
    } else if (normalized === "ctrl" || normalized === "control") {
      display.push(isMac ? "\u2303" : "Ctrl");
    } else if (normalized === "shift") {
      display.push(isMac ? "\u21E7" : "Shift");
    } else if (normalized === "alt" || normalized === "option") {
      display.push(isMac ? "\u2325" : "Alt");
    } else if (normalized === "arrowleft") {
      display.push("\u2190");
    } else if (normalized === "arrowright") {
      display.push("\u2192");
    } else if (normalized === "arrowup") {
      display.push("\u2191");
    } else if (normalized === "arrowdown") {
      display.push("\u2193");
    } else if (normalized === "enter" || normalized === "return") {
      display.push("\u21A9");
    } else if (normalized === "escape") {
      display.push("Esc");
    } else if (normalized === "backspace" || normalized === "delete") {
      display.push(isMac ? "\u232B" : "Backspace");
    } else if (normalized === "tab") {
      display.push(isMac ? "\u21E5" : "Tab");
    } else if (normalized === "space") {
      display.push("Space");
    } else {
      display.push(part.length === 1 ? part.toUpperCase() : part);
    }
  }

  return { isMac, parts: display };
}

export function formatAccelerator(
  accelerator: string,
  platform: string = defaultPlatform()
): string {
  const display = acceleratorDisplayParts(accelerator, platform);
  return display.isMac ? display.parts.join("") : display.parts.join("+");
}

export function matchesAccelerator(
  event: KeybindingEventSnapshot,
  accelerator: string,
  platform: string = defaultPlatform()
): boolean {
  const parts = accelerator.split("+").map((part) => part.toLowerCase());
  let needsMeta = false;
  let needsCtrl = false;
  let needsShift = false;
  let needsAlt = false;
  let targetKey = "";

  for (const part of parts) {
    switch (part) {
      case "cmdorctrl":
      case "commandorcontrol":
        if (isMacPlatform(platform)) {
          needsMeta = true;
        } else {
          needsCtrl = true;
        }
        break;
      case "cmd":
      case "command":
      case "meta":
        needsMeta = true;
        break;
      case "ctrl":
      case "control":
        needsCtrl = true;
        break;
      case "alt":
      case "option":
        needsAlt = true;
        break;
      case "shift":
        needsShift = true;
        break;
      default:
        targetKey = part;
        break;
    }
  }

  if (event.metaKey !== needsMeta) {
    return false;
  }
  if (event.ctrlKey !== needsCtrl) {
    return false;
  }
  if (event.shiftKey !== needsShift) {
    return false;
  }
  if (event.altKey !== needsAlt) {
    return false;
  }

  const eventKey = event.key.toLowerCase();
  if (targetKey === "arrowleft") return eventKey === "arrowleft";
  if (targetKey === "arrowright") return eventKey === "arrowright";
  if (targetKey === "arrowup") return eventKey === "arrowup";
  if (targetKey === "arrowdown") return eventKey === "arrowdown";
  if (targetKey === "enter" || targetKey === "return") return eventKey === "enter";
  if (targetKey === "escape") return eventKey === "escape";
  if (targetKey === "backspace" || targetKey === "delete") return eventKey === "backspace";
  if (targetKey === "tab") return eventKey === "tab";
  if (targetKey === "space") return eventKey === " ";
  if (targetKey === "]") return eventKey === "]";
  if (targetKey === "[") return eventKey === "[";

  return eventKey === targetKey;
}
