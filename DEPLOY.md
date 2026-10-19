# Putting friendchat online

## Read this first — the part that catches everyone

friendchat is **two halves**:

| | files | what it does | what it needs |
|---|---|---|---|
| front | `public/index.html`, `app.js`, `style.css` | what you see | any web host |
| back | `server.mjs`, `db.mjs`, `bot.mjs` | accounts, messages, pictures, Question Bot | **Node** |

Uploading only the `public/` folder by FTP gets you a site that **looks** right and
cannot work. There is nothing to sign you in, nothing storing messages. You will
reach the login screen and get *"Can't reach the server"* the moment you try to use it.

Your cPanel hosting (the one `greek.quest` and `talk-to-sam` are on) runs **PHP**.
It will not run `server.mjs`. So there are only two honest routes:

- **A.** Port the backend to PHP + MySQL, then it fits the host you already have.
- **B.** Run the Node version on a host that does Node (Render, Fly, Railway).

Nothing in `public/` changes either way — that is why new messages arrive by
polling rather than WebSockets.

---

## Fixing "friendchat could not start"

Reload the page; the message names the cause. The three you are likely to see:

### "Your host is sending app.js with the wrong type"

`app.js` loads as a **module script**, and browsers refuse to run a module unless
the server labels it as JavaScript. Some shared hosts send `text/plain`.

**Fix:** upload the included **`public/.htaccess`** into the same folder as
`index.html`. The line that matters is:

```apache
AddType text/javascript .js
```

`.htaccess` is a hidden file. In cPanel's File Manager turn on
*Settings → Show Hidden Files (dotfiles)* first, or send it over FTP.

### "The server could not find app.js"

`app.js` is not in the same folder as `index.html`. This usually means the whole
project folder was uploaded, leaving the real files one level down in `public/`.

**Upload the CONTENTS of `public/`, not the project folder.** You want:

```
public_html/
  index.html
  app.js
  style.css
  .htaccess
```

not `public_html/public/index.html`, and not `public_html/server.mjs`.

### "The server sent a web page where app.js should be"

The host answered with its own error page. Same cause as above — the file is not
where `index.html` is looking.

---

## Route A — port the backend to PHP (fits your current host)

Not built yet. It means rewriting `server.mjs` as a single `api.php` and the
SQLite schema in `db.mjs` as MySQL tables, then uploading `api.php` next to
`index.html` exactly like `talk-to-sam/api.php`. Ask and I will write it.

Everything in `public/` stays byte-for-byte the same. Pictures and Question Bot
were both built with this in mind: a picture is base64 inside ordinary JSON
(`php://input` reads it the same way), and the bot is one HTTPS POST that PHP
can make with cURL.

## Route B — run the Node version as-is

No rewrite. On a Node host:

```
npm install        # the Anthropic SDK; nothing else
npm start          # honours PORT, so most hosts need no config
```

Give it a **persistent disk** and point two things at it, or they reset on every
redeploy:

- `chat.db` — the whole database, one file.
- `uploads/` — every picture anyone has sent. Override with `CHAT_UPLOADS`.

Free tiers usually sleep when idle, which means a slow first load rather than
an outage.

---

## Switching Question Bot on

The bot is the one part of friendchat that talks to the outside world. It needs
an Anthropic API key, set in the **server's** environment — never in `public/`,
and never in the database:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Get one from <https://console.anthropic.com> → API keys. Without it everything
else works normally and the bot says it is not switched on, in the app and in
the server log.

Two optional knobs:

| variable | default | what it does |
|---|---|---|
| `BOT_DAILY_LIMIT` | `50` | Questions one account may ask per day. |
| `BOT_EFFORT` | `medium` | `low` is faster and cheaper, `high` thinks harder. |

**The key is money.** Anyone who can sign up can ask the bot questions, and every
question is billed to you. The daily limit is the brake; set it lower if the site
is public, and set a spend limit on the key itself in the Anthropic console.

---

## Before anyone real uses it

1. **HTTPS.** Session cookies over plain HTTP can be read in transit. The included
   `.htaccess` already redirects to https; once there is a certificate, also add
   `Secure` to the cookie in `server.mjs` (`sessionCookie()`).
2. **Rate limiting** on signup and login, or passwords can be guessed at leisure
   by a script.
3. **Never upload `chat.db` or `uploads/`.** They hold everyone's messages and
   photographs. `.gitignore` keeps both out of git, and the `.htaccess` refuses to
   serve `.db` files, but the simplest protection is not putting them on a web
   server at all. Note `uploads/` is deliberately **outside** `public/`: pictures
   are served through `/api/image`, which checks you are in the conversation
   first. Moving them into `public/` would make every photo public to anyone who
   guesses a filename.
4. **A spend limit on the Anthropic key**, for the reason in the section above.
