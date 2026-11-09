# cmd-mod-herdr-status

A Command Code mod that reports the agent's state to [Herdr](https://herdr.dev) so the terminal
tab or pane can show what Command Code is doing — idle, working, blocked on you, done, or
errored.

It emits Herdr's OSC `7501` status sequence on the controlling terminal (`/dev/tty`):

```
ESC ] 7501 ; state=working:app=command-code:title=<base64>:msg=<base64> ESC \
```

Nothing is printed when the process has no controlling terminal, so headless and piped runs are
unaffected. The mod also stays completely inert unless Herdr sets `HC_TERMINAL_ID`.

## States

| State | When |
| --- | --- |
| `idle` | Session start, after an interrupt, or after a denied permission |
| `working` | An agent run is in flight (`run_start` through `run_end`) |
| `blocked` | A permission prompt is pending, or the `ask_user_question` tool is waiting |
| `done` | The run ended normally |
| `error` | The run ended with a stop reason of `error`, or `run_error` fired |
| `clear` | Session end — Herdr drops the status |

Each update carries the session title when one is known (from `cmd.getSessionName()` at session
start, then refreshed by `session_titled`), plus a short message for `blocked` and `error`.
Text is stripped of control characters and capped at 2000 characters before base64 encoding.

## Requirements

- Herdr, with `HC_TERMINAL_ID` exported in the environment.
- No npm dependencies.

## Install

This mod lives in the [`commandcode-mods`](../) repo as `herdr-status/`.

```bash
# install the whole mods repo (herdr-status + claude-agent)
cmd mods add /Users/armedi.armedi/repos/github.com/armedi/commandcode-mods

# or install just this mod
cmd mods add /Users/armedi.armedi/repos/github.com/armedi/commandcode-mods/herdr-status

# or try it without installing
cmd --mod /Users/armedi.armedi/repos/github.com/armedi/commandcode-mods/herdr-status/herdr-status.ts
```

Changes apply on the next session or after `/reload`.

## How it works

The factory registers nothing that changes agent behavior:

- `cmd.hooks({onSessionStart, onSessionEnd, onPermissionRequest, beforeToolCall})` publishes
  `idle`/`clear`, reports `blocked` while a permission prompt is open, and reports `blocked`
  when `ask_user_question` runs. It always returns `undefined`, so no prompting is answered.
- `cmd.on(...)` observes `run_start`, `tool_running`, `tool_completed`, `tool_errored`,
  `interrupted`, `run_end`, `run_error`, and `session_titled` to keep the state current.

## Customizing

`APP` sets the `app=` field (`command-code` by default). Everything else is derived from the
session and run events, so there are no flags or environment variables beyond
`HC_TERMINAL_ID`.
