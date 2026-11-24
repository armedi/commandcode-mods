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

This mod lives in [`armedi/commandcode-mods`](https://github.com/armedi/commandcode-mods) as
`herdr-status/`.

```bash
# install the whole mods repo (herdr-status + claude-agent), for your user
cmd mods add -g armedi/commandcode-mods

# pin a branch or tag
cmd mods add -g armedi/commandcode-mods@main
```

Drop `-g` to install into the current project instead of your user settings.

### Install only this mod

`cmd mods add` takes a repo, an npm name, or a local path — not a subdirectory of a repo
(`.../commandcode-mods/herdr-status` fails to clone). Use one of these instead.

Turn the other mod off after installing the repo:

```bash
cmd mods add -g armedi/commandcode-mods
cmd mods disable claude-agent -g
```

Or load only this mod's file from the repo. There is no flag for it, so the filter goes in
`mods.sources` — `~/.commandcode/settings.json` for your user, or the project's
`.commandcode/settings.json` (project settings load once you start Command Code there):

```json
{
  "mods": {
    "sources": [
      {"source": "armedi/commandcode-mods", "mods": ["herdr-status/*.ts"]}
    ]
  }
}
```

Then install it:

```bash
cmd mods update
```

### Try it without installing

`--mod` takes a local path, not a git URL, so clone first:

```bash
git clone https://github.com/armedi/commandcode-mods.git
cd commandcode-mods
cmd --mod ./herdr-status
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
