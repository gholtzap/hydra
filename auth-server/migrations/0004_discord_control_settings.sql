CREATE TABLE IF NOT EXISTS discord_control_settings (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  guild_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  allowed_user_ids TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);

CREATE INDEX IF NOT EXISTS discord_control_settings_route_idx
  ON discord_control_settings (enabled, guild_id, channel_id);
