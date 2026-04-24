import type { SessionTagColor } from "../shared-types";

const path = require("node:path");

const SESSION_TAG_COLORS = new Set<SessionTagColor>([
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray"
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const normalizedFilePath = path.resolve(filePath);
  const normalizedRootPath = path.resolve(rootPath);
  const relativePath = path.relative(normalizedRootPath, normalizedFilePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function normalizeSessionTagColor(value: unknown): SessionTagColor | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SESSION_TAG_COLORS.has(normalized as SessionTagColor) ? normalized as SessionTagColor : null;
}

function parseFrontmatter(contents: string): {
  hasFrontmatter: boolean;
  lines: string[];
  values: Record<string, string>;
  body: string;
} {
  if (!contents.startsWith("---")) {
    return {
      hasFrontmatter: false,
      lines: [],
      values: {},
      body: contents
    };
  }

  const lines = contents.split(/\r?\n/);
  if (lines[0].trim() !== "---") {
    return {
      hasFrontmatter: false,
      lines: [],
      values: {},
      body: contents
    };
  }

  const closingIndex = lines.findIndex((line: string, index: number) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    return {
      hasFrontmatter: false,
      lines: [],
      values: {},
      body: contents
    };
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const values: Record<string, string> = {};

  for (const line of frontmatterLines) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    values[match[1]] = stripYamlScalarQuotes(match[2].trim());
  }

  return {
    hasFrontmatter: true,
    lines: frontmatterLines,
    values,
    body: lines.slice(closingIndex + 1).join("\n")
  };
}

function stripYamlScalarQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

module.exports = {
  isPathWithinRoot,
  isPlainObject,
  normalizeSessionTagColor,
  parseFrontmatter
};
