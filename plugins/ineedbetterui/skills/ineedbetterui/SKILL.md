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

- It prints `listening on http://127.0.0.1:PORT/`, or `already running on ...` if this project's server is up. Tell the user the address.
- If the skill was called alone, do not ask what to do: start the server, give the address, and do not record that message. If it came with a request, start the server first, then record from that request on.
- Never turn broadcast on yourself, and do not install Node without the user's approval. The user stops the server with `ineedbetterui stop`.
- Records live in `<project>/node_modules/.ineedbetterui/`. Before running anything that deletes `node_modules` (`npm ci`, etc.), warn the user that the transcript goes with it. If the server cannot create that folder, do not record elsewhere: show the error.

## Recording

Register once, before anything else. Keep the token for the whole session; every write needs it.

~~~bash
ineedbetterui register --model <the model you run as>   # prints agent and token
ineedbetterui record question --turn 3 --rawFile q.txt --cleanedFile clean.txt
ineedbetterui progress --turn 3 "reading the outline code"
ineedbetterui record report --turn 3 --file reply.md
~~~

Pass `--token`, or set `INEEDBETTERUI_TOKEN` once. Every command prints the server's JSON answer: read it, and follow its `next` line. A refused command exits non-zero and saved nothing.

- Put text in a file (`--file`, `--rawFile`, `--cleanedFile`; `-` reads standard input). A shell mangles quotes and backslashes.
- If `ineedbetterui` is not installed, the same writes go to the HTTP API by hand: `POST /api/entries`, `POST /api/progress`, with `X-Ineedbetterui-Agent: <token>` and your last `sync.head` as `knownHead`. The command does the header and the head for you.

**Record every user message (kind `question`) and every reply you give the user.** Never record internal reasoning or raw tool calls.

- Kinds: `question`, `report` (progress or explanation), `decision` (awaiting the user's choice), `error`, `done`, `other`. Bodies are Markdown.
- Write what you record — bodies, headings, cleaned questions, outline titles — in the language of the conversation, not the language of these instructions. The page UI stays English.
- A question needs the user's words **and** your cleaned version. A cleaned question keeps the intent, conditions and strength of the request, adds nothing, drops greetings and repetition, and has no meta phrases such as "the user asks".
- If a reply is rejected for length, write it shorter; never split it in two and never cut it off.
- Recorded replies never change. To correct something, say so in a new reply.

## Turns

A turn is one user message and the one reply you give it.

- **`--turn` is the position of the user's message in the conversation in front of you.** Count their messages; the first one you record is turn 1. Send the same number with the progress lines and the reply of that turn.
- If a write is refused for a missing turn, you skipped recording one. Those messages are still in front of you: record the missing turn and its reply, then carry on. `next` names the number to send.
- Recording the user's message opens the turn; recording your reply closes it. **One question takes one reply**: a second reply in the same turn is refused.
- Within your own turn you are never blocked. If the user says something more before you answer — including after stopping you mid-answer — record it as a question like any other and answer once when you are done.
- The turn is yours alone. If a write is refused with `409` naming another agent, record nothing, tell the user in their language that the other agent is still answering, and do not retry on your own. When the user asks you to try again, record the original message again with its own turn number; do not record the retry request itself.
- While you work, say what you are doing with `progress`, in the language of the conversation. The user sees it under the conversation; it is never recorded, and the reply clears it. Say it again whenever what you are doing changes.

## Sync

Several agents can share one thread. The transcript is a hash chain, and the head you hold tells the server what you have already seen. The command keeps it for you; on the HTTP API, send your last `sync.head` as `knownHead`.

- The write that records the user's message is also your sync: read its response before you answer. `turn` tells you what shapes this reply — `replyLimit`, `replyTo` (Add reply is on, see below), `outline` (the step to continue), `unseen` (a count; the events are in `sync.unseen`).
- `sync.status`: `current` = nothing new. `behind` = `sync.unseen` holds what others added since your head; continue from it. `none` or `unknown` = `sync.unseen` holds the conversation since the last reset, so read it before answering.
- Pin, Add reply, settings, broadcast and outline changes are not events; their current values are in `state` and `turn`.
- Replies in `unseen` arrive as 200-character previews; fetch the full text with `GET /api/entries/<id>` when you need it.

## Outline

Items are JSON: `{"no": "2-1", "title": "Add noise", "type": "report"}`. A `no` with a `-` is a sub-item of the number before it. Each item is `pending`, `active` or `done`, and **only an item without sub-items has a status of its own**: a parent's follows the items under it.

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

- To rename, add or renumber, send the whole list again to `PATCH /api/outline` with the `version` you last saw. Statuses are kept for the numbers already there.
- Every write response carries `outlineVersion` while there is an outline. When it differs from the one you remember, read `GET /api/outline`.
- Finish `report` items and move on; for `decision` items give the options, their impact and your recommendation, then wait for the user.
- **You cannot clear the outline.** When everything is finished, move the last items to `done` and leave it standing; only the user removes it, from the page.

## Pinned document

A pinned reply is a document the user works on with you. When the user turns on Add reply, `turn.replyTo` names it, and this turn's reply edits that document instead of adding an ordinary reply.

- Read it with `GET /api/entries/<id>` and send the change to `POST /api/pin/edit` as `old` (copied exactly, occurring once) and `new`, with this turn's number. That edit is the turn's reply. The conversation shows only your change; the pinned area shows the whole document.
- If the user asks for a change while `turn.replyTo` is absent, do not edit: reply asking them to pin the reply and turn on Add reply, and make the edit next turn.
- You may pin a reply with `POST /api/pin` (`{"target":null}` unpins) when the user asks.

You cannot reset the conversation: only the user can, with the Reset button in the page's settings. If the user asks you to reset, tell them where it is.

The server enforces the remaining rules and its error messages say what to fix. Full CLI, data model, API and UI details: [references/reference.md](references/reference.md).
