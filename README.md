# Claude Code Pro

> A multi-workspace desktop client for [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview) — gives you a file tree and parallel project workspaces on top of the terminal you already love.

## Why

[Claude Code](https://docs.claude.com/en/docs/claude-code/overview) is an incredible CLI agent, but two things slow me down when I use it:

1. **No file tree.** I switch to Finder or VS Code just to see what's in the project. I want a project explorer next to the agent.
2. **One terminal = one project.** If I want Claude working on two projects in parallel, I'm juggling iTerm tabs and `cd`-ing manually. There's no first-class concept of "workspace".

Claude Code Pro fixes both. It's a thin Electron wrapper around the `claude` CLI:

- **File tree sidebar** — browse your project, click to open files in Monaco editor, right-click for common operations.
- **Multi-tab workspaces** — every tab is a Claude Code session in its own folder. Switch tabs, the file tree switches with it. Run multiple projects in parallel without context-switching.
- **Drag-and-drop paths** — drag any file (from the tree or Finder) into the terminal to insert its absolute path. Great for `@`-referencing files in Claude Code.
- **Auto-launches `claude`** — every new terminal opens with Claude Code already running.

## Features

| | |
|---|---|
| File tree | Browse, open in editor, right-click menu (rename, delete, copy path, reveal in Finder) |
| Multi-tab terminals | Each tab is an independent workspace with its own working directory |
| Auto-launch Claude | New terminals automatically start `claude` |
| Drag-and-drop | Drag files into the terminal to insert absolute paths (escapes spaces / unicode) |
| Monaco editor | Full VS Code editor for in-app file editing, multi-tab |
| Shift+Enter | Newline in Claude Code input (no need to remember Option+Enter) |
| Web links | Cmd+Click URLs in terminal opens system default browser |
| Debug console | Built-in panel for runtime diagnostics |

## Requirements

- macOS (Linux/Windows likely work but untested)
- [Node.js](https://nodejs.org/) 20+
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/setup) installed and authenticated (`claude` should be on your `PATH`)

## Run from source

```bash
git clone https://github.com/leverageaiapp/claude-code-pro.git
cd claude-code-pro
npm install
npx electron-rebuild -f -w node-pty   # rebuild native module for Electron
npm run dev
```

The Electron window opens, prompts you to pick a folder, and you're in.

## Build

```bash
npm run build
```

Outputs to `dist/` and `dist-electron/`. To package as a `.dmg`, install [`electron-builder`](https://www.electron.build/) and add a `build` config to `package.json` — see their docs.

## Tech stack

- **Electron** — desktop shell
- **React 19 + Vite** — renderer
- **TypeScript + Tailwind CSS** — typing & styling
- **Zustand** — state management
- **Monaco Editor** — code editor (the same one VS Code uses)
- **xterm.js + node-pty** — terminal emulator + PTY backend
- **Claude Code CLI** — the actual AI agent (we don't replace it, just wrap it)

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Electron Main                                        │
│  ├─ PTY processes (one per terminal tab)              │
│  ├─ File system IPC                                   │
│  └─ Window / dialog handlers                          │
└────────────────────────┬─────────────────────────────┘
                         │ IPC
┌────────────────────────┴─────────────────────────────┐
│  Renderer (React)                                     │
│  ├─ FileTree (sidebar, per-tab cwd)                   │
│  ├─ Tab Bar (terminal + editor tabs)                  │
│  ├─ Monaco Editor (per editor tab)                    │
│  └─ xterm Terminal (per terminal tab)                 │
└──────────────────────────────────────────────────────┘
```

Each terminal tab spawns its own `node-pty` process with a working directory, and inside that PTY runs `claude`. State per tab is preserved across tab switches.

## Contributing

PRs welcome. The codebase is small and approachable:

- `electron/main.ts` — IPC handlers, PTY lifecycle
- `electron/preload.ts` — context-isolated API bridge
- `src/components/` — UI components
- `src/stores/` — Zustand stores

## License

[MIT](./LICENSE)

## Acknowledgments

Inspired by [openclaude](https://github.com/komako-workshop/openclaude) and built around the excellent [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview).
