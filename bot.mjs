/**
 * friend-chat — Question Bot.
 *
 * The one part of the app that talks to something outside it. Everything here
 * is about turning a stored conversation into a Claude request and the reply
 * back into a sentence a person can read, including when it goes wrong.
 *
 * The API key is never sent to the browser and never stored in the database:
 * it is read from ANTHROPIC_API_KEY in the server's own environment. If it is
 * missing the bot says so plainly rather than failing silently.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOT_NAME, UPLOAD_DIR } from './db.mjs';

const MODEL = 'claude-opus-5';

/** How many questions one account may ask per day, so a stray tab or a
 *  curious signup cannot quietly run up the API bill. */
export const DAILY_LIMIT = Number(process.env.BOT_DAILY_LIMIT) || 50;

/** low | medium | high | xhigh | max -- raise it for harder questions, at the
 *  cost of a longer wait and more tokens. */
const EFFORT = process.env.BOT_EFFORT || 'medium';

/** Enough room for the answer plus the thinking that precedes it. */
const MAX_TOKENS = 8000;

/** How many turns of the thread to replay, and how much of it may be pictures. */
const HISTORY_TURNS = 20;
const MAX_IMAGES = 3;
const IMAGE_LOOKBACK = 6;

export const isConfigured = () => !!process.env.ANTHROPIC_API_KEY;

const SYSTEM = `You are ${BOT_NAME}, a helper built into a small texting app
called friendchat. People open a chat with you to ask anything at all: facts,
advice, explanations, help writing a message, working something out.

You are reading a chat thread, so write like a message, not like an essay.
Keep answers short -- usually a sentence or a short paragraph. Use a few plain
lines or dashes if you genuinely need to list things, but no headings, no bold,
and no markdown tables: none of it renders here, it just shows up as symbols.
Stay under about 1500 characters unless the person asks for more detail.

Answer the question that was asked. If you don't know something, or it depends
on information you don't have, say so in a line instead of guessing. If someone
sends a picture, look at it and answer about what is actually in it.

This chat is private to the person you are talking to. You cannot see their
other conversations, send messages to their friends, or do anything in the app
on their behalf -- if they ask for that, say so.`;

let client = null;
/** Built on first use: constructing it needs the key, which may be absent. */
const anthropic = () => (client ??= new Anthropic());

/* ------------------------------------------------------- building a request */

/**
 * Attach a stored picture as an image block. Returns null if the file has gone
 * missing, so one lost upload degrades to a text note instead of a failure.
 */
async function imageBlock(row) {
  try {
    const data = await readFile(join(UPLOAD_DIR, row.filename));
    return {
      type: 'image',
      source: { type: 'base64', media_type: row.mime, data: data.toString('base64') },
    };
  } catch {
    return null;
  }
}

/**
 * Turn stored rows into Messages API turns. Pictures are only attached for the
 * last few messages: older ones become "[a photo]" so a long thread of images
 * cannot grow the request without bound.
 */
async function toTurns(history) {
  const turns = [];
  let budget = MAX_IMAGES;

  for (const [index, row] of history.entries()) {
    const recent = index >= history.length - IMAGE_LOOKBACK;

    if (row.kind === 'bot') {
      turns.push({ role: 'assistant', content: row.body || '(no answer)' });
      continue;
    }

    if (row.kind === 'image' && row.filename) {
      const block = recent && budget > 0 ? await imageBlock(row) : null;
      if (block) {
        budget--;
        const content = [block];
        if (row.body) content.push({ type: 'text', text: row.body });
        turns.push({ role: 'user', content });
      } else {
        turns.push({ role: 'user', content: row.body || '[a photo]' });
      }
      continue;
    }

    if (row.body) turns.push({ role: 'user', content: row.body });
  }

  // The conversation has to open on a user turn.
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

/* ------------------------------------------------------------- asking Claude */

/** Thrown for anything the person asking should be told about. */
export class BotError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Ask the model, given the thread so far and the new question.
 * Returns the answer text; throws BotError with something readable otherwise.
 */
export async function ask(history, question) {
  if (!isConfigured()) {
    throw new BotError(
      503,
      `${BOT_NAME} is not switched on yet. The server needs an ANTHROPIC_API_KEY `
        + 'in its environment -- see DEPLOY.md.'
    );
  }

  const messages = await toTurns(history.slice(-HISTORY_TURNS));
  // A question sent on its own becomes the last turn. A picture sent with no
  // caption does not: it is already the last turn, and there is nothing to add.
  if (question) messages.push({ role: 'user', content: question });
  if (!messages.length) throw new BotError(400, 'Ask a question first.');

  let reply;
  try {
    reply = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // A safety classifier can decline a request outright. Asking for the
      // default fallback means such a question is quietly re-answered by
      // another model instead of coming back as a dead end.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: EFFORT },
      messages,
    });
  } catch (err) {
    throw translate(err);
  }

  // Check why it stopped before reading content: a refusal carries none.
  // It is a real answer, though, not a failure -- so it is returned to be
  // stored and shown in the thread like anything else the bot says.
  if (reply.stop_reason === 'refusal') {
    return "I can't help with that one, sorry. Ask me something else?";
  }

  const text = reply.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (!text) {
    throw new BotError(502, `${BOT_NAME} came back empty-handed. Please ask again.`);
  }
  if (reply.stop_reason === 'max_tokens') {
    return `${text}\n\n(I ran out of room -- ask me to carry on.)`;
  }
  return text;
}

/** Turn an SDK exception into a sentence, keeping the detail in the log. */
function translate(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new BotError(503, "The server's Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new BotError(503, "The server's Anthropic API key is not allowed to use this model.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new BotError(429, `${BOT_NAME} is busy right now. Try again in a moment.`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new BotError(503, "Couldn't reach Anthropic. Check the server's internet connection.");
  }
  if (err instanceof Anthropic.APIError) {
    console.error('Question Bot API error:', err.status, err.message);
    return new BotError(502, `${BOT_NAME} could not answer that (error ${err.status}).`);
  }
  console.error('Question Bot failed:', err);
  return new BotError(500, `${BOT_NAME} ran into a problem. Please try again.`);
}
