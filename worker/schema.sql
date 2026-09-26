-- Open Chambers alerts database. Run once: wrangler d1 execute openchambers --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS subscriptions (
  token TEXT PRIMARY KEY,          -- APNs device token (hex)
  mode TEXT NOT NULL DEFAULT 'passage',   -- 'passage' | 'all'
  summary INTEGER NOT NULL DEFAULT 1,     -- include first sentence of the CRS summary
  quiet INTEGER NOT NULL DEFAULT 0,       -- 1 = hold pushes 10pm-8am ET (delivered next morning)
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  token TEXT NOT NULL,
  member_id TEXT NOT NULL,         -- bioguide id
  PRIMARY KEY (token, member_id)
);
CREATE INDEX IF NOT EXISTS follows_member ON follows(member_id);
CREATE TABLE IF NOT EXISTS seen_votes (
  vote_id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS queued (              -- pushes held for quiet hours
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
