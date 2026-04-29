const HASH_ALGORITHM = "pbkdf2-sha256";
const PBKDF2_ITERATIONS = 100_000;
const MAX_PBKDF2_ITERATIONS = 1_000_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

const textEncoder = new TextEncoder();

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derivePasswordKey(password, salt, PBKDF2_ITERATIONS, HASH_BYTES);

  return [
    HASH_ALGORITHM,
    String(PBKDF2_ITERATIONS),
    encodeBase64Url(salt),
    encodeBase64Url(key),
  ].join(":");
}

export async function verifyPassword(data: {
  hash: string;
  password: string;
}): Promise<boolean> {
  const parsed = parsePasswordHash(data.hash);
  if (!parsed) {
    return false;
  }

  const candidate = await derivePasswordKey(
    data.password,
    parsed.salt,
    parsed.iterations,
    parsed.key.byteLength,
  );

  return timingSafeEqual(candidate, parsed.key);
}

async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  byteLength: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    material,
    byteLength * 8,
  );

  return new Uint8Array(bits);
}

function parsePasswordHash(hash: string): {
  iterations: number;
  key: Uint8Array;
  salt: Uint8Array;
} | null {
  const [algorithm, iterationsText, saltText, keyText, extra] = hash.split(":");
  if (algorithm !== HASH_ALGORITHM || !iterationsText || !saltText || !keyText || extra) {
    return null;
  }

  if (!/^\d+$/.test(iterationsText)) {
    return null;
  }

  const iterations = Number.parseInt(iterationsText, 10);
  if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > MAX_PBKDF2_ITERATIONS) {
    return null;
  }

  try {
    const salt = decodeBase64Url(saltText);
    const key = decodeBase64Url(keyText);
    if (salt.byteLength === 0 || key.byteLength === 0) {
      return null;
    }

    return { iterations, key, salt };
  } catch {
    return null;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url payload.");
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.byteLength; index += 1) {
    diff |= a[index] ^ b[index];
  }

  return diff === 0;
}
