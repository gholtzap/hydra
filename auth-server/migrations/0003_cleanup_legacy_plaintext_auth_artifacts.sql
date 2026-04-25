-- Clean up legacy plaintext auth artifacts after moving sessions to encrypted secondary storage

-- Invalidate legacy sessions that were persisted in D1 before secondary storage took over.
DELETE FROM "session";

-- Remove persisted ID tokens while leaving access and refresh tokens intact.
UPDATE "account"
SET "id_token" = NULL
WHERE "id_token" IS NOT NULL;
