export type ParsedCommandSpec = {
  env: Record<string, string>;
  argv: string[];
};

const DISALLOWED_SHELL_TOKENS = new Set([
  "|",
  "||",
  "&",
  "&&",
  ";",
  ";;",
  "<",
  "<<",
  ">",
  ">>"
]);

function normalizeCommandLine(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return parseCommandSpec(normalized) ? normalized : "";
}

function parseCommandSpec(value: unknown): ParsedCommandSpec | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || /[\0\r\n]/.test(normalized)) {
    return null;
  }

  const tokens = tokenizeCommandLine(normalized);
  if (!tokens || !tokens.length) {
    return null;
  }

  const env: Record<string, string> = {};
  let commandIndex = 0;

  while (commandIndex < tokens.length) {
    const token = tokens[commandIndex];
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (!match) {
      break;
    }

    env[match[1]] = match[2];
    commandIndex += 1;
  }

  const argv = tokens.slice(commandIndex);
  if (!argv.length || argv.some((token) => DISALLOWED_SHELL_TOKENS.has(token))) {
    return null;
  }

  return {
    env,
    argv
  };
}

function tokenizeCommandLine(value: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let tokenStarted = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (inSingleQuote) {
      if (character === "'") {
        inSingleQuote = false;
      } else {
        current += character;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (character === "\"") {
        inDoubleQuote = false;
        continue;
      }

      if (character === "\\") {
        const nextCharacter = value[index + 1];
        if (nextCharacter === "\"" || nextCharacter === "\\") {
          current += nextCharacter;
          index += 1;
          tokenStarted = true;
          continue;
        }
      }

      current += character;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    if (character === "'") {
      inSingleQuote = true;
      tokenStarted = true;
      continue;
    }

    if (character === "\"") {
      inDoubleQuote = true;
      tokenStarted = true;
      continue;
    }

    if (character === "\\") {
      const nextCharacter = value[index + 1];
      if (nextCharacter && (/\s/.test(nextCharacter) || nextCharacter === "'" || nextCharacter === "\"" || nextCharacter === "\\")) {
        current += nextCharacter;
        index += 1;
        tokenStarted = true;
        continue;
      }
    }

    current += character;
    tokenStarted = true;
  }

  if (inSingleQuote || inDoubleQuote) {
    return null;
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens.length ? tokens : null;
}

function commandSpecToHelperArgs(prefix: "build" | "run", spec: ParsedCommandSpec): string[] {
  const envFlag = prefix === "build" ? "--build-env" : "--run-env";
  const argFlag = prefix === "build" ? "--build-arg" : "--run-arg";
  const args: string[] = [];

  for (const [key, value] of Object.entries(spec.env)) {
    args.push(envFlag, `${key}=${value}`);
  }

  for (const value of spec.argv) {
    args.push(argFlag, value);
  }

  return args;
}

module.exports = {
  commandSpecToHelperArgs,
  normalizeCommandLine,
  parseCommandSpec
};
