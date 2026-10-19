/**
 * friend-chat — storage layer.
 *
 * Everything lives in one SQLite file (chat.db) via Node's built-in
 * node:sqlite. Image bytes are the one exception: they sit on disk under
 * uploads/ and are referenced by row, because a few megabytes of photo per
 * message would bloat the database and every backup of it.
 *
 * A one-to-one chat is just a conversation with two members and
 * is_group = 0. That way group chat is nearly free: same tables,
 * same message path, same unread logic. Question Bot is the same trick
 * again: is_bot = 1 with exactly one member, so it reuses the whole
 * thread, polling and read-marker machinery instead of being a feature
 * off to the side.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_DAYS = 30;
const MAX_BODY = 4000;
/** The bot is allowed to run longer than a person types, but not forever. */
const BOT_MAX_BODY = 8000;

/** Shown wherever the bot speaks. Kept here so one edit renames it everywhere. */
export const BOT_NAME = 'Question Bot';

export const db = new DatabaseSync(process.env.CHAT_DB || 'chat.db');

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL,
  pass_hash    TEXT NOT NULL,
  pass_salt    TEXT NOT NULL,
  friend_code  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  allow_groups INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS users_code     ON users(friend_code);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  is_group   INTEGER NOT NULL DEFAULT 0,
  title      TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  conv_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (conv_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'text',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv_id, id);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reads (
  conv_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conv_id, user_id)
);

/*
 * One row per picture, hanging off the message that carries it. The bytes
 * live in a file; this row is what proves who is allowed to read that file.
 * ON DELETE CASCADE means deleting a conversation forgets its images too --
 * the files are then orphaned on disk, which sweepOrphanImages() clears.
 */
CREATE TABLE IF NOT EXISTS images (
  msg_id   INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  -- Kept so the browser can reserve the right space before the bytes arrive.
  -- Without them every picture shoves the thread around as it loads.
  width    INTEGER NOT NULL DEFAULT 0,
  height   INTEGER NOT NULL DEFAULT 0
);

/* A per-day counter, so one chatty account cannot spend the whole API bill. */
CREATE TABLE IF NOT EXISTS bot_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  asked   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`);

/**
 * Columns added after the first release. SQLite has no "ADD COLUMN IF NOT
 * EXISTS", so check the table first; this keeps a database made by an earlier
 * version working instead of needing to be thrown away.
 */
for (const [table, column, spec] of [
  ['users', 'allow_groups', 'INTEGER NOT NULL DEFAULT 1'],
  ['conversations', 'is_bot', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
}

const now = () => Date.now();
const q = (sql) => db.prepare(sql);

/* ---------------------------------------------------------------- passwords */

/**
 * scrypt with a per-user random salt. The stored hash is never reversible,
 * so a copy of chat.db does not hand over anyone's password.
 */
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

function passwordMatches(password, user) {
  const { hash } = hashPassword(password, user.pass_salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.pass_hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------ friend codes */

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, they read as 1 and 0
const CODE_DIGITS = '23456789';                   // no 0 or 1 either

const pick = (set) => set[randomBytes(1)[0] % set.length];

/**
 * A public handle like MAYA-7390, safe to hand out. Seeded from the username
 * so it feels like yours, but stored independently -- renaming yourself later
 * does not invalidate the code your friends have already saved.
 */
function generateFriendCode(username) {
  const seed = username.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  for (let attempt = 0; attempt < 50; attempt++) {
    let prefix = seed;
    while (prefix.length < 4) prefix += pick(CODE_LETTERS);
    let digits = '';
    for (let i = 0; i < 4; i++) digits += pick(CODE_DIGITS);
    const code = `${prefix}-${digits}`;
    if (!findUserByCode(code)) return code;
  }
  throw new Error('Could not allocate a friend code');
}

export function normalizeCode(raw) {
  const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/* ------------------------------------------------------------------- users */

export const USERNAME_RULE = /^[A-Za-z0-9_]{3,20}$/;

export function findUserByCode(code) {
  return q('SELECT * FROM users WHERE friend_code = ?').get(code) || null;
}

export function findUserByName(username) {
  return q('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) || null;
}

export function findUserById(id) {
  return q('SELECT * FROM users WHERE id = ?').get(id) || null;
}

export function createUser(username, password) {
  const { salt, hash } = hashPassword(password);
  const code = generateFriendCode(username);
  const { lastInsertRowid } = q(
    `INSERT INTO users (username, pass_hash, pass_salt, friend_code, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(username, hash, salt, code, now());
  return findUserById(Number(lastInsertRowid));
}

export function authenticate(username, password) {
  const user = findUserByName(username);
  if (!user) return null;
  return passwordMatches(password, user) ? user : null;
}

export function changeUsername(userId, username) {
  q('UPDATE users SET username = ? WHERE id = ?').run(username, userId);
}

export function changePassword(userId, password) {
  const { salt, hash } = hashPassword(password);
  q('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(hash, salt, userId);
  return { salt, hash };
}

/**
 * Whether friends may add this user to group chats. Off is a refusal to be
 * added to NEW groups; groups the user is already in are untouched, so turning
 * it off never silently removes anyone from a conversation in progress.
 */
export function setAllowGroups(userId, allow) {
  q('UPDATE users SET allow_groups = ? WHERE id = ?').run(allow ? 1 : 0, userId);
}

export const allowsGroups = (user) => user.allow_groups !== 0;

export function regenerateFriendCode(userId) {
  const user = findUserById(userId);
  const code = generateFriendCode(user.username);
  q('UPDATE users SET friend_code = ? WHERE id = ?').run(code, userId);
  return code;
}

/** The shape of a user that is safe to send to a browser. */
export const publicUser = (u) => u && { id: u.id, username: u.username };

/* ---------------------------------------------------------------- sessions */

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const expires = now() + SESSION_DAYS * 86400_000;
  q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

export function userForSession(token) {
  if (!token) return null;
  const row = q(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`
  ).get(token, now());
  return row || null;
}

export function deleteSession(token) {
  q('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Used after a password change, so other devices are logged out. */
export function deleteSessionsExcept(userId, keepToken) {
  q('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, keepToken);
}

export function purgeExpiredSessions() {
  q('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

/* ------------------------------------------------------------------ blocks */

export function block(blockerId, blockedId) {
  q('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
    .run(blockerId, blockedId, now());
}

export function unblock(blockerId, blockedId) {
  q('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId);
}

export function listBlocked(userId) {
  return q(
    `SELECT u.id, u.username FROM blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = ? ORDER BY u.username COLLATE NOCASE`
  ).all(userId);
}

/** True if either user has blocked the other -- blocking cuts both directions. */
export function blockedEitherWay(a, b) {
  const row = q(
    `SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?)
                             OR (blocker_id = ? AND blocked_id = ?) LIMIT 1`
  ).get(a, b, b, a);
  return !!row;
}

const blockedIdsFor = (userId) =>
  q('SELECT blocked_id FROM blocks WHERE blocker_id = ?').all(userId).map((r) => r.blocked_id);

/* ----------------------------------------------------------- conversations */

export function isMember(convId, userId) {
  return !!q('SELECT 1 FROM members WHERE conv_id = ? AND user_id = ?').get(convId, userId);
}

export function getConversation(convId) {
  return q('SELECT * FROM conversations WHERE id = ?').get(convId) || null;
}

export function membersOf(convId) {
  return q(
    `SELECT u.id, u.username FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.conv_id = ? ORDER BY m.joined_at`
  ).all(convId);
}

function addMember(convId, userId) {
  q('INSERT OR IGNORE INTO members (conv_id, user_id, joined_at) VALUES (?, ?, ?)')
    .run(convId, userId, now());
}

/** Reuse the existing one-to-one thread if these two have talked before. */
export function findDirectConversation(a, b) {
  const row = q(
    `SELECT c.id FROM conversations c
       JOIN members m1 ON m1.conv_id = c.id AND m1.user_id = ?
       JOIN members m2 ON m2.conv_id = c.id AND m2.user_id = ?
      WHERE c.is_group = 0 AND c.is_bot = 0
      LIMIT 1`
  ).get(a, b);
  return row ? row.id : null;
}

export function createDirectConversation(a, b) {
  const existing = findDirectConversation(a, b);
  if (existing) return existing;
  const { lastInsertRowid } = q(
    'INSERT INTO conversations (is_group, title, created_by, created_at) VALUES (0, NULL, ?, ?)'
  ).run(a, now());
  const id = Number(lastInsertRowid);
  addMember(id, a);
  addMember(id, b);
  return id;
}

export function createGroup(title, creatorId, memberIds) {
  const { lastInsertRowid } = q(
    'INSERT INTO conversations (is_group, title, created_by, created_at) VALUES (1, ?, ?, ?)'
  ).run(title, creatorId, now());
  const id = Number(lastInsertRowid);
  addMember(id, creatorId);
  for (const uid of memberIds) addMember(id, uid);
  return id;
}

export function joinGroup(convId, userId, byUsername) {
  addMember(convId, userId);
  const who = findUserById(userId);
  systemMessage(convId, `${who.username} was added by ${byUsername}`);
}

export function leaveGroup(convId, userId) {
  const who = findUserById(userId);
  q('DELETE FROM members WHERE conv_id = ? AND user_id = ?').run(convId, userId);
  systemMessage(convId, `${who.username} left the group`);
  // A group nobody is left in is just dead weight.
  const { c } = q('SELECT COUNT(*) AS c FROM members WHERE conv_id = ?').get(convId);
  if (c === 0) q('DELETE FROM conversations WHERE id = ?').run(convId);
}

export function renameGroup(convId, title) {
  q('UPDATE conversations SET title = ? WHERE id = ?').run(title, convId);
}

/**
 * Every conversation the user is in, newest activity first, each with the
 * other members, a preview of the last message and an unread count.
 */
export function listConversations(userId) {
  const rows = q(
    `SELECT c.id, c.is_group, c.is_bot, c.title, c.created_at,
            COALESCE(r.last_read_id, 0) AS last_read_id,
            (SELECT MAX(id) FROM messages WHERE conv_id = c.id) AS last_id
       FROM conversations c
       JOIN members m ON m.conv_id = c.id AND m.user_id = ?
       LEFT JOIN reads r ON r.conv_id = c.id AND r.user_id = ?`
  ).all(userId, userId);

  const hidden = blockedIdsFor(userId);
  // SQLite has no array parameters, so build the NOT IN list by hand from
  // integers we already own. These ids come from our own table, never input.
  const notBlocked = hidden.length ? `AND (m.user_id IS NULL OR m.user_id NOT IN (${hidden.join(',')}))` : '';

  const lastVisible = q(
    `SELECT m.body, m.created_at, m.kind, u.username
       FROM messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.conv_id = ? ${notBlocked}
      ORDER BY m.id DESC LIMIT 1`
  );
  const unreadCount = q(
    `SELECT COUNT(*) AS c FROM messages m
      WHERE m.conv_id = ? AND m.id > ? AND m.kind = 'text'
        AND m.user_id IS NOT NULL AND m.user_id != ? ${notBlocked}`
  );

  const list = rows.map((row) => {
    const others = membersOf(row.id).filter((u) => u.id !== userId);
    const last = lastVisible.get(row.id) || null;
    const { c: unread } = unreadCount.get(row.id, row.last_read_id, userId);

    return {
      id: row.id,
      isGroup: !!row.is_group,
      isBot: !!row.is_bot,
      title: row.is_bot
        ? BOT_NAME
        : row.is_group
          ? row.title
          : others.map((u) => u.username).join(', ') || '(no one else here)',
      members: others,
      lastBody: last ? last.body : null,
      lastKind: last ? last.kind : null,
      lastFrom: last ? last.username : null,
      lastAt: last ? last.created_at : row.created_at,
      lastId: row.last_id || 0,
      unread,
    };
  });

  // Question Bot is pinned to the top rather than sinking down the list as
  // friends reply: it is a tool you go back to, not a thread that moves.
  return list.sort((a, b) => Number(b.isBot) - Number(a.isBot) || b.lastAt - a.lastAt);
}

/* ---------------------------------------------------------------- messages */

export function sendMessage(convId, userId, body) {
  const text = String(body).slice(0, MAX_BODY);
  const { lastInsertRowid } = q(
    `INSERT INTO messages (conv_id, user_id, body, kind, created_at)
     VALUES (?, ?, ?, 'text', ?)`
  ).run(convId, userId, text, now());
  return Number(lastInsertRowid);
}

function systemMessage(convId, body) {
  q(`INSERT INTO messages (conv_id, user_id, body, kind, created_at)
     VALUES (?, NULL, ?, 'system', ?)`).run(convId, body, now());
}

/**
 * Messages in a conversation after `afterId`. Anything written by someone the
 * viewer has blocked is dropped here, so a block takes effect retroactively
 * and lifts cleanly when they unblock.
 */
export function getMessages(convId, userId, afterId = 0, limit = 200) {
  const rows = q(
    `SELECT m.id, m.user_id, m.body, m.kind, m.created_at, u.username,
            i.mime AS image_mime, i.bytes AS image_bytes,
            i.width AS image_width, i.height AS image_height
       FROM messages m
       LEFT JOIN users u  ON u.id = m.user_id
       LEFT JOIN images i ON i.msg_id = m.id
      WHERE m.conv_id = ? AND m.id > ?
      ORDER BY m.id
      LIMIT ?`
  ).all(convId, afterId, limit);

  const hidden = new Set(blockedIdsFor(userId));
  return rows
    .filter((m) => !hidden.has(m.user_id))
    .map((m) => ({
      id: m.id,
      body: m.body,
      kind: m.kind,
      at: m.created_at,
      from: m.kind === 'bot' ? BOT_NAME : m.username,
      mine: m.user_id === userId,
      // The bytes are fetched separately from /api/image, which re-checks
      // membership -- a message id is not on its own a licence to read a file.
      ...(m.image_mime
        ? {
            image: {
              mime: m.image_mime,
              bytes: m.image_bytes,
              width: m.image_width,
              height: m.image_height,
            },
          }
        : {}),
    }));
}

export function markRead(convId, userId, messageId) {
  q(
    `INSERT INTO reads (conv_id, user_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(conv_id, user_id)
       DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`
  ).run(convId, userId, messageId);
}

/** Highest message id across everything the user can see -- the poll cursor. */
export function latestVisibleId(userId) {
  const row = q(
    `SELECT COALESCE(MAX(m.id), 0) AS top FROM messages m
       JOIN members mem ON mem.conv_id = m.conv_id AND mem.user_id = ?`
  ).get(userId);
  return row.top;
}

/* ------------------------------------------------------------------ images */

/**
 * Image bytes live here; only the row that points at them is in SQLite.
 * Resolved against this file's own folder, not the working directory, so the
 * server finds its uploads however it was started.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const configuredUploads = process.env.CHAT_UPLOADS || 'uploads';
export const UPLOAD_DIR = isAbsolute(configuredUploads)
  ? configuredUploads
  : join(HERE, configuredUploads);

mkdirSync(UPLOAD_DIR, { recursive: true });

/** What a browser may send, and the extension each is stored under. */
export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** An unguessable name, so the file is not reachable by guessing an id. */
export const newImageFilename = (mime) =>
  `${randomBytes(16).toString('hex')}.${IMAGE_TYPES[mime]}`;

/**
 * A picture message: the row carries the optional caption, the image row
 * carries the file. One transaction, so a message can never exist pointing
 * at an image row that was never written.
 */
export function sendImageMessage(convId, userId, caption, image) {
  const { filename, mime, bytes, width = 0, height = 0 } = image;
  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = q(
      `INSERT INTO messages (conv_id, user_id, body, kind, created_at)
       VALUES (?, ?, ?, 'image', ?)`
    ).run(convId, userId, String(caption ?? '').slice(0, MAX_BODY), now());
    const id = Number(lastInsertRowid);
    q(`INSERT INTO images (msg_id, filename, mime, bytes, width, height)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, filename, mime, bytes, width, height);
    db.exec('COMMIT');
    return id;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function imageForMessage(msgId) {
  return q(
    `SELECT i.*, m.conv_id, m.user_id FROM images i
       JOIN messages m ON m.id = i.msg_id
      WHERE i.msg_id = ?`
  ).get(msgId) || null;
}

/** Every filename the database still knows about -- the keep-list for a sweep. */
export const allImageFilenames = () =>
  new Set(q('SELECT filename FROM images').all().map((r) => r.filename));

/* ------------------------------------------------------------- question bot */

/**
 * Each user gets exactly one bot conversation, created the first time it is
 * needed. Looked up by (is_bot, member) rather than stored on the user row,
 * so it is just another conversation to every other query in this file.
 */
export function ensureBotConversation(userId) {
  const existing = q(
    `SELECT c.id FROM conversations c
       JOIN members m ON m.conv_id = c.id AND m.user_id = ?
      WHERE c.is_bot = 1 LIMIT 1`
  ).get(userId);
  if (existing) return existing.id;

  const { lastInsertRowid } = q(
    `INSERT INTO conversations (is_group, is_bot, title, created_by, created_at)
     VALUES (0, 1, ?, ?, ?)`
  ).run(BOT_NAME, userId, now());
  const id = Number(lastInsertRowid);
  addMember(id, userId);
  return id;
}

export const isBotConversation = (conv) => !!conv && conv.is_bot === 1;

/**
 * The tail of the conversation, oldest first, for replaying to the model.
 * Image rows come along so the caller can attach the picture itself.
 */
export function botHistory(convId, limit = 20) {
  const rows = q(
    `SELECT m.id, m.user_id, m.body, m.kind, i.filename, i.mime
       FROM messages m LEFT JOIN images i ON i.msg_id = m.id
      WHERE m.conv_id = ? AND m.kind IN ('text', 'image', 'bot')
      ORDER BY m.id DESC LIMIT ?`
  ).all(convId, limit);
  return rows.reverse();
}

/**
 * Store a question and its answer together, after the model has replied.
 * Nothing is written until the answer exists, so a failed request leaves no
 * half of an exchange stranded in the thread.
 */
export function saveBotExchange(convId, userId, question, answer) {
  db.exec('BEGIN');
  try {
    const asked = sendMessage(convId, userId, question);
    const { lastInsertRowid } = q(
      `INSERT INTO messages (conv_id, user_id, body, kind, created_at)
       VALUES (?, NULL, ?, 'bot', ?)`
    ).run(convId, String(answer).slice(0, BOT_MAX_BODY), now());
    const replied = Number(lastInsertRowid);
    // The answer is to your own question, so it is read the moment it lands --
    // the bot must never sit in the list wearing an unread badge.
    markRead(convId, userId, replied);
    db.exec('COMMIT');
    return { asked, replied };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * An answer with no question of its own -- what a picture sent without a
 * caption gets back, since the picture is already the question.
 */
export function saveBotReply(convId, userId, answer) {
  const { lastInsertRowid } = q(
    `INSERT INTO messages (conv_id, user_id, body, kind, created_at)
     VALUES (?, NULL, ?, 'bot', ?)`
  ).run(convId, String(answer).slice(0, BOT_MAX_BODY), now());
  const replied = Number(lastInsertRowid);
  markRead(convId, userId, replied);
  return { replied };
}

const today = () => new Date().toISOString().slice(0, 10);

export function botAskedToday(userId) {
  const row = q('SELECT asked FROM bot_usage WHERE user_id = ? AND day = ?').get(userId, today());
  return row ? row.asked : 0;
}

export function countBotAsk(userId) {
  q(
    `INSERT INTO bot_usage (user_id, day, asked) VALUES (?, ?, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET asked = asked + 1`
  ).run(userId, today());
}
