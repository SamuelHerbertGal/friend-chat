/**
 * friend-chat — HTTP server.
 *
 * node:http serves the static files in public/ and a small JSON API under
 * /api/. New messages arrive by polling (GET /api/poll), not WebSockets, so
 * this whole file could be reimplemented as a cPanel api.php without the
 * browser code changing at all. The one exception is Question Bot, which
 * needs to reach api.anthropic.com -- see bot.mjs.
 *
 *   node --experimental-sqlite server.mjs
 *
 * Normally the browser loads public/ from this same server, so every request
 * is same-origin and none of this needs to think about where it came from.
 * ALLOWED_ORIGIN exists for the one case that is not that: the GitHub Pages
 * preview, which serves public/ on its own domain and calls this server's API
 * across origins. Setting it turns on CORS headers and switches the session
 * cookie to SameSite=None; Secure, which is what a cross-site cookie requires
 * -- see sessionCookie() below. Leave it unset for every other deployment.
 */

import { createServer } from 'node:http';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as D from './db.mjs';
import * as Bot from './bot.mjs';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

/** See the file-header comment: unset by default, meaning same-origin only. */
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;

/** Pictures arrive base64'd inside JSON, so this route needs a bigger body. */
const BODY_LIMITS = { 'POST /api/upload': 8 * 1024 * 1024 };
const DEFAULT_BODY_LIMIT = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

/* ------------------------------------------------------------- small tools */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function readJsonBody(req, limit = DEFAULT_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'That is too large to send.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail(400, 'Malformed request.');
  }
}

const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([k, v]) => k && v !== undefined)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );

/**
 * SameSite=Lax is the right default: it is same-origin, so the browser sends
 * the cookie with no help needed. A cookie read across origins needs
 * SameSite=None, and the browser refuses SameSite=None without Secure too --
 * so turning on cross-origin mode means this now requires HTTPS. Render
 * terminates TLS for us; this would break a plain http://localhost run, which
 * is exactly why it only changes when ALLOWED_ORIGIN is actually set.
 */
const sessionCookie = (token, maxAgeSeconds) => {
  const policy = ALLOWED_ORIGIN ? 'SameSite=None; Secure' : 'SameSite=Lax';
  return `sid=${token}; HttpOnly; ${policy}; Path=/; Max-Age=${maxAgeSeconds}`;
};

const str = (value, max = 500) => String(value ?? '').trim().slice(0, max);

/* ------------------------------------------------------------ static files */

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^([/\\.])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'Forbidden' });

  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/**
 * A stored picture, once the route handler has decided the caller may see it.
 * Cached privately and at length: the bytes behind a message id never change,
 * and the alternative is refetching every photo on every redraw.
 */
async function sendFile(res, { path, mime }) {
  try {
    const data = await readFile(path);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'That picture is missing from the server.' });
  }
}

/**
 * Delete upload files the database no longer refers to. An upload is written
 * before its row, so a crash in between -- or a deleted conversation -- can
 * leave bytes behind with nothing pointing at them.
 */
async function sweepOrphanImages() {
  try {
    const keep = D.allImageFilenames();
    const found = await readdir(D.UPLOAD_DIR);
    let removed = 0;
    for (const name of found) {
      if (keep.has(name)) continue;
      await unlink(join(D.UPLOAD_DIR, name)).catch(() => {});
      removed++;
    }
    if (removed) console.log(`swept ${removed} orphaned upload${removed === 1 ? '' : 's'}`);
  } catch (err) {
    console.error('could not sweep uploads:', err.message);
  }
}

/* -------------------------------------------------------------- API routes */

/** Routes listed here may be called without a session. */
const PUBLIC_ROUTES = new Set(['POST /api/signup', 'POST /api/login', 'GET /api/me']);

const requireMember = (convId, user) => {
  const conv = D.getConversation(convId);
  if (!conv || !D.isMember(convId, user.id)) fail(404, 'Conversation not found.');
  return conv;
};

/** Resolve a friend code to a user, with the checks every caller needs. */
function resolveCode(rawCode, me) {
  const code = D.normalizeCode(rawCode);
  if (!code) fail(400, 'Enter a friend code.');

  const them = D.findUserByCode(code);
  // Deliberately the same message either way: a wrong code and a code that
  // belongs to someone who blocked you should be indistinguishable.
  if (!them || D.blockedEitherWay(me.id, them.id)) fail(404, 'No one has that friend code.');
  if (them.id === me.id) fail(400, 'That is your own friend code.');
  return them;
}

/**
 * Unlike a block, this is said plainly. The point of the setting is that your
 * friends find out they cannot add you, rather than wondering why you never
 * replied in a group you were never in.
 */
function refuseIfGroupsOff(them) {
  if (!D.allowsGroups(them)) fail(403, `${them.username} isn't accepting group invites.`);
}

/**
 * A file's first bytes, checked against the type it was declared as. The
 * declared MIME decides how the picture is served back, so a .exe announcing
 * itself as image/png must not get through on the extension alone.
 */
function looksLikeImage(data, mime) {
  const starts = (...bytes) => bytes.every((b, i) => data[i] === b);
  switch (mime) {
    case 'image/jpeg': return starts(0xff, 0xd8, 0xff);
    case 'image/png':  return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/gif':  return data.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp': return data.subarray(0, 4).toString('latin1') === 'RIFF'
                           && data.subarray(8, 12).toString('latin1') === 'WEBP';
    default: return false;
  }
}

/**
 * Ask the bot and store the exchange. Called from the ordinary send and upload
 * routes, because the bot thread is not a separate kind of conversation.
 *
 * Nothing is written unless an answer comes back, so a failed request leaves
 * the thread exactly as it was and the browser can hand the text back.
 */
async function askQuestionBot(ctx, convId, question) {
  if (D.botAskedToday(ctx.user.id) >= Bot.DAILY_LIMIT) {
    fail(429, `That is ${Bot.DAILY_LIMIT} questions today, which is the daily limit. `
      + 'It resets at midnight.');
  }

  let answer;
  try {
    answer = await Bot.ask(D.botHistory(convId), question);
  } catch (err) {
    if (err instanceof Bot.BotError) fail(err.status, err.message);
    throw err;
  }

  // Counted only once an answer actually arrived: a failure should not cost
  // anyone one of their questions for the day.
  D.countBotAsk(ctx.user.id);

  const { replied } = question
    ? D.saveBotExchange(convId, ctx.user.id, question, answer)
    : D.saveBotReply(convId, ctx.user.id, answer);

  return { status: 200, data: { id: replied, answered: true } };
}

const ROUTES = {
  'POST /api/signup': async (ctx) => {
    const username = str(ctx.body.username, 20);
    const password = String(ctx.body.password ?? '');

    if (!D.USERNAME_RULE.test(username)) {
      fail(400, 'Usernames are 3-20 characters: letters, numbers and underscores.');
    }
    if (password.length < 6) fail(400, 'Use a password of at least 6 characters.');
    if (D.findUserByName(username)) fail(409, 'That username is taken.');

    const user = D.createUser(username, password);
    const token = D.createSession(user.id);
    return {
      status: 200,
      data: { user: me(user) },
      headers: { 'Set-Cookie': sessionCookie(token, 30 * 86400) },
    };
  },

  'POST /api/login': async (ctx) => {
    const user = D.authenticate(str(ctx.body.username, 20), String(ctx.body.password ?? ''));
    if (!user) fail(401, 'Wrong username or password.');
    const token = D.createSession(user.id);
    return {
      status: 200,
      data: { user: me(user) },
      headers: { 'Set-Cookie': sessionCookie(token, 30 * 86400) },
    };
  },

  'POST /api/logout': async (ctx) => {
    D.deleteSession(ctx.token);
    return { status: 200, data: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
  },

  'GET /api/me': async (ctx) => ({
    status: 200,
    data: {
      user: ctx.user ? me(ctx.user) : null,
      // Sent unconditionally so the sign-in screen and the app agree on what
      // the bot is called and whether it has a key to work with.
      bot: { name: D.BOT_NAME, ready: Bot.isConfigured(), dailyLimit: Bot.DAILY_LIMIT },
    },
  }),

  /* --- composing -------------------------------------------------------- */

  /** Turn a typed friend code into a name, so compose can show a chip. */
  'POST /api/lookup': async (ctx) => {
    const them = resolveCode(ctx.body.code, ctx.user);
    return {
      status: 200,
      data: {
        user: D.publicUser(them),
        // Echo the canonical code back so a chip can carry it to /api/compose
        // without the browser having to remember what was typed.
        code: them.friend_code,
        allowsGroups: D.allowsGroups(them),
      },
    };
  },

  /**
   * The single way a conversation begins. One recipient opens a one-to-one
   * chat, two or more makes a group -- so a group is an option of composing
   * rather than a separate feature with its own button.
   */
  'POST /api/compose': async (ctx) => {
    const codes = Array.isArray(ctx.body.codes) ? ctx.body.codes.slice(0, 20) : [];
    const body = str(ctx.body.body, 4000);

    const people = [];
    for (const raw of codes) {
      if (!str(raw)) continue;
      const them = resolveCode(raw, ctx.user);
      if (!people.some((p) => p.id === them.id)) people.push(them);
    }
    if (!people.length) fail(400, 'Add at least one friend code.');
    if (!body) fail(400, 'Write a message to send.');

    const isGroup = people.length > 1;
    let convId;

    if (isGroup) {
      for (const them of people) refuseIfGroupsOff(them);
      // An unnamed group is named after the people in it, the way a mail
      // thread is labelled by its participants.
      const title = str(ctx.body.title, 60) || people.map((p) => p.username).join(', ').slice(0, 60);
      convId = D.createGroup(title, ctx.user.id, people.map((p) => p.id));
    } else {
      convId = D.createDirectConversation(ctx.user.id, people[0].id);
      // A direct chat can already exist; sending into it must still respect a block.
      if (D.blockedEitherWay(ctx.user.id, people[0].id)) fail(403, 'Message not delivered.');
    }

    const id = D.sendMessage(convId, ctx.user.id, body);
    D.markRead(convId, ctx.user.id, id);
    return { status: 200, data: { conversation: convId, isGroup, with: people.map((p) => p.username) } };
  },

  'POST /api/group/invite': async (ctx) => {
    const conv = requireMember(Number(ctx.body.conversation), ctx.user);
    if (!conv.is_group) fail(400, 'That is a one-to-one chat, not a group.');
    const them = resolveCode(ctx.body.code, ctx.user);
    if (D.isMember(conv.id, them.id)) fail(409, `${them.username} is already in this group.`);
    refuseIfGroupsOff(them);
    D.joinGroup(conv.id, them.id, ctx.user.username);
    return { status: 200, data: { added: them.username } };
  },

  'POST /api/group/leave': async (ctx) => {
    const conv = requireMember(Number(ctx.body.conversation), ctx.user);
    if (!conv.is_group) fail(400, 'You can only leave a group.');
    D.leaveGroup(conv.id, ctx.user.id);
    return { status: 200, data: { ok: true } };
  },

  'POST /api/group/rename': async (ctx) => {
    const conv = requireMember(Number(ctx.body.conversation), ctx.user);
    if (!conv.is_group) fail(400, 'You can only rename a group.');
    const title = str(ctx.body.title, 60);
    if (!title) fail(400, 'Give the group a name.');
    D.renameGroup(conv.id, title);
    return { status: 200, data: { title } };
  },

  /* --- reading and sending ---------------------------------------------- */

  'GET /api/conversations': async (ctx) => {
    // Created on first sight rather than at signup, so accounts that existed
    // before the bot did get one too.
    D.ensureBotConversation(ctx.user.id);
    return { status: 200, data: { conversations: D.listConversations(ctx.user.id) } };
  },

  'GET /api/messages': async (ctx) => {
    const convId = Number(ctx.query.get('conversation'));
    const conv = requireMember(convId, ctx.user);
    const after = Number(ctx.query.get('after')) || 0;
    const messages = D.getMessages(convId, ctx.user.id, after);
    return {
      status: 200,
      data: {
        messages,
        isGroup: !!conv.is_group,
        isBot: D.isBotConversation(conv),
        title: conv.title,
        members: D.membersOf(convId),
      },
    };
  },

  'POST /api/messages': async (ctx) => {
    const convId = Number(ctx.body.conversation);
    const conv = requireMember(convId, ctx.user);
    const body = str(ctx.body.body, 4000);
    if (!body) fail(400, 'Write something first.');

    // The bot conversation is a conversation like any other, so a question
    // arrives through the same endpoint as a text to a friend. It just takes
    // a few seconds and writes two messages instead of one.
    if (D.isBotConversation(conv)) return askQuestionBot(ctx, convId, body);

    // In a one-to-one chat a block stops delivery outright. In a group it only
    // hides messages, so the group keeps working for everyone else.
    if (!conv.is_group) {
      const other = D.membersOf(convId).find((u) => u.id !== ctx.user.id);
      if (other && D.blockedEitherWay(ctx.user.id, other.id)) {
        fail(403, 'Message not delivered.');
      }
    }

    const id = D.sendMessage(convId, ctx.user.id, body);
    D.markRead(convId, ctx.user.id, id);
    return { status: 200, data: { id } };
  },

  /* --- pictures --------------------------------------------------------- */

  /**
   * A picture, base64'd inside JSON so this stays one shape of request the
   * whole way through -- and so a PHP port reads it the same way as the rest.
   * The browser shrinks the image first; this is the backstop, not the limit.
   */
  'POST /api/upload': async (ctx) => {
    const convId = Number(ctx.body.conversation);
    const conv = requireMember(convId, ctx.user);
    const mime = str(ctx.body.mime, 40).toLowerCase();
    const caption = str(ctx.body.caption, 4000);

    if (!D.IMAGE_TYPES[mime]) {
      fail(400, 'Pictures must be a JPEG, PNG, GIF or WebP.');
    }

    let data;
    try {
      data = Buffer.from(String(ctx.body.data ?? ''), 'base64');
    } catch {
      fail(400, 'That picture could not be read.');
    }
    if (!data.length) fail(400, 'That picture was empty.');
    if (data.length > 5 * 1024 * 1024) fail(413, 'Pictures must be under 5 MB.');
    if (!looksLikeImage(data, mime)) fail(400, 'That file is not the kind of picture it claims to be.');

    if (!conv.is_group && !D.isBotConversation(conv)) {
      const other = D.membersOf(convId).find((u) => u.id !== ctx.user.id);
      if (other && D.blockedEitherWay(ctx.user.id, other.id)) {
        fail(403, 'Picture not delivered.');
      }
    }

    // Write the file before the row: a file with no row is swept up later,
    // whereas a row with no file would be a permanently broken picture.
    const filename = D.newImageFilename(mime);
    await writeFile(join(D.UPLOAD_DIR, filename), data);

    // Dimensions are taken on trust: they only decide how much space the
    // browser reserves, so a wrong pair makes a picture look odd and nothing
    // worse. Clamped anyway so a silly number cannot stretch the layout.
    const side = (value) => Math.min(20000, Math.max(0, Math.round(Number(value) || 0)));

    let id;
    try {
      id = D.sendImageMessage(convId, ctx.user.id, caption, {
        filename,
        mime,
        bytes: data.length,
        width: side(ctx.body.width),
        height: side(ctx.body.height),
      });
    } catch (err) {
      await unlink(join(D.UPLOAD_DIR, filename)).catch(() => {});
      throw err;
    }
    D.markRead(convId, ctx.user.id, id);

    // Send a picture to the bot and it answers about the picture. The question
    // is empty on purpose: the caption is already part of the picture's own
    // message, so passing it again would store it twice.
    if (D.isBotConversation(conv)) {
      try {
        const answered = await askQuestionBot(ctx, convId, '');
        return { status: 200, data: { id, replyId: answered.data.id, answered: true } };
      } catch (err) {
        // The picture did send; only the answer failed. Reporting that as an
        // upload error would be untrue, and would have the browser offer the
        // picture again when it is already sitting in the thread.
        if (err instanceof HttpError) return { status: 200, data: { id, botError: err.message } };
        throw err;
      }
    }

    return { status: 200, data: { id } };
  },

  /**
   * The bytes of one picture. Deliberately behind the API rather than a file
   * in public/: membership is re-checked here, so a message id leaking does
   * not hand the photo to someone outside the conversation.
   */
  'GET /api/image': async (ctx) => {
    const msgId = Number(ctx.query.get('message'));
    const image = D.imageForMessage(msgId);
    if (!image) fail(404, 'No such picture.');

    requireMember(image.conv_id, ctx.user);
    // A blocked person's pictures disappear along with their messages.
    if (image.user_id && image.user_id !== ctx.user.id
        && D.blockedEitherWay(ctx.user.id, image.user_id)) {
      fail(404, 'No such picture.');
    }

    return { status: 200, file: { path: join(D.UPLOAD_DIR, image.filename), mime: image.mime } };
  },

  'POST /api/read': async (ctx) => {
    const convId = Number(ctx.body.conversation);
    requireMember(convId, ctx.user);
    D.markRead(convId, ctx.user.id, Number(ctx.body.messageId) || 0);
    return { status: 200, data: { ok: true } };
  },

  /**
   * The polling endpoint. The browser sends the highest message id it has
   * seen; a cheap integer comparison tells it whether to refetch anything.
   */
  'GET /api/poll': async (ctx) => {
    const since = Number(ctx.query.get('since')) || 0;
    const top = D.latestVisibleId(ctx.user.id);
    return {
      status: 200,
      data: top > since
        ? { top, changed: true, conversations: D.listConversations(ctx.user.id) }
        : { top, changed: false },
    };
  },

  /* --- blocking --------------------------------------------------------- */

  'GET /api/blocks': async (ctx) => ({ status: 200, data: { blocked: D.listBlocked(ctx.user.id) } }),

  'POST /api/block': async (ctx) => {
    // Blocking takes a username, because by the time you want to block someone
    // you are looking at a chat with them, not at their code.
    const username = str(ctx.body.username, 20);
    const them = D.findUserByName(username);
    if (!them) fail(404, 'No such user.');
    if (them.id === ctx.user.id) fail(400, 'You cannot block yourself.');
    D.block(ctx.user.id, them.id);
    return { status: 200, data: { blocked: them.username } };
  },

  'POST /api/unblock': async (ctx) => {
    const them = D.findUserByName(str(ctx.body.username, 20));
    if (!them) fail(404, 'No such user.');
    D.unblock(ctx.user.id, them.id);
    return { status: 200, data: { unblocked: them.username } };
  },

  /* --- settings --------------------------------------------------------- */

  'POST /api/settings/username': async (ctx) => {
    const username = str(ctx.body.username, 20);
    if (!D.USERNAME_RULE.test(username)) {
      fail(400, 'Usernames are 3-20 characters: letters, numbers and underscores.');
    }
    const taken = D.findUserByName(username);
    if (taken && taken.id !== ctx.user.id) fail(409, 'That username is taken.');
    D.changeUsername(ctx.user.id, username);
    return { status: 200, data: { user: me(D.findUserById(ctx.user.id)) } };
  },

  'POST /api/settings/password': async (ctx) => {
    const current = String(ctx.body.current ?? '');
    const next = String(ctx.body.next ?? '');
    // Re-check the old password: a hijacked session should not be able to
    // take the account over permanently.
    if (!D.authenticate(ctx.user.username, current)) fail(403, 'That is not your current password.');
    if (next.length < 6) fail(400, 'Use a password of at least 6 characters.');
    D.changePassword(ctx.user.id, next);
    D.deleteSessionsExcept(ctx.user.id, ctx.token);
    return { status: 200, data: { ok: true } };
  },

  'POST /api/settings/newcode': async (ctx) => ({
    status: 200,
    data: { friendCode: D.regenerateFriendCode(ctx.user.id) },
  }),

  'POST /api/settings/groups': async (ctx) => {
    const allow = !!ctx.body.allow;
    D.setAllowGroups(ctx.user.id, allow);
    return { status: 200, data: { allowsGroups: allow } };
  },
};

const me = (user) => ({
  id: user.id,
  username: user.username,
  friendCode: user.friend_code,
  allowsGroups: D.allowsGroups(user),
});

/* ------------------------------------------------------------------ server */

/**
 * Cross-origin headers for the one browser allowed to call this API from a
 * different origin -- see the file-header comment. `Access-Control-Allow-
 * Origin` is echoed back rather than set to the page's own origin directly,
 * which is just how a credentialed CORS response has to be built: the
 * wildcard `*` is rejected by browsers the moment cookies are involved.
 * Anything whose Origin header does not match ALLOWED_ORIGIN gets none of
 * this and falls back to the ordinary same-origin rules.
 */
function allowCrossOrigin(req, res) {
  if (!ALLOWED_ORIGIN || req.headers.origin !== ALLOWED_ORIGIN) return false;
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  return true;
}

const server = createServer(async (req, res) => {
  const crossOrigin = allowCrossOrigin(req, res);

  // The browser asks permission with OPTIONS before a POST it considers
  // risky -- any JSON body counts. There is nothing to run for this request;
  // the headers above already answered it, so just say which methods and
  // headers the real request may use and stop.
  if (req.method === 'OPTIONS') {
    if (crossOrigin) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const key = `${req.method} ${pathname}`;
  const handler = ROUTES[key];

  try {
    if (!handler) fail(404, 'No such endpoint.');

    const token = parseCookies(req.headers.cookie).sid;
    const user = D.userForSession(token);
    if (!user && !PUBLIC_ROUTES.has(key)) fail(401, 'Please sign in.');

    const body = req.method === 'POST'
      ? await readJsonBody(req, BODY_LIMITS[key] ?? DEFAULT_BODY_LIMIT)
      : {};
    const result = await handler({ req, user, token, body, query: url.searchParams });
    if (result.file) return await sendFile(res, result.file);
    sendJson(res, result.status, result.data, result.headers);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(`${key} failed:`, err);
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
});

D.purgeExpiredSessions();
setInterval(D.purgeExpiredSessions, 6 * 3600_000).unref();
await sweepOrphanImages();

server.listen(PORT, () => {
  console.log(`friend-chat is running at http://localhost:${PORT}`);
  if (!Bot.isConfigured()) {
    console.log(`${D.BOT_NAME} is off: set ANTHROPIC_API_KEY to switch it on.`);
  }
});
