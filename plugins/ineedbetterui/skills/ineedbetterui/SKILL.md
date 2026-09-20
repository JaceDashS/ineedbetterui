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
{"kind":"question","rawBody":"<user's words>","cleanedBody":"<cleaned question>","clientRef":"turn-14-q","knownHead":"<last sync.head>"}
~~~

- Questions need both `rawBody` and `cleanedBody` (the server refuses otherwise and picks one to show from the user's setting). A cleaned question keeps the intent, conditions and strength of the request, adds nothing, drops greetings and repetition, and has no meta phrases such as "the user asks".
- On retry, reuse the same `clientRef` so the entry is not duplicated.
- If a reply is rejected for length, split or rewrite it; never cut it off. Check `written` in the response: a failed write saved nothing.
- Recorded replies never change. To correct something, say so in a new reply.

## Turns

A turn is one user message and your replies to it. Only one turn is open at a time.

- Recording the user's message opens the turn. You may record several replies (steps); mark the last one `"final": true`, which closes the turn. Until then the page shows the agent as still working, and no other message can be recorded.
- If recording the user's message is refused with 409 (another turn is in progress), tell the user, in the conversation's language, that it could not be recorded because another turn is in progress and that they can ask you to try again. Record nothing and do not retry on your own. When the user asks you to try again, record the original message again (same `clientRef`); do not record the retry request itself.

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
- Send the change to `POST /api/pin/edit` as `old` (copied exactly from the document, occurring once in it) and `new` (what replaces it; include the surrounding text to insert, leave it empty to delete). Add `"final": true` if this ends the turn.
- The server records the whole new document as a new reply, moves the pin to it and turns Add reply off. The conversation shows only your change.
- If `old` is missing or occurs more than once, the edit is refused: add surrounding text so it occurs once and send it again. A normal reply while Add reply is on is refused and points you here.
- If the user asks you to change the pinned document but `turn.replyTo` is absent (Add reply is off), do not edit it: reply asking the user to pin the reply and turn on Add reply, and make the edit in the next turn.
- You may pin a reply with `POST /api/pin` (`{"target":null}` unpins) when the user asks.

You cannot reset the conversation: only the user can, with the Reset button in the page's settings. If the user asks you to reset, tell them where it is.

The server enforces the remaining rules and its error messages say what to fix. Full CLI, data model, API and UI details: [references/reference.md](references/reference.md).
