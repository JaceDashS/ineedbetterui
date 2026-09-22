# I Need Better UI Reference

The contract of a small tool that records agent conversations to a JSONL file and shows them in a browser: how to run it, the data format, the HTTP API and the rules behind them.

- **Source of truth**: the code (`ineedbetterui.mjs`, `lib/`, `ui/` in this skill folder, and `bin/ineedbetterui.mjs` in the repository). Where this document and the code disagree, the code is the real behaviour and this document gets fixed.
- **Scope**: what agents and users rely on. Details that the code states plainly (colours, pixel sizes, highlighting keywords, storage keys) are left to the code.
- **Checked on**: Windows 11, Node.js v24.14.0, npm 11.9

## Contents

1. [Overview](#1-overview)
2. [Files](#2-files)
3. [Running](#3-running)
4. [Data model](#4-data-model)
5. [HTTP API](#5-http-api)
6. [Rules](#6-rules)
7. [Page](#7-page)
8. [Broadcast](#8-broadcast)
9. [Agent integration](#9-agent-integration)
10. [Tests](#10-tests)
11. [Known limitations](#11-known-limitations)

---

## 1. Overview

The project is **I Need Better UI**; the skill, npm package and command are `ineedbetterui`.

| Part | Role |
|---|---|
| Local HTTP server | Serves the API and appends events to a JSONL file. |
| Transcript page | A fixed HTML page with no transcript data. Its script loads entries from the API and redraws only what changed when the server pushes a change. |
| JSONL transcript | One event per line, append-only. Replaying it gives the current state and the hash chain. |

**Principles**

- Only Node built-in modules; no npm dependencies, CDNs or web fonts.
- Records live in the project's `node_modules/.ineedbetterui/` with a `.gitignore` of `*`; nothing committable is created.
- Append-only: even a reset adds a `reset` event.
- Agents get only the events they have not seen, found through a hash chain.
- The server calls no AI model and intercepts no chat input; nothing is recorded unless an agent calls the API.
- Everything the agent reads (SKILL.md, this document, API messages and hints) and the page UI are English. Content the agent writes (bodies, headings, cleaned questions, outline titles, notes) is in the language of the conversation.

## 2. Files

| Path | Role |
|---|---|
| `package.json` | npm package `ineedbetterui` (command, install script, `files`) |
| `bin/ineedbetterui.mjs` | Command: start the server, `stop`, `status`, `register`, `record`, `progress`, `install`, `uninstall` ([3.3](#33-npm-commands)) |
| `plugins/ineedbetterui/skills/ineedbetterui/` | The skill folder, shared by the npm package and the (phase 2) marketplace |
| `…/ineedbetterui.mjs` | Server: record storage, API, server lifecycle |
| `…/lib/paths.mjs` | Session ID and records folder rules, shared by the server and `bin` |
| `…/lib/names.mjs` | The animal list and the naming rule for agents |
| `…/lib/qr.mjs` | QR encoder for the broadcast address |
| `.../lib/transcript.mjs` | Transcript replay, current state and hash-chain reconstruction |
| `.../lib/sync.mjs` | Agent synchronization results, next hints and public entry views |
| `.../lib/outline.mjs` | Outline validation, editing and derived status calculation |
| `.../lib/turns.mjs` | Turn numbering, reply limits and exact text-patch validation |
| `.../lib/project-info.mjs` | Atomic project.json updates, open.html and legacy server files |
| `.../lib/server-runtime.mjs` | Port selection, start locking, server reuse and broadcast rebinding |
| `.../lib/agents.mjs` | Persistent agent registration, identity and expiry |
| `.../lib/api/read.mjs` | Read-only API routes for health, state, sync, registered agents and entry lists |
| `.../lib/api/settings.mjs` | Settings and broadcast-switch API routes |
| `.../lib/api/outline.mjs` | Outline API routes |
| `.../lib/api/mutations.mjs` | Entry, progress, pin and reset API routes |
| `…/ui/page.html`, `page.css`, `markdown.js`, `entries.js`, `settings.js`, `layout.js`, `transcript.js`, `page.js` | Page shell, styles, Markdown and entry renderers, settings, layout and transcript-data controllers, and client script, joined into one HTML at server start |
| `…/SKILL.md` | Instructions the agent follows |
| `…/references/reference.md` | This document |
| `README.md` | npm page |
| `tests/` | Automated tests ([10](#10-tests)) |
| `tester/restart-ineedbetterui.ps1`, `tester/start-codex-test.ps1` | Manual test helpers ([10](#10-tests)) |

The npm package holds only `package.json`, `README.md`, `bin/` and `plugins/ineedbetterui/skills/`. Files with `.private.` in the name (notes, Korean translations `*.ko.private.md`) are ignored by git, excluded by `files`, and skipped when the skill is installed.

**At runtime**, in `<project>/node_modules/.ineedbetterui/`:

| File | Role |
|---|---|
| `.gitignore` | `*`; keeps the folder out of git. Left alone if it exists |
| `transcript.jsonl` | The transcript |
| `cli-heads.json` | Each agent token's last head, so `record` can send `knownHead` by itself ([3.4](#34-recording-from-the-command-line)). Once it holds more than 100, the heads of tokens no longer in `project.json` are dropped on the next write: those agents were forgotten after 7 days and their tokens are refused from then on |
| `project.json` | `app`, `sessionId`, `projectPath`, `createdAt`, `lastStartedAt`, while a server runs `server: {port, pid, startedAt}` (the one place that says where it runs), and `agents`, the registered agents keyed by their token ([6.5](#65-who-wrote-it)) |
| `open.html` | While a server runs: open it in a browser to go to the page |
| `start.lock` | Exists only for the moment a start is checking, binding and recording (see [3.2](#32-resuming-a-session)) |

Older versions wrote `server-<port>.html` instead; a start still checks those ports once and then removes the files.

Deleting or recreating `node_modules` (`npm ci` etc.) deletes the records. No option changes these paths.

## 3. Running

Run from the project folder (the working directory is the project that gets recorded):

~~~bash
node <skill folder>/ineedbetterui.mjs               # this computer only (default)
node <skill folder>/ineedbetterui.mjs --broadcast   # also reachable on the LAN
ineedbetterui [--broadcast]                         # the same, when installed with npm
~~~

### 3.1 Options and output

- `--broadcast` starts bound to `0.0.0.0`; otherwise the server binds to `127.0.0.1` and broadcast can be switched on in the page ([8](#8-broadcast)). `--no-broadcast` and unknown arguments are ignored. The port is automatic.

| Case | Output |
|---|---|
| New server | `ineedbetterui listening on http://127.0.0.1:PORT/`, then `records <transcript path>` |
| Started with `--broadcast` | Also `broadcast access on http://LAN-IP:PORT/` |
| Already running | `ineedbetterui already running on http://127.0.0.1:PORT/` (exit code 0) |
| Error | One line with the message (exit code 1) |

### 3.2 Resuming a session

Running again in the same folder reuses that project's server.

- **Session ID**: the first 12 hex digits of the SHA-256 of the project folder's real path (lower-cased on Windows).
- **Startup**: a start takes `start.lock` (created only if absent, which is exclusive on every platform), so starts of one project go one at a time and each sees what the one before recorded. Holding it, the start asks `GET /api/health` (600 ms timeout) on the port in `project.json`'s `server` entry (and on the ports of older `server-<port>.html` files); if this project's server answers, it prints `already running` with that port. Otherwise it binds, in order, that recorded port, the project port (`40000 + session ID % 20000`) and any free port; a taken port is asked once whether it is this project's server. The winner writes `project.json`'s `server` entry and `open.html`, removes older info files, and lets go of the lock. A lock older than 10 seconds, left by a start that died, is ignored.
- **One server per project**: because the whole check, bind and record happen under the lock, starts made at the same moment end with one server even when the recorded or project port is held by another program. A start that cannot get the lock within 15 seconds stops with an error.
- **Stopping**: on a normal exit the server removes its `server` entry and `open.html`, unless a newer server of the project has replaced them. A killed process cannot, so `ineedbetterui stop` clears them, and a later start ignores an entry whose port does not answer as this project.
- A server stopped and then moved with its folder continues the same transcript; the session ID follows the new path.
- On Windows the folder cannot be moved while the server runs (`EBUSY`). Elsewhere, stop the server before moving it.

### 3.3 npm commands

| Command | Action |
|---|---|
| `ineedbetterui` | Start or reuse the server for the current folder |
| `ineedbetterui register --model M` | Register an agent and print its name and token ([3.4](#34-recording-from-the-command-line)) |
| `ineedbetterui status` | Where the recording stands: server, registered agents and their tokens, open turn, outline, pin and the last entries ([3.5](#35-finding-your-place-again)) |
| `ineedbetterui record <kind> --turn N …` | Record a question or a reply |
| `ineedbetterui progress --turn N "…"` | Say what you are doing; not recorded |
| `ineedbetterui stop` | Stop this folder's server (found through `project.json` and checked through the health session ID), then clear its `server` entry and `open.html` |
| `ineedbetterui install` | Copy the skill folder (without `*.private.*`) to `~/.agents/skills/ineedbetterui/` (Codex) and `~/.claude/skills/ineedbetterui/` (Claude Code) with a `.ineedbetterui-install.json` marker. A folder without the marker is left alone. Ends with a banner that links the manual |
| `ineedbetterui uninstall` | Delete marked skill folders only. Records stay in each project. Run it before `npm uninstall -g`, since npm runs no uninstall scripts |
| `ineedbetterui --version`, `--help` | Version, help |

`postinstall` runs `install` for global installs only (`npm_config_global=true`) and never fails the npm install. It ends with the banner, which links the manual. npm captures the output of install scripts, so from `postinstall` the banner is written to the terminal device (`\\.\CONOUT$` on Windows, `/dev/tty` elsewhere) and falls back to standard output where there is no terminal.

The banner's lettering is drawn with block characters where the console reads UTF-8 (on Windows that is what `chcp` reports, otherwise the terminal environment variables and the locale). Anywhere else the lettering is plain ASCII in a frame, since a block character is drawn full-width on a legacy code page and would break the lines.

### 3.4 Recording from the command line

`record` and `progress` are the API in one line. They find this folder's server through `project.json`, check it answers for this session, send the write, print the whole JSON response and exit non-zero when it was refused. An agent needs no URL, no header and no hand-written JSON.

```bash
ineedbetterui register --model claude-opus-5          # once: prints agent and token
export INEEDBETTERUI_TOKEN=<token>                    # or pass --token on each call
ineedbetterui record question --turn 3 --rawFile q.txt --cleaned "What the user asked"
ineedbetterui progress --turn 3 "reading the outline code"
ineedbetterui record report --turn 3 --file reply.md  # - reads standard input
```

- Text comes from `--file`/`--rawFile`/`--cleanedFile` (a path, or `-` for standard input) or from `--text`/`--raw`/`--cleaned`. **A file is the safe one**: a shell mangles quotes and backslashes, and Windows adds an encoding trap.
- `register` takes `--model`, the model the agent runs as; it is what the agent's name is made from ([6.5](#65-who-wrote-it)).
- `--turn` is required ([6.6](#66-turn-numbers)). `--heading` and `--clientRef` are optional. `--recovered`, on a question, records the turns before it as a gap ([6.6](#66-turn-numbers)).
- The token comes from `--token` or `INEEDBETTERUI_TOKEN`. With neither, it is worked out from what is on this computer, in order: the agent `--agent <name>` names; the agent holding the open turn, when `--turn` is that turn's number; the only agent of this project when there is just one. Anything else is refused rather than guessed. The command then sends that agent's real token, so the server still sees an identified write ([6.5](#65-who-wrote-it)).
- A write recognised that way comes back with `identity` (`{agent, token, why}`) and a `next` that names the agent and says to read the instructions again: an agent that no longer knows its own token has usually lost the rules with it. Turn numbers are per agent, so being recognised as the wrong one would misnumber the conversation — hence the open turn, which is held by one agent at a time, rather than a guess at who wrote last.
- `knownHead` is kept for the agent in `cli-heads.json` next to the transcript and sent automatically, so syncing costs nothing to carry.
- Everything else (outline, pin, settings) stays on the HTTP API ([5](#5-http-api)).

### 3.5 Finding your place again

An agent that loses its context — compaction, a new session, a crash — keeps none of what recording needs: not the token, not the sync head, not the turn it was on. All of it is on this computer already, so `status` gives it back instead of the agent guessing or registering a second time.

```bash
ineedbetterui status
```

It prints one JSON object: `server` (running, address, PID, broadcast), `agents` (each registered agent with its **token**, model, `lastTurn` and whether it holds the open turn), `turn`, `outline`, `pin`, `entryCount`, the last five entries, and `next`, which says what to do from here.

- It needs no token and never writes. With no server running it says so and tells the agent to start one.
- The tokens are printed because the point is to hand one back; they are already in `project.json` next to the transcript, and reach no further than this computer ([6.5](#65-who-wrote-it)).
- `GET /api/agents` is the same registry without the tokens, for a caller that has the HTTP API but not the command.

## 4. Data model

### 4.1 File format

UTF-8, one JSON object per line, `\n` line ends. The event type is `t`; keys and enum values are English. `time` is ISO 8601 with the local offset and milliseconds. Lines that are not JSON are skipped when replaying but still count in the hash chain.

~~~json
{"t":"entry","id":"a-12","kind":"question","time":"...","turn":14,"heading":"","body":"cleaned","rawBody":"original","cleanedBody":"cleaned","questionMode":"cleaned","clientRef":"claude-otter-turn-14-q"}
{"t":"entry","id":"a-13","kind":"report","time":"...","heading":"Reply","body":"text","outlineNo":"2-1","agent":"claude-otter"}
{"t":"entry","id":"a-15","kind":"report","time":"...","heading":"Reply","body":"whole new document","revises":"a-13","patch":{"old":"...","new":"..."}}
{"t":"turn","time":"...","open":false,"target":"a-12","no":14,"agent":"claude-otter","source":"user"}
{"t":"pin","time":"...","target":"a-13","source":"user"}
{"t":"pin-reply","time":"...","active":true,"target":"a-13","source":"user"}
{"t":"outline","time":"...","items":[{"no":"1","title":"Item","type":"report","status":"active"}]}
{"t":"settings","time":"...","questionMode":"raw","maxResponseChars":2000,"maxUnseenEvents":20}
{"t":"broadcast","time":"...","enabled":true,"url":"http://192.168.0.77:47823/","port":47823,"source":"user"}
{"t":"reset","time":"..."}
~~~

Records from earlier versions may also hold `note` and `revision` lines and entries with `replyTo`; they are replayed and shown, but no longer created.

### 4.2 Events

| `t` | Effect |
|---|---|
| `entry` | Appends an entry. A question opens the turn and the reply to it closes it. A reply carries `outlineNo` when an outline step was active as it was recorded, and every entry carries `agent`, the name of whoever wrote it. An entry with `revises` is a new version of the pinned document, with the change in `patch` |
| `note`, `revision` | Older records only: a note on an entry, or a replaced body |
| `pin` | Sets or clears the single pin (`target` ID or `null`); a new pin turns Add reply off |
| `pin-reply` | Add reply on (`active:true`, with the pinned `target`) or off: this turn's reply edits the pinned document; valid only while that entry stays pinned. Older records use `reply-target` (`target` or `null`), still read |
| `outline` | Replaces the outline (an empty `items` means there is none) |
| `settings` | Applies the valid fields it carries |
| `broadcast` | Records a broadcast switch ([8](#8-broadcast)) |
| `reset` | Clears entries, outline, pin, Add reply and broadcast, and restores default settings |

`source` is `user` when the request had the `X-Ineedbetterui-UI: 1` header (the page), otherwise `agent`.

### 4.3 IDs, hashes and replay

- Entry IDs are `a-N`, one more than the highest N in the whole file; numbers are never reused, even after a reset. Notes are `n-<ms>-<5 chars>`, revisions `r-<ms>-<5 chars>`.
- **Hash chain**: only conversation lines are chained: `entry`, `note`, `revision`, `reset` and lines that are not JSON. Each one's hash is the first 16 hex digits of `sha256(previous hash + "\n" + line)`, starting from `0000000000000000`; the last hash is the **head**. Hashes are not stored; the server computes them once per line in memory. `eventCount` counts chained lines.
- **State switches** (`pin`, `pin-reply`, `settings`, `broadcast`, `outline`) are stored and applied but not chained: only their current value matters, so their history would be noise in `sync.unseen`. They do not move the head; agents read their current values in `state` and `turn`, and pages learn of them through `/api/events`.
- Replay: file order is canonical; the last `revision` is the body; the last `pin`, `pin-reply` and `outline` win; `settings` apply field by field; entry numbering includes lines before resets, while `clientRef` deduplication and turn numbers start over at each reset.
- Defaults: `questionMode` `cleaned`, `maxResponseChars` 3000, `maxUnseenEvents` 20 (`0` = unlimited for both), empty outline, no pin.
- A write parses and hashes only its own line. Before each write the server compares the file with the bytes it expects; an outside change makes it replay the whole file first.

### 4.4 Enums

| Field | Values |
|---|---|
| `kind` | `question`, `report`, `decision`, `error`, `done`, `other` |
| `questionMode` | `cleaned`, `raw` |
| outline `status` | `pending`, `active`, `done` |

## 5. HTTP API

### 5.1 Common rules

- Responses are `application/json; charset=utf-8` with `Cache-Control: no-store`. Request bodies are JSON, at most 2,000,000 bytes; an empty body is `{}`.
- Requests from this computer need nothing. With broadcast on, a request from any other device must carry the access token, as `?t=<token>` or the header `X-Ineedbetterui-Token`, or it is refused with `403`; the page itself (`GET /`) is served without it, since it holds no transcript data and asks for the data with the token it kept. Only this computer may change the `broadcast` setting.
- Every request is refused with `403` unless the Host is `127.0.0.1`, `localhost`, `[::1]` or the broadcast LAN address (against DNS rebinding). Writes (`POST`, `PATCH`) also need `Content-Type: application/json` and, if an `Origin` is sent, the same origin as the Host (against cross-site requests).
- Every write body accepts `knownHead` ([6.3](#63-sync)). Error messages are English and say what to fix.

**Errors**: `{"ok":false,"error":"...","written":false}` with `400` (validation, bad JSON, too large, unknown target, over the character limit, an edit that cannot apply), `403` (a Host, token or cross-origin refusal), `404` (unknown path) or `409` (a question while another turn is open, [6.4](#64-turns-and-the-pinned-document)).

**Successful writes** return `ok`, `written` (whether a line or switch was stored), `state`, `outlineVersion` (only while there is an outline), `sync` ([5.3](#53-the-sync-object)), `next` (a one-line hint for the agent) and, for entry APIs, `entry`. Recording a question also returns `turn` ([5.7](#57-post-apientries)). For agents `state` is `GET /api/state` without `outline` and the broadcast QR code, since it comes back with every write; requests from the page (`X-Ineedbetterui-UI: 1`) get the full state. Error responses carry the same `state` and `outlineVersion`.

`next` says, as needed: read `sync.unseen` (the conversation so far for a new agent, or events missed); send `sync.head` as `knownHead`; `unseen` was truncated; after a question, where to send the reply (`POST /api/pin/edit` when Add reply is on), the character limit, and that `POST /api/progress` is there for saying what it is doing meanwhile; while a turn is open, that the reply closes it; otherwise, to record the user's next message first.

### 5.2 Endpoints

| Method | Path | Purpose | Success |
|---|---|---|---|
| `GET` | `/` | The page (fixed file, no data) | `200` |
| `GET` | `/api/events` | Server-Sent Events: `data: {"head":"...","state":N}` on connect and after every write (`state` counts state switches, which do not move the head), a keep-alive comment every 25 s, `retry: 2000` | `200`, stays open |
| `GET` | `/api/health` | `{ok, app, sessionId, pid, port, broadcast}` | `200` |
| `GET` | `/api/state` | Current state summary | `200` |
| `GET` | `/api/sync` | Events after a head | `200` |
| `GET` | `/api/entries` | Entry list | `200` |
| `GET` | `/api/entries/:id` | One entry in full | `200` |
| `POST` | `/api/entries` | Add an entry | `201`; `200` for a duplicate `clientRef` |
| `POST` | `/api/pin/edit` | Edit the pinned document with `old`/`new`; recorded as a new reply | `201` |
| `POST` | `/api/entries/:id/notes`, `/api/entries/:id/revisions` | Always refused: recorded replies are not edited | `400` |
| `PATCH` | `/api/settings` | Question mode, character limit, sync cap, broadcast | `200` |
| `GET` | `/api/agents` | Who is registered, how far each one got, and the open turn | `200` |
| `POST` | `/api/agents` | Register and get a name and a token | `201` |
| `POST` | `/api/progress` | Say what you are doing in the open turn. Shown to the user, never recorded | `200`, `409` |
| `GET` | `/api/outline` | `{ok, version, items}`; `items` is empty when there is no outline | `200` |
| `PATCH` | `/api/outline` | Make the outline, or edit its titles, types and numbering | `200`, `409` |
| `PATCH` | `/api/outline/status` | Move item statuses, one step each | `200`, `409` |
| `DELETE` | `/api/outline` | Clear the outline. The page on this computer only | `200`, `403` |
| `POST` | `/api/pin` | Set or clear the pin | `200` |
| `POST` | `/api/pin/reply` | Turn Add reply on or off for the pinned entry (the page's switch) | `200` |
| `POST` | `/api/reply-target` | Renamed: refused with a pointer to `/api/pin/reply` | `400` |
| `POST` | `/api/broadcast` | Moved into settings: refused with a pointer to `PATCH /api/settings` | `400` |
| `POST` | `/api/turn/cancel` | End the open turn without a reply. The page on this computer only | `200`, `400`, `409` |
| `POST` | `/api/reset` | Reset, from the page's Reset button only (`{"confirm":true}`) | `200` |

### 5.3 The sync object

~~~json
{"head":"9c1f0b7a2e4d3c58","eventCount":42,"status":"behind","unseenCount":2,"truncated":false,
 "unseen":[{"hash":"5d2e...","t":"settings","time":"...","questionMode":"raw"},
           {"hash":"9c1f...","t":"entry","time":"...","id":"a-31","kind":"report","heading":"","preview":"first 200 chars","length":1280,"truncated":true}]}
~~~

- `next` tells the agent what to do from here: the turn number to send, the reply limit, unseen events, the pinned document. On an agent's first write, and on every tenth turn after it, it also repeats what recording is and how to find the place again; the server has no other way to reach an agent whose instructions have fallen out of its context.
- `status`: `current`, `behind`, `none` or `unknown` ([6.3](#63-sync)). `unseenCount` counts all unseen events; `truncated` says only the latest were sent.
- Every summary has `hash`, `t`, `time`. Entries add `id`, `kind`, `heading`, `replyTo`, `outlineNo`, `agent`, `missedTurns`; a `turn` event adds `target`, `no`, `agent` and `cancelledBy`; a new version of the pinned document carries `revises`, `old` and `new` instead of its body; questions carry the full `body` and `questionMode`; other bodies and non-question revisions are `{"body"}` up to 200 code points, else `{"preview","length","truncated":true}`. Notes carry their full text. A non-JSON line is `{"t":"invalid"}`. State switches never appear here.

### 5.4 GET /api/state

`mode`, `outline` (with derived parent statuses), `pin` (`{target, source, revisionCount, replyActive}` or `null`; `replyActive` is Add reply), `turn` (`{open, since, agent, no, progress, cancelled}`; `since` is the turn's last sign of life, which a progress line moves forward; `cancelled` is the number of the last turn the user cancelled, until the next entry; `open` turns false once the 10-minute limit passes, and the last three are `null` unless it is open), `questionMode`, `broadcast` (`{enabled, url, port, qr}` or `null`), `maxResponseChars`, `maxUnseenEvents`, `head`, `eventCount`, `lastEntry` (`{id, kind, time}`), `entryCount`.

### 5.5 GET /api/sync

| Query | Meaning |
|---|---|
| `knownHead` | The head the caller holds; missing or unknown means it knows nothing ([6.3](#63-sync)) |
| `limit` | Maximum events to return; defaults to `maxUnseenEvents`; `0` = unlimited |

Returns `{ok, ...sync}`.

### 5.6 GET /api/entries

| Query | Default | Meaning |
|---|---|---|
| `after` | none | Entries after this ID (from the start if not found) |
| `before` | none | The `limit` entries right before this ID; takes precedence over `after` and `last` |
| `last` | none | The last `last` entries (max 1000); takes precedence over `after` |
| `limit` | `50` | 1–1000 |
| `replyTo` | none | Only entries whose `replyTo` is this ID (a pinned reply's thread) |
| `full` | none | `1` adds `body`, `patch`, `notes[]`, `revisions[]`, `clientRef`, question and broadcast fields |

Returns `{ok, entries, nextAfter, hasMore, hasBefore}`: `hasMore` means entries exist after the returned ones, `hasBefore` before them. The basic form is `{id, kind, time, heading, replyTo?, revises?, outlineNo?, agent?, turn?, missedTurns?, cancelled?}`.

`GET /api/entries/:id` returns one current entry in the `full=1` form; an unknown ID is `400`.

### 5.7 POST /api/entries

~~~json
{"kind":"question","turn":14,"rawBody":"original","cleanedBody":"cleaned","knownHead":"..."}
{"kind":"report","turn":14,"body":"reply","heading":"Title","knownHead":"..."}
~~~

1. `kind` must be a valid kind. Questions need both `rawBody` and `cleanedBody` as strings; other kinds need `body`.
1. `recovered: true` on a question lets it skip the turns that were never recorded; they are written to the entry as `missedTurns` ([6.6](#66-turn-numbers)). It is refused on a reply, and when there is no gap to recover.
1. `turn` is required on every write: a whole number from 1, the position of the user's message in the conversation, counted by the agent itself ([6.6](#66-turn-numbers)).
2. A question's `body` is `rawBody` when `questionMode` is `raw`, else `cleanedBody`. An empty body is refused.
3. A known `clientRef` writes nothing and returns the existing entry with `deduplicated:true` (even while a turn is open). A question with no `clientRef` gets `<agent>-turn-<n>-q`, so recording the same turn twice is one entry; a reply gets none, so a rewritten reply is not mistaken for a retry.
4. A question while **another agent's** turn is open is refused with `409`; the agent holding the turn may record as many messages as the user sends before it answers. A reply with no open turn is refused with `409`: one question takes one reply. A `final` field is refused; recording the reply closes the turn by itself.
5. While Add reply is on, a non-question is refused and pointed to `POST /api/pin/edit`.
6. Non-questions are checked against the character limit, close the turn, and are stamped with the active outline step as `outlineNo`. A reply that does not fit the limit is written shorter, never split in two.

**Turn brief**: the response to a question (new or deduplicated) carries `turn`, what the agent needs before writing this turn's reply. Fields appear only when they apply:

| Field | Meaning |
|---|---|
| `replyLimit` | The character limit for the reply (absent when unlimited) |
| `replyTo` | Add reply is on: this turn's reply edits this pinned entry through `POST /api/pin/edit` |
| `outline` | `{no, title}` of the step being worked on: the `active` item with no sub-items |
| `unseen` | `{count, kinds, in}`: a summary only, how many events the agent missed counted by `t`; `in` is `"sync.unseen"`, where the events themselves are in the same response |

Everything else stays in `state`. `next` repeats the essentials in words (Add reply, the limit).

### 5.8 Other writes

| Endpoint | Body and rules |
|---|---|
| `POST /api/pin/edit` | `{old, new, heading?}` while Add reply is on, and with an open turn: this edit is the turn's reply, so it closes it. `old` (non-empty) must occur exactly once in the pinned document and is replaced by `new` (may be empty to delete). A `body` is refused: the only way is `old`/`new`. `new` is checked against the character limit. The whole resulting document is recorded as a new reply with `revises` and `patch`; the pin moves to it and Add reply turns off; the earlier version is unchanged |
| `POST /api/entries/:id/notes`, `POST /api/entries/:id/revisions` | Refused with a message: to correct a reply, say so in a new reply; to work on it as a document, pin it and use Add reply |
| `PATCH /api/settings` | Any of `questionMode` (`cleaned`/`raw`), `maxResponseChars`, `maxUnseenEvents` (integers ≥ 0) and `broadcast` (boolean, this computer only, [8](#8-broadcast)). Every field is checked first, so a request applies whole or not at all. The first three are kept across restarts; `broadcast` is not |
| `POST /api/agents` | `{model}`, the model the agent runs as, or nothing. Returns `{agent, token}`. Needs no identity of its own |
| `POST /api/turn/cancel` | Nothing. Refused unless the page on this computer sends it, and with `409` when no turn is open. It appends a `turn` event that closes the turn, marks the question `cancelled` and leaves the transcript otherwise untouched |
| `POST /api/progress` | `{text}`, 1 to 200 characters, in the language of the conversation. It starts the turn's ten minutes again ([6.4](#64-turns-and-the-pinned-document)). Refused with `409` when no turn is open. It writes nothing (`written` is `false`), replaces whatever was there, and is cleared by any entry, so a stopped answer leaves no stale line behind. It lives in memory only, so a restarted server has none |
| `PATCH /api/outline` | `{items}`, an array of `{no, title, type}` with a non-empty `no` and `title` and no repeated `no`. A `status` in an item is refused. With no outline this makes one, every item `pending`. With an outline this edits it and needs the current `version` (`409` otherwise): each `no` that was already there keeps its status, each new `no` starts `pending`, the list may not get shorter, and a `no` that is not `pending` may not disappear. The response carries the new `outlineVersion` |
| `PATCH /api/outline/status` | `{items}`, an array of `{no, status}`, and optionally `version`. Each `no` must be in the outline, appear once, and have no sub-items. Each move is one step along `pending` - `active` - `done`. The whole request applies or none of it does |
| `DELETE /api/outline` | No body. Refused with `403` unless it comes from the page (`X-Ineedbetterui-UI: 1`) on this computer |
| `POST /api/pin` | `{target}`: an entry ID (not a question) or `null` |
| `POST /api/pin/reply` | `{active: true \| false}`: Add reply for the pinned entry (a reply must be pinned to turn it on). The page calls this; agents send their edit to `POST /api/pin/edit`, and anything else sent here is refused with that pointer |
| `POST /api/reset` | `{confirm:true}`. Accepted only from the page (`X-Ineedbetterui-UI: 1`) on this computer, and not while a turn is open (`409`). Agents are refused and told to point the user to the button |

## 6. Rules

### 6.1 Question mode

The page checkbox sets `questionMode`: checked `cleaned` (default), unchecked `raw`. Each question stores both forms and the mode at the time.

Changing the mode rewrites nothing: the `body` recorded with an entry stays as it was, and that is what agents read. The page holds both forms, so as soon as the setting is applied it redraws every question in the wording the setting now asks for - including the ones already on screen. An entry recorded before both forms were stored falls back to its `body`.

A cleaned question keeps the intent, conditions and strength of the request, adds nothing, drops greetings, repetition and meta phrases, and is one sentence or a short paragraph in the conversation's language. Unclear parts are left as questions, not filled in.

### 6.2 Reply character limit

Applies to new non-question bodies and to the `new` text of a pin edit (not to questions, headings or the whole document), counted as Unicode code points. Default 3000, `0` = unlimited, set in the page or with `PATCH /api/settings`. Over the limit nothing is saved or cut; the error carries `maxResponseChars` and `length`, and the agent splits or rewrites the reply.

### 6.3 Sync

Several agents can share one thread. Each agent holds one hash, the last head it received, and the server returns only the events after it.

| Step | Request | `status` | `unseen` |
|---|---|---|---|
| A writes answer 1 | no `knownHead` (empty thread) | `none` | empty |
| A writes answer 2 | head after 1 | `current` | empty (own writes are never returned) |
| B joins, writes answer 3 | no `knownHead` | `none` | answers 1 and 2 |
| A writes answer 4 | head after 2 | `behind` | answer 3 |
| B writes answer 5 | head after 3 | `behind` | answer 4 |

| `status` | Condition | `unseen` |
|---|---|---|
| `current` | Nothing after `knownHead` except this request's own event | empty |
| `behind` | Other events after `knownHead` | those events |
| `none` | No `knownHead`: a new agent, or one that lost its head | events since the last reset (the reset line excluded) |
| `unknown` | `knownHead` not in the chain | events since the last reset |

At most `maxUnseenEvents` (or `limit`) of the latest are sent; `truncated` and `unseenCount` tell when there were more. Other agents' entries (including new versions of the pinned document) and resets are events; pin, Add reply, settings, broadcast and outline changes are not (see [4.3](#43-ids-hashes-and-replay)).

### 6.4 Turns and the pinned document

- **Turns**: recording a question opens a turn, which belongs to the agent that recorded it ([6.5](#65-who-wrote-it)) and carries its number ([6.6](#66-turn-numbers)), and the reply to it (an entry or a pin edit) closes it. One question takes one reply: a reply that does not fit `maxResponseChars` is written shorter, never split across entries, and a second reply in the same turn is refused with `409`.
- **Several messages, one answer**: the agent holding the turn may record message after message before it answers, each one restarting the turn's clock. A user who interrupts an answer, or simply says another thing first, is never locked out of their own transcript, and what they said is recorded either way. Only **another** agent is refused with `409`, since that is what the lock is for: it records nothing, tells its user which agent is mid-turn, and records the original message again (same `clientRef`) only when the user asks it to retry; the retry request itself is not recorded. A turn nobody closes unlocks 10 minutes after its last sign of life: the user's last message of the turn, or the agent's last progress line. The lock is there to free a turn nobody is working on, so an agent that says what it is doing keeps its turn however long the work takes, and the turn opens up only after ten minutes of silence.
- **A turn that gets no reply**: the user ends it with the Cancel turn button under the conversation (— `POST /api/turn/cancel`, the page on this computer only). It appends a `turn` event: the turn closes, the question is marked `cancelled` and keeps that mark for good, and a reply or progress line sent for it afterwards is refused with `409` saying the user cancelled it. The agent does not record that answer anywhere; it tells the user and waits for the next message. Nothing else is removed: the question, and everything recorded before it, stay.
- **A turn nobody ends**: once the last entry is a question and the lock has expired, the page replaces the spinner with a line saying the agent has been quiet for more than ten minutes. It does not say the turn went unanswered, because the agent that holds it may still reply; the user ends it with Cancel turn.
- While a turn is open the page shows a spinner, and the agent says what it is doing with `POST /api/progress`, which the page shows and the transcript never keeps. Each new message clears it: an agent still at work says so again.
- **Recorded replies never change.** Notes and revisions are refused; records made by earlier versions still show theirs.
- **Pinned document**: one pin at a time, on a non-question entry, shown in the fixed area at the top. With Add reply on, the turn's reply is an edit of that document through `POST /api/pin/edit` with `old`/`new`. The server applies it to the pinned text and records the whole result as a new reply (`revises` points to the previous version, `patch` holds the change), moves the pin to it and turns Add reply off. The conversation shows only the change; the pinned area shows the whole document. Other agents get `{revises, old, new}` in `sync.unseen`.
- While a turn is open the page disables its pin and Add reply buttons, so the pinned document cannot change under the agent. If the user asks for a change while Add reply is off, the agent does not edit: it replies asking the user to pin the reply and turn on Add reply.
- `old` is looked up in the current document; a missing or repeated `old` is refused, so an edit never lands in the wrong place, and one based on a stale copy fails instead of overwriting.

### 6.5 Who wrote it

- **Every write says who it is from**, in the `X-Ineedbetterui-Agent` header: the literal `user` from the page, or the token an agent was given. A write without it, or with a token the server does not know, is refused with `401`. Reads need nothing.
- An agent registers once, with `POST /api/agents` and the model it runs as, and is given a name and a token. The name is the model's family and an animal that nobody in this project holds: `claude-otter`, `codex-lynx`. Once the animals run out the same ones come back numbered (`claude-otter-2`).
- The token is what the agent sends; it never needs to remember the name, which comes back on every write in the entry it wrote. An agent that registers again is a new agent with a new name, including after a restart: names are never re-used while their agent is known.
- Registrations live in `project.json`, not the transcript: they say who is connected, not what was said, and keeping them there lets a name outlive a restart. Each write stamps `lastSeenAt`. Once a day (on the day's first request, so a server that was off at midnight still does it) agents unheard from for 7 days are forgotten and their animals freed.
- The names are not secrets and are not meant to be: everything happens over loopback, where the access token already stands between the transcript and anything outside ([8](#8-broadcast)).
- **A turn belongs to whoever opened it.** Only that agent may reply to it, edit the pinned document in it, or report progress on it; anyone else is refused with `409` and told who is answering. The page shows each writer's name on its entries, in a colour of its own, bold where that name first appears.

### 6.6 Turn numbers

The agent counts the user's messages in the conversation in front of it and sends that number as `turn` with every write of the turn: the question that opens it, the progress lines, and the reply that closes it.

The server does not hand the number out, and that is the point. A turn the agent forgot to record leaves no request behind, so silence and "nothing happened" look the same; a number the agent assigns itself turns that silence into a gap.

- The first write from an agent sets its baseline, whatever the number: an agent may join a conversation at any point, and the skill is often called partway through one.
- A question must be the next number. A gap is refused with `409` naming the missing turns, which are still in the agent's context, so it records them and works forward. A number already recorded is refused with `409` saying which one is next.
- A reply or a progress line must carry the open turn's number. A higher one is refused with `409`: the user's message for that turn was never recorded.
- Numbers are per agent ([6.5](#65-who-wrote-it)), so agents sharing a transcript count their own conversations, and a reset starts every count over.

- **A gap the agent cannot fill**: recording the missing turns needs the user's own words, and an agent whose context was compacted no longer has them. Writing them from memory would put words in the user's mouth, so it sends the next question with `recovered: true` (`--recovered`) instead: the question is recorded at its true number and carries `missedTurns`, the turns it jumped over. The page shows them as a gap above that question. It is refused when there is no gap, so it cannot become the ordinary way to number a turn.

This catches a turn recorded by halves, and a turn skipped entirely as soon as the agent records anything again. It does not catch a conversation where the agent stops recording and never starts again — but that leaves an empty page, which the user sees.

### 6.7 Outline

- An outline `no` containing `-` marks a sub-item of the `no` before the `-`: `2-1` belongs to `2`.
- **Only an item without sub-items carries a status of its own.** A parent's status is worked out from its sub-items and sent out with the outline: `active` while any of them is `active`, `done` once all are `done`, else `pending`. Sending a status for a parent is refused, so a parent can never disagree with what is under it.
- Several items are `active` at once (a parent and the sub-item running inside it). Nothing records which one is "current": the `active` item with no sub-items is the step being worked on, and it is what `turn.outline` names.
- The three jobs are separate: `PATCH /api/outline` shapes the outline, `PATCH /api/outline/status` moves statuses, and only the user clears it. An agent that has finished moves every item to `done` and leaves the outline standing.
- The version counts outline changes and resets and never goes back, so a new outline never reuses a number. Every write response carries `outlineVersion` while there is an outline: an agent that sees a number other than the one it remembers reads `GET /api/outline`.
- The page shows `active` rows in the accent colour, the deepest one in bold, and `done` rows greyed out with a line through them. The outline area hides when there are no items.
- A row whose step has a reply is a link to the first reply recorded under it, and every such reply carries a badge with its step's number and title. Both come from `outlineNo`, which the server writes as it records the reply; the agent sends nothing for it.

## 7. Page

- **Layout**: a sidebar (a pin button reading `Hide pinned`/`Show pinned`, lit while the pinned reply is showing and the icon alone once the sidebar is collapsed; kind legend; outline with a clear button, reduced to its numbers when the sidebar is collapsed, still carrying the colour, weight and line through that show where the work is; and at the bottom the theme and settings buttons) and the conversation, oldest at the top, questions on the right, replies on the left. The pinned reply sits at the top, across the full width rather than to one side, and carries the same pin button as its entry does, so it can be unpinned where it is read. It is as tall as it needs to be and scrolls inside that; its divider drags (or takes arrow keys) to any height between a glimpse and the smaller of the whole message and half the window, kept in this browser.
- **Settings panel** (gear, hidden with the collapsed sidebar): opens as a dialog in the middle of the page, closed by the background, `Esc` or the gear. Applying settings or resetting waits for the server: the controls are disabled and say `Applying…` or `Resetting…` until it answers, and the QR code appears only once broadcast is on. Changes to its regular controls are staged: `Cancel` discards them and closes, `Apply` saves them and keeps the panel open, and `Save` saves them and closes. It holds: `Use AI-cleaned questions`, `Text size` (Small 13px, Medium 15px, Large 17px, Extra large 19px; conversation text only, kept in this browser), `Max response chars`, `Max unseen events`, `Broadcast access` with QR code, address and copy button, and `Reset conversation` (asks for confirmation; disabled during a turn and on other computers).
- **Loading**: the first refresh fetches the state and the latest 50 entries (`last=50`). Scrolling near the top loads the 50 before the oldest loaded entry (`before=<id>`) and keeps the entry on screen in place; while the list is too short to scroll, older pages keep loading.
- **Updates**: the page listens on `/api/events`; a pushed head different from the one it has applied triggers a refresh, and it also refreshes every 30 s as a safety net, never overlapping. A refresh reads `/api/state`, asks `/api/sync?knownHead=<applied head>&limit=0` what is new, appends new entries (`after=<last id>`), refetches only entries touched by a note or revision, and reloads the latest page after a reset or an unknown head. The page's own writes do not advance the applied head.
- **Pinned reply**: loaded on its own (`/api/entries/:id`, and `?replyTo=` for threads in older records), since it may be outside the loaded window; reloaded when the pin changes or something touches it. A new version of the pinned document shows in the conversation as its change only (removed and added text).
- **Turn**: while `state.turn.open`, a spinner under the conversation shows `state.turn.progress`, the line the agent last sent, or a general message when it has sent none.
- **Drawing**: each card is kept by entry ID with a version (body, heading, question mode, note and revision counts, pinned or not); only cards whose ID or version differ are added, replaced, moved or removed.
- **Scroll**: at the bottom it follows new entries; otherwise the entry on screen stays in place. The position before a reload is kept in `sessionStorage`.
- **Markdown**: all text is HTML-escaped first. Entry headings use inline formatting. Bodies support: paragraphs, `#` headings (drawn as `h4`–`h6`), `>` quotes, bold, italics, `<br>`, inline code, links (`http`, `https`, `mailto`, `/`, `#` only), flat lists, tables, and fenced code blocks with light highlighting for `js`/`ts`, `json`, `py`, `bash`/`sh`, `ps1`, `html`/`xml`, `css`.
- **Theme**: light and dark, following the system until the reader chooses; the choice and layout sizes are kept in `localStorage`.

## 8. Broadcast

Broadcast lets other devices on the network open and use the page. It is off by default and switched in the settings panel, or on from the start with `--broadcast`.

- It is the `broadcast` field of `PATCH /api/settings`, accepted only from this computer. Unlike the other settings it is not kept: a restarted server is local again unless started with `--broadcast`, so a transcript is never exposed by a restart the user did not notice. The server rebinds (`127.0.0.1` ↔ `0.0.0.0`) on the same port without restarting, after sending the response; open connections drop and reconnect. The switch is stored as a `broadcast` state switch (not a chain event); a failed rebind restores the previous state and records `error`.
- The address uses the first non-internal IPv4 that does not start with `169.254.`, else `127.0.0.1`, and carries the access token: `http://IP:PORT/?t=<token>`. The settings panel shows it, while broadcast is on, as a QR code (version 4-L, URL up to 78 bytes), the address, and a copy button.
- **Access token**: 16 characters, made when the server starts and never stored. This computer never needs it; any other device does, and gets it by opening the QR code or the shared address. The page keeps it in that browser (`agent-token:`) and removes it from the address bar, so a later visit to the plain address still works. Restarting the server makes a new token, which ends every link already shared.
- The access token is the only check, and there is no encryption (plain HTTP): anyone on the network who gets the address or the QR code can read and change the transcript until the server restarts. The Windows firewall may ask about `node.exe`.

## 9. Agent integration

1. When the skill is called, start the server in the background from the project folder and give the user the address; run the same command again when you need it. Register with `ineedbetterui register --model <your model>` (or `POST /api/agents`) and keep the token; every write carries it, as `--token` or the `X-Ineedbetterui-Agent` header.
2. Start every turn by recording the user's message with `knownHead` and `turn`, the position of that message in the conversation, and read the response before answering: this write is the sync. Send the same `turn` with the progress lines and the reply. On `409`, record nothing, tell the user, and record the original message again only when the user asks you to retry.
3. Record the reply you give the user; that closes the turn. With Add reply on, the reply is an edit sent to `POST /api/pin/edit`. While you work, say what you are doing with `POST /api/progress`.
4. Keep the new `sync.head`. On `behind`, continue from `sync.unseen`; on `none` or `unknown`, `sync.unseen` holds the conversation since the last reset.
5. Follow `next`; it names the turn number to send. A refused write saved nothing; rewrite over-long replies, and send the same `turn` when retrying.
6. **If you no longer know where you are** — a compacted context, a resumed session — run `ineedbetterui status` before writing anything. It gives back the token, the name, the open turn and the next turn number ([3.5](#35-finding-your-place-again)); do not register again, and do not guess a turn number.

| Need | Request |
|---|---|
| Where the recording stands after losing context | `ineedbetterui status`, or `GET /api/agents` and `GET /api/state` |
| Full text of a previewed reply | `GET /api/entries/<id>` |
| Recent entries | `GET /api/entries?last=N&full=1` |
| Events after a head | `GET /api/sync?knownHead=<head>&limit=N` |

~~~powershell
$base = 'http://127.0.0.1:47823'; $knownHead = $null
function Send-Entry($payload) {
  if ($script:knownHead) { $payload.knownHead = $script:knownHead }
  $json = $payload | ConvertTo-Json -Depth 5
  $result = Invoke-RestMethod -Method Post -Uri "$base/api/entries" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
  $script:knownHead = $result.sync.head
  $result
}
Send-Entry @{ kind = 'question'; turn = 14; rawBody = 'original question'; cleanedBody = 'cleaned question' }
~~~

`Invoke-RestMethod` throws on `4xx`; the error body is in the exception's `ErrorDetails.Message`.

**Codex**: the same skill folder works in OpenAI Codex (`$ineedbetterui`; skills in `.agents/skills/` or `~/.agents/skills/`). The records folder is inside the working directory, so the `workspace-write` sandbox can write it; if writes are blocked, the user starts the server from a normal terminal. Checked on 2026-09-14 with Codex CLI 0.154.0 on Windows; a real Codex session since the records moved into `node_modules` has not been checked.

## 10. Tests

~~~bash
node tests/run-all.mjs
~~~

| File | Covers |
|---|---|
| `tests/sync-test.mjs` | Storage and git exclusion, session resume, hash sync, restart, moving the folder, broadcast switching and its access token, page elements, four simultaneous starts (fresh, with an older info file, and with the project port held by another program) ending with one server, a stale `start.lock` |
| `tests/render-test.mjs` | Highlighting, Markdown escaping, notes refused, paging past 1000 entries |
| `tests/core-test.mjs` | Question mode, deduplication, turns and progress, agent names and turn ownership, character limit, revisions refused, pin edits, outline, `next`, request checks, event stream, entry paging, the page without data, multi-agent sync, reset |
| `tests/cli-test.mjs` | Package contents, global install into a temporary prefix, skill registration, `stop`, `uninstall` |
| `tests/docs-test.mjs` | This document names every endpoint, query option, event type, command, flag and skill file in the code |

Tests use temporary folders and never touch the real home folder or global npm. A folder a dying process still has open as its working directory cannot be removed on Windows, so a suite retries and, failing that, leaves the folder behind rather than ending a run that passed every check. A port inside a Windows reserved range (Hyper-V, WSL) refuses `listen` with `EACCES` however free it is, so the test that has to hold a project port tries other folders until one binds. `tester/restart-ineedbetterui.ps1` restarts the repository server with `tester/` as the project; `tester/start-codex-test.ps1` prepares `tester/codex-project/` and runs Codex there.

## 11. Known limitations

| Area | Limitation |
|---|---|
| Highlighting | A light regex tokenizer: regex literals, triple-quoted strings, heredocs and TypeScript types are not coloured correctly |
| Markdown | No nested lists or images; HTML tags other than `<br>` show as text |
| Old entries | Loaded 50 at a time while scrolling up; no jump to an entry |
| Reading position | After a reload, restored by entry only if it is among the latest 50 |
| Turn lock | A turn whose agent never replies blocks **other** agents' questions for up to 10 minutes; the agent that holds it is not blocked |
| Pinned edits | An edit applies only while Add reply is on; the user turns it on again for each edit |
| Turn numbers | The agent counts the user's messages itself, so a wrong count is not detected; only a gap is. An agent that records nothing at all leaves nothing to check |
| Memory | The server keeps the whole transcript and its bytes in memory |
| Progress | The line an agent is on is not recorded, so it is gone after a restart and cannot be looked back at |
| Recovered turns | A gap says which turns were lost, never what was in them: those messages are gone for good |
| Agent names | The command works the agent out from the open turn or from a single registration; with several agents, no open turn of its own and no `--agent`, it is refused, and an agent that registers again instead appears as a second name. Two sessions recording one project at the same turn number can have an unidentified reply recorded as the wrong one of them, and a recorded entry is never edited. A name freed after 7 days can be given out again, while old entries keep it |
| Hand edits | A changed line shows only as `unknown` heads, without saying which line |
| Old records | Records under older names or locations are not migrated |
| Heads after upgrading | Versions before state switches left the chain hashed every line, so a head an agent kept from such a version is `unknown` once; the agent then gets the conversation since the last reset and continues normally |
| Non-JS projects | Recording creates a `node_modules` folder |
| Simultaneous starts | Resolved by `start.lock`: checked with four starts at once, fresh, with an older info file, and with the project port held by another program. A start that dies holding the lock delays the next start by up to 10 seconds |
| Stopping | Without npm, stop the process yourself; on Windows `stop` kills it |
| Broadcast | Only the access token, over plain HTTP; open connections drop when switching; the first IPv4 may be a VPN or virtual adapter; copying the address fails over plain `http` |
| Moving folders | Protected only on Windows |
| npm | Where install scripts do not run, run `ineedbetterui install`; pnpm and Bun unchecked; only Node 24 and Windows fully checked |
