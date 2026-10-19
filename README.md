# friend-chat

A small texting site: you make an account, your friends reach you with a
**friend code**, and you talk one-to-one or in groups. You can send pictures,
and there is a **Question Bot** you can ask anything.

One npm dependency — the Anthropic SDK, for the bot. Everything else is Node's
standard library plus the built-in SQLite that landed in Node 22.

## Running it

```
npm install
```

once, then double-click **`run.bat`**, or:

```
npm start
```

Then open <http://localhost:3000>. Sign up, and your friend code appears in the
top right. To try it properly, open a second account in a private window and
text yourself.

```
npm test
```

runs 139 end-to-end checks against a throwaway database. They never call the
Anthropic API, so the suite costs nothing and works offline.

### Switching Question Bot on

Everything works without this; the bot alone needs a key, in the environment
the **server** runs in:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Get one at <https://console.anthropic.com>. Without it the app runs normally and
the bot says it is not switched on, rather than failing in some confusing way.
`BOT_DAILY_LIMIT` (default 50) caps how many questions one account may ask per
day, because every question is billed to whoever owns the key. See `DEPLOY.md`.

## About the friend code

The original plan was that you would type in *your friend's password* to text
them. That cannot be made safe: a password you have given away is not a
password any more. Whoever holds it can read your messages, rename you, change
your password and lock you out, and you cannot undo it without changing your
password and telling everyone all over again.

So there are two separate things here:

| | who sees it | what it does |
|---|---|---|
| **Password** | only you | logs you in, nothing else |
| **Friend code** | anyone you give it to | lets them open a chat with you |

The friend code looks like `MAYA-7390`. It is seeded from your username so it
feels like yours, but it is stored separately, which means:

- renaming yourself does **not** break the code friends already saved
- you can issue a **new code** at any time if you gave it to the wrong person,
  and your existing chats carry on untouched

Codes skip the letters `I` and `O` and the digits `0` and `1`, so nobody has to
guess whether that was a one or an ell when reading one out loud.

## The layout

Three columns, like a mail client:

```
┌──────────────────────────────────────────────────────────────┐
│  friendchat   [ search chats          ]      CODE  ⚙  (A)    │
├───────────┬─────────────────────┬────────────────────────────┤
│ ✎ Compose │ (M) maya      14:20 │  (M) maya                  │
│           │     sixish works    │                            │
│ All     3 │                     │    hey! got my code ok?    │
│ Unread  1 │ (D) daniel   ● 2    │        yes, worked first → │
│ Groups  1 │     quick q about…  │                            │
│           │                     │  ┌──────────────────────┐  │
│ Log out   │ (SD) Saturday 12:04 │  │ Write a message    ➤ │  │
│           │     daniel: I will… │  └──────────────────────┘  │
│ ASAF-4821 │                     │                            │
└───────────┴─────────────────────┴────────────────────────────┘
```

Each person gets a coloured initial, always the same colour, so the list is
scannable without reading it; a group shows two overlapping discs instead.
Below 900px the rail slides away behind the menu button and the list and
thread take turns.

`c` composes, `Enter` sends, `Shift+Enter` makes a new line, `Ctrl+V` attaches a
picture from the clipboard, `Escape` closes whatever is open — the picture
viewer first, if one is up.

## What it does

- **Accounts** — signup and login, 30-day sessions in an HttpOnly cookie.
  Passwords are stored as scrypt hashes with a per-user random salt, so a copy
  of the database does not hand over anyone's password.
- **One Compose** — there is no separate "new group" button. You add friend
  codes to the **To** field and they become named chips; typing the eighth
  character resolves a code on its own, so there is nothing to press. One
  recipient opens a one-to-one chat, **two or more makes a group**, and the
  group-name box only appears once there is a group to name. Composing to
  someone you have talked to before returns to the same thread rather than
  starting a second one.
- **Group chats** — members can be added later, the group renamed, and anyone
  can leave. Joins and departures appear in the thread as a system line. An
  unnamed group is labelled with the names of the people in it.
- **Group chat is optional, twice over** — it is never its own feature, only an
  option of composing; and Settings has *"Let friends add me to group chats"*,
  on by default. Turn that off and nobody can put you in a new group; they are
  told plainly that you are not accepting group invites, rather than being left
  to wonder. Groups you are already in are untouched, you can still start your
  own, and one-to-one chats are unaffected.
- **Search and filters** — search runs over names, group titles and message
  previews. The rail filters to All, Unread or Groups, each with a count.
- **Blocking** — cuts both directions. Their messages disappear from your view
  (retroactively, and they come back if you unblock), they cannot start a new
  chat with you, and in a one-to-one chat delivery stops. A blocked person's
  code reports "no one has that friend code", exactly as a wrong code does, so a
  block is not detectable.
- **Pictures** — attach one with the image button, or just paste a screenshot
  into the message box. Big photos are shrunk in the browser before they are
  sent (long edge 1600px, re-encoded as JPEG) so a phone camera's eight
  megabytes becomes a few hundred kilobytes. A caption is optional. Click a
  picture in the thread to see it full size; `Escape` closes it. Animated GIFs
  are passed through untouched, because re-encoding one would stop it moving.
- **Question Bot** — a chat with Claude, yellow everywhere so it never reads as
  a person. It sits at the top of your list and in the rail; the thread is
  private to you, and nobody else can open it. Send it a picture and it answers
  about the picture. It remembers the thread, so follow-up questions work.
- **Settings** — change your username, change your password (which requires the
  old one and logs out your other devices), or get a new friend code.
- **Unread counts**, day separators, grouped runs of messages, and a layout that
  collapses to a single column on a phone.

## How the files fit together

```
server.mjs      HTTP server: static files + the JSON API. No framework.
db.mjs          Schema and every query. Passwords, sessions, friend codes.
bot.mjs         The only code that talks to anything outside: Claude.
test.mjs        End-to-end tests; boots the real server over HTTP.
public/
  index.html    Both screens: the sign-in gate and the app shell.
  app.js        All browser logic. Renders via textContent, never innerHTML.
  style.css     Three-column mail layout, and the phone fallback.
chat.db         Created on first run. Gitignored; it holds real messages.
uploads/        Picture files. Gitignored, and deliberately not in public/.
```

Every conversation begins at `POST /api/compose`, which decides between a
one-to-one chat and a group purely by how many recipients it was handed.
`POST /api/lookup` is what turns a typed code into a named chip.

**One idea, used three times.** A one-to-one chat is just a conversation with
two members and `is_group = 0`. A group is the same thing with more members.
Question Bot is the same thing again — `is_bot = 1`, one member — so it reuses
the whole thread, polling, unread and read-marker machinery instead of being a
feature bolted on beside it. A question to the bot even arrives through the
ordinary `POST /api/messages`; it just takes a few seconds and writes two
messages instead of one.

Pictures follow the same instinct: a picture is a message with `kind = 'image'`,
its caption in the usual `body`, and a row in `images` pointing at the file. So
blocking, unread counts, day separators and search all already handle them.

**Why `uploads/` is not inside `public/`.** A file in `public/` is served to
anyone who asks for it. Pictures go through `GET /api/image?message=…` instead,
which re-checks that you are a member of that conversation and that you have
not blocked the sender — so a leaked message id is not a licence to read
somebody's photograph. Filenames are random on top of that.

Columns added after the first release are applied at startup by the small
migration loop at the top of `db.mjs` — a database made by an earlier version
keeps working instead of having to be deleted.

## Putting it online later

New messages arrive by **polling** `/api/poll` every 1.5 seconds, not over
WebSockets. That was deliberate. Your cPanel hosting runs PHP, not Node, and
polling is the one design that ports to it: `server.mjs` becomes an `api.php`
alongside `talk-to-sam/api.php`, SQLite becomes MySQL, and **`public/` does not
change at all**. WebSockets would have ruled that host out.

The poll is cheap — one integer comparison server-side unless something actually
changed, and the tab stops polling entirely when it is not being looked at.

Three things to change before this is on the open internet:

1. Serve it over **HTTPS**. Session cookies over plain HTTP can be read in
   transit. The cookie is already `HttpOnly` and `SameSite=Lax`; add `Secure`
   once there is a certificate.
2. Add **rate limiting** on signup and login, or someone will script their way
   through passwords at their leisure.
3. Decide what Question Bot costs you. Anyone who can sign up can ask it
   questions, and every question is billed to your API key. `BOT_DAILY_LIMIT` is
   the brake; a spend limit on the key itself is the backstop.
