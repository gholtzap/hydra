-- Encrypted Better Auth secondary storage for Cloudflare D1

CREATE TABLE IF NOT EXISTS "secondary_storage" (
  "key_hash" TEXT PRIMARY KEY NOT NULL,
  "value_encrypted" TEXT NOT NULL,
  "expires_at" INTEGER,
  "created_at" INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  "updated_at" INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);

CREATE INDEX IF NOT EXISTS "secondary_storage_expires_at_idx"
  ON "secondary_storage"("expires_at");
