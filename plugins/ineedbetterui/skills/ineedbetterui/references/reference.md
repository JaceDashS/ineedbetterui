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
| `bin/ineedbetterui.mjs` | Command: start the server, `stop`, `install`, `uninstall` ([3.3](#33-npm-commands)) |
| `plugins/ineedbetterui/skills/ineedbetterui/` | The skill folder, shared by the npm package and the (phase 2) marketplace |
| `…/ineedbetterui.mjs` | Server: record storage, API, server lifecycle |
| `…/lib/paths.mjs` | Session ID and records folder rules, shared by the server and `bin` |
| `…/lib/qr.mjs` | QR encoder for the broadcast address |
| `…/ui/page.html`, `page.css`, `page.js` | Page shell, styles and client script, joined into one HTML at server start |
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
| `server-<port>.html` | Info about the running server; opening it redirects to the page |
| `project.json` | `app`, `sessionId`, `projectPath`, `createdAt`, `lastStartedAt` |

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
- **Startup**: for each `server-<port>.html` in the records folder, `GET /api/health` (600 ms timeout); if `app` and `sessionId` match, print `already running` and exit. Otherwise delete the stale info files, try their ports first, then any free port, write `project.json` and a new info file, and print the address.
- A server stopped and then moved with its folder continues the same transcript; the session ID follows the new path.
- On Windows the folder cannot be moved while the server runs (`EBUSY`). Elsewhere, stop the server before moving it.

### 3.3 npm commands

| Command | Action |
|---|---|
| `ineedbetterui` | Start or reuse the server for the current folder |
| `ineedbetterui stop` | Stop this folder's server (checked through the health session ID) and delete its info file |
| `ineedbetterui install` | Copy the skill folder (without `*.private.*`) to `~/.agents/skills/ineedbetterui/` (Codex) and `~/.claude/skills/ineedbetterui/` (Claude Code) with a `.ineedbetterui-install.json` marker. A folder without the marker is left alone |
| `ineedbetterui uninstall` | Delete marked skill folders only. Records stay in each project. Run it before `npm uninstall -g`, since npm runs no uninstall scripts |
| `ineedbetterui --version`, `--help` | Version, help |

`postinstall` runs `install` for global installs only (`npm_config_global=true`) and never fails the npm install.

## 4. Data model

### 4.1 File format

UTF-8, one JSON object per line, `\n` line ends. The event type is `t`; keys and enum values are English. `time` is ISO 8601 with the local offset and milliseconds. Lines that are not JSON are skipped when replaying but still count in the hash chain.

~~~json
{"t":"entry","id":"a-12","kind":"question","time":"...","heading":"","body":"cleaned","rawBody":"original","cleanedBody":"cleaned","questionMode":"cleaned","clientRef":"turn-14-q"}
{"t":"entry","id":"a-13","kind":"report","time":"...","heading":"Reply","body":"text"}
{"t":"entry","id":"a-14","kind":"report","time":"...","heading":"","body":"follow-up","replyTo":"a-13"}
{"t":"note","id":"n-...","target":"a-13","time":"...","anchor":"estimate","title":"What is an estimate?","text":"..."}
{"t":"revision","id":"r-...","target":"a-13","time":"...","body":"full revised body"}
{"t":"pin","time":"...","target":"a-13","source":"user"}
{"t":"reply-target","time":"...","target":"a-13","source":"user"}
{"t":"outline","time":"...","done":false,"items":[{"no":"1","title":"Item","type":"report","status":"active","current":true}]}
{"t":"settings","time":"...","questionMode":"raw","maxResponseChars":2000,"maxUnseenEvents":20}
{"t":"broadcast","time":"...","enabled":true,"url":"http://192.168.0.77:47823/","port":47823,"source":"user"}
{"t":"reset","time":"..."}
~~~

### 4.2 Events

| `t` | Effect |
|---|---|
| `entry` | Appends an entry. A non-question entry consumes a pending reply-target and gets its `replyTo` |
| `note` | Adds a note to the target entry |
| `revision` | Replaces the target's displayed body; history is kept |
| `pin` | Sets or clears the single pin (`target` ID or `null`); a new pin clears the reply-target |
| `reply-target` | Links the next non-question entry to the pinned entry; valid only while it equals the pin |
| `outline` | Replaces the outline |
| `settings` | Applies the valid fields it carries |
| `broadcast` | Records a broadcast switch ([8](#8-broadcast)) |
| `reset` | Clears entries, outline, pin, reply-target and broadcast, and restores default settings |

`source` is `user` when the request had the `X-Ineedbetterui-UI: 1` header (the page), otherwise `agent`.

### 4.3 IDs, hashes and replay

- Entry IDs are `a-N`, one more than the highest N in the whole file; numbers are never reused, even after a reset. Notes are `n-<ms>-<5 chars>`, revisions `r-<ms>-<5 chars>`.
- **Hash chain**: each line's hash is the first 16 hex digits of `sha256(previous hash + "\n" + line)`, starting from `0000000000000000`. The last hash is the **head**. Hashes are not stored; the server computes them once per line in memory.
- Replay: file order is canonical; the last `revision` is the body; the last `pin`, `reply-target` and `outline` win; `settings` apply field by field; `clientRef` deduplication and numbering include lines before resets.
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
- No authentication. With broadcast on, other devices on the LAN may use every endpoint except `POST /api/broadcast`.
- Every request is refused with `403` unless the Host is `127.0.0.1`, `localhost`, `[::1]` or the broadcast LAN address (against DNS rebinding). Writes (`POST`, `PATCH`) also need `Content-Type: application/json` and, if an `Origin` is sent, the same origin as the Host (against cross-site requests).
- Every write body accepts `knownHead` ([6.3](#63-sync)). Error messages are English and say what to fix.

**Errors**: `{"ok":false,"error":"...","written":false}` with `400` (validation, bad JSON, too large, unknown target, over the character limit), `403` (see above) or `404` (unknown path).

**Successful writes** return `ok`, `written` (whether a line was appended), `state` (as `GET /api/state`), `sync` ([5.3](#53-the-sync-object)), `next` (a one-line hint for the agent) and, for entry APIs, `entry`. Recording a question also returns `turn` ([5.7](#57-post-apientries)).

`next` says, as needed: read `sync.unseen` (the conversation so far for a new agent, or events missed); send `sync.head` as `knownHead`; `unseen` was truncated; record the reply after a question, or record the user's next message first after a reply; the next reply is linked to a pinned entry.

### 5.2 Endpoints

| Method | Path | Purpose | Success |
|---|---|---|---|
| `GET` | `/` | The page (fixed file, no data) | `200` |
| `GET` | `/api/events` | Server-Sent Events: `data: {"head":"..."}` on connect and after every write, a keep-alive comment every 25 s, `retry: 2000` | `200`, stays open |
| `GET` | `/api/health` | `{ok, app, sessionId, pid, port, broadcast}` | `200` |
| `GET` | `/api/state` | Current state summary | `200` |
| `GET` | `/api/sync` | Events after a head | `200` |
| `GET` | `/api/entries` | Entry list | `200` |
| `GET` | `/api/entries/:id` | One entry in full | `200` |
| `POST` | `/api/entries` | Add an entry | `201`; `200` for a duplicate `clientRef` |
| `POST` | `/api/entries/:id/notes` | Add a note to the pinned reply | `201` |
| `POST` | `/api/entries/:id/revisions` | Replace a body | `201` |
| `PATCH` | `/api/settings` | Question mode, character limit, sync cap | `200` |
| `GET` | `/api/outline` | The outline as text: `{ok, done, text, version}` | `200` |
| `PATCH` | `/api/outline` | Set or edit the outline | `200` |
| `POST` | `/api/pin` | Set or clear the pin | `200` |
| `POST` | `/api/reply-target` | Set or clear Add reply | `200` |
| `POST` | `/api/broadcast` | Switch broadcast (this computer only; `400` from the LAN) | `200` |
| `POST` | `/api/reset` | Reset (`{"confirm":true}` required) | `200` |

### 5.3 The sync object

~~~json
{"head":"9c1f0b7a2e4d3c58","eventCount":42,"status":"behind","unseenCount":2,"truncated":false,
 "unseen":[{"hash":"5d2e...","t":"settings","time":"...","questionMode":"raw"},
           {"hash":"9c1f...","t":"entry","time":"...","id":"a-31","kind":"report","heading":"","preview":"first 200 chars","length":1280,"truncated":true}]}
~~~

- `status`: `current`, `behind`, `none` or `unknown` ([6.3](#63-sync)). `unseenCount` counts all unseen events; `truncated` says only the latest were sent.
- Every summary has `hash`, `t`, `time`. Entries add `id`, `kind`, `heading`, `replyTo`; questions carry the full `body` and `questionMode`; other bodies and non-question revisions are `{"body"}` up to 200 code points, else `{"preview","length","truncated":true}`. Notes carry their full text. `pin`/`reply-target` carry `target`, `source`; `outline` carries `done`, `items`; `settings` its fields; `broadcast` `enabled`, `url`, `port`. A non-JSON line is `{"t":"invalid"}`.

### 5.4 GET /api/state

`mode`, `outline`, `outlineDone`, `pin` (`{target, source, revisionCount}` or `null`), `replyTarget`, `questionMode`, `broadcast` (`{enabled, url, port, qr}` or `null`), `maxResponseChars`, `maxUnseenEvents`, `head`, `eventCount`, `lastEntry` (`{id, kind, time}`), `entryCount`.

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
| `full` | none | `1` adds `body`, `notes[]`, `revisions[]`, `clientRef`, question and broadcast fields |

Returns `{ok, entries, nextAfter, hasMore, hasBefore}`: `hasMore` means entries exist after the returned ones, `hasBefore` before them. The basic form is `{id, kind, time, heading, replyTo?}`.

`GET /api/entries/:id` returns one current entry in the `full=1` form; an unknown ID is `400`.

### 5.7 POST /api/entries

~~~json
{"kind":"question","rawBody":"original","cleanedBody":"cleaned","clientRef":"turn-14-q","knownHead":"..."}
{"kind":"report","body":"reply","heading":"Title","clientRef":"turn-14-a","knownHead":"..."}
~~~

1. `kind` must be a valid kind. Questions need both `rawBody` and `cleanedBody` as strings; other kinds need `body`.
2. A question's `body` is `rawBody` when `questionMode` is `raw`, else `cleanedBody`. An empty body is refused.
3. A known `clientRef` writes nothing and returns the existing entry with `deduplicated:true`.
4. Non-questions are checked against the character limit and get `replyTo` from a pending reply-target.

**Turn brief**: the response to a question (new or deduplicated) carries `turn`, what the agent needs before writing this turn's reply. Fields appear only when they apply:

| Field | Meaning |
|---|---|
| `replyLimit` | The character limit for the reply (absent when unlimited) |
| `replyTo` | Add reply is on: the reply will be linked to this pinned entry |
| `outline` | `{no, title, status}` of the current outline item (`current:true`, else the first `active`) |
| `unseen` | `{count, kinds, in}`: a summary only, how many events the agent missed counted by `t`; `in` is `"sync.unseen"`, where the events themselves are in the same response |

Everything else stays in `state`. `next` repeats the essentials in words (Add reply, the limit).

### 5.8 Other writes

| Endpoint | Body and rules |
|---|---|
| `POST /api/entries/:id/notes` | `{anchor?, title?, text}`. The target must be the pinned reply (not a question). `anchorFound` is true when `anchor` is in the displayed body. No character limit |
| `POST /api/entries/:id/revisions` | Either `{body}`, the full new body, or `{old, new}`: `old` (non-empty) must occur exactly once in the current body and is replaced by `new` (may be empty to delete). Not both. Missing or repeated `old` is refused with `400`. Either way the full resulting body is stored as the revision, and non-questions are checked against the character limit |
| `PATCH /api/settings` | Any of `questionMode` (`cleaned`/`raw`), `maxResponseChars`, `maxUnseenEvents` (integers ≥ 0) |
| `PATCH /api/outline` | One of: `{text}`, the whole outline as text; `{old, new, version}`, a part of the text replaced by the same rule as revisions, refused if `version` is not the current one; `{done:true}` to finish (`{done:false}` alone clears it). `{items}`, a JSON array, is still accepted. The result must parse and validate: every line `no \| title \| type \| status` with an optional `\| current`, non-empty `no` and `title`, a valid status, at most one current. The response adds `outline: {text, version}` |
| `POST /api/pin` | `{target}`: an entry ID (not a question) or `null` |
| `POST /api/reply-target` | `{target}`: the pinned reply or `null` |
| `POST /api/broadcast` | `{on}` boolean; from this computer only |
| `POST /api/reset` | `{confirm:true}` |

## 6. Rules

### 6.1 Question mode

The page checkbox sets `questionMode`: checked `cleaned` (default), unchecked `raw`. Each question stores both forms and the mode at the time; changing the mode does not change past entries.

A cleaned question keeps the intent, conditions and strength of the request, adds nothing, drops greetings, repetition and meta phrases, and is one sentence or a short paragraph in the conversation's language. Unclear parts are left as questions, not filled in.

### 6.2 Reply character limit

Applies to new non-question bodies and their revisions (not to questions, headings or notes), counted as Unicode code points. Default 3000, `0` = unlimited, set in the page or with `PATCH /api/settings`. Over the limit nothing is saved or cut; the error carries `maxResponseChars` and `length`, and the agent splits or rewrites the reply.

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

At most `maxUnseenEvents` (or `limit`) of the latest are sent; `truncated` and `unseenCount` tell when there were more. The user's pins and settings, resets and other agents' entries are all events.

### 6.4 Pins, replies, notes, outline

- One pin at a time, on a non-question entry. The pinned reply shows in the fixed area at the top.
- With Add reply on, the next non-question reply gets `replyTo`. While its parent is pinned, a reply shows only in the pinned area's reply list; unpinning returns it to the normal list.
- A note is inserted right after the first occurrence of its `anchor` in the body, or at the end. Notes render as Markdown.
- **Outline text**: one item per line, `no | title | type | status`, plus ` | current` on the current item. A title may itself contain ` | `: the first field is `no` and the last fields are `type`, `status` and `current`. `version` counts outline changes and resets.
- Agents send the whole outline once, then edit it with `old`/`new` against the text and version they read (`GET /api/outline`). To move `current`, one `old` spans both lines and those between. Other agents receive the edit as `{t:"outline", old, new}` in `sync.unseen` instead of the whole list; the full outline is in `state`.
- An outline `no` containing `-` is a sub-item; the current item is highlighted. The outline area hides when `done` or empty.

## 7. Page

- **Layout**: a sidebar (pin toggle, question mode, kind legend, outline, theme and settings) and the conversation, oldest at the top, questions on the right, replies on the left; the pinned reply sits at the top.
- **Settings panel** (gear): `Max response chars`, `Max unseen events`, `Broadcast access` with QR code, address and copy button.
- **Loading**: the first refresh fetches the state and the latest 50 entries (`last=50`). Scrolling near the top loads the 50 before the oldest loaded entry (`before=<id>`) and keeps the entry on screen in place; while the list is too short to scroll, older pages keep loading.
- **Updates**: the page listens on `/api/events`; a pushed head different from the one it has applied triggers a refresh, and it also refreshes every 30 s as a safety net, never overlapping. A refresh reads `/api/state`, asks `/api/sync?knownHead=<applied head>&limit=0` what is new, appends new entries (`after=<last id>`), refetches only entries touched by a note or revision, and reloads the latest page after a reset or an unknown head. The page's own writes do not advance the applied head.
- **Pinned reply**: loaded on its own (`/api/entries/:id` and `?replyTo=`), since it may be outside the loaded window; reloaded when the pin changes or something touches it.
- **Drawing**: each card is kept by entry ID with a version (body, heading, question mode, note and revision counts, pinned or not); only cards whose ID or version differ are added, replaced, moved or removed.
- **Scroll**: at the bottom it follows new entries; otherwise the entry on screen stays in place. The position before a reload is kept in `sessionStorage`.
- **Markdown**: all text is HTML-escaped first. Supported: paragraphs, `#` headings (drawn as `h4`–`h6`), `>` quotes, bold, italics, `<br>`, inline code, links (`http`, `https`, `mailto`, `/`, `#` only), flat lists, tables, and fenced code blocks with light highlighting for `js`/`ts`, `json`, `py`, `bash`/`sh`, `ps1`, `html`/`xml`, `css`.
- **Theme**: light and dark, following the system until the reader chooses; the choice and layout sizes are kept in `localStorage`.

## 8. Broadcast

Broadcast lets other devices on the network open and use the page. It is off by default and switched in the settings panel, or on from the start with `--broadcast`.

- `POST /api/broadcast` accepts only this computer's requests. The server rebinds (`127.0.0.1` ↔ `0.0.0.0`) on the same port without restarting, after sending the response; open connections drop and reconnect. The switch is recorded as a `broadcast` event; a failed rebind restores the previous state and records `error`.
- The address uses the first non-internal IPv4 that does not start with `169.254.`, else `127.0.0.1`. The panel shows it with a QR code (version 4-L, URL up to 78 bytes).
- No authentication or encryption: while on, anyone on the network can read and change the transcript. The Windows firewall may ask about `node.exe`.

## 9. Agent integration

1. When the skill is called, start the server in the background from the project folder and give the user the address; run the same command again when you need it.
2. Start every turn by recording the user's message with `knownHead`, and read the response before answering: this write is the sync.
3. Record each reply you give the user.
4. Keep the new `sync.head`. On `behind`, continue from `sync.unseen`; on `none` or `unknown`, `sync.unseen` holds the conversation since the last reset.
5. Follow `next`. A refused write saved nothing; rewrite over-long replies, and reuse `clientRef` when retrying.

| Need | Request |
|---|---|
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
Send-Entry @{ kind = 'question'; rawBody = 'original question'; cleanedBody = 'cleaned question'; clientRef = 'turn-14-q' }
~~~

`Invoke-RestMethod` throws on `4xx`; the error body is in the exception's `ErrorDetails.Message`.

**Codex**: the same skill folder works in OpenAI Codex (`$ineedbetterui`; skills in `.agents/skills/` or `~/.agents/skills/`). The records folder is inside the working directory, so the `workspace-write` sandbox can write it; if writes are blocked, the user starts the server from a normal terminal. Checked on 2026-09-14 with Codex CLI 0.154.0 on Windows; a real Codex session since the records moved into `node_modules` has not been checked.

## 10. Tests

~~~bash
node tests/run-all.mjs
~~~

| File | Covers |
|---|---|
| `tests/sync-test.mjs` | Storage and git exclusion, session resume, hash sync, restart, moving the folder, broadcast switching, page elements |
| `tests/render-test.mjs` | Highlighting, Markdown escaping, notes, paging past 1000 entries |
| `tests/core-test.mjs` | Question mode, deduplication, character limit, pins and replies, revisions, outline, `next`, request checks, event stream, entry paging, the page without data, multi-agent sync, reset |
| `tests/cli-test.mjs` | Package contents, global install into a temporary prefix, skill registration, `stop`, `uninstall` |
| `tests/docs-test.mjs` | This document names every endpoint, query option, event type and skill file in the code |

Tests use temporary folders and never touch the real home folder or global npm. `tester/restart-ineedbetterui.ps1` restarts the repository server with `tester/` as the project; `tester/start-codex-test.ps1` prepares `tester/codex-project/` and runs Codex there.

## 11. Known limitations

| Area | Limitation |
|---|---|
| Highlighting | A light regex tokenizer: regex literals, triple-quoted strings, heredocs and TypeScript types are not coloured correctly |
| Markdown | No nested lists or images; HTML tags other than `<br>` show as text |
| Old entries | Loaded 50 at a time while scrolling up; no jump to an entry |
| Reading position | After a reload, restored by entry only if it is among the latest 50 |
| Revisions | A full `body` is not checked for being a fragment; questions can be revised |
| `clientRef` | A `clientRef` from before a reset returns the old entry |
| Memory | The server keeps the whole transcript and its bytes in memory |
| Hand edits | A changed line shows only as `unknown` heads, without saying which line |
| Old records | Records under older names or locations are not migrated |
| Non-JS projects | Recording creates a `node_modules` folder |
| Simultaneous starts | Two starts at the same moment can run two servers on one transcript |
| Stopping | Without npm, stop the process yourself; on Windows `stop` kills it |
| Broadcast | No authentication; open connections drop when switching; the first IPv4 may be a VPN or virtual adapter; copying the address fails over plain `http` |
| Moving folders | Protected only on Windows |
| npm | Where install scripts do not run, run `ineedbetterui install`; pnpm and Bun unchecked; only Node 24 and Windows fully checked |
