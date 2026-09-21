---
name: ineedbetterui
description: Records the conversation between the user and the agent to a local file and shows it in a browser UI with an outline, pins, notes and code highlighting. Use when the user calls ineedbetterui, or asks to record this conversation or view it in a browser.
---

# I Need Better UI

Calling this skill is the request to start recording. Apply it only in the session where the user called it.

## Start

From the **project folder** being recorded, run the server in the background. Point to this skill's script; never `cd` into the skill folder.

~~~bash
node <skill folder>/ineedbetterui.mjs              # this computer only
node <skill folder>/ineedbetterui.mjs --broadcast  # also reachable on the LAN
~~~

- Tell the user the printed address. If called alone, start it, give the address, and do not record that message. If called with a request, start first and record from that request on.
- Never enable broadcast or install Node without the user's approval. The user stops the server with `ineedbetterui stop`.
- Records are in `<project>/node_modules/.ineedbetterui/`. Warn before any command, such as `npm ci`, that deletes `node_modules`. If that folder cannot be created, show the error; never record elsewhere.

## Record

Register once before the first write and keep the token for this session:

~~~bash
ineedbetterui register --model <your model>
ineedbetterui record question --turn 3 --rawFile q.txt --cleanedFile clean.txt
ineedbetterui progress --turn 3 "reading the outline code"
ineedbetterui record report --turn 3 --file reply.md
~~~

Pass `--token` or set `INEEDBETTERUI_TOKEN`; with neither, the command works out who you are from the turn you hold rather than making a second agent. If an answer carries `identity`, that is your name and token: use them, and read this file again. Put recorded text in files; shell arguments can damage quotes, backslashes and encoding. Read every JSON result and follow `next`; a refused command exits non-zero and saves nothing. For HTTP fallback or command details, read [references/reference.md](references/reference.md).

**Record every user message as `question`, before answering, and every reply you give. Never record internal reasoning or raw tool calls.**

**If you have lost the thread of this recording** — a compacted context, a resumed session — run `ineedbetterui status` before writing anything. It gives back your token, your name, the open turn and the turn number to send next. Never register twice in one session, and never guess a turn number.

- Kinds are `question`, `report`, `decision`, `error`, `done` and `other`; bodies are Markdown.
- Write progress, bodies, headings, cleaned questions and outline titles in the conversation's language. The UI and instructions remain English.
- A question needs the user's exact words and a cleaned version that preserves intent, conditions and force, adds nothing, and removes only greetings, repetition and meta phrasing.
- If a reply exceeds the active limit, shorten it; never split or truncate it. Recorded replies are immutable, so correct one with a new reply.
- Use `progress` while working and whenever the activity changes. It is visible but not recorded, and the reply clears it.

## Turns and sync

A turn is one user message and your one reply. **One question gets one reply; never write a second reply for a turn.** `--turn` is that user message's 1-based position in the conversation; use the same number for its question, progress and reply.

- Record the question first; that response is also your sync. Before answering, account for `sync.unseen` and the returned `turn` fields (`replyLimit`, `replyTo`, `outline`); fetch a full entry when its preview is insufficient. The CLI carries the sync head; always follow `next`.
- If the user sends more before your reply, including after interrupting you, record each message as its own question and give one reply when finished.
- On a `409` naming another agent, record and reply nothing. Tell the user in the conversation's language that agent is still answering. Retry the original message only if the user asks; do not record the retry request.
- If a turn number or other write is refused, follow the error exactly; do not invent, skip or reuse turns.
- If turns are missing and you no longer have those messages, record the next question with `--recovered`: the gap is marked as a gap. Never write the user's words from memory.

## Outline

For outline payloads and version rules, read the Outline section of [references/reference.md](references/reference.md) only when creating or changing one.

- Start a batch with the complete ordered outline. Keep titles in the conversation's language.
- Finish `report` items and continue. For a `decision` item, give the choices, impact and recommendation, then wait for the user.
- Never clear the outline. Mark its final leaf items `done`; only the user clears it from the page.

## Pinned document

When `turn.replyTo` is present, Add reply is on: this turn edits that pinned reply instead of adding an ordinary reply. Read the entry named by `replyTo`, then send `old` copied exactly from its single occurrence and the replacement as `new` to `POST /api/pin/edit`; this edit is the turn's one reply.

- If the user asks to edit while `replyTo` is absent, do not edit. Ask them to pin the reply and enable Add reply, then edit on their next turn.
- Pin or unpin with `POST /api/pin` only when the user asks.
- Never reset the conversation. If asked, direct the user to the Reset button in page settings.

The server enforces formats, limits and state transitions. Obey its errors rather than working around them. Full CLI, data, API, UI and recovery details are in [references/reference.md](references/reference.md).
