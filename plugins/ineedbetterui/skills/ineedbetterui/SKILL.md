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
- Write everything you record (bodies, headings, cleaned questions, outline titles, notes) in the language of the conversation, not the language of these instructions. The page UI itself stays English.
- Kinds: `question`, `report` (progress or explanation), `decision` (awaiting the user's choice), `error`, `done`, `other`. Bodies are Markdown.

~~~json
POST /api/entries
{"kind":"question","rawBody":"<user's words>","cleanedBody":"<cleaned question>","clientRef":"turn-14-q","knownHead":"<last sync.head>"}
~~~

- Questions need both `rawBody` and `cleanedBody` (the server refuses otherwise and picks one to show from the user's setting). A cleaned question keeps the intent, conditions and strength of the request, adds nothing, drops greetings and repetition, and has no meta phrases such as "the user asks".
- On retry, reuse the same `clientRef` so the entry is not duplicated.
- If a reply is rejected for length, split or rewrite it; never cut it off. Check `written` in the response: a failed write saved nothing.

## Sync

Several agents can share one thread. The transcript is a hash chain (each head = hash of the previous head + the new line), and the head you hold tells the server what you have already seen.

- Start every turn by recording the user's message with your `knownHead`, and read the response before you answer: that write is your sync. Its `turn` object tells you what shapes this reply: `replyLimit` (keep the reply within it), `replyTo` (the user turned on Add reply, so your reply is linked to that pinned entry; write it as a reply to it), `outline` (the current item to continue), `unseen` (only a count of missed events by type; the events themselves are in `sync.unseen` of the same response, so read them there).
- Put the last `sync.head` you received into every write as `knownHead`, and keep the new one from the response. You never get your own writes back.
- `sync.status`: `current` = nothing new. `behind` = `sync.unseen` holds what others added since your head (another agent's replies, the user's pins or settings); continue from it. `none` (you sent no head, e.g. you just joined) or `unknown` (the server does not know your head) = `sync.unseen` holds the conversation since the last reset, so read it before answering.
- Every write response carries a one-line `next` hint; follow it.
- Replies in `unseen` arrive as 200-char previews; fetch the full text with `GET /api/entries/<id>` only when you need it.

## Outline

When an explanation or a batch of changes starts, send every item in order to `PATCH /api/outline` (`no`, `title`, `type`, `status`: `pending|active|done`, `current:true` on the current item, sub-items numbered `2-1`, `2-2`). Finish `report` items and move on; for `decision` items give the options, their impact and your recommendation, then wait for the user. Send `{"done":true}` when everything is finished.

## Pins, notes, revisions

- Pin a reply with `POST /api/pin` (`{"target":null}` unpins). Notes go to the pinned reply via `POST /api/entries/:id/notes`; if the response says `anchorFound:false`, tell the user.
- A revision (`POST /api/entries/:id/revisions`) sends either the full new body as `body`, or, for a small change, `old` (text copied exactly from the current body, unique in it) and `new`. Prefer `old`/`new` for small edits; if `old` is missing or not unique the server refuses, so add surrounding text and retry.
- `POST /api/reset` with `{"confirm":true}` only when the user explicitly asks to reset.

The server enforces the remaining rules and its error messages say what to fix. Full CLI, data model, API and UI details: [references/reference.md](references/reference.md).
