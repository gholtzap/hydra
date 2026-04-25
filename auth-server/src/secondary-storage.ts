import type { D1Database } from "@cloudflare/workers-types";

export interface BetterAuthSecondaryStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

type StorageRow = {
  expires_at: number | null;
  value_encrypted: string;
};

const ENVELOPE_VERSION = "v1";
const ENCRYPTION_KEY_INFO = encodeUtf8("hydra:better-auth:secondary-storage:encrypt");
const HASH_KEY_INFO = encodeUtf8("hydra:better-auth:secondary-storage:hash");
const KEY_DERIVATION_SALT = encodeUtf8("hydra:better-auth:secondary-storage");

const SELECT_STORAGE_SQL = `
  SELECT value_encrypted, expires_at
  FROM secondary_storage
  WHERE key_hash = ?
  LIMIT 1
`;

const UPSERT_STORAGE_SQL = `
  INSERT INTO secondary_storage (
    key_hash,
    value_encrypted,
    expires_at,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(key_hash) DO UPDATE SET
    value_encrypted = excluded.value_encrypted,
    expires_at = excluded.expires_at,
    updated_at = excluded.updated_at
`;

const DELETE_STORAGE_SQL = `
  DELETE FROM secondary_storage
  WHERE key_hash = ?
`;

export function createEncryptedSecondaryStorage(
  database: D1Database,
  secret: string,
): BetterAuthSecondaryStorage {
  const normalizedSecret = secret.trim();
  if (!normalizedSecret) {
    throw new Error("BETTER_AUTH_SECRET is required to derive secondary storage crypto.");
  }

  const rootKeyPromise = importRootKey(normalizedSecret);
  const encryptionKeyPromise = rootKeyPromise.then((rootKey) => deriveEncryptionKey(rootKey));
  const hashKeyPromise = rootKeyPromise.then((rootKey) => deriveHashKey(rootKey));

  async function hashStorageKey(rawKey: string): Promise<string> {
    const hmacKey = await hashKeyPromise;
    const digest = await crypto.subtle.sign("HMAC", hmacKey, encodeUtf8(rawKey));
    return bytesToHex(digest);
  }

  async function encryptValue(
    value: string,
    keyHash: string,
    expiresAt: number | null,
  ): Promise<string> {
    const encryptionKey = await encryptionKeyPromise;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: buildAdditionalData(keyHash, expiresAt),
      },
      encryptionKey,
      encodeUtf8(value),
    );

    return `${ENVELOPE_VERSION}:${bytesToHex(iv)}:${bytesToHex(ciphertext)}`;
  }

  async function decryptValue(
    encryptedValue: string,
    keyHash: string,
    expiresAt: number | null,
  ): Promise<string> {
    const [version, ivHex, ciphertextHex] = encryptedValue.split(":");
    if (version !== ENVELOPE_VERSION || !ivHex || !ciphertextHex) {
      throw new Error("Unsupported secondary storage payload format.");
    }

    const encryptionKey = await encryptionKeyPromise;
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: hexToBytes(ivHex),
        additionalData: buildAdditionalData(keyHash, expiresAt),
      },
      encryptionKey,
      hexToBytes(ciphertextHex),
    );

    return decodeUtf8(plaintext);
  }

  async function deleteByHashedKey(keyHash: string): Promise<void> {
    await database.prepare(DELETE_STORAGE_SQL).bind(keyHash).run();
  }

  return {
    async get(key) {
      const keyHash = await hashStorageKey(key);
      const row = await database.prepare(SELECT_STORAGE_SQL).bind(keyHash).first<StorageRow>();
      if (!row) {
        return null;
      }

      const now = Date.now();
      if (isExpired(row.expires_at, now)) {
        await deleteByHashedKey(keyHash).catch(() => undefined);
        return null;
      }

      try {
        return await decryptValue(row.value_encrypted, keyHash, row.expires_at);
      } catch {
        await deleteByHashedKey(keyHash).catch(() => undefined);
        return null;
      }
    },

    async set(key, value, ttl) {
      const now = Date.now();
      if (ttl !== undefined) {
        if (!Number.isFinite(ttl)) {
          throw new TypeError("Secondary storage TTL must be a finite number.");
        }

        if (ttl <= 0) {
          const keyHash = await hashStorageKey(key);
          await deleteByHashedKey(keyHash);
          return;
        }
      }

      const expiresAt = ttl === undefined ? null : now + Math.max(1, Math.ceil(ttl * 1000));
      const keyHash = await hashStorageKey(key);
      const encryptedValue = await encryptValue(value, keyHash, expiresAt);

      await database
        .prepare(UPSERT_STORAGE_SQL)
        .bind(keyHash, encryptedValue, expiresAt, now, now)
        .run();
    },

    async delete(key) {
      const keyHash = await hashStorageKey(key);
      await deleteByHashedKey(keyHash);
    },
  };
}

function buildAdditionalData(keyHash: string, expiresAt: number | null): Uint8Array {
  return encodeUtf8(`${ENVELOPE_VERSION}:${keyHash}:${expiresAt ?? "none"}`);
}

async function importRootKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encodeUtf8(secret), "HKDF", false, ["deriveKey"]);
}

async function deriveEncryptionKey(rootKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: KEY_DERIVATION_SALT,
      info: ENCRYPTION_KEY_INFO,
    },
    rootKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

async function deriveHashKey(rootKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: KEY_DERIVATION_SALT,
      info: HASH_KEY_INFO,
    },
    rootKey,
    {
      name: "HMAC",
      hash: "SHA-256",
      length: 256,
    },
    false,
    ["sign"],
  );
}

function isExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt <= now;
}

function bytesToHex(input: BufferSource): string {
  const bytes = toUint8Array(input);
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }

  return output;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0) {
    throw new Error("Invalid hex payload.");
  }

  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    const value = Number.parseInt(hex.slice(index, index + 2), 16);
    if (Number.isNaN(value)) {
      throw new Error("Invalid hex payload.");
    }

    output[index / 2] = value;
  }

  return output;
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value: BufferSource): string {
  return new TextDecoder().decode(toUint8Array(value));
}

function toUint8Array(input: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }

  return new Uint8Array(input);
}
