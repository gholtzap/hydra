CREATE TABLE IF NOT EXISTS discord_link_codes (
  code TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);

CREATE INDEX IF NOT EXISTS discord_link_codes_user_idx
  ON discord_link_codes (user_id);

CREATE INDEX IF NOT EXISTS discord_link_codes_expires_idx
  ON discord_link_codes (expires_at);
