import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.DATA_DIR ?? "/data";
mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, "big-pause.sqlite"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    thread_ts TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (thread_ts, channel_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_ts TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    posted_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (thread_ts, channel_id) REFERENCES threads(thread_ts, channel_id)
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS posts_by_thread_user
    ON posts (thread_ts, channel_id, user_id, posted_at)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS seen_messages (
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    PRIMARY KEY (channel_id, message_ts)
  )
`);

export function trackThread(threadTs: string, channelId: string, creatorId: string) {
  db.prepare(
    "INSERT OR IGNORE INTO threads (thread_ts, channel_id, creator_id) VALUES (?, ?, ?)"
  ).run(threadTs, channelId, creatorId);
}

export function isTrackedThread(threadTs: string, channelId: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM threads WHERE thread_ts = ? AND channel_id = ?"
  ).get(threadTs, channelId);
  return row !== undefined;
}

// Returns false if this message was already handled (Slack can redeliver events).
export function claimMessage(channelId: string, messageTs: string): boolean {
  const result = db.prepare(
    "INSERT OR IGNORE INTO seen_messages (channel_id, message_ts) VALUES (?, ?)"
  ).run(channelId, messageTs);
  return result.changes > 0;
}

export function recordPost(threadTs: string, channelId: string, userId: string) {
  db.prepare(
    "INSERT INTO posts (thread_ts, channel_id, user_id) VALUES (?, ?, ?)"
  ).run(threadTs, channelId, userId);
}

export function getTotalPosts(threadTs: string, channelId: string, userId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM posts WHERE thread_ts = ? AND channel_id = ? AND user_id = ?"
  ).get(threadTs, channelId, userId) as { count: number };
  return row.count;
}

// Start of the server's local day, formatted like SQLite's UTC datetime('now').
function startOfLocalDayUtc(): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start.toISOString().slice(0, 19).replace("T", " ");
}

export function getPostsToday(threadTs: string, channelId: string, userId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM posts
     WHERE thread_ts = ? AND channel_id = ? AND user_id = ?
     AND posted_at >= ?`
  ).get(threadTs, channelId, userId, startOfLocalDayUtc()) as { count: number };
  return row.count;
}

export function hasPostedBefore(threadTs: string, channelId: string, userId: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM posts WHERE thread_ts = ? AND channel_id = ? AND user_id = ? LIMIT 1"
  ).get(threadTs, channelId, userId);
  return row !== undefined;
}
