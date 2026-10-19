/**
 * friend-chat — end-to-end API test.
 *
 * Boots the real server against a throwaway database and drives it over HTTP
 * the way a browser would, so the session cookies and polling are exercised
 * for real rather than mocked.
 *
 *   npm test
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const DB = join(HERE, 'test-chat.db');
/**
 * Uploads go somewhere disposable too. This is not tidiness: the server sweeps
 * upload files its database does not know about, so a test run pointed at the
 * real uploads/ folder would delete every real picture in it.
 */
const UPLOADS = join(HERE, 'test-uploads');

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

/** A browser-ish client: remembers its own session cookie. */
function client(name) {
  let cookie = null;
  return {
    name,
    me: null,
    async call(path, { method = 'GET', body } = {}) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    },
    /** For responses that are not JSON -- a picture's bytes and headers. */
    async raw(path) {
      return fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {} });
    },
  };
}

/** A real 1x1 PNG. Small, but with the magic bytes a PNG actually has. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/me`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server never came up');
}

/* ------------------------------------------------------------------- run   */

await rm(DB, { force: true });
await rm(`${DB}-wal`, { force: true });
await rm(`${DB}-shm`, { force: true });
await rm(UPLOADS, { force: true, recursive: true });

const server = spawn(
  process.execPath,
  ['--experimental-sqlite', join(HERE, 'server.mjs')],
  {
    env: {
      ...process.env,
      PORT: String(PORT),
      CHAT_DB: DB,
      CHAT_UPLOADS: UPLOADS,
      // Question Bot is exercised without a key on purpose: the tests assert
      // that it refuses clearly rather than that Claude answers well, so the
      // suite never spends money or needs the network.
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  }
);

try {
  await waitForServer();

  const alice = client('alice');
  const bob = client('bob');
  const carol = client('carol');

  /* ---- accounts ------------------------------------------------------- */
  console.log('\naccounts');

  let r = await alice.call('/api/signup', { method: 'POST', body: { username: 'alice', password: 'hunter22' } });
  check('alice can sign up', r.status === 200 && r.data.user.username === 'alice', JSON.stringify(r.data));
  alice.me = r.data.user;
  check('signup returns a friend code', /^[A-Z]{4}-[0-9]{4}$/.test(alice.me.friendCode || ''), alice.me.friendCode);
  check("the code is seeded from the username", (alice.me.friendCode || '').startsWith('ALIC'), alice.me.friendCode);

  r = await bob.call('/api/signup', { method: 'POST', body: { username: 'bob', password: 'bobpass1' } });
  bob.me = r.data.user;
  check('bob can sign up', r.status === 200, JSON.stringify(r.data));

  r = await carol.call('/api/signup', { method: 'POST', body: { username: 'carol', password: 'carol123' } });
  carol.me = r.data.user;

  r = await client('x').call('/api/signup', { method: 'POST', body: { username: 'alice', password: 'whatever1' } });
  check('a duplicate username is refused', r.status === 409, JSON.stringify(r.data));

  r = await client('x').call('/api/signup', { method: 'POST', body: { username: 'ab', password: 'longenough' } });
  check('a too-short username is refused', r.status === 400);

  r = await client('x').call('/api/signup', { method: 'POST', body: { username: 'gooduser', password: '123' } });
  check('a too-short password is refused', r.status === 400);

  r = await client('x').call('/api/signup', { method: 'POST', body: { username: 'bad name!', password: 'longenough' } });
  check('a username with punctuation is refused', r.status === 400);

  r = await client('x').call('/api/login', { method: 'POST', body: { username: 'alice', password: 'wrongpass' } });
  check('a wrong password is refused', r.status === 401);

  const alice2 = client('alice-phone');
  r = await alice2.call('/api/login', { method: 'POST', body: { username: 'ALICE', password: 'hunter22' } });
  check('login is case-insensitive on the username', r.status === 200, JSON.stringify(r.data));

  r = await client('anon').call('/api/conversations');
  check('no session means no access', r.status === 401);

  /* ---- looking a code up ---------------------------------------------- */
  console.log('\nfriend-code lookup');

  r = await alice.call('/api/lookup', { method: 'POST', body: { code: bob.me.friendCode } });
  check('a code resolves to a name', r.status === 200 && r.data.user.username === 'bob', JSON.stringify(r.data));
  check('it echoes the canonical code', r.data.code === bob.me.friendCode, r.data.code);
  check('it reports the group setting', r.data.allowsGroups === true);
  check('it does not leak the password hash',
    !JSON.stringify(r.data).includes('pass_hash') && !JSON.stringify(r.data).includes('pass_salt'),
    JSON.stringify(r.data));

  r = await alice.call('/api/lookup', { method: 'POST', body: { code: 'ZZZZ-9999' } });
  check('an unknown code does not resolve', r.status === 404);

  r = await alice.call('/api/lookup', {
    method: 'POST',
    body: { code: bob.me.friendCode.replace('-', '').toLowerCase() },
  });
  check('a lowercase, dashless code still resolves', r.status === 200 && r.data.user.username === 'bob');

  // The whole point of the design change: bob's password is useless as a handle.
  r = await alice.call('/api/lookup', { method: 'POST', body: { code: 'bobpass1' } });
  check("bob's password is not a way to reach him", r.status === 404);

  /* ---- compose: one recipient ----------------------------------------- */
  console.log('\ncompose (one recipient)');

  r = await alice.call('/api/compose', {
    method: 'POST',
    body: { codes: [bob.me.friendCode], body: 'hey bob' },
  });
  check('alice can compose to bob', r.status === 200, JSON.stringify(r.data));
  check('one recipient is not a group', r.data.isGroup === false);
  const ab = r.data.conversation;

  r = await alice.call('/api/compose', { method: 'POST', body: { codes: [], body: 'to nobody' } });
  check('composing to nobody is refused', r.status === 400);

  r = await alice.call('/api/compose', { method: 'POST', body: { codes: [bob.me.friendCode], body: '  ' } });
  check('an empty message is refused', r.status === 400);

  r = await alice.call('/api/compose', { method: 'POST', body: { codes: ['ZZZZ-9999'], body: 'hi' } });
  check('an unknown code is refused', r.status === 404);

  r = await alice.call('/api/compose', { method: 'POST', body: { codes: [alice.me.friendCode], body: 'hi' } });
  check('you cannot compose to yourself', r.status === 400);

  r = await alice.call('/api/compose', {
    method: 'POST',
    body: { codes: [bob.me.friendCode.replace('-', '').toLowerCase()], body: 'again' },
  });
  check('composing again reuses the same thread', r.status === 200 && r.data.conversation === ab,
    JSON.stringify(r.data));

  /* ---- messages ------------------------------------------------------- */
  console.log('\nmessages');

  r = await alice.call(`/api/messages?conversation=${ab}&after=0`);
  check("compose delivered alice's first message",
    r.data.messages.some((m) => m.body === 'hey bob'),
    JSON.stringify(r.data.messages?.map((m) => m.body)));

  r = await bob.call('/api/conversations');
  const bobsView = r.data.conversations.find((c) => c.id === ab);
  check('the chat shows up for bob unasked', !!bobsView, JSON.stringify(r.data));
  check('both composed messages are unread', bobsView?.unread === 2, String(bobsView?.unread));
  check("the chat is titled with alice's name", bobsView?.title === 'alice', bobsView?.title);

  r = await bob.call(`/api/messages?conversation=${ab}&after=0`);
  check('bob can read the message', r.data.messages?.[0]?.body === 'hey bob', JSON.stringify(r.data));
  check("it is not marked as bob's own", r.data.messages[0].mine === false);
  check('it is attributed to alice', r.data.messages[0].from === 'alice');

  const lastSeen = r.data.messages[r.data.messages.length - 1].id;
  await bob.call('/api/read', { method: 'POST', body: { conversation: ab, messageId: lastSeen } });
  r = await bob.call('/api/conversations');
  check('reading clears the unread count', r.data.conversations.find((c) => c.id === ab).unread === 0);

  r = await bob.call('/api/messages', { method: 'POST', body: { conversation: ab, body: 'hi alice' } });
  check('bob can reply', r.status === 200);

  r = await alice.call(`/api/messages?conversation=${ab}&after=${lastSeen}`);
  check('after= only returns what is new', r.data.messages.length === 1 && r.data.messages[0].body === 'hi alice',
    JSON.stringify(r.data.messages));

  r = await alice.call('/api/messages', { method: 'POST', body: { conversation: ab, body: '   ' } });
  check('an empty message is refused', r.status === 400);

  r = await carol.call(`/api/messages?conversation=${ab}`);
  check("an outsider cannot read someone else's chat", r.status === 404);

  r = await carol.call('/api/messages', { method: 'POST', body: { conversation: ab, body: 'butting in' } });
  check('an outsider cannot post into it either', r.status === 404);

  /* ---- polling -------------------------------------------------------- */
  console.log('\npolling');

  r = await bob.call('/api/poll?since=0');
  check('a stale cursor reports a change', r.data.changed === true && r.data.top > 0, JSON.stringify(r.data));
  const top = r.data.top;

  r = await bob.call(`/api/poll?since=${top}`);
  check('a current cursor reports no change', r.data.changed === false);
  check('no conversations are sent when nothing changed', r.data.conversations === undefined);

  await alice.call('/api/messages', { method: 'POST', body: { conversation: ab, body: 'still there?' } });
  r = await bob.call(`/api/poll?since=${top}`);
  check('a new message moves the cursor', r.data.changed === true && r.data.top > top);

  /* ---- group chat ----------------------------------------------------- */
  console.log('\ngroup chat');

  r = await alice.call('/api/compose', {
    method: 'POST',
    body: { title: 'Weekend plans', codes: [bob.me.friendCode, carol.me.friendCode], body: 'who is free saturday?' },
  });
  check('two recipients make a group', r.status === 200 && r.data.isGroup === true, JSON.stringify(r.data));
  const group = r.data.conversation;

  r = await carol.call(`/api/messages?conversation=${group}`);
  check('carol is in it', r.status === 200 && r.data.isGroup === true, JSON.stringify(r.data));
  check('it has all three members', r.data.members?.length === 3, String(r.data.members?.length));
  check('it keeps its name', r.data.title === 'Weekend plans', r.data.title);

  await bob.call('/api/messages', { method: 'POST', body: { conversation: group, body: 'saturday works' } });
  r = await carol.call(`/api/messages?conversation=${group}`);
  const groupMsg = r.data.messages.find((m) => m.body === 'saturday works');
  check("carol sees bob's group message", !!groupMsg);
  check('it is attributed to bob', groupMsg?.from === 'bob');

  r = await alice.call('/api/group/rename', { method: 'POST', body: { conversation: group, title: 'Sunday plans' } });
  check('a group can be renamed', r.status === 200 && r.data.title === 'Sunday plans');

  r = await carol.call('/api/group/leave', { method: 'POST', body: { conversation: group } });
  check('carol can leave', r.status === 200);

  r = await carol.call(`/api/messages?conversation=${group}`);
  check('after leaving she cannot read it', r.status === 404);

  r = await alice.call(`/api/messages?conversation=${group}&after=0`);
  check('the group is told she left',
    r.data.messages.some((m) => m.kind === 'system' && /carol left/.test(m.body)),
    JSON.stringify(r.data.messages.map((m) => m.body)));

  r = await alice.call('/api/group/invite', { method: 'POST', body: { conversation: group, code: carol.me.friendCode } });
  check('she can be added back', r.status === 200 && r.data.added === 'carol', JSON.stringify(r.data));

  r = await alice.call('/api/group/invite', { method: 'POST', body: { conversation: group, code: bob.me.friendCode } });
  check('adding an existing member is refused', r.status === 409);

  r = await alice.call('/api/group/leave', { method: 'POST', body: { conversation: ab } });
  check('you cannot "leave" a one-to-one chat', r.status === 400);

  /* ---- opting out of group chats -------------------------------------- */
  console.log('\ngroup opt-out');

  r = await carol.call('/api/me');
  check('group invites are allowed by default', r.data.user.allowsGroups === true, JSON.stringify(r.data.user));

  r = await carol.call('/api/settings/groups', { method: 'POST', body: { allow: false } });
  check('carol can opt out', r.status === 200 && r.data.allowsGroups === false, JSON.stringify(r.data));

  r = await carol.call('/api/me');
  check('the choice sticks', r.data.user.allowsGroups === false);

  // Opting out must not eject her from anything she is already part of.
  r = await carol.call(`/api/messages?conversation=${group}`);
  check('a group she was already in still works', r.status === 200, JSON.stringify(r.data));
  r = await carol.call('/api/messages', { method: 'POST', body: { conversation: group, body: 'still here' } });
  check('and she can still talk in it', r.status === 200, JSON.stringify(r.data));

  // Now leave, so the next add is a real add rather than an already-member case.
  await carol.call('/api/group/leave', { method: 'POST', body: { conversation: group } });

  r = await alice.call('/api/group/invite', { method: 'POST', body: { conversation: group, code: carol.me.friendCode } });
  check('she cannot be added to an existing group', r.status === 403, JSON.stringify(r.data));
  check('and the reason names her plainly',
    /carol isn't accepting group invites/.test(r.data.error || ''), r.data.error);

  r = await alice.call('/api/compose', {
    method: 'POST',
    body: { title: 'Another group', codes: [carol.me.friendCode, bob.me.friendCode], body: 'hi' },
  });
  check('nor pulled into a brand new one', r.status === 403, JSON.stringify(r.data));

  // One-to-one is not a group, so the opt-out must not block it.
  r = await alice.call('/api/compose', { method: 'POST', body: { codes: [carol.me.friendCode], body: 'just you' } });
  check('but a one-to-one still goes through', r.status === 200, JSON.stringify(r.data));

  r = await carol.call('/api/compose', {
    method: 'POST',
    body: { title: "Carol's own group", codes: [bob.me.friendCode, alice.me.friendCode], body: 'my group' },
  });
  check('she can still make her own group', r.status === 200 && r.data.isGroup === true, JSON.stringify(r.data));

  r = await alice.call('/api/compose', { method: 'POST', body: { codes: [carol.me.friendCode], body: 'still fine' } });
  check('one-to-one chats are unaffected', r.status === 200, JSON.stringify(r.data));

  r = await carol.call('/api/settings/groups', { method: 'POST', body: { allow: true } });
  check('she can opt back in', r.status === 200 && r.data.allowsGroups === true);

  r = await alice.call('/api/group/invite', { method: 'POST', body: { conversation: group, code: carol.me.friendCode } });
  check('and can be added again', r.status === 200 && r.data.added === 'carol', JSON.stringify(r.data));

  /* ---- blocking ------------------------------------------------------- */
  console.log('\nblocking');

  r = await bob.call('/api/block', { method: 'POST', body: { username: 'alice' } });
  check('bob can block alice', r.status === 200, JSON.stringify(r.data));

  r = await bob.call('/api/blocks');
  check('alice is on the block list', r.data.blocked.some((u) => u.username === 'alice'));

  r = await bob.call(`/api/messages?conversation=${ab}`);
  check("alice's messages are hidden from bob", r.data.messages.every((m) => m.from !== 'alice'),
    JSON.stringify(r.data.messages.map((m) => m.from)));

  r = await alice.call('/api/messages', { method: 'POST', body: { conversation: ab, body: 'hello?' } });
  check('alice can no longer reach bob', r.status === 403, JSON.stringify(r.data));

  r = await alice.call('/api/lookup', { method: 'POST', body: { code: bob.me.friendCode } });
  check("bob's code stops working for alice", r.status === 404);

  r = await bob.call('/api/block', { method: 'POST', body: { username: 'bob' } });
  check('you cannot block yourself', r.status === 400);

  r = await bob.call('/api/unblock', { method: 'POST', body: { username: 'alice' } });
  check('bob can unblock alice', r.status === 200);

  r = await bob.call(`/api/messages?conversation=${ab}`);
  check('unblocking brings the history back', r.data.messages.some((m) => m.from === 'alice'));

  r = await alice.call('/api/messages', { method: 'POST', body: { conversation: ab, body: 'back again' } });
  check('and alice can send again', r.status === 200);

  /* ---- settings ------------------------------------------------------- */
  console.log('\nsettings');

  r = await carol.call('/api/settings/newcode', { method: 'POST' });
  check('a new friend code can be issued', r.status === 200 && r.data.friendCode !== carol.me.friendCode,
    `${carol.me.friendCode} -> ${r.data.friendCode}`);
  const oldCode = carol.me.friendCode;
  carol.me.friendCode = r.data.friendCode;

  r = await alice.call('/api/lookup', { method: 'POST', body: { code: oldCode } });
  check('the old code stops working', r.status === 404);
  r = await alice.call('/api/lookup', { method: 'POST', body: { code: carol.me.friendCode } });
  check('the new code works', r.status === 200);

  r = await bob.call('/api/settings/username', { method: 'POST', body: { username: 'robert' } });
  check('bob can rename himself', r.status === 200 && r.data.user.username === 'robert', JSON.stringify(r.data));

  r = await alice.call('/api/conversations');
  check('the rename shows in alice\'s list',
    alice && r.data.conversations.some((c) => c.title === 'robert'),
    JSON.stringify(r.data.conversations.map((c) => c.title)));

  r = await alice.call(`/api/messages?conversation=${ab}&after=0`);
  check('his old messages are re-attributed too', r.data.messages.some((m) => m.from === 'robert'));

  r = await bob.call('/api/settings/username', { method: 'POST', body: { username: 'alice' } });
  check('he cannot take a taken username', r.status === 409);

  r = await bob.call('/api/lookup', { method: 'POST', body: { code: alice.me.friendCode } });
  check("alice's code survives her friend's rename", r.status === 200);

  r = await bob.call('/api/settings/password', { method: 'POST', body: { current: 'wrong', next: 'newpass1' } });
  check('a password change needs the old password', r.status === 403);

  r = await bob.call('/api/settings/password', { method: 'POST', body: { current: 'bobpass1', next: 'short' } });
  check('the new password must be long enough', r.status === 400);

  r = await bob.call('/api/settings/password', { method: 'POST', body: { current: 'bobpass1', next: 'newpass1' } });
  check('bob can change his password', r.status === 200, JSON.stringify(r.data));

  r = await bob.call('/api/me');
  check('his own session still works afterwards', r.data.user?.username === 'robert');

  r = await client('y').call('/api/login', { method: 'POST', body: { username: 'robert', password: 'newpass1' } });
  check('the new password logs him in', r.status === 200);
  r = await client('y').call('/api/login', { method: 'POST', body: { username: 'robert', password: 'bobpass1' } });
  check('the old password no longer does', r.status === 401);

  /* ---- sessions ------------------------------------------------------- */
  console.log('\nsessions');

  r = await alice2.call('/api/settings/password', { method: 'POST', body: { current: 'hunter22', next: 'newalice1' } });
  check('alice changes her password on her phone', r.status === 200);
  r = await alice.call('/api/conversations');
  check('her other device is logged out', r.status === 401, JSON.stringify(r.data));
  r = await alice2.call('/api/conversations');
  check('the device she did it on is not', r.status === 200);

  r = await alice2.call('/api/logout', { method: 'POST' });
  check('logout succeeds', r.status === 200);
  r = await alice2.call('/api/conversations');
  check('and the session is dead', r.status === 401);

  /* ---- pictures ------------------------------------------------------- */
  console.log('\npictures');

  // The sessions block above logged this device out on purpose, and her
  // password is the new one by now.
  r = await alice.call('/api/login', { method: 'POST', body: { username: 'alice', password: 'newalice1' } });
  check('alice signs back in', r.status === 200, JSON.stringify(r.data));

  r = await alice.call('/api/upload', {
    method: 'POST',
    body: { conversation: ab, mime: 'image/png', data: PNG_1X1, caption: 'look at this', width: 1, height: 1 },
  });
  check('alice can send a picture', r.status === 200 && r.data.id > 0, JSON.stringify(r.data));
  const picture = r.data.id;

  r = await bob.call(`/api/messages?conversation=${ab}&after=0`);
  const shot = r.data.messages.find((m) => m.id === picture);
  check('bob sees it in the thread', !!shot, JSON.stringify(r.data.messages.map((m) => m.kind)));
  check('it arrives as a picture, not text', shot?.kind === 'image', shot?.kind);
  check('the caption rides along as the body', shot?.body === 'look at this', shot?.body);
  check('its size comes with it, so the layout can hold a space',
    shot?.image?.width === 1 && shot?.image?.height === 1, JSON.stringify(shot?.image));

  let res = await bob.raw(`/api/image?message=${picture}`);
  check('bob can fetch the bytes', res.status === 200, String(res.status));
  check('they are served as a png', res.headers.get('content-type') === 'image/png',
    res.headers.get('content-type'));
  check('and the browser is told not to sniff them',
    res.headers.get('x-content-type-options') === 'nosniff');
  check('the bytes that come back are a real png',
    Buffer.from(await res.arrayBuffer())
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

  res = await carol.raw(`/api/image?message=${picture}`);
  check('an outsider cannot fetch the bytes', res.status === 404, String(res.status));

  res = await client('anon').raw(`/api/image?message=${picture}`);
  check('nor can someone with no session at all', res.status === 401, String(res.status));

  r = await alice.call('/api/upload', {
    method: 'POST',
    body: { conversation: ab, mime: 'application/pdf', data: PNG_1X1 },
  });
  check('a type that is not a picture is refused', r.status === 400, JSON.stringify(r.data));

  // The declared type decides how the file is served back, so the bytes have
  // to actually match it.
  r = await alice.call('/api/upload', {
    method: 'POST',
    body: { conversation: ab, mime: 'image/png', data: Buffer.from('<?php echo 1; ?>').toString('base64') },
  });
  check('a file lying about its type is refused', r.status === 400, JSON.stringify(r.data));

  r = await alice.call('/api/upload', {
    method: 'POST',
    body: { conversation: ab, mime: 'image/png', data: '' },
  });
  check('an empty picture is refused', r.status === 400, JSON.stringify(r.data));

  r = await carol.call('/api/upload', {
    method: 'POST',
    body: { conversation: ab, mime: 'image/png', data: PNG_1X1 },
  });
  check('an outsider cannot post a picture into the chat', r.status === 404, JSON.stringify(r.data));

  r = await bob.call('/api/conversations');
  const withPicture = r.data.conversations.find((c) => c.id === ab);
  check('the list says the last thing said was a picture', withPicture?.lastKind === 'image',
    withPicture?.lastKind);

  // A block hides pictures as thoroughly as it hides words.
  await bob.call('/api/block', { method: 'POST', body: { username: 'alice' } });
  res = await bob.raw(`/api/image?message=${picture}`);
  check("a blocked person's pictures go away too", res.status === 404, String(res.status));
  await bob.call('/api/unblock', { method: 'POST', body: { username: 'alice' } });
  res = await bob.raw(`/api/image?message=${picture}`);
  check('and come back on unblocking', res.status === 200, String(res.status));

  /* ---- question bot --------------------------------------------------- */
  console.log('\nquestion bot');

  r = await carol.call('/api/me');
  check('the server names the bot', r.data.bot?.name === 'Question Bot', JSON.stringify(r.data.bot));
  check('and says it has no key in the tests', r.data.bot?.ready === false, JSON.stringify(r.data.bot));
  check('and reports a daily limit', r.data.bot?.dailyLimit > 0, String(r.data.bot?.dailyLimit));

  r = await carol.call('/api/conversations');
  const botConv = r.data.conversations.find((c) => c.isBot);
  check('everyone gets a bot conversation unasked', !!botConv, JSON.stringify(r.data.conversations));
  check('it is called Question Bot', botConv?.title === 'Question Bot', botConv?.title);
  check('it is pinned to the top of the list', r.data.conversations[0]?.isBot === true,
    r.data.conversations[0]?.title);
  check('it is not a group', botConv?.isGroup === false);
  check('it has no other members', botConv?.members?.length === 0, JSON.stringify(botConv?.members));
  check('it carries no unread badge', botConv?.unread === 0, String(botConv?.unread));

  r = await carol.call('/api/conversations');
  check('a second look does not make a second one',
    r.data.conversations.filter((c) => c.isBot).length === 1,
    String(r.data.conversations.filter((c) => c.isBot).length));

  r = await carol.call(`/api/messages?conversation=${botConv.id}`);
  check('the thread reports itself as the bot', r.data.isBot === true, JSON.stringify(r.data));
  check('and starts empty', r.data.messages.length === 0, String(r.data.messages.length));

  r = await alice.call(`/api/messages?conversation=${botConv.id}`);
  check("nobody can read someone else's bot chat", r.status === 404, JSON.stringify(r.data));

  // With no key the bot must fail in a way a person can act on, and must not
  // leave half an exchange behind in the thread.
  r = await carol.call('/api/messages', {
    method: 'POST',
    body: { conversation: botConv.id, body: 'what is the capital of France?' },
  });
  check('asking with no key is refused', r.status === 503, JSON.stringify(r.data));
  check('and the reason names the missing key', /ANTHROPIC_API_KEY/.test(r.data.error || ''),
    r.data.error);

  r = await carol.call(`/api/messages?conversation=${botConv.id}`);
  check('a failed question leaves nothing in the thread', r.data.messages.length === 0,
    JSON.stringify(r.data.messages.map((m) => m.body)));

  // A picture is different: it did send, and only the answer failed.
  r = await carol.call('/api/upload', {
    method: 'POST',
    body: { conversation: botConv.id, mime: 'image/png', data: PNG_1X1, width: 1, height: 1 },
  });
  check('a picture to the bot still sends', r.status === 200 && r.data.id > 0, JSON.stringify(r.data));
  check('but it reports that the answer failed', /ANTHROPIC_API_KEY/.test(r.data.botError || ''),
    r.data.botError);

  r = await carol.call(`/api/messages?conversation=${botConv.id}`);
  check('the picture is in the thread on its own',
    r.data.messages.length === 1 && r.data.messages[0].kind === 'image',
    JSON.stringify(r.data.messages.map((m) => m.kind)));

  /* ---- static + misc -------------------------------------------------- */
  console.log('\nserving');

  res = await fetch(`${BASE}/`);
  check('the page is served', res.status === 200 && (await res.text()).includes('friend'));
  res = await fetch(`${BASE}/style.css`);
  check('the stylesheet is served', res.status === 200);
  res = await fetch(`${BASE}/app.js`);
  check('the script is served', res.status === 200);
  res = await fetch(`${BASE}/../db.mjs`);
  check('the database layer is not reachable', res.status === 404, String(res.status));
  res = await fetch(`${BASE}/api/nope`);
  check('an unknown endpoint 404s as json', res.status === 404);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 200));
  await rm(DB, { force: true });
  await rm(`${DB}-wal`, { force: true });
  await rm(`${DB}-shm`, { force: true });
  await rm(UPLOADS, { force: true, recursive: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailed:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
