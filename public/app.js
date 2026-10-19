/**
 * friendchat — browser app.
 *
 * Server data is rendered through textContent and DOM nodes, never innerHTML,
 * so a message body can never become markup.
 *
 * New messages arrive by polling /api/poll every POLL_MS. The response is a
 * single integer comparison unless something actually changed, which keeps it
 * cheap enough to port to shared hosting later.
 */

const POLL_MS = 1500;

// Tell the boot guard in index.html that this file ran. It must be set here,
// at the top of module evaluation, not after the first request: the flag means
// "app.js executed", and a slow server must not look like a failed one.
window.__booted = true;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The close/cross used on chips and dialogs. */
const xIcon = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
  svg.append(path);
  return svg;
};

const state = {
  me: null,
  bot: { name: 'Question Bot', ready: false, dailyLimit: 0 },
  conversations: [],
  activeId: null,
  activeIsGroup: false,
  activeIsBot: false,
  activeMembers: [],
  lastMsgId: 0,
  rendered: new Set(), // message ids already on screen, see appendMessages()
  pollTop: 0,
  timer: null,
  filter: 'all',
  search: '',
  recipients: [],   // compose chips: [{id, username, allowsGroups}]
  attachment: null, // a picture chosen but not yet sent, see pickImage()
  asking: false,    // true while waiting on the bot, which takes seconds
};

/* -------------------------------------------------------------------- api */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showError(node, message) {
  if (!message) {
    node.hidden = true;
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

/* ------------------------------------------------------------- formatting */

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function dayLabel(ms) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(ms, today)) return 'Today';
  if (sameDay(ms, yesterday)) return 'Yesterday';
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function listTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  if (sameDay(date, new Date())) return clockTime(ms);
  if (Date.now() - ms < 7 * 86400_000) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------- avatars    */

const AVATAR_COLOURS = [
  '#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6',
  '#0b8043', '#c5221f', '#1967d2', '#a142f4', '#e52592',
  '#12b5cb', '#f09300',
];

/** Same name, same colour, every session — the list stays scannable. */
function avatarColour(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
}

function avatar(name, extraClass = '') {
  const node = el('div', `avatar ${extraClass}`.trim(), (name || '?').charAt(0));
  node.style.background = avatarColour(name);
  return node;
}

/** The bot's own disc: a question mark, in its own colour, never a letter. */
function botAvatar(extraClass = '') {
  const node = el('div', `avatar bot-avatar ${extraClass}`.trim(), '?');
  node.title = state.bot.name;
  return node;
}

/** Groups get two overlapping discs so they read differently at a glance. */
function conversationAvatar(conv) {
  if (conv.isBot) return botAvatar();
  if (!conv.isGroup) return avatar(conv.members[0]?.username ?? conv.title);
  const stack = el('div', 'avatar-stack');
  const names = conv.members.slice(0, 2).map((m) => m.username);
  while (names.length < 2) names.push('?');
  for (const name of names) stack.append(avatar(name));
  return stack;
}

/* ============================== sign in / up ============================ */

let gateMode = 'login';

function setGateMode(mode) {
  gateMode = mode;
  for (const tab of $$('.tab')) tab.classList.toggle('is-on', tab.dataset.mode === mode);
  const signingUp = mode === 'signup';
  $('#gate-submit').textContent = signingUp ? 'Create account' : 'Log in';
  $('#gate-hint').hidden = !signingUp;
  $('#gate-form').password.autocomplete = signingUp ? 'new-password' : 'current-password';
  showError($('#gate-error'), '');
}

for (const tab of $$('.tab')) tab.addEventListener('click', () => setGateMode(tab.dataset.mode));

$('#gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const button = $('#gate-submit');
  showError($('#gate-error'), '');
  button.disabled = true;
  try {
    const { user } = await api(`/api/${gateMode}`, {
      method: 'POST',
      body: { username: form.username.value, password: form.password.value },
    });
    form.reset();
    enterApp(user);
  } catch (err) {
    showError($('#gate-error'), err.message);
  } finally {
    button.disabled = false;
  }
});

/* ================================= the app ============================== */

function enterApp(user) {
  state.me = user;
  $('#gate').hidden = true;
  $('#app').hidden = false;

  $('#my-code').textContent = user.friendCode;
  $('#rail-code').textContent = user.friendCode;
  $('#settings-code').textContent = user.friendCode;

  const me = $('#avatar-me');
  me.textContent = user.username.charAt(0);
  me.style.background = avatarColour(user.username);
  me.title = user.username;

  $('#ask-bot').querySelector('span').textContent = state.bot.name;
  $('#ask-bot').title = state.bot.ready
    ? `Ask ${state.bot.name} anything`
    : `${state.bot.name} is not switched on: the server has no ANTHROPIC_API_KEY.`;

  refreshConversations();
  startPolling();
}

function leaveApp() {
  stopPolling();
  clearAttachment();
  closeLightbox();
  state.me = null;
  state.activeId = null;
  state.activeIsBot = false;
  state.conversations = [];
  $('#app').hidden = true;
  $('#gate').hidden = false;
  settingsModal.hidden = true;
  composeModal.hidden = true;
  setGateMode('login');
}

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  leaveApp();
});

$('#avatar-me').addEventListener('click', () => $('#open-settings').click());

/* Click your own code to copy it — the main thing anyone does with it. */
for (const id of ['#my-code', '#rail-code']) {
  $(id).addEventListener('click', async () => {
    const node = $(id);
    const original = state.me.friendCode;
    try {
      await navigator.clipboard.writeText(original);
      node.classList.add('copied');
      node.textContent = 'Copied!';
      setTimeout(() => {
        node.classList.remove('copied');
        node.textContent = state.me.friendCode;
      }, 1200);
    } catch {
      /* Clipboard blocked (plain http, or permissions) — the code is visible anyway. */
    }
  });
}

/* --------------------------------------------------- filters and search   */

for (const item of $$('.nav-item')) {
  item.addEventListener('click', () => {
    state.filter = item.dataset.filter;
    for (const other of $$('.nav-item')) other.classList.toggle('is-on', other === item);
    closeRail();
    renderConversations();
  });
}

$('#search').addEventListener('input', (event) => {
  state.search = event.target.value.trim().toLowerCase();
  $('#search-clear').hidden = !state.search;
  renderConversations();
});

$('#search-clear').addEventListener('click', () => {
  $('#search').value = '';
  state.search = '';
  $('#search-clear').hidden = true;
  renderConversations();
  $('#search').focus();
});

/* The rail is a slide-over on a phone. */
const closeRail = () => $('.rail').classList.remove('open');
$('#menu').addEventListener('click', () => $('.rail').classList.toggle('open'));

/**
 * Open the bot's own thread. The conversation is made server-side the first
 * time the list is fetched, so it is found rather than created here.
 */
$('#ask-bot').addEventListener('click', async () => {
  closeRail();
  if (!state.conversations.some((c) => c.isBot)) {
    await refreshConversations().catch(() => {});
  }
  const bot = state.conversations.find((c) => c.isBot);
  if (!bot) return;
  await openConversation(bot.id);
  sendInput.focus();
});

function visibleConversations() {
  return state.conversations.filter((conv) => {
    if (state.filter === 'unread' && !conv.unread) return false;
    if (state.filter === 'groups' && !conv.isGroup) return false;
    if (!state.search) return true;
    const haystack = [
      conv.title,
      conv.lastBody ?? '',
      ...conv.members.map((m) => m.username),
    ].join(' ').toLowerCase();
    return haystack.includes(state.search);
  });
}

/* ----------------------------------------------- the conversation list    */

async function refreshConversations() {
  const { conversations } = await api('/api/conversations');
  state.conversations = conversations;
  renderConversations();
}

function renderCounts() {
  const all = state.conversations.length;
  const unread = state.conversations.reduce((n, c) => n + (c.unread ? 1 : 0), 0);
  const groups = state.conversations.filter((c) => c.isGroup).length;
  const counts = { all: all || '', unread: unread || '', groups: groups || '' };
  for (const node of $$('.nav-count')) node.textContent = counts[node.dataset.count];
}

/**
 * The one line under each name in the list. A picture has no text to quote,
 * so it is described instead -- with its caption when it has one.
 */
function previewText(conv) {
  const prefix = conv.isGroup && conv.lastFrom ? `${conv.lastFrom}: ` : '';
  if (conv.lastKind === 'image') {
    return prefix + (conv.lastBody ? `Photo — ${conv.lastBody}` : 'Photo');
  }
  if (!conv.lastBody) return conv.isBot ? 'Ask me anything' : 'No messages yet';
  return prefix + conv.lastBody;
}

function renderConversations() {
  renderCounts();

  const list = $('#conv-list');
  const empty = $('#list-empty');
  list.replaceChildren();

  const shown = visibleConversations();
  if (!shown.length) {
    empty.hidden = false;
    empty.textContent = state.search ? `Nothing matches "${state.search}".`
      : state.filter === 'unread' ? 'No unread chats.'
      : state.filter === 'groups' ? 'No group chats yet.'
      : 'No conversations yet. Hit Compose to start one.';
    return;
  }
  empty.hidden = true;

  for (const conv of shown) {
    const unread = conv.unread > 0 && conv.id !== state.activeId;
    const row = el('button', 'conv');
    row.type = 'button';
    if (conv.id === state.activeId) row.classList.add('is-on');
    if (unread) row.classList.add('unread');
    if (conv.isBot) row.classList.add('is-bot');

    row.append(conversationAvatar(conv));

    const text = el('div', 'conv-text');
    const top = el('div', 'conv-top');

    const name = el('div', 'conv-name');
    if (conv.isGroup) name.append(el('span', 'tag', 'group'));
    if (conv.isBot) name.append(el('span', 'tag bot-tag', 'ai'));
    name.append(document.createTextNode(conv.title));
    top.append(name);

    const right = el('span', 'conv-time', listTime(conv.lastAt));
    if (unread) right.append(el('span', 'badge', String(conv.unread)));
    top.append(right);

    text.append(top, el('p', 'conv-last', previewText(conv)));
    row.append(text);
    row.addEventListener('click', () => openConversation(conv.id));
    list.append(row);
  }
}

/* -------------------------------------------------------------- thread    */

async function openConversation(id, { silent = false } = {}) {
  const switching = state.activeId !== id;
  if (switching) {
    state.activeId = id;
    state.lastMsgId = 0;
    state.rendered.clear();
    $('#messages').replaceChildren();
    // A picture picked for one chat should not follow you into the next one.
    clearAttachment();
    showError($('#send-error'), '');
  }

  $('#empty').hidden = true;
  $('#thread').hidden = false;
  $('.shell').classList.add('has-thread');
  closeRail();

  let data;
  try {
    data = await api(`/api/messages?conversation=${id}&after=${state.lastMsgId}`);
  } catch (err) {
    if (!silent) showError($('#send-error'), err.message);
    return;
  }

  state.activeIsGroup = data.isGroup;
  state.activeIsBot = !!data.isBot;
  state.activeMembers = data.members;

  const conv = state.conversations.find((c) => c.id === id);
  const others = data.members.filter((u) => u.id !== state.me.id);
  const title = data.isBot
    ? state.bot.name
    : data.isGroup ? (data.title || 'Group') : (others[0]?.username ?? conv?.title ?? 'Chat');

  $('#thread-title').textContent = title;
  $('#thread-title').classList.toggle('bot-title', !!data.isBot);
  $('#thread-sub').textContent = data.isBot
    ? (state.bot.ready
        ? 'Ask anything. Only you can see this chat.'
        : 'Not switched on: the server has no ANTHROPIC_API_KEY.')
    : data.isGroup
      ? `${data.members.length} people: ${data.members.map((u) => u.username).join(', ')}`
      : 'One-to-one chat';
  $('#thread-sub').classList.toggle('bad', !!data.isBot && !state.bot.ready);

  $('#send-input').placeholder = data.isBot ? 'Ask a question' : 'Write a message';
  $('#attach').title = data.isBot ? 'Ask about a picture' : 'Send a picture';

  const head = $('#thread-avatar');
  head.replaceChildren();
  head.className = '';
  head.append(conversationAvatar({ isBot: data.isBot, isGroup: data.isGroup, members: others, title }));

  $('#group-add').hidden = !data.isGroup;
  $('#group-rename').hidden = !data.isGroup;
  $('#group-leave').hidden = !data.isGroup;
  $('#block-user').hidden = data.isGroup || !others.length;
  if (!data.isGroup && others.length) $('#block-user').title = `Block ${others[0].username}`;

  appendMessages(data.messages);
  if (switching) renderConversations();

  if (state.lastMsgId) {
    await api('/api/read', {
      method: 'POST',
      body: { conversation: id, messageId: state.lastMsgId },
    }).catch(() => {});

    const entry = state.conversations.find((c) => c.id === id);
    if (entry && entry.unread) {
      entry.unread = 0;
      renderConversations();
    }
  }
}

function appendMessages(incoming) {
  // Sending and the poll can both refresh the thread before lastMsgId has been
  // updated, so the same message can arrive twice. Ids already on screen are
  // dropped here rather than drawn a second time.
  const messages = incoming.filter((m) => !state.rendered.has(m.id));
  if (!messages.length) return;

  const box = $('#messages');
  // Only auto-scroll if the reader was already at the bottom, so an arriving
  // message never yanks the view away from something being read.
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  // The last real message, which is not necessarily the last child: the bot's
  // typing indicator sits there too, and it is not a message.
  let prev = null;
  for (let node = box.lastElementChild; node; node = node.previousElementSibling) {
    if (node._msg) {
      prev = node._msg;
      break;
    }
  }

  for (const msg of messages) {
    if (!prev || !sameDay(prev.at, msg.at)) box.append(el('div', 'daymark', dayLabel(msg.at)));

    if (msg.kind === 'system') {
      const node = el('div', 'sysmsg', msg.body);
      node._msg = msg;
      box.append(node);
      prev = msg;
      state.rendered.add(msg.id);
      state.lastMsgId = Math.max(state.lastMsgId, msg.id);
      continue;
    }

    const node = el('div', `msg ${msg.mine ? 'mine' : 'theirs'}`);
    const newSpeaker = !prev || prev.from !== msg.from || prev.kind === 'system';
    if (newSpeaker) node.classList.add('starts');
    if (msg.kind === 'bot') node.classList.add('from-bot');

    // Name only on the first of a run, and only where it is ambiguous.
    // The bot is always named: in a chat you opened to talk to a machine, the
    // one thing worth never being in doubt about is which replies are its.
    if (msg.kind === 'bot' && newSpeaker) {
      node.append(el('div', 'msg-from bot-from', state.bot.name));
    } else if (state.activeIsGroup && !msg.mine && newSpeaker) {
      node.append(el('div', 'msg-from', msg.from ?? 'someone'));
    }

    node.append(msg.image ? imageBubble(msg) : el('div', 'bubble', msg.body));
    node.append(el('div', 'msg-time', clockTime(msg.at)));

    node._msg = msg;
    box.append(node);
    prev = msg;
    state.rendered.add(msg.id);
    state.lastMsgId = Math.max(state.lastMsgId, msg.id);
  }

  if (atBottom) box.scrollTop = box.scrollHeight;
}

function closeThread() {
  state.activeId = null;
  state.lastMsgId = 0;
  state.rendered.clear();
  $('#thread').hidden = true;
  $('#empty').hidden = false;
  $('.shell').classList.remove('has-thread');
  $('#messages').replaceChildren();
  renderConversations();
}

$('#back').addEventListener('click', closeThread);

/* ------------------------------------------------------------ composing   */

const sendInput = $('#send-input');

const growInput = () => {
  sendInput.style.height = 'auto';
  sendInput.style.height = `${Math.min(sendInput.scrollHeight, 140)}px`;
};
sendInput.addEventListener('input', growInput);

sendInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#send-form').requestSubmit();
  }
});

/** Lock the controls while a send is in flight, which for the bot is seconds. */
function setSending(on) {
  state.asking = on;
  $('.send-btn').disabled = on;
  $('#attach').disabled = on;
  $('#attach-drop').disabled = on;
}

/**
 * Three dots in a bubble, standing in for the answer until it arrives. Not a
 * message and never stored: it carries no _msg, so appendMessages steps over
 * it, and it is taken down the moment the request settles either way.
 */
function showTyping() {
  const box = $('#messages');
  const node = el('div', 'msg theirs from-bot typing');
  node.append(el('div', 'msg-from bot-from', state.bot.name));
  const bubble = el('div', 'bubble typing-bubble');
  for (let i = 0; i < 3; i++) bubble.append(el('span', 'dot'));
  node.append(bubble);
  box.append(node);
  box.scrollTop = box.scrollHeight;
  return node;
}

$('#send-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeId || state.asking) return;

  const body = sendInput.value.trim();
  const picture = state.attachment;
  if (!body && !picture) return;

  showError($('#send-error'), '');
  sendInput.value = '';
  growInput();

  // The picture stays on screen until it is actually gone, so a failed send
  // can leave it exactly where it was instead of making you pick it again.
  const waiting = state.activeIsBot ? showTyping() : null;
  setSending(true);

  try {
    const sent = picture
      ? await api('/api/upload', {
          method: 'POST',
          body: {
            conversation: state.activeId,
            caption: body,
            mime: picture.mime,
            data: picture.base64,
            width: picture.width,
            height: picture.height,
          },
        })
      : await api('/api/messages', {
          method: 'POST',
          body: { conversation: state.activeId, body },
        });

    if (picture) clearAttachment();
    waiting?.remove();
    await openConversation(state.activeId);
    await refreshConversations();

    // The picture arrived but the answer about it did not. Say so without
    // pretending the upload failed, because it did not.
    if (sent.botError) showError($('#send-error'), sent.botError);
  } catch (err) {
    waiting?.remove();
    showError($('#send-error'), err.message);
    sendInput.value = body; // Give the text back rather than losing it.
    growInput();
  } finally {
    setSending(false);
  }
});

/* -------------------------------------------------------------- pictures   */

/** Long edge to shrink down to: plenty for a phone screen, small to send. */
const MAX_EDGE = 1600;
/** Below this, a picture is sent untouched rather than re-encoded. */
const KEEP_AS_IS_BYTES = 900 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGES = /^image\/(jpeg|png|gif|webp)$/;

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    // A data URL is "data:<mime>;base64,<payload>" -- only the payload is sent.
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('That picture could not be read.'));
    reader.readAsDataURL(blob);
  });

/**
 * Shrink a chosen picture before it goes anywhere. Phone cameras produce
 * several megabytes; sending that over a polling API, storing it and loading
 * it again on every thread is all waste, and none of it is visible on screen.
 */
async function prepareImage(file) {
  if (!ALLOWED_IMAGES.test(file.type)) {
    throw new Error('Pictures must be a JPEG, PNG, GIF or WebP.');
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file could not be read as a picture.');
  }

  const longest = Math.max(bitmap.width, bitmap.height);
  // A canvas keeps one frame, so re-encoding a GIF would quietly stop it
  // animating. GIFs are therefore sent exactly as they came.
  const untouched = file.type === 'image/gif'
    || (longest <= MAX_EDGE && file.size <= KEEP_AS_IS_BYTES);

  if (untouched) {
    const { width, height } = bitmap;
    bitmap.close();
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error('That picture is over 5 MB. Try a smaller one.');
    }
    return describe(file.name, { blob: file, mime: file.type, width, height });
  }

  const scale = Math.min(1, MAX_EDGE / longest);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency, so anything see-through would come out black
  // unless something opaque is laid down first.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob) throw new Error('That picture could not be prepared for sending.');
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error('That picture is still too large after shrinking.');
  }
  return describe(file.name, { blob, mime: 'image/jpeg', width, height });
}

async function describe(name, { blob, mime, width, height }) {
  return {
    name: name || 'picture',
    mime,
    width,
    height,
    bytes: blob.size,
    base64: await blobToBase64(blob),
    url: URL.createObjectURL(blob),
  };
}

function setAttachment(attachment) {
  clearAttachment();
  state.attachment = attachment;
  $('#attach-thumb').src = attachment.url;
  $('#attach-name').textContent = attachment.name;
  $('#attach-size').textContent = `${Math.max(1, Math.round(attachment.bytes / 1024))} KB`;
  $('#attach-preview').hidden = false;
}

function clearAttachment() {
  // The object URL pins the picture in memory until it is given back.
  if (state.attachment) URL.revokeObjectURL(state.attachment.url);
  state.attachment = null;
  $('#attach-thumb').removeAttribute('src');
  $('#attach-preview').hidden = true;
}

async function pickImage(file) {
  if (!state.activeId || state.asking) return;
  showError($('#send-error'), '');
  try {
    setAttachment(await prepareImage(file));
    sendInput.focus();
  } catch (err) {
    showError($('#send-error'), err.message);
  }
}

$('#attach').addEventListener('click', () => $('#attach-input').click());
$('#attach-drop').addEventListener('click', () => {
  clearAttachment();
  sendInput.focus();
});

$('#attach-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  // Cleared so that choosing the same file twice in a row still counts.
  event.target.value = '';
  if (file) await pickImage(file);
});

/* Paste a screenshot straight in -- the usual way anyone sends one. */
sendInput.addEventListener('paste', async (event) => {
  const item = [...(event.clipboardData?.items ?? [])]
    .find((entry) => entry.kind === 'file' && entry.type.startsWith('image/'));
  if (!item) return;
  const file = item.getAsFile();
  if (!file) return;
  event.preventDefault();
  await pickImage(file);
});

/**
 * A picture in the thread. Width and height are set from the stored size so
 * the browser reserves the space up front; without them every picture shoves
 * the conversation around as it loads.
 */
function imageBubble(msg) {
  const wrap = el('div', 'bubble bubble-image');

  const img = el('img', 'msg-image');
  img.src = `/api/image?message=${msg.id}`;
  img.alt = msg.body || 'Picture';
  img.loading = 'lazy';
  if (msg.image.width && msg.image.height) {
    img.width = msg.image.width;
    img.height = msg.image.height;
  }
  img.addEventListener('click', () => openLightbox(img.src, img.alt));
  img.addEventListener('error', () => {
    img.remove();
    wrap.prepend(el('div', 'image-gone', 'This picture could not be loaded.'));
  });

  wrap.append(img);
  if (msg.body) wrap.append(el('div', 'image-caption', msg.body));
  return wrap;
}

/* ------------------------------------------------------- the picture viewer */

const lightbox = $('#lightbox');

function openLightbox(src, alt) {
  const img = $('#lightbox-img');
  img.src = src;
  img.alt = alt || '';
  lightbox.hidden = false;
}

function closeLightbox() {
  lightbox.hidden = true;
  $('#lightbox-img').removeAttribute('src');
}

$('#close-lightbox').addEventListener('click', closeLightbox);
/* Anywhere but the picture itself dismisses it. */
lightbox.addEventListener('click', (event) => {
  if (event.target !== $('#lightbox-img')) closeLightbox();
});

/* ========================== the compose dialog ========================== */

const composeModal = $('#compose-modal');
const toInput = $('#to-input');

function openCompose() {
  state.recipients = [];
  toInput.value = '';
  $('#group-title').value = '';
  $('#compose-body').value = '';
  showError($('#compose-error'), '');
  renderChips();
  composeModal.hidden = false;
  toInput.focus();
}

$('#compose').addEventListener('click', openCompose);
$('#close-compose').addEventListener('click', () => { composeModal.hidden = true; });

function renderChips() {
  const box = $('#chips');
  for (const old of [...box.querySelectorAll('.chip')]) old.remove();

  for (const person of state.recipients) {
    const chip = el('div', 'chip');
    chip.append(avatar(person.username));
    chip.append(el('span', null, person.username));

    const remove = el('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${person.username}`);
    remove.append(xIcon());
    remove.addEventListener('click', () => {
      state.recipients = state.recipients.filter((p) => p.id !== person.id);
      renderChips();
      toInput.focus();
    });

    chip.append(remove);
    box.insertBefore(chip, toInput);
  }

  // The group name only matters once there is a group to name.
  const isGroup = state.recipients.length > 1;
  $('#title-field').hidden = !isGroup;
  if (isGroup) {
    $('#group-title').placeholder = state.recipients.map((p) => p.username).join(', ').slice(0, 60);
  }

  $('#compose-hint').textContent = !state.recipients.length ? ''
    : isGroup ? `Group chat with ${state.recipients.length} people`
    : `One-to-one chat with ${state.recipients[0].username}`;

  updateComposeButton();
}

const updateComposeButton = () => {
  $('#compose-send').disabled = !state.recipients.length || !$('#compose-body').value.trim();
};
$('#compose-body').addEventListener('input', updateComposeButton);

/* Type 8 characters and the dash places itself. */
toInput.addEventListener('input', () => {
  const clean = toInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  toInput.value = clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
  // A full code resolves on its own — no need to press anything.
  if (clean.length === 8) addRecipient();
});

toInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ',' || event.key === ' ') {
    event.preventDefault();
    addRecipient();
  } else if (event.key === 'Backspace' && !toInput.value && state.recipients.length) {
    state.recipients.pop();
    renderChips();
  }
});

let adding = false;

async function addRecipient() {
  const code = toInput.value.trim();
  if (!code || adding) return;

  adding = true;
  showError($('#compose-error'), '');
  try {
    const found = await api('/api/lookup', { method: 'POST', body: { code } });
    const { user, allowsGroups } = found;
    if (state.recipients.some((p) => p.id === user.id)) {
      showError($('#compose-error'), `${user.username} is already on the list.`);
    } else if (!allowsGroups && state.recipients.length >= 1) {
      // Say it at the moment of adding rather than after they write a message.
      showError($('#compose-error'), `${user.username} isn't accepting group invites.`);
    } else if (state.recipients.length === 1 && !state.recipients[0].allowsGroups) {
      // The person already on the list is fine alone, but cannot be in a group.
      showError($('#compose-error'), `${state.recipients[0].username} isn't accepting group invites.`);
    } else {
      state.recipients.push({ ...user, code: found.code, allowsGroups });
      toInput.value = '';
      renderChips();
    }
  } catch (err) {
    showError($('#compose-error'), err.message);
  } finally {
    adding = false;
  }
}

$('#compose-send').addEventListener('click', async () => {
  const body = $('#compose-body').value.trim();
  if (!state.recipients.length || !body) return;

  const button = $('#compose-send');
  button.disabled = true;
  showError($('#compose-error'), '');

  try {
    const { conversation } = await api('/api/compose', {
      method: 'POST',
      body: {
        codes: state.recipients.map((p) => p.code),
        title: $('#group-title').value,
        body,
      },
    });
    composeModal.hidden = true;
    await refreshConversations();
    await openConversation(conversation);
    sendInput.focus();
  } catch (err) {
    showError($('#compose-error'), err.message);
  } finally {
    button.disabled = false;
    updateComposeButton();
  }
});

/* ------------------------------------------------------------- groups      */

$('#group-add').addEventListener('click', async () => {
  const code = prompt('Friend code of the person to add:');
  if (!code) return;
  try {
    await api('/api/group/invite', {
      method: 'POST',
      body: { conversation: state.activeId, code },
    });
    await openConversation(state.activeId);
    await refreshConversations();
    showError($('#send-error'), '');
  } catch (err) {
    showError($('#send-error'), err.message);
  }
});

$('#group-rename').addEventListener('click', async () => {
  const title = prompt('New name for this group:', $('#thread-title').textContent);
  if (!title) return;
  try {
    await api('/api/group/rename', {
      method: 'POST',
      body: { conversation: state.activeId, title },
    });
    await refreshConversations();
    await openConversation(state.activeId);
  } catch (err) {
    showError($('#send-error'), err.message);
  }
});

$('#group-leave').addEventListener('click', async () => {
  if (!confirm('Leave this group? You will stop receiving its messages.')) return;
  try {
    await api('/api/group/leave', { method: 'POST', body: { conversation: state.activeId } });
    closeThread();
    await refreshConversations();
  } catch (err) {
    showError($('#send-error'), err.message);
  }
});

/* ------------------------------------------------------------- blocking    */

$('#block-user').addEventListener('click', async () => {
  const other = state.activeMembers.find((u) => u.id !== state.me.id);
  if (!other) return;
  if (!confirm(`Block ${other.username}? You will stop seeing their messages, and they cannot start new chats with you.`)) return;

  try {
    await api('/api/block', { method: 'POST', body: { username: other.username } });
    closeThread();
    await refreshConversations();
  } catch (err) {
    showError($('#send-error'), err.message);
  }
});

async function renderBlockList() {
  const { blocked } = await api('/api/blocks');
  const list = $('#block-list');
  list.replaceChildren();

  if (!blocked.length) {
    list.append(el('li', 'none', 'You have not blocked anyone.'));
    return;
  }

  for (const user of blocked) {
    const row = el('li');
    row.append(avatar(user.username, 'small'));
    row.append(el('span', null, user.username));
    const undo = el('button', 'ghost small', 'Unblock');
    undo.type = 'button';
    undo.addEventListener('click', async () => {
      await api('/api/unblock', { method: 'POST', body: { username: user.username } });
      await renderBlockList();
      await refreshConversations();
    });
    row.append(undo);
    list.append(row);
  }
}

/* ------------------------------------------------------------- settings    */

const settingsModal = $('#settings');

function settingsMessage(text, bad = false) {
  const node = $('#settings-msg');
  node.textContent = text;
  node.classList.toggle('bad', bad);
  node.hidden = !text;
}

$('#open-settings').addEventListener('click', async () => {
  settingsMessage('');
  $('#username-form').reset();
  $('#password-form').reset();
  $('#username-form').username.value = state.me.username;
  $('#allow-groups').checked = state.me.allowsGroups;
  settingsModal.hidden = false;
  await renderBlockList();
});
$('#close-settings').addEventListener('click', () => { settingsModal.hidden = true; });

/* Click the dimmed backdrop to dismiss any dialog. */
for (const modal of [settingsModal, composeModal]) {
  modal.addEventListener('click', (event) => {
    if (event.target === modal) modal.hidden = true;
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // The viewer sits on top of everything, so it closes on its own first --
    // otherwise one Escape would shut the dialog behind it as well.
    if (!lightbox.hidden) {
      closeLightbox();
      return;
    }
    settingsModal.hidden = true;
    composeModal.hidden = true;
    closeRail();
    return;
  }
  // "c" composes, the way a mail client does — but not while typing.
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');
  if (event.key === 'c' && !typing && state.me && composeModal.hidden && settingsModal.hidden) {
    event.preventDefault();
    openCompose();
  }
});

$('#allow-groups').addEventListener('change', async (event) => {
  const allow = event.target.checked;
  try {
    const data = await api('/api/settings/groups', { method: 'POST', body: { allow } });
    state.me.allowsGroups = data.allowsGroups;
    settingsMessage(allow
      ? 'Friends can add you to group chats.'
      : 'Friends can no longer add you to group chats.');
  } catch (err) {
    event.target.checked = !allow; // Put the switch back where it was.
    settingsMessage(err.message, true);
  }
});

$('#regen-code').addEventListener('click', async () => {
  try {
    const { friendCode } = await api('/api/settings/newcode', { method: 'POST' });
    state.me.friendCode = friendCode;
    $('#settings-code').textContent = friendCode;
    $('#my-code').textContent = friendCode;
    $('#rail-code').textContent = friendCode;
    settingsMessage(`Your new friend code is ${friendCode}.`);
  } catch (err) {
    settingsMessage(err.message, true);
  }
});

$('#username-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { user } = await api('/api/settings/username', {
      method: 'POST',
      body: { username: event.target.username.value },
    });
    state.me.username = user.username;
    const me = $('#avatar-me');
    me.textContent = user.username.charAt(0);
    me.style.background = avatarColour(user.username);
    me.title = user.username;
    settingsMessage(`You are now ${user.username}.`);
    await refreshConversations();
    if (state.activeId) await openConversation(state.activeId);
  } catch (err) {
    settingsMessage(err.message, true);
  }
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    await api('/api/settings/password', {
      method: 'POST',
      body: { current: form.current.value, next: form.next.value },
    });
    form.reset();
    settingsMessage('Password changed. Other devices have been logged out.');
  } catch (err) {
    settingsMessage(err.message, true);
  }
});

/* --------------------------------------------------------------- polling   */

async function poll() {
  if (!state.me) return;
  try {
    const data = await api(`/api/poll?since=${state.pollTop}`);
    state.pollTop = data.top;
    if (!data.changed) return;

    state.conversations = data.conversations;
    renderConversations();
    if (state.activeId) await openConversation(state.activeId, { silent: true });
  } catch (err) {
    // A 401 means the session died (logged out elsewhere, or expired).
    if (/sign in/i.test(err.message)) leaveApp();
  }
}

function startPolling() {
  stopPolling();
  state.timer = setInterval(poll, POLL_MS);
}
function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/* Don't poll a tab nobody is looking at; catch up the moment it returns. */
document.addEventListener('visibilitychange', () => {
  if (!state.me) return;
  if (document.hidden) stopPolling();
  else {
    poll();
    startPolling();
  }
});

/* ----------------------------------------------------------------- start   */

/** Take the loading screen down once we know which screen to show. */
const clearBootScreen = () => $('#boot')?.remove();

(async function boot() {
  let user = null;
  let trouble = '';

  try {
    const data = await api('/api/me');
    user = data.user;
    // What the bot is called, and whether the server has a key for it, both
    // come from the server so the two can never disagree.
    if (data.bot) state.bot = data.bot;
  } catch (err) {
    // The files loaded but the API did not answer — almost always the Node
    // server not running behind them. Say so on the sign-in screen.
    trouble = `Can't reach the server (${err.message}). `
      + 'The page loaded, but nothing is answering /api — check that server.mjs is running.';
  }

  clearBootScreen();

  if (user) return enterApp(user);

  $('#gate').hidden = false;
  setGateMode('login');
  if (trouble) showError($('#gate-error'), trouble);
})();
