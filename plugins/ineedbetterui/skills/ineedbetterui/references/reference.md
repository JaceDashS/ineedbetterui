# I Need Better UI Reference

The reference for a small tool that records agent conversations to a JSONL file and lets you read them again in a browser.

- **Source of truth**: the current code of the server `plugins/ineedbetterui/skills/ineedbetterui/ineedbetterui.mjs` and the command `bin/ineedbetterui.mjs`. Where this document and the code disagree, the code is the real behaviour and this document gets fixed.
- **Checked on**: Windows 11, Node.js v24.14.0, npm 11.9

## Contents

1. [Overview](#1-overview)
2. [Files](#2-files)
3. [Running](#3-running)
4. [Data model](#4-data-model)
5. [HTTP API](#5-http-api)
6. [Feature rules](#6-feature-rules)
7. [Page](#7-page)
8. [Markdown rendering](#8-markdown-rendering)
9. [Styles](#9-styles)
10. [Broadcast](#10-broadcast)
11. [Agent integration guide](#11-agent-integration-guide)
12. [Test tools](#12-test-tools)
13. [Known limitations](#13-known-limitations)

---

## 1. Overview

The project is called **I Need Better UI**; the skill, npm package and command are all `ineedbetterui`.

It has three parts.

| Part | Role |
|---|---|
| Local HTTP server | Serves the recording API and appends events to a JSONL file. |
| Transcript page | A single HTML page served by the server. The server pushes a message on every write, and the page refreshes right away. |
| JSONL transcript | One event per line. Replaying the whole file from the start gives the current state and the hash chain. |

**Design principles**

- The server and API are in `ineedbetterui.mjs`, the QR encoder in `lib/qr.mjs`, the project path rules in `lib/paths.mjs`, and the page in the HTML, CSS and JS files under `ui/`. The server joins the `ui/` files once at startup and sends them as one HTML response. Only Node built-in modules (`crypto`, `fs`, `http`, `os`, `path`, `url`) are used: no npm dependencies, external CDNs or web fonts.
- Records are stored in the project's `node_modules/.ineedbetterui/`, with a `.gitignore` there containing only `*`. Nothing is created that could be committed to the project repository.
- The transcript is append-only. Even a reset adds a `reset` event instead of deleting lines.
- Agents are not sent the whole log again and again. The hash chain picks out only the events an agent has not seen.
- The server never calls an AI model. The cleaned question (`cleanedBody`) is written by the recording agent.
- The server does not intercept chat input. Nothing is recorded unless the agent calls the API.
- Everything the agent reads (SKILL.md, this reference, API messages and hints) is English, and so is the page UI. Content the agent writes (entry bodies, headings, outline titles, notes, cleaned questions) is in the language of the conversation and shown as is.

## 2. Files

### 2.1 Repository

| Path | Description |
|---|---|
| `package.json` | npm package `ineedbetterui` (command `ineedbetterui`, install script) |
| `bin/ineedbetterui.mjs` | Command entry: start the server, `stop`, `install`, `uninstall` ([3.3](#33-npm-commands)) |
| `plugins/ineedbetterui/skills/ineedbetterui/` | The skill source. The npm package and the (phase 2) marketplace use the same folder |
| `…/ineedbetterui.mjs` | Server entry: record storage, API, server lifecycle |
| `…/lib/qr.mjs` | QR encoder for the broadcast address |
| `…/lib/paths.mjs` | Session ID and records folder rules, shared by the server and `bin` |
| `…/ui/page.html` · `page.css` · `page.js` | Page shell, styles and client JS, joined into one HTML at server start |
| `…/SKILL.md` | Instructions the agent follows to run and record. Skill name `ineedbetterui` |
| `…/references/reference.md` | This document |
| `README.md` | Description for the npm page |
| `tests/` | Automated tests ([12.2](#122-automated-tests)) |
| `tester/restart-ineedbetterui.ps1` | Server restart script for integration testing |
| `tester/start-codex-test.ps1` | Codex test project setup and launcher ([12.3](#123-codex-test-launcher)) |

The npm package contains only `package.json`, `README.md`, `bin/` and `plugins/ineedbetterui/skills/`; `tests/` and `tester/` are left out. Publish with `npm publish` from the repository root; `files` in `package.json` decides what goes in. Files with `.private.` in the name (developer notes, the Korean translations `*.ko.private.md`) are ignored by git, excluded from the npm package by `files`, and skipped when the skill is installed.

An installed skill folder looks like this. The folder name is the skill name: `$ineedbetterui` in Codex, `/ineedbetterui` in Claude Code.

~~~text
ineedbetterui/
|-- ineedbetterui.mjs
|-- SKILL.md
|-- lib/
|   |-- paths.mjs
|   |-- qr.mjs
|-- ui/
|   |-- page.html
|   |-- page.css
|   |-- page.js
|-- .ineedbetterui-install.json   (marker written by ineedbetterui install)
|-- references/
    |-- reference.md
~~~

### 2.2 Files created at runtime

~~~text
<project>/node_modules/.ineedbetterui/   (records folder)
  .gitignore          one line `*`; keeps the whole folder out of git
  transcript.jsonl    the transcript
  server-<port>.html   info about the running server
  project.json        project info
~~~

- The records folder and `.gitignore` are created when the server starts or on the first write. An existing `.gitignore` is left alone.
- Most repositories ignore `node_modules`; where they do not, the folder's own `.gitignore` still keeps the records out.
- Anything that deletes or recreates `node_modules` (`npm ci` etc.) deletes the records too.
- There is no option or environment variable to change the path.

`project.json` example:

~~~json
{
  "app": "ineedbetterui",
  "sessionId": "3f9a1c2b7d4e",
  "projectPath": "C:\\projects\\my-app",
  "createdAt": "2026-09-14T22:40:01.120+09:00",
  "lastStartedAt": "2026-09-14T23:05:12.004+09:00"
}
~~~

`createdAt` is when `project.json` was first written; `lastStartedAt` is updated each time a new server starts.

## 3. Running

Run with the project to record as the working directory. The server file is `ineedbetterui.mjs` in the skill folder (`plugins/ineedbetterui/skills/ineedbetterui/` in the repository). If installed with npm, the `ineedbetterui` command starts the same server.

~~~bash
node <skill folder>/ineedbetterui.mjs               # this computer only (default)
node <skill folder>/ineedbetterui.mjs --broadcast   # start with LAN access on
ineedbetterui [--broadcast]                         # the same, when installed with npm
~~~

The working directory is the project being recorded, so do not `cd` into the folder that holds the script.

### 3.1 Options and fixed values

| Item | Value |
|---|---|
| `--broadcast` | Start with broadcast on, bound to `0.0.0.0`. Without it the server binds to `127.0.0.1` only; broadcast can be turned on in the page settings ([10](#10-broadcast)). `--no-broadcast` is accepted and ignored. |
| Project | The working directory. No option changes it. |
| Transcript | `<project>/node_modules/.ineedbetterui/transcript.jsonl`, created on the first write. No option changes it. |
| Port | Automatic; there is no option for it ([3.2](#32-resuming-a-session)). |

- Unknown arguments are ignored without error, including the old `--port`, `--data`, `--export`, `--max-response-chars`.
- A new server keeps running. Agents run it in the background.

**Console output**

| Case | Output |
|---|---|
| New server | `ineedbetterui listening on http://127.0.0.1:PORT/`, then `records <transcript path>` |
| New server started with `--broadcast` | After those two lines, `broadcast access on http://LAN-IP:PORT/` |
| Already running | `ineedbetterui already running on http://127.0.0.1:PORT/` (exit code 0) |
| Error | One line with the error message (exit code 1) |

### 3.2 Resuming a session

Running the command again in the same project folder reuses that project's server if it is running, and starts one otherwise. There is no port to remember or pass.

**Session ID**

The first 12 hex digits of the SHA-256 of the project folder's real path. The path is resolved to its real form (including Windows 8.3 short names) and lower-cased on Windows. The same folder always gives the same ID.

**Server info file**

A new server writes `server-<port>.html` in the records folder.

- Opening it in a browser redirects to `http://127.0.0.1:<port>/`.
- Its `body` carries `data-app`, `data-session-id`, `data-port` and `data-pid`.
- It is deleted on a normal exit (Ctrl+C, SIGTERM, ...). After a forced kill it stays and is cleaned up on the next start.

**Startup**

1. Find every `server-<port>.html` in the records folder.
2. Send `GET http://127.0.0.1:<port>/api/health` for each (600 ms timeout). If `app` is `ineedbetterui` and `sessionId` matches, reuse that server.
   - Print the `already running` line and exit with code 0. Broadcast follows the running server's current state; a different start option is not an error.
3. If no server can be reused, delete every server info file in the records folder.
4. Try the ports of the deleted files first; if all are taken, use a free port from the OS.
5. Create the records folder and `.gitignore`, create or update `project.json`, write the server info file and print the address. With `--broadcast`, also print the LAN address.

| Case | Result |
|---|---|
| No server, no info file | Start fresh on a free port |
| This project's server is running | Print its address; start nothing |
| Only an info file left by a forced kill | Delete it and start again, on the same port if possible |
| The old port is used by another program | Delete the old file and start on a free port |
| This project's server runs with a different broadcast state | Print the address without error |
| Project folder moved or renamed after stopping the server | The records folder moves with it and **the transcript continues**. The session ID changes to match the new path |

**Moving the folder**

The server's working directory is the project folder, so on Windows the folder cannot be moved or renamed while the server runs (`EBUSY`). macOS and Linux do not prevent it, so stop the server before moving.

### 3.3 npm commands

`npm install -g ineedbetterui` adds the `ineedbetterui` command.

| Command | Action |
|---|---|
| `ineedbetterui [--no-broadcast]` | Start the server for the project in the current folder, or print the running server's address. Runs the server file from the skill folder as is |
| `ineedbetterui stop` | Find this project's server (checking the session ID via the health check), stop it and delete its info file |
| `ineedbetterui install` | Register the skill |
| `ineedbetterui uninstall` | Remove the skill. Records stay in each project |
| `ineedbetterui --version`, `--help` | Version, help |

**Install script (`postinstall`)**

- npm runs it on every install. It registers the skill (like `install`) only for global installs, where `npm_config_global` is `true`; inside a project it does nothing.
- A failed registration does not fail the npm install; it prints a hint to run `ineedbetterui install`.

**`install`**

| Target | Location |
|---|---|
| Codex skill | `~/.agents/skills/ineedbetterui/` |
| Claude Code skill | `~/.claude/skills/ineedbetterui/` |

- Copies the package's skill folder (except `*.private.*` files) and writes the `.ineedbetterui-install.json` marker.
- If a folder with that name exists without the marker (a folder the user made), it is skipped, not overwritten.
- Running it again deletes the marked folder and copies it fresh.

**`uninstall`**

- Deletes only skill folders that carry the marker.
- Records are kept in each project's `node_modules/.ineedbetterui/`; delete that folder by hand to remove them.
- npm v7+ no longer runs uninstall scripts, so run this before `npm uninstall -g ineedbetterui`.

## 4. Data model

### 4.1 File format

- UTF-8 text, one JSON object per line, lines end with `\n`.
- Lines that are not valid JSON, and empty lines, are skipped when replaying state. Non-empty lines are part of the hash chain even if they are not JSON.
- The event type is the `t` field. Keys and enum values are English; the user's language appears only in content fields such as `body`, `heading`, `title` and `text`.
- `time` is an ISO 8601 string with the server's local offset and milliseconds, e.g. `2026-09-14T21:30:05.123+09:00`.

~~~json
{"t":"entry","id":"a-12","kind":"question","time":"...","heading":"","body":"cleaned question","rawBody":"original","cleanedBody":"cleaned question","questionMode":"cleaned","clientRef":"turn-14-q"}
{"t":"entry","id":"a-13","kind":"report","time":"...","heading":"Reply","body":"explanation"}
{"t":"pin","time":"...","target":"a-13","source":"user"}
{"t":"reply-target","time":"...","target":"a-13","source":"user"}
{"t":"entry","id":"a-14","kind":"report","time":"...","heading":"","body":"follow-up reply","replyTo":"a-13"}
{"t":"note","id":"n-1757853005123-k3x9a","target":"a-13","time":"...","anchor":"estimate","title":"What is an estimate?","text":"..."}
{"t":"revision","id":"r-1757853005456-p2m7q","target":"a-13","time":"...","body":"full revised body"}
{"t":"outline","time":"...","done":false,"items":[{"no":"1","title":"Item","type":"report","status":"active","current":true}]}
{"t":"settings","time":"...","questionMode":"raw","maxResponseChars":2000,"maxUnseenEvents":20}
{"t":"reset","time":"..."}
~~~

### 4.2 Events

| `t` | Fields | Effect |
|---|---|---|
| `entry` | `id`, `kind`, `time`, `heading`, `body`; for questions `rawBody`, `cleanedBody`, `questionMode`; optional `clientRef`, `replyTo`; for broadcast entries `broadcastId`, `broadcastUrl`, `broadcastPort`, `qr` | Appends an entry to the conversation. A non-question entry consumes a pending reply-target. |
| `note` | `id`, `target`, `time`, `anchor`, `title`, `text` | Adds a note to the target entry |
| `revision` | `id`, `target`, `time`, `body` | Replaces the target's displayed body and adds it to the revision history |
| `pin` | `time`, `target` (ID or `null`), `source` (`user` or `agent`) | Replaces or clears the pin. Changing the pin clears the reply-target |
| `reply-target` | `time`, `target` (ID or `null`), `source` | Sets the pending link for the next non-question entry. Valid only while it equals the pinned entry |
| `outline` | `time`, `done`, `items` | Replaces the outline |
| `settings` | `time`, optional `questionMode`, `maxResponseChars`, `maxUnseenEvents` | Applies the valid fields to the current settings |
| `broadcast` | `time`, `enabled`, `url`, `port`, `source`, `error` on failure | Records the broadcast state ([10](#10-broadcast)) |
| `reset` | `time` | Clears the current state |

### 4.3 Identifiers and hashes

| Item | Format | Rule |
|---|---|---|
| entry | `a-N` | Highest N in the whole file (including before resets) + 1. Numbers are never reused after a reset. |
| note | `n-<epoch ms>-<5 random chars>` | Server generated |
| revision | `r-<epoch ms>-<5 random chars>` | Server generated |
| broadcast | `broadcast-<epoch ms>-<5 random chars>` | Generated at server start |
| event hash | 16 hex digits | First 16 digits of `sha256(<previous hash> + "\n" + <raw line>)` |
| head | 16 hex digits | Hash of the last line; `0000000000000000` for an empty transcript |

Hashes are not stored in the file. The server computes them from the start every time it reads the file, so the same file gives the same values after a restart. Changing even one character of an existing line changes every hash after it.

### 4.4 Enums

| Field | Values |
|---|---|
| `kind` | `question`, `report`, `decision`, `error`, `done`, `other` |
| `questionMode` | `cleaned`, `raw` |
| outline `status` | `pending`, `active`, `done` (the page shows only these three as labels) |
| `source` | `user` (request has the `X-Ineedbetterui-UI: 1` header), `agent` (otherwise) |

### 4.5 Replay rules

At startup and after every write, the server rereads the whole file from the start to build the state and the hash chain.

1. File order is canonical. Entries are listed in the order they were written.
2. If there are `revision`s, the last one's `body` is the displayed body.
3. For `pin`, `reply-target` and `outline`, the last event is the current state.
4. For `settings`, the last valid value of each field is current.
5. A `reset` clears the entries, outline, pin, reply-target and broadcast state, and restores `questionMode` to `cleaned`, `maxResponseChars` to 3000 and `maxUnseenEvents` to 20; later events then apply.
6. `clientRef` deduplication and entry numbering count lines from before resets too.

### 4.6 Defaults

| Item | Default |
|---|---|
| `questionMode` | `cleaned` |
| `maxResponseChars` | `3000` (`0` = unlimited) |
| `maxUnseenEvents` | `20` (`0` = unlimited) |
| Outline | `{done:false, items:[]}` |
| Pin, reply-target, broadcast | none |

## 5. HTTP API

### 5.1 Common rules

- Every API response is `application/json; charset=utf-8` with `Cache-Control: no-store`.
- Request bodies are JSON, at most 2,000,000 bytes. An empty body counts as `{}`.
- There is no authentication. By default the server binds to `127.0.0.1` only. With broadcast on it binds to `0.0.0.0`, and other devices on the LAN can use the page and the API, writes included. Only `POST /api/broadcast` is limited to this computer.
- To stop other web pages from calling the local server, every request is checked as follows, and refused with `403` otherwise:
  - The Host must be `127.0.0.1`, `localhost`, `[::1]`, or the LAN address while broadcasting (blocks DNS rebinding).
  - Writes must be `Content-Type: application/json`, and if an `Origin` is present it must match the requested Host (blocks cross-site requests).
- Writes from the page carry the `X-Ineedbetterui-UI: 1` header, which makes the `source` of pin and reply-target events `user`.
- Every write body accepts an optional `knownHead` ([6.3](#63-sync)).
- Error messages are English and say what to fix.

**Error response**

~~~json
{"ok":false,"error":"description","written":false}
~~~

| Status | When |
|---|---|
| `400` | Validation failure, invalid JSON, body too large, target not found, over the character limit |
| `403` | Host not allowed, a write without a JSON content type, a cross-origin write |
| `404` | Unknown API path, unsupported entry sub-path, a path that is not the page |
| `500` | Exception while handling |

Only an over-the-limit error adds `maxResponseChars` and `length` ([6.2](#62-reply-character-limit)).

**Common fields of a successful write**

| Field | Description |
|---|---|
| `ok` | `true` |
| `written` | `true` if this request appended a line to the JSONL |
| `state` | The `GET /api/state` result right after the write |
| `sync` | Sync result ([5.3](#53-the-sync-object)) |
| `next` | A one-line hint for the agent. It asks for `knownHead` when it was missing or unknown; asks to record the reply when the last entry is a question, and otherwise to record the user's next message first; and names the pending reply-target if any. It keeps the recording rules alive in long or compacted sessions |
| `entry` | Entry APIs only. New entries and duplicates get the full form; notes and revisions get the summary form |

### 5.2 Endpoints

| Method | Path | Purpose | Success |
|---|---|---|---|
| `GET` | `/api/events` | Server-Sent Events stream: pushes `{"head"}` on connect and after every write | `200`, stays open |
| `GET` | `/api/health` | Health check, session check | `200` |
| `GET` | `/api/state` | Current state summary | `200` |
| `GET` | `/api/sync` | Unseen events, or recent events on request | `200` |
| `GET` | `/api/entries` | Entry list | `200` |
| `GET` | `/api/entries/:id` | One entry in full | `200` |
| `POST` | `/api/entries` | Add an entry | `201`; `200` for a duplicate `clientRef` |
| `POST` | `/api/entries/:id/notes` | Add a note | `201` |
| `POST` | `/api/entries/:id/revisions` | Revise a body | `201` |
| `PATCH` | `/api/settings` | Question mode, character limit, sync cap | `200` |
| `POST` | `/api/broadcast` | Broadcast on/off (loopback only) | `200`; `written:false` if already in that state |
| `PATCH` | `/api/outline` | Replace the outline | `200` |
| `POST` | `/api/pin` | Set or clear the pin | `200` |
| `POST` | `/api/reply-target` | Set or clear the Add reply link | `200` |
| `POST` | `/api/reset` | Reset | `200` |
| `GET` | `/`, `*.html` | The transcript page | `200` |

### 5.3 The sync object

~~~json
{
  "head": "9c1f0b7a2e4d3c58",
  "eventCount": 42,
  "status": "behind",
  "unseenCount": 2,
  "truncated": false,
  "unseen": [
    {"hash":"5d2e...","t":"settings","time":"...","questionMode":"raw"},
    {"hash":"9c1f...","t":"entry","time":"...","id":"a-31","kind":"report","heading":"","preview":"first 200 chars...","length":1280,"truncated":true}
  ]
}
~~~

| Field | Description |
|---|---|
| `head` | The current last hash. The agent sends it as the next `knownHead`. |
| `eventCount` | Number of lines in the hash chain |
| `status` | `current`, `behind`, `none`, `unknown` ([6.3](#63-sync)) |
| `unseenCount` | Number of unseen events; `null` for `none` and `unknown` |
| `truncated` | `true` if `unseen` holds only the most recent part of the unseen events |
| `unseen` | Event summaries, in file order |

**Event summaries**

Every summary has `hash`, `t` and `time`. A line that is not JSON is `{"hash":"...","t":"invalid"}`.

| `t` | Extra fields |
|---|---|
| `entry` (question) | `id`, `kind`, `heading`, `body` (full), `questionMode`, `replyTo` if any |
| `entry` (other) | `id`, `kind`, `heading`, `replyTo` and `broadcastUrl` if any, body form |
| `note` | `id`, `target`, `anchor`, `title`, `text` (full) |
| `revision` | `id`, `target`; `body` (full) if the target is a question, otherwise the body form |
| `pin`, `reply-target` | `target`, `source` |
| `outline` | `done`, `items` |
| `settings` | Whichever of `questionMode`, `maxResponseChars`, `maxUnseenEvents` the event had |
| `broadcast` | `enabled`, `url`, `port` |
| `reset` | none |

The body form is `{"body": full}` up to 200 code points, and `{"preview": first 200, "length": total, "truncated": true}` beyond that. Get the full text with `GET /api/entries/:id`. QR module data is never included in summaries.

### 5.4 GET /api/health

Tells whether the server is alive and which project it belongs to. Used by startup ([3.2](#32-resuming-a-session)).

~~~json
{"ok":true,"app":"ineedbetterui","sessionId":"3f9a1c2b7d4e","pid":1234,"port":47823,"broadcast":true}
~~~

### 5.5 GET /api/state

~~~json
{
  "mode": "record",
  "outline": [{"no":"2-2","title":"...","type":"report","status":"active","current":true}],
  "outlineDone": false,
  "pin": {"target":"a-13","source":"user","revisionCount":1},
  "replyTarget": null,
  "questionMode": "cleaned",
  "broadcast": null,
  "maxResponseChars": 3000,
  "maxUnseenEvents": 20,
  "head": "9c1f0b7a2e4d3c58",
  "eventCount": 42,
  "lastEntry": {"id":"a-14","kind":"report","time":"..."},
  "entryCount": 14
}
~~~

- `pin`: an object only when the target is in the current list and is not a question; otherwise `null`.
- `replyTarget`: the ID only while it equals the pinned entry; otherwise `null`.
- `broadcast`: `{enabled:true, url, port, qr}` while broadcasting, otherwise `null`.

### 5.6 GET /api/sync

| Query | Description |
|---|---|
| `knownHead` | The last head the agent received. Without it the status is `none` |
| `limit` | Maximum number of events to return. Defaults to the `maxUnseenEvents` setting; `0` = unlimited |

~~~json
{"ok":true,"head":"...","eventCount":42,"status":"behind","unseenCount":5,"truncated":false,"unseen":[...]}
~~~

- If `knownHead` is in the chain, returns the most recent `limit` events after it.
- If `knownHead` is missing or not in the chain, returns the most recent `limit` events only when `limit` is 1 or more; otherwise an empty array. `unseenCount` is `null`.

### 5.7 GET /api/entries

| Query | Default | Description |
|---|---|---|
| `after` | none | Start after this ID; from the beginning if not found |
| `limit` | `50` | Clamped to 1–1000 |
| `last` | none | If 1 or more, return the last `last` entries (max 1000). Takes precedence over `after` and `limit` |
| `full` | none | `1` includes bodies and details |

~~~json
{"ok":true,"entries":[...],"nextAfter":"a-14","hasMore":false}
~~~

| Form | Fields |
|---|---|
| Basic | `id`, `kind`, `time`, `heading`, `replyTo` if any |
| `full=1` | Basic + `body`, `notes[]`, `revisions[]`, `clientRef` if any. Questions add `rawBody`, `cleanedBody`, `questionMode`. Broadcast entries add `broadcastId`, `broadcastUrl`, `broadcastPort`, `qr` |

### 5.8 GET /api/entries/:id

Returns one entry of the current list in the `full=1` form. An unknown ID is `400`.

~~~json
{"ok":true,"entry":{"id":"a-31","kind":"report","time":"...","heading":"","body":"full text","notes":[],"revisions":[]}}
~~~

### 5.9 POST /api/entries

~~~json
{"kind":"question","rawBody":"original","cleanedBody":"cleaned","heading":"","clientRef":"turn-14-q","knownHead":"..."}
{"kind":"report","body":"reply body","heading":"Title","clientRef":"turn-14-a","knownHead":"..."}
~~~

| Field | Required | Description |
|---|---|---|
| `kind` | yes | A value from [4.4](#44-enums) |
| `body` | for non-questions | String |
| `rawBody` + `cleanedBody` | both, for questions | Strings: the user's words and the agent's cleaned version |
| `heading` | no | Empty string if not a string |
| `clientRef` | no | Deduplication key for retries |
| `knownHead` | no | Sync base hash |

**Processing**

1. Validate `kind`; refuse if no body field is present, and refuse a question unless both `rawBody` and `cleanedBody` are strings.
2. Decide the body:
   - Question: use `rawBody` as `body` if the current `questionMode` is `raw`, otherwise `cleanedBody`.
   - Other kinds: use `body`, then `rawBody`, then `cleanedBody`.
3. Refuse if the chosen body is empty or whitespace only.
4. If the `clientRef` already exists, write nothing and return `200 {ok, written:false, deduplicated:true, entry, state, sync, next}`.
5. For non-questions, check the character limit.
6. For non-questions with a valid reply-target, add `replyTo`.
7. Return `201 {ok, written:true, entry, state, sync, next}`. The entry just written does not count as unseen in `sync`.

### 5.10 POST /api/entries/:id/notes

~~~json
{"anchor":"estimate","title":"What is an estimate?","text":"A value predicted from the given information.","knownHead":"..."}
~~~

- `text` is required and must not be whitespace only. `anchor` and `title` are optional.
- The target must be **the currently pinned reply**. A question, or an entry that is not pinned, is refused with `400`. No new entry is created.
- `anchorFound` in the response is `true` only if `anchor` is non-empty and appears in the target's displayed body.
- The response `entry` is the summary form `{id, kind, time, heading, replyTo?, noteCount, revisionCount}`.
- Notes are not subject to the character limit. Notes stay when the pin is cleared or moved.

### 5.11 POST /api/entries/:id/revisions

~~~json
{"body":"the full latest body","knownHead":"..."}
~~~

- `body` is required and must be **the full latest body**. The server does not check for fragments; it replaces the body with what it gets.
- Non-question targets are checked against the character limit.
- The original and earlier revisions stay in `revisions[]`. The response `entry` is the summary form of 5.10.

### 5.12 PATCH /api/settings

~~~json
{"questionMode":"raw"}
{"maxResponseChars":2000}
{"maxUnseenEvents":50}
~~~

- At least one of the three fields is required.
- `questionMode` accepts `cleaned` or `raw`; `maxResponseChars` and `maxUnseenEvents` accept integers of 0 or more.
- Writes a `settings` event with only the fields sent. It applies from the next request and survives restarts.

### 5.13 PATCH /api/outline

~~~json
{"done":false,"items":[{"no":"1","title":"Item","type":"report","status":"done"},{"no":"2","title":"Next","type":"decision","status":"active","current":true}]}
{"done":true}
~~~

- `done` must be a boolean. With `done:true`, `items` is stored as an empty array.
- With `done:false`, `items` may be omitted or empty (an empty outline); if present it must be an array. Each item needs a non-empty string `no` and `title`, and `status` of `pending`, `active` or `done`; `current`, if present, must be a boolean, and at most one item may be current. A bad item is refused with `400` and a message naming the item. `type` and other keys are stored as sent.
- The page reads `no`, `title`, `type`, `status` and `current`.

### 5.14 POST /api/pin

~~~json
{"target":"a-13"}
{"target":null}
~~~

- `target` is an entry ID string or `null`. Unknown IDs and questions are refused.
- There is at most one pin; a new pin replaces the old one.

### 5.15 POST /api/reply-target

~~~json
{"target":"a-13"}
{"target":null}
~~~

- Only the pinned reply can be set.
- Once set, the next **non-question** entry gets `replyTo` and the link clears itself. Question entries do not consume it.

### 5.16 POST /api/reset

~~~json
{"confirm":true}
~~~

Refused unless `confirm` is `true`. Existing lines stay; only a `reset` event is added.

## 6. Feature rules

### 6.1 Question mode

| Sidebar checkbox | `questionMode` | Question entry `body` |
|---|---|---|
| Checked (default) | `cleaned` | `cleanedBody` |
| Unchecked | `raw` | `rawBody` |

- Question entries store both forms and the mode at the time.
- Changing the mode does not change past entries.
- Question cards show an `AI-cleaned` or `Original` label.

**Writing the cleaned question (for agents)**

- Keep the intent, conditions and strength of the request.
- Add no new requests, background or judgement.
- No greetings, exclamations, repetition, or meta phrases such as "the user asks".
- One sentence or a short paragraph.
- Do not fill in what you did not understand; leave only the unclear part as a question.

### 6.2 Reply character limit

- **Applies to**: the body of new non-question entries, and revision bodies of non-question entries.
- **Does not apply to**: questions, `heading`, notes.
- **Counting**: `Array.from(body).length` (Unicode code points).
- **Default**: 3000; `0` = unlimited.
- **Setting**: `Max response chars` in the page settings, or `PATCH /api/settings`. There is no command-line option.
- **Checked**: against the limit when the server receives the write. Agents need not look it up first.
- **Over the limit**: nothing is saved and nothing is cut off.

~~~json
{"ok":false,"error":"A reply can be at most 2000 characters (this one has 2450). Split or rewrite it; do not cut it off.","written":false,"maxResponseChars":2000,"length":2450}
~~~

The agent splits or rewrites the reply to fit the returned `maxResponseChars`.

### 6.3 Sync

So that agents do not receive the whole log again and again, the server returns only the events after the point the agent last saw (`knownHead`).

| `status` | Condition | `unseen` |
|---|---|---|
| `current` | No events after `knownHead` (other than the one this request wrote) | Empty |
| `behind` | Other events after `knownHead` | The most recent `maxUnseenEvents`; `truncated: true` if there are more |
| `none` | No `knownHead` sent | Empty (with `limit` on `GET /api/sync`, the last `limit` events) |
| `unknown` | `knownHead` is not in the chain (a hash from another transcript, an edited line, ...) | Empty (with `limit` on `GET /api/sync`, the last `limit` events) |

- Pins and settings changed by the user in the browser, resets, and other agents' entries all show up as events.
- `maxUnseenEvents` is set with `Max unseen events` in the settings panel (default 20, `0` = unlimited) or `PATCH /api/settings`.
- Explicit requests are listed in [11.1](#111-basic-flow).

### 6.4 Pins and Add reply

- The pin target is one non-question entry.
- The pinned reply is shown in the fixed area above the conversation, and still appears in the normal list.
- With Add reply on, the next non-question reply is linked through `replyTo`.
- While its parent is pinned, a `replyTo` entry is shown **only in the pinned area's reply list**, not in the normal list. Unpinning or pinning another reply puts it back in the normal list. No data is ever deleted.

### 6.5 Notes

- A note is inserted as `<aside class="note">` right after the first occurrence of `anchor` in the body; if not found, at the end of the body.
- A note without a title shows `Note`. Note text is rendered as Markdown too.

### 6.6 Outline

- A `no` containing `-` is indented as a sub-item (e.g. `2-1`).
- The `current:true` row is bold and gets `aria-current="step"`.
- The outline area is hidden when `done:true` or when there are no items.
- Agent rule: when an explanation or change session starts, send every item in the original order, and send the whole list again whenever a status changes. Send `{"done":true}` at the end.

## 7. Page

### 7.1 Layout

| Area | Behaviour |
|---|---|
| Sidebar | Fixed on the left. Closed, it is a 56px rail; open, an overlay. Starts closed. Clicking the backdrop closes it. |
| Pinned area | `position: sticky` at the top of the content. The bottom handle resizes it between 96px and 80vh. Scrolls inside when content overflows |
| Conversation | Oldest at the top, newest at the bottom. Chat layout: questions lean right, replies lean left |

### 7.2 Sidebar (top to bottom)

| Element | Open | Closed rail |
|---|---|---|
| Title `I Need Better UI`, open/close button | Shown, X icon | Hamburger icon |
| `Pinned` checkbox | Shows or hides the pinned area (page only) | `P` |
| `Use AI-cleaned questions` checkbox and hint | Switches the question mode | `AI`, hint hidden |
| `Entry colors` legend | Kind names and descriptions | Short letters |
| `Outline` table | Drag column borders to resize, bottom handle for height | Hidden |
| Theme button at the bottom | Icon and `Dark Mode` / `Light Mode` | Icon only |
| Settings (gear) button at the bottom | At the right end of the theme row; opens the settings panel | Hidden |

**Settings panel**

Opens above the footer when the gear is pressed. `Esc`, clicking outside, or collapsing the sidebar closes it. With the sidebar collapsed, neither the button nor the panel is shown.

| Item | Behaviour |
|---|---|
| `Max response chars` number input and hint | Changes the character limit, from the next reply on |
| `Max unseen events` number input and hint | Changes the sync cap |
| `Broadcast access` checkbox and hint | Switches broadcast with `POST /api/broadcast`; the hint follows the state |
| QR code, address link, copy button | Shown only while broadcasting |

- Resize the sidebar by dragging its right edge, or focus it and use `←`/`→` (16px), `Home`/`End`. The range is `min(84vw, 320px)` to twice that (within the screen width).
- Number inputs save on `change` (Enter or blur). A value that is not an integer of 0 or more, or one the server refuses, reverts. Polling does not overwrite an input while it has focus.
- When a write fails, the page shows an alert with the server's message.

### 7.3 Entry cards

- The top shows the time (English `Intl.DateTimeFormat`, medium date + short time), the kind label, and for questions the mode label.
- A `heading` is shown as a title (inline Markdown applied).
- Non-question entries in the normal list have a pin button at the top right: an outline icon when not pinned, filled when pinned.
- Entries in the pinned area get an `Add reply` button and a pin icon. With Add reply on, the button fills with the accent colour.

### 7.4 Refresh and scrolling

- The page listens on `GET /api/events` (Server-Sent Events). The server writes `data: {"head":"..."}` when the stream opens and after every write, plus a keep-alive comment every 25 seconds. When the pushed head differs from the page's, the page refreshes. `EventSource` reconnects by itself (the server asks for a 2-second retry), for example after broadcast rebinds the server.
- As a safety net the page also refreshes every 30 seconds. Refreshes never overlap; a push that arrives during one triggers one more afterwards.
- A refresh fetches `GET /api/state` with `cache: "no-store"`. If the head, entry count, last ID, pin, reply-target, broadcast, outline, question mode, character limit and sync cap are all unchanged, it does nothing.
- When the entry count or last ID changes, it fetches `GET /api/entries?after=<last ID>&limit=1000&full=1` and appends the new entries, following `nextAfter` while `hasMore` is `true`.
- If the combined count does not match `entryCount` (after a reset, for example), it refetches every page from the start.
- When the head moved, it asks `GET /api/sync?knownHead=<previous head>&limit=0` which events are new and refetches, with `GET /api/entries/:id`, only the entries touched by `note` or `revision` events, so notes and revisions appear without a reload. If the previous head is unknown, it refetches everything.
- The scroll position is restored after a refresh:
  - At the bottom (within 24px): stay at the bottom.
  - At the top (within 80px): stay at the top.
  - Otherwise keep the entry that was on screen in place.
  - The pinned area's own scroll is kept the same way.
- The position just before a reload is saved in `sessionStorage` and restored. Without a saved value the page starts at the newest entry at the bottom.

### 7.5 Browser storage keys

Every key ends with the page path (`location.pathname`). Browser storage is per origin (host and port), so earlier values are not visible when the port changes.

| Key prefix | Storage | Value |
|---|---|---|
| `agent-theme:` | localStorage | `light` or `dark`; follows the system setting when absent |
| `agent-vis:` | localStorage | `{"pin":true}` |
| `agent-sidebar:v3:` | localStorage | `open` or `closed` |
| `agent-sidebar-width:` | localStorage | Sidebar width (px) |
| `agent-outline-h:` | localStorage | Outline height |
| `agent-outline-columns:` | localStorage | Width ratios of the four outline columns |
| `agent-pinned-h:` | localStorage | Pinned area height (px) |
| `agent-view:` | sessionStorage | Scroll position just before a reload |

## 8. Markdown rendering

Rendering happens in the browser. All text is HTML-escaped first, so a `<script>` or event attribute in a body never runs.

### 8.1 Supported syntax

| Syntax | Rule |
|---|---|
| Paragraph | Separated by blank lines; line breaks inside become `<br>` |
| Heading | `#` to `######`. Drawn as `h4`–`h6`, below the entry title (`h3`) |
| Blockquote | `> text`. Consecutive `>` lines form one quote, joined with line breaks |
| Bold | `**text**` |
| Italic | `*text*` or `_text_` |
| Line break tag | `<br>`, `<br/>`, `<br />` in a body become line breaks. Other HTML tags are escaped and shown as text |
| Inline code | A pair of backticks. No highlighting |
| Link | `[label](URL)`. A link only if the URL starts with `http://`, `https://`, `mailto:`, `/` or `#`; opens in a new tab. Otherwise only the label is shown |
| List | `- item`, `1. item`. No nesting |
| Table | A `---` separator line after the header line. Scrolls horizontally |
| Code block | Three-backtick or `~~~` fences |

Nested lists and images are not supported and show as text.

### 8.2 Code blocks

- A line starting with three backticks or `~~~` opens a code block. The closing fence must be the same kind. An unclosed block runs to the end of the body.
- Nothing inside the fence is parsed as Markdown.
- The first word after the opening fence, lower-cased, is the language tag.
- Output: `<pre class="code-block" data-lang="language"><code>…</code></pre>`. `data-lang` holds the normalized name from 8.3 (`js`, `json`, `py`, `bash`, `ps1`, `html`, `css`); it is omitted when there is no tag or it is not recognized.

### 8.3 Syntax highlighting

| Language | Recognized tags |
|---|---|
| `js` | `js`, `javascript`, `mjs`, `cjs`, `jsx`, `ts`, `typescript`, `tsx` |
| `json` | `json`, `jsonl` |
| `py` | `py`, `python` |
| `bash` | `sh`, `bash`, `zsh`, `shell` |
| `ps1` | `ps1`, `powershell`, `pwsh` |
| `html` | `html`, `xml`, `svg` |
| `css` | `css` |

Tags are case-insensitive. Other tags, or none, output the escaped text without highlighting.

**Order of checks (all but html)**

The tokenizer scans the code once from the start and, at each position, checks the following in order. A character that matches nothing is only escaped.

| Order | Check | js | json | py | bash | ps1 | css |
|---|---|---|---|---|---|---|---|
| 1 | Block comment → `tok-comment` | `/* */` | — | — | — | `<# #>` | `/* */` |
| 2 | Line comment → `tok-comment` | `//` | — | `#` | `#` ¹ | `#` ¹ | — |
| 3 | String → `tok-string` | quotes, template | quotes ² | quotes | quotes | quotes | quotes |
| 4 | Name → table below | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 5 | Number → `tok-number` | int, decimal | int, decimal | int, decimal | int, decimal | int, decimal | with unit ³ |

1. A comment only at the start of the code or after whitespace. The `#` in `${#arr}` is not a comment.
2. A JSON string followed by `:` is a key and gets `tok-function`.
3. `px`, `em`, `rem`, `vh`, `vw`, `ms`, `s`, `%`

Quoted strings use double or single quotes and understand backslash escapes. Without a closing quote they end at the end of the line. JS template strings (backticks) may span lines.

**Names**

| Condition | Token |
|---|---|
| Language keyword | `tok-keyword` |
| CSS name starting with `@` (`@media` etc.) | `tok-keyword` |
| CSS name inside `{ }` followed by `:` | `tok-function` (property name) |
| PowerShell `Verb-Noun` (`Write-Host` etc.) | `tok-function` |
| js, py, bash, ps1 name followed by `(` | `tok-function` |
| Anything else | none |

| Language | Keywords |
|---|---|
| js | `as async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield` |
| json | `true false null` |
| py | `False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return self try while with yield` |
| bash | `case do done echo elif else esac exit export fi for function if in local return then until while` |
| ps1 (case-insensitive) | `$false $null $true begin break catch class continue do else elseif end exit filter finally for foreach function if in param process return switch throw trap try until while` |
| css | `!important` |

**HTML**

| Target | Token |
|---|---|
| `<!-- -->` | `tok-comment` |
| Tag name right after `<` or `</` | `tok-keyword` |
| Attribute name inside a tag | `tok-function` |
| Quoted value inside a tag | `tok-string` |
| Text outside tags | none |

If the tokenizer throws, the escaped text is output without highlighting. Every token is escaped and then wrapped only in a `span` with a fixed class, so code is never interpreted as HTML, highlighted or not.

## 9. Styles

### 9.1 Themes

- Light and dark themes are CSS variables switched by `<html data-theme>`.
- Without a saved choice the theme follows `prefers-color-scheme`, and changes with the system setting.

| Variable | Use | light | dark |
|---|---|---|---|
| `--bg` | Page background | `#f5f6fa` | `#141820` |
| `--fg` | Text | `#202532` | `#eef1f7` |
| `--card` | Message card | `#fff` | `#202632` |
| `--muted` | Secondary text | `#606879` | `#a8b2c4` |
| `--line` | Borders | `#d9dfea` | `#394456` |
| `--accent` | Accent, report border | `#245ac7` | `#94b7ff` |
| `--nested-bg` | Nested message background | `#eef2f9` | `#283142` |
| `--code-bg` | Code block background | `#f6f8fa` | `#161b22` |

### 9.2 Entry kind colours

Kind colours are used only for the 4px left border of cards and legend items.

| kind | Meaning | light | dark |
|---|---|---|---|
| `question` | User message | `#8a92a3` | `#7d8699` |
| `report` | Progress or explanation | `#245ac7` | `#94b7ff` |
| `decision` | Awaiting the user's choice | `#bb8b22` | `#d9a441` |
| `error` | Failure or blocked step | `#de5964` | `#e8828b` |
| `done` | Completed | `#329b77` | `#5fc79d` |
| `other` | Other | `#7a5ec2` | `#a98ff0` |

### 9.3 Nested messages

A message inside a message gets a different background from the outer card.

| Target | Background | Border |
|---|---|---|
| Note in a body `.note` | `--nested-bg` | 3px accent, left |
| Entry in the pinned reply list `.reply-entry` | `--nested-bg` | 4px kind colour, left |
| Note inside a reply entry | `--card` | 3px accent, left |

### 9.4 Code token colours

| Variable | light | dark | Note |
|---|---|---|---|
| `--tok-comment` | `#656d76` | `#8b949e` | italic |
| `--tok-string` | `#1a7f37` | `#7ee787` | |
| `--tok-keyword` | `#8250df` | `#c792ea` | |
| `--tok-number` | `#b35900` | `#ffa657` | |
| `--tok-function` | `#245ac7` | `#94b7ff` | |

Code blocks (`.entry pre.code-block`) have a `--code-bg` background, a `1px solid var(--line)` border, 8px corners, no wrapping and horizontal scrolling. Inside notes or replies the background is still `--code-bg`.

## 10. Broadcast

Broadcast lets other devices on the same network open and use the transcript page. **It is off by default** and is turned on in the page settings (the sidebar gear). Starting with `--broadcast` turns it on from the start.

**Switching**

1. Send `{"on":true}` or `{"on":false}` to `POST /api/broadcast`. **Only loopback (this computer) requests are accepted**; a request from the LAN is refused with `400`.
2. The server changes only its binding, without restarting: `close()`, then `listen(port, '0.0.0.0' | '127.0.0.1')` on the same port. The port, the transcript and the server info file stay the same.
3. The binding changes **after** the response is sent, because changing the address drops open connections. The page and agents reconnect on their next request.
4. The change is recorded as a `broadcast` event and reaches agents through `sync.unseen`.
5. If rebinding fails, the previous state is restored and a `broadcast` event with `error` is written.

~~~json
{"t":"broadcast","time":"...","enabled":true,"url":"http://192.168.0.77:47823/","port":47823,"source":"user"}
~~~

**Access address**

`http://IP:PORT/` uses the **first** network interface address that is IPv4, not internal and not starting with `169.254.`. If none is found, `127.0.0.1` is used.

**Page**

While on, the settings panel shows a QR code (SVG on white with a 4-module quiet zone), the address link and a copy button. Copying fails outside a secure context (another device opening over `http`), and the page asks the user to select and copy the address. No QR entry is written to the transcript; QR entries left by older versions still show in the conversation.

**QR encoder**

- A byte-mode encoder built into the server, fixed at version 4, error correction L (33×33 modules).
- The URL must be **78 bytes or less** in UTF-8. Longer URLs throw `The broadcast URL is too long for the QR code.` and the start fails.
- The mask with the lowest penalty of the eight is chosen.

**Security**

There is no authentication or encryption. By default only this computer can connect, so the LAN cannot reach the server until broadcast is on. While on, anyone on the same network can see the page and call every API, including writes and reset; only switching broadcast is limited to this computer. The Host, content type and Origin checks in [5.1](#51-common-rules) apply at all times. On Windows the firewall may ask whether to allow `node.exe` on the network the first time.

## 11. Agent integration guide

### 11.1 Basic flow

1. When the skill is called, start at once, even with no other request. With the project folder as the working directory, run `node <skill folder>/ineedbetterui.mjs` in the background and tell the user the printed address. Run the same command again when you do not know the address or in a new session; if the server is running it only prints the address.
2. When the user sends a message, record it as a question with `POST /api/entries`. Include the last `sync.head` you received as `knownHead`.
3. When you give the user a reply, record it with the same API.
4. Keep the `sync.head` of every write response and check `sync.status`:
   - `behind`: read `sync.unseen` and apply the user's pin or settings changes and other agents' entries.
   - `none` / `unknown`: no log was sent. Use the explicit requests below only when needed.
5. Follow the `next` hint in every write response.
6. A refused write (`written:false`) saved nothing. If it was over the character limit, rewrite and send again. Reuse the same `clientRef` when retrying.

**Explicit requests**

| Need | Request |
|---|---|
| More unseen events (`truncated`) | `GET /api/sync?knownHead=<previous head>&limit=N` |
| The last N events | `GET /api/sync?limit=N` |
| The last N entries | `GET /api/entries?last=N&full=1` |
| The full text of a previewed reply | `GET /api/entries/<id>` |

### 11.2 Example calls (PowerShell)

~~~powershell
$base = 'http://127.0.0.1:47823'
$knownHead = $null

function Send-Entry($payload) {
  if ($script:knownHead) { $payload.knownHead = $script:knownHead }
  $json = $payload | ConvertTo-Json -Depth 5
  $result = Invoke-RestMethod -Method Post -Uri "$base/api/entries" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
  $script:knownHead = $result.sync.head
  if ($result.sync.status -eq 'behind') { $result.sync.unseen | ForEach-Object { "unseen: $($_.t) $($_.id)" } }
  $result
}

Send-Entry @{ kind = 'question'; rawBody = 'original question'; cleanedBody = 'cleaned question'; clientRef = 'turn-14-q' }
Send-Entry @{ kind = 'report'; heading = 'Result'; body = "reply body`n~~~js`nconst a = 1;`n~~~"; clientRef = 'turn-14-a' }
~~~

`Invoke-RestMethod` throws on `4xx` responses. To read an over-the-limit body, parse the exception's `ErrorDetails.Message` as JSON.

### 11.3 Suggested prompts

**Recording**

~~~text
Record the user's messages in this thread, and the replies you give the user, to ineedbetterui.
Keep the user's real words as rawBody, and also write a cleanedBody that keeps the meaning, conditions and strength.
Add no greetings, meta phrases or new requests to cleanedBody.
Leave internal reasoning and raw tool calls out of replies.
Reuse the same clientRef when retrying the same request.
Send the last sync.head as knownHead with every write; never ask for the whole log.
Report a failed write as not saved, and leave existing records unchanged.
Record in the language of the conversation.
~~~

**Cleaning a question**

~~~text
Rewrite the user input below as a cleanedBody of one sentence or a short paragraph.
- Keep the intent, conditions and strength of the request.
- Add no new requests, background or judgement.
- Remove greetings, exclamations, repetition and meta phrases.
- If the input is unclear, do not fill it in; leave only the unclear part as a question.
- Write it in the language of the input.
Output only the cleaned question.

rawBody:
{{USER_RAW_BODY}}
~~~

**Recording a reply**

~~~text
Record the reply below as the public text given to the user.
- Leave out internal reasoning, raw tool calls and private details of the environment.
- Do not drop or soften the conditions, strength or results the user asked for.
- Do not look up the character limit first. If the server refuses the reply as too long, split or rewrite it to fit the returned maxResponseChars; never cut it off.
kind: {{KIND}}
body:
{{PUBLIC_RESPONSE}}
~~~

### 11.4 Using it with Codex (ChatGPT)

The same skill folder works in OpenAI Codex. The following was checked on 2026-09-14 with Codex CLI 0.154.0 (Windows, `elevated` sandbox) and the `codex sandbox` command.

| Item | Details |
|---|---|
| Skill location | The project's `.agents/skills/ineedbetterui/` or `~/.agents/skills/ineedbetterui/` |
| Calling | CLI and IDE extension: `$ineedbetterui` (list with `/skills`). Desktop app: type `@` and pick the skill. Sending just the skill name makes the agent start the server and give the address without asking (a SKILL.md rule) |
| Writing records | The records folder is inside the working directory (`node_modules/.ineedbetterui`), so the `workspace-write` sandbox can write it without extra setup. The sandbox allowing writes in the working directory was checked; a real Codex session since this location change has not been checked yet |
| When writes are blocked | The user starts the server from a normal terminal first. An agent inside the sandbox was confirmed to record to that server |
| localhost | Inside the sandbox, opening ports (`127.0.0.1`, `0.0.0.0`) and connecting to `127.0.0.1` work |
| Background processes | A detached child process kept running after a command run with `codex sandbox` finished. Not checked in a real agent session |
| LAN access | The sandbox user's firewall rules may block other devices. Not checked |

~~~powershell
codex -C <project> -c 'sandbox_mode="workspace-write"'
~~~

- `sandbox_mode` can also go in `config.toml`. A trusted project's `.codex/config.toml` is read too.
- The repository's `tester/start-codex-test.ps1` prepares a test project and runs this for you ([12.3](#123-codex-test-launcher)).

## 12. Test tools

### 12.1 Tester server script

`tester/restart-ineedbetterui.ps1` restarts the repository's latest `ineedbetterui.mjs` with the `tester` folder as the project.

~~~powershell
.\tester\restart-ineedbetterui.ps1
.\tester\restart-ineedbetterui.ps1 -NoBroadcast
~~~

| Parameter | Default | Description |
|---|---|---|
| `-NoBroadcast` | off | Adds `--no-broadcast` |

**Steps**

1. `tester` is the project, so records go to `tester/node_modules/.ineedbetterui/`, which the repository `.gitignore` covers through `node_modules/`.
2. Health-check each server info file in that folder, stop the responding server by PID and delete the file.
3. Run `node ..\plugins\ineedbetterui\skills\ineedbetterui\ineedbetterui.mjs [--no-broadcast]` from `tester` in the same console.
4. Once the server is up, check `/api/state` and, if the outline is empty, add a sample outline with `PATCH /api/outline`.
5. Wait for the server process to end and exit with its exit code.

### 12.2 Automated tests

~~~bash
node tests/run-all.mjs
~~~

| File | Checks |
|---|---|
| `tests/sync-test.mjs` | Storage location and git exclusion, session resume, hash sync, `GET /api/entries/:id`, hashes kept after restart, moving the folder, broadcast off by default and switching, settings panel elements, page script compiles |
| `tests/render-test.mjs` | Syntax highlighting, Markdown escaping, note rules, paging past 1000 entries |
| `tests/core-test.mjs` | Event stream push, question mode, deduplication, character limit, pin and Add reply, revisions, outline, `next` hints, Host/content type/Origin checks, state kept after restart, reset |
| `tests/cli-test.mjs` | npm package contents, `npm pack`, global install to a temporary location, skill registration by the install script, protection of user folders, `ineedbetterui` start, `stop` and record location, install inside a project, `uninstall`, `npm uninstall -g` |

- Each file can also run on its own, e.g. `node tests/sync-test.mjs`.
- `cli-test.mjs` points `USERPROFILE`/`HOME` and `CODEX_HOME` at temporary folders and installs globally into a temporary `--prefix`. It never touches the real user folder or global npm.
- Each test creates a project folder in a temporary directory and deletes it at the end. Records are created inside that project, so real projects and `tester/` records are not touched.
- Each check prints `PASS` or `FAIL`, and any failure makes the exit code 1. `run-all.mjs` runs the four files in turn and exits with 1 if any fails.
- The running-folder move check runs only on Windows; the git exclusion check only when `git` is available.
- The broadcast switch check binds to `0.0.0.0`, so the Windows firewall may ask for permission.
- The page's actual rendering and deleting the server info file on normal exit are outside the automated tests. Access from another computer cannot be exercised from a single machine.

### 12.3 Codex test launcher

`tester/start-codex-test.ps1` prepares and runs a lightweight Codex CLI trial of the skill. It does not change the user's global settings or global skill folders.

~~~powershell
.\tester\start-codex-test.ps1             # prepare and launch Codex
.\tester\start-codex-test.ps1 -NoLaunch   # prepare only and print the command
~~~

1. Copy the repository's skill source folder over `tester/codex-project/.agents/skills/ineedbetterui/`.
2. Run the Codex CLI in `tester/codex-project` with `sandbox_mode="workspace-write"`, for that run only. Records go to `tester/codex-project/node_modules/.ineedbetterui/`.

`tester/codex-project/` is ignored by git.

## 13. Known limitations

Limits of the current code, and places where it behaves differently from the intended design. Update this list and the related section when fixing one.

### 13.1 Rendering

| Item | Current behaviour |
|---|---|
| Highlighting accuracy | The tokenizer is a light regex-based one, so JS regex literals, Python triple-quoted strings, shell heredocs and TypeScript type names are not coloured correctly. |
| Markdown coverage | No nested lists or images. HTML tags other than `<br>` show as text. |

### 13.2 API and data

| Item | Current behaviour |
|---|---|
| revision | Fragments are not detected. Question entries can be revised too. |
| `clientRef` | A `clientRef` equal to one from before a reset returns the old entry instead of writing a new one. |
| Performance | A write parses and hashes only the new line. Before each write the server reads the file and compares its bytes with the copy it keeps in memory; only if they differ (an outside edit) is the whole file replayed. Reads are served from memory. The in-memory copy costs as much memory as the file size. |
| Editing the file by hand | Hashes are not stored, so a changed line shows up only as `unknown`, without saying which line changed. |
| Records under old names | Records in an old `agent-transcript.private.jsonl` (in the project folder) or an `i-need-better-ui` data folder are not moved to the new location. |
| Deleting records | Deleting or recreating `node_modules` (`npm ci` etc.) deletes the records too, without backup or warning. |
| Non-JS projects | Recording creates a `node_modules` folder. It is excluded from git, but editors or tools may treat the project as a JS project. |

### 13.3 Server and network

| Item | Current behaviour |
|---|---|
| Simultaneous starts | Two starts at almost the same time in the same project may both see no running server and start two servers writing the same transcript. They do not know each other's state, so entry IDs can collide. |
| Stopping | If installed with npm, stop with `ineedbetterui stop`. With the skill folder alone, kill the process yourself. On Windows `stop` kills the process forcibly, and deletes the leftover server info file itself. |
| Authentication | None. While broadcasting, anyone on the LAN can read and change the transcript. |
| Broadcast switch | Open connections drop while the binding changes. The page and agents reconnect on their next request; one request right after the switch may fail. |
| Copy button | Over plain `http` (not a secure context) the clipboard API is blocked and copying fails; the address must be selected and copied by hand. |
| Folder move protection | Windows only. macOS and Linux do not stop the folder from being moved while the server runs; the server keeps trying the old path, so stop it before moving. |
| Access address | The first IPv4 found is used. If a VPN, WSL or Hyper-V virtual adapter comes first, other devices may not be able to reach that address. |
| QR capacity | URLs over 78 bytes cannot be encoded. |

### 13.4 npm distribution

| Item | Current behaviour |
|---|---|
| Blocked install scripts | Where install scripts do not run (`--ignore-scripts` etc.), the skill is not registered; run `ineedbetterui install` yourself. Not checked with pnpm or Bun. |
| Removal | npm does not run uninstall scripts. Without `ineedbetterui uninstall` first, the skill folders and the Codex config block stay behind. |
| Skill copies | The skill is registered by copying. Updating the package copies it again through the install script, but if the script does not run the old SKILL.md stays. |
| Node versions | Checked only on Node.js v24. `engines` is `>=24`. |
| Operating systems | The full flow was checked on Windows only. The macOS and Linux paths exist in the code but were not checked. |
