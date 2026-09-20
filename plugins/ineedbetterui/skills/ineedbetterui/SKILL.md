---
name: ineedbetterui
description: Records the conversation between the user and the agent to a local file and shows it in a browser UI with an outline, pins, notes and code highlighting. Use when the user calls ineedbetterui, or asks to record this conversation or view it in a browser.
---

# I Need Better UI

Calling this skill is itself the request to start recording. Apply these rules only in the session where the user called it.

## Start

Run the server in the background from the **project folder** (the working directory is the project that gets recorded). Point to the script by its path in this skill folder; never `cd` into the skill folder.

~~~bash
node <skill folder>/ineedbetterui.mjs              # this computer only (default)
node <skill folder>/ineedbetterui.mjs --broadcast  # also reachable on the LAN
~~~

- It prints `listening on http://127.0.0.1:PORT/`, or `already running on ...` if this project's server is up. Tell the user the address. Do not remember the port; run the same command again when you need it.
- If the skill was called alone, do not ask what to do: start the server, give the address, and do not record that message. If it came with a request, start the server first, then record from that request on.
- If the server cannot create its records folder (`EPERM` etc.), do not record elsewhere. Show the error; the user can start `ineedbetterui` in a normal terminal and you will then get "already running".
- Never turn broadcast on yourself, and do not install Node without the user's approval. The user stops the server with `ineedbetterui stop`.
- Records live in `<project>/node_modules/.ineedbetterui/`. Before running anything that deletes `node_modules` (`npm ci`, etc.), warn the user that the transcript goes with it.

## What to record

- Every user message (kind `question`) and every reply you give the user. Never record internal reasoning or raw tool calls.
- Write everything you record (bodies, headings, cleaned questions, outline titles) in the language of the conversation, not the language of these instructions. The page UI itself stays English.
- Kinds: `question`, `report` (progress or explanation), `decision` (awaiting the user's choice), `error`, `done`, `other`. Bodies are Markdown.

~~~json
POST /api/entries
{"kind":"question","turn":14,"rawBody":"<user's words>","cleanedBody":"<cleaned question>","knownHead":"<last sync.head>"}
~~~

- Questions need both `rawBody` and `cleanedBody` (the server refuses otherwise and picks one to show from the user's setting). A cleaned question keeps the intent, conditions and strength of the request, adds nothing, drops greetings and repetition, and has no meta phrases such as "the user asks".
- **Number the turn.** `turn` is the position of the user's message in the conversation in front of you: count their messages, starting at 1 for the first one you record. Send the same number with the progress lines and the reply. Retrying a question with the same number is not a duplicate; the server keeps one entry.
- If a write is refused because a turn is missing, you skipped recording it. Those messages are still in front of you: record the missing turn and its reply, then carry on. `next` always names the number to send.
- If a reply is rejected for length, write it shorter; never split it across two replies and never cut it off. Check `written` in the response: a failed write saved nothing.
- Recorded replies never change. To correct something, say so in a new reply.

## Turns

A turn is one user message and your replies to it. Only one turn is open at a time.

- **Register once, before anything else**: `POST /api/agents` with `{"model": "<the model you run as>"}`. You get back `{"agent", "token"}`. Send `X-Ineedbetterui-Agent: <token>` with **every** write; without it a write is refused. Keep the token for the whole session, and tell the user your `agent` name if they ask who is answering.
- The turn is yours alone: another agent cannot reply to it, and you cannot reply to theirs. If a write is refused with `409` naming another agent, wait and tell the user.
- Within your own turn you are never blocked. If the user sends another message before you answer — including after stopping you mid-answer — record it as a question like any other and answer once when you are done.
- Recording the user's message opens the turn, and recording your reply closes it. **One question takes one reply**, so there is nothing to mark: a second reply in the same turn is refused. Until you reply, no other message can be recorded.
- While you work, say what you are doing: `POST /api/progress` with `{"text": "reading the outline code"}`, in the language of the conversation. The user sees it under the conversation; it is never recorded, and the reply clears it. Send it again whenever what you are doing changes.
- If recording the user's message is refused with 409, the error names the other agent that is mid-turn. Tell the user, in the conversation's language, that it could not be recorded because that agent is still answering and that they can ask you to try again. Record nothing and do not retry on your own. When the user asks you to try again, record the original message again (same `clientRef`); do not record the retry request itself.

## Sync

Several agents can share one thread. The transcript is a hash chain (each head = hash of the previous head + the new line), and the head you hold tells the server what you have already seen.

- Start every turn by recording the user's message with your `knownHead`, and read the response before you answer: that write is your sync. Its `turn` object tells you what shapes this reply: `replyLimit` (keep the reply within it), `replyTo` (the user turned on Add reply: this turn's reply edits that pinned document, see below), `outline` (the step to continue), `unseen` (only a count of missed events by type; the events themselves are in `sync.unseen` of the same response, so read them there).
- Put the last `sync.head` you received into every write as `knownHead`, and keep the new one from the response. You never get your own writes back.
- `sync.status`: `current` = nothing new. `behind` = `sync.unseen` holds conversation others added since your head (another agent's questions and replies, edits of the pinned document as `old`/`new`); continue from it. Pin, Add reply, settings, broadcast and outline changes are not events: their current values are in `state` and `turn`. `none` (you sent no head, e.g. you just joined) or `unknown` (the server does not know your head) = `sync.unseen` holds the conversation since the last reset, so read it before answering.
- Every write response carries a one-line `next` hint; follow it.
- Replies in `unseen` arrive as 200-char previews; fetch the full text with `GET /api/entries/<id>` only when you need it.

## Outline

Items are JSON: `{"no": "2-1", "title": "Add noise", "type": "report"}`. A `no` with a `-` is a sub-item of the number before it, so `2-1` belongs to `2`. Each item is `pending`, `active` or `done`, and **only an item without sub-items has a status of its own**: a parent's follows the items under it.

- Start a batch by sending the whole outline once, with no statuses. Every item starts `pending`.

~~~json
PATCH /api/outline
{"items": [{"no": "1", "title": "Basics", "type": "report"},
           {"no": "2", "title": "Training", "type": "report"},
           {"no": "2-1", "title": "Add noise", "type": "report"}]}
~~~

- Move statuses with `PATCH /api/outline/status`. Each move is one step along `pending` - `active` - `done`, so closing one item and opening the next goes in one request. Send only items that have no sub-items.

~~~json
{"items": [{"no": "1", "status": "done"}, {"no": "2-1", "status": "active"}]}
~~~

- To rename an item, add one, or renumber, send the whole list again to `PATCH /api/outline` with the `version` you last saw. Statuses are kept for the numbers already there. You cannot make the list shorter, and you cannot change the `no` of an item that has started.
- Every write response carries `outlineVersion` while there is an outline (none means there is none). When it differs from the one you remember, someone changed the outline: read `GET /api/outline`.
- Finish `report` items and move on; for `decision` items give the options, their impact and your recommendation, then wait for the user.
- **You cannot clear the outline.** When everything is finished, move the last items to `done` and leave it standing; only the user removes it, from the page.

## Pinned document

A pinned reply is a document the user works on with you. When the user turns on Add reply, this turn's reply edits that document instead of adding an ordinary reply.

- `turn.replyTo` names the pinned entry. Read its text with `GET /api/entries/<id>`.
- Send the change to `POST /api/pin/edit` as `old` (copied exactly from the document, occurring once in it) and `new` (what replaces it; include the surrounding text to insert, leave it empty to delete). This edit is the turn's reply, so it closes the turn.
- The server records the whole new document as a new reply, moves the pin to it and turns Add reply off. The conversation shows only your change.
- If `old` is missing or occurs more than once, the edit is refused: add surrounding text so it occurs once and send it again. A normal reply while Add reply is on is refused and points you here.
- If the user asks you to change the pinned document but `turn.replyTo` is absent (Add reply is off), do not edit it: reply asking the user to pin the reply and turn on Add reply, and make the edit in the next turn.
- You may pin a reply with `POST /api/pin` (`{"target":null}` unpins) when the user asks.

You cannot reset the conversation: only the user can, with the Reset button in the page's settings. If the user asks you to reset, tell them where it is.

The server enforces the remaining rules and its error messages say what to fix. Full CLI, data model, API and UI details: [references/reference.md](references/reference.md).
