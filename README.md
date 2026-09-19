# I Need Better UI

Read your conversations with AI coding agents in a better UI.

I Need Better UI (`ineedbetterui`) is a skill for **Codex** and **Claude Code**. While you work, the agent records your questions and its answers into a local transcript, and a local web page shows them with an outline, pinned answers, notes and syntax-highlighted code.

- Everything stays on your machine. No accounts, no cloud, no dependencies.
- One transcript per project folder, kept in `node_modules/.ineedbetterui` so git ignores it.
- The agent only receives the events it has not seen yet, so the transcript does not fill its context window.

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

## Use

1. Open your project folder in your agent.
2. Call the skill. The skill name alone is enough; you can also put a question after it.
   - Codex CLI: `$ineedbetterui`
   - Codex desktop app: type `@`, choose **ineedbetterui** and send
   - Claude Code: `/ineedbetterui`
3. The agent starts the server right away (or reuses the running one) and gives you a URL such as `http://127.0.0.1:52341/`. Open it in your browser. If you added a question, it answers it and records both.
4. Keep talking as usual. Questions and answers appear on the page as soon as the agent records them.

Things you can ask the agent:

- "Pin that answer."
- "Add a note to the pinned answer explaining the word *estimate*."
- "Make an outline for this task and keep it updated."

Things you can do on the page:

- Pin or unpin an answer.
- Choose whether questions are recorded as written or as a short AI-cleaned version.
- Limit the length of recorded answers.
- Switch between light and dark themes.

Start a new agent session? Call the skill again. The same project folder continues the same transcript.

## Commands

Run these in a terminal, from the project folder where it matters.

| Command | What it does |
|---|---|
| `ineedbetterui` | Start the server for the project in the current folder, or print the URL of the one already running |
| `ineedbetterui --broadcast` | Same, but start with network access already on |
| `ineedbetterui stop` | Stop the server for the project in the current folder |
| `ineedbetterui install` | Register the skill |
| `ineedbetterui uninstall` | Remove the skill (transcripts stay in each project) |
| `ineedbetterui --version` | Print the version |

## Where transcripts are stored

Each project keeps its transcript in `node_modules/.ineedbetterui/` inside the project folder. That folder contains a `.gitignore` with `*`, so git ignores it even in projects without a `node_modules` rule.

Deleting or recreating `node_modules` (for example `npm ci`) also deletes the transcript.

## Network access

By default the page is only reachable from this computer. To open it on your phone or another device, expand the sidebar, open **Settings** (the gear next to the theme button) and turn on **Broadcast access**. The panel then shows a QR code, the address and a copy button.

Switching it rebinds the running server, so the port, the transcript and any open page stay as they are. **While it is on there is no authentication**: anyone on the same network can read and change the transcript. Only this computer can turn it on or off, and `ineedbetterui --broadcast` starts with it already on.

## Update

```bash
npm update -g ineedbetterui
```

The install script registers the new skill files again. If it did not run, use `ineedbetterui install`.

## Uninstall

npm does not run uninstall scripts, so remove the skill first:

```bash
ineedbetterui uninstall            # transcripts stay in each project
npm uninstall -g ineedbetterui
```

`uninstall` removes only folders it installed.

## License

[MIT](LICENSE)
