# I Need Better UI

Read your conversations with AI coding agents in a better UI.

I Need Better UI (`ineedbetterui`) is a skill for **Codex** and **Claude Code**. While you work, the agent records your questions and its answers into a local transcript, and a local web page shows them with an outline, a pinned answer you can keep refining, and syntax-highlighted code.

![The conversation, with a pinned answer at the top and the collapsed sidebar on the left](https://raw.githubusercontent.com/JaceDashS/ineedbetterui/main/docs/images/overview.png)

- Everything stays on your machine. No accounts, no cloud, no dependencies.
- One transcript per project folder, kept in `node_modules/.ineedbetterui` so git ignores it.
- The agent only receives the events it has not seen yet, so the transcript does not fill its context window.

## Contents

1. [Requirements](#requirements)
2. [Install](#install)
3. [Start recording](#start-recording)
4. [Reading the page](#reading-the-page)
5. [Working with the agent](#working-with-the-agent)
6. [Settings](#settings)
7. [Network access](#network-access)
8. [Where transcripts are stored](#where-transcripts-are-stored)
9. [Commands](#commands)
10. [Update and uninstall](#update-and-uninstall)
11. [Troubleshooting](#troubleshooting)

## Requirements

- Node.js 24 or later (tested on Node.js 24 on Windows 11)
- Codex (CLI or desktop app) and/or Claude Code

## Install

```bash
npm install -g ineedbetterui
```

A global install registers the skill for both agents:

| Agent | Skill folder |
|---|---|
| Codex | `~/.agents/skills/ineedbetterui/` |
| Claude Code | `~/.claude/skills/ineedbetterui/` |

If your package manager skips install scripts (for example `--ignore-scripts`, pnpm or Bun), run this once:

```bash
ineedbetterui install
```

## Start recording

1. Open your project folder in your agent.
2. Call the skill. The skill name alone is enough; you can also put a question after it.
   - Codex CLI: `$ineedbetterui`
   - Codex desktop app: type `@`, choose **ineedbetterui** and send
   - Claude Code: `/ineedbetterui`
3. The agent starts the server (or reuses the one already running) and gives you a URL such as `http://127.0.0.1:52341/`. Open it in your browser.
4. Keep talking as usual. Questions and answers appear on the page as soon as the agent records them.

Calling the skill again in a later session continues the same transcript, as long as you are in the same project folder.

## Reading the page

### The conversation

Your messages sit on the right, the agent's answers on the left. Every answer is Markdown: headings, lists, tables and code blocks are rendered, and code is highlighted.

The coloured bar down the left of each card says what kind of entry it is, and the sidebar spells the colours out:

| Colour | Kind | Meaning |
|---|---|---|
| grey | Question | your message |
| blue | Report | progress or an explanation |
| amber | Decision | the agent is waiting for your choice |
| red | Error | a failure or a blocked step |
| green | Done | completed work |
| purple | Other | anything else |

### The sidebar

The sidebar is a narrow rail that opens over the conversation when you click the menu button. It holds the entry colours and the outline.

![The open sidebar, with the entry colours and the outline](https://raw.githubusercontent.com/JaceDashS/ineedbetterui/main/docs/images/outline.png)

The **outline** is the agent's plan for the work in front of it. Each step is `Pending`, `Active` or `Done`: a finished step is struck through, and the step being worked on is in the accent colour. Click a step to jump to the first answer recorded under it, and every answer carries a badge naming its step, so you always know which part of the plan you are reading.

Only you can clear the outline, with the **×** beside its heading. The agent adds to it and moves steps along, but never takes it away.

### The pinned answer

Pin any answer and it stays at the top of the page while you scroll. It is meant for the one thing you keep coming back to: a summary, a list of decisions, a draft.

With **Add reply** turned on, the agent's next answer *edits the pinned document* instead of adding a new message below it. The conversation then shows only what changed, while the pinned area shows the whole document. Ask for the change in words — "add a line about the sampler" — and the agent applies it.

While the agent is answering, the pin controls are locked so the document cannot move under it.

## Working with the agent

Things worth asking for:

- "Pin that answer."
- (With **Add reply** on) "Add a line explaining the word *estimate*." The agent edits the pinned answer, and the page shows what changed.
- "Make an outline for this task and keep it updated."
- "Who is answering?" — each agent gets a name like `claude-otter`, shown on what it wrote whenever more than one agent shares the transcript.

### While it works

A turn is one message from you and the one answer to it. While a turn is open, the page shows a spinner and the line the agent last said it was on:

![A turn in progress: what the agent is doing, and the Cancel turn button](https://raw.githubusercontent.com/JaceDashS/ineedbetterui/main/docs/images/working.png)

That line is shown, never recorded — it is gone the moment the answer arrives.

If the agent stops without answering, **Cancel turn** ends the turn: the question stays in the transcript, marked as cancelled, and the agent is told the answer is no longer wanted. A turn whose agent has gone quiet for more than ten minutes says so in the same place.

## Settings

The gear at the foot of the open sidebar.

![The settings panel](https://raw.githubusercontent.com/JaceDashS/ineedbetterui/main/docs/images/settings.png)

| Setting | What it does |
|---|---|
| **Use AI-cleaned questions** | Checked records the agent's concise wording of your message; unchecked records your words as you typed them. The transcript always keeps both. |
| **Text size** | Scales the conversation text, in this browser only. |
| **Max response chars** | Length limit for a recorded answer; `0` removes it. An answer that does not fit is written shorter, never cut off. |
| **Max unseen events** | How many events an agent is given per sync; `0` sends everything. |
| **Broadcast access** | Lets other devices on your network open the page ([below](#network-access)). |
| **Reset conversation** | Starts an empty conversation. The transcript file keeps every line. |

Changes are held until you act on them: **Cancel** discards them, **Apply** keeps the panel open, **Save** applies them and closes it.

### Dark mode

The button at the foot of the sidebar switches the theme, and until you touch it the page follows your system setting.

![The same conversation in dark mode](https://raw.githubusercontent.com/JaceDashS/ineedbetterui/main/docs/images/dark.png)

## Network access

By default the page is reachable only from this computer. To open it on your phone or another device, open **Settings** and turn on **Broadcast access**. The panel then shows a QR code, the address and a copy button. The address carries an access token: other devices need it, this computer does not, and it changes whenever the server restarts.

Switching it rebinds the running server, so the port, the transcript and any open page stay as they are. **The access token is the only thing standing in the way**: anyone on the same network who gets the address or the QR code can read and change the transcript. Only this computer can turn it on or off. It turns off when the server restarts; `ineedbetterui --broadcast` starts with it already on.

## Where transcripts are stored

Each project keeps its transcript in `node_modules/.ineedbetterui/` inside the project folder. That folder contains a `.gitignore` with `*`, so git ignores it even in projects without a `node_modules` rule.

Deleting or recreating `node_modules` (for example `npm ci`) also deletes the transcript.

## Commands

Run these in a terminal, from the project folder where it matters.

| Command | What it does |
|---|---|
| `ineedbetterui` | Start the server for the project in the current folder, or print the URL of the one already running |
| `ineedbetterui --broadcast` | Same, but start with network access already on |
| `ineedbetterui stop` | Stop the server for the project in the current folder |
| `ineedbetterui status` | What is being recorded here: the server, the agents connected to it and the last entries. An agent that loses track of the conversation uses it to find its place again |
| `ineedbetterui register`, `record`, `progress` | What the agent uses to write to the transcript; you do not need them |
| `ineedbetterui install` | Register the skill |
| `ineedbetterui uninstall` | Remove the skill (transcripts stay in each project) |
| `ineedbetterui --version` | Print the version |

## Update and uninstall

```bash
npm update -g ineedbetterui
```

The install script registers the new skill files again. If it did not run, use `ineedbetterui install`.

npm does not run uninstall scripts, so remove the skill before the package:

```bash
ineedbetterui uninstall            # transcripts stay in each project
npm uninstall -g ineedbetterui
```

`uninstall` removes only folders it installed.

## Troubleshooting

**The agent does not know the skill.** The install script was probably skipped. Run `ineedbetterui install`, then start a new agent session.

**The page is empty.** Nothing appears until the agent records it. Ask it to record the conversation; if it says it cannot, run `ineedbetterui status` in the project folder to see whether the server is running.

**The agent stopped recording halfway.** Its context was probably compacted. Ask it to run `ineedbetterui status`: that gives back its name, its place in the conversation and the rules, and it can carry on. Turns that were never recorded stay missing, and the page marks the gap.

**A question has no answer under it.** The agent is still working, or it stopped. The page says which: a spinner while the turn is open, and a line about the agent having gone quiet once ten minutes pass without a word. **Cancel turn** ends it.

**The transcript disappeared.** Something deleted `node_modules` — `npm ci` does. Transcripts live inside it, so they go with it.

**Windows asks about the firewall.** Only when broadcast is on, because the server then listens on the network. Answering "no" keeps it local, which is the default.

## License

[MIT](LICENSE)
