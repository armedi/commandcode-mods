# cmd-mod-claude-agent

A Command Code mod that exposes a **Claude Agent** group in `/model`. It writes a
`claude-agent` provider entry into `providers.json` (the model list is fetched from the Claude
CLI) and intercepts that entry's requests in-process, running them through the official
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) on your local
`claude auth login` credentials — subscription, API key, or cloud account.

This is the supported path: the Agent SDK is what Anthropic publishes for programmatic agents.
No OAuth tokens are reused, no headers are spoofed, no billing headers are forged.

## How it works

Command Code only draws extra `/model` groups from `providers.json`. The mod asks the Claude
CLI for its supported models, writes the `claude-agent` entry there (with
`api: anthropic-messages` and that list), then patches the host's `@ai-sdk/anthropic` model
prototype in-process. When the declarative provider builds a model for the sentinel `baseURL`,
its `doStream`/`doGenerate` return the `LanguageModelV3` adapter below instead, so requests go
straight to the Agent SDK — no HTTP wire and no server.

The adapter:

1. Starts one long-lived Agent SDK session per Command Code thread, with the harness's system
   prompt, no built-in Claude Code tools (`tools: []`), no settings sources, no CLAUDE.md, and
   `verbatimPrompts: true` so Claude Code adds none of its own per-turn context (skill lists,
   reminders, nested memory files).
2. Publishes the harness's tools to the SDK as an in-process MCP server, so the model sees
   exactly the tools Command Code offered — with their real JSON schemas.
3. Streams text, thinking, and tool calls back as AI SDK stream parts.
4. Suspends at a tool call: the MCP handler blocks on a promise. Command Code executes the tool
   in its own loop (permissions, diffs, plan mode, MCP/mod tools all intact), sends the result
   on the next request, and the handler resolves with it, so the SDK continues its turn.
5. Forwards token usage from the Anthropic stream events.
6. Treats the host transcript as the source of truth. Each request's user turns and tool results
   are fingerprinted; if the incoming transcript continues what the session already holds, only
   the new user message is sent. If it diverges — an edited turn, a compaction, a model switch,
   a fresh process — the session restarts and the whole visible transcript is replayed as **one**
   message, matching OpenCode's Claude Agent provider.

Reliability rules layered on top:

- **Session signature.** The system prompt and the tool set (names + schemas) are part of the
  session identity. A plan-mode switch or a changed tool list restarts the session and replays,
  instead of feeding the model stale instructions.
- **Tool-call deadline.** A suspended tool call that never gets a result resolves with an error
  after `CLAUDE_AGENT_MOD_TOOL_TIMEOUT_MS` (default 10 min) and the session is closed, so a dead
  harness turn can never wedge later requests.
- **Call matching by arguments.** Parallel calls of the same tool are bound to their tool_use id
  by matching the arguments the MCP handler receives against the streamed tool-call JSON, not by
  arrival order.
- **Cleanup.** Idle sessions are swept every few minutes, anonymous one-shot sessions close at
  the end of their turn, and `session_shutdown`, mod reload, and process exit dispose of every
  subprocess. Session state lives on `globalThis`, so a hot reload does not orphan them.
- **Content passthrough.** Image blocks in tool results and image file parts (base64 or URL) in
  user messages reach the model instead of being flattened to text.

Tool execution stays in Command Code; the adapter only runs the Agent SDK and hands its
stream to the host.

## Requirements

- `claude` logged in on this machine (`claude auth status`).
- Dependencies installed once from the repo root: `npm install`.

## Install

This mod lives in the [`commandcode-mods`](../) repo as `claude-agent/`.

```bash
# install the whole mods repo (herdr-status + claude-agent)
cmd mods add /Users/armedi.armedi/repos/github.com/armedi/commandcode-mods

# or install just this mod (it uses the repo-root node_modules)
cmd mods add /Users/armedi.armedi/repos/github.com/armedi/commandcode-mods/claude-agent

# or try it without installing
cmd --mod /Users/armedi.armedi/repos/github.com/armedi/commandcode-mods/claude-agent/claude-agent.ts
```

`--mod` and `--model` are separate: `--mod` loads the provider, `--model` picks a model id.

At startup the mod registers a `claude-agent` entry in `~/.commandcode/providers.json`, which
is the only source the host reads for extra `/model` groups. The entry is **generated state**:
the model list comes from the CLI's `supportedModels()` and is cached in the mod store; the
mod rewrites `baseURL` and `models` from that list, so you never maintain it by hand. The
sentinel `baseURL` is never used for network traffic; the mod patches the host's Anthropic model
so requests go straight to the Agent SDK.

Pick a model in `/model` under **Claude Agent (byok)**, or pass one explicitly:

```bash
cmd --model claude-agent/claude-sonnet-5-5
```

The Command Code Claude rows in `/model` are the plan-gated catalog entries; the
**Claude Agent (byok)** group is this provider and is not plan-gated.

## Model ids

The list is read from the Claude CLI at startup via the Agent SDK's `supportedModels()`, then
exposed as `claude-agent/<value>`. That includes the CLI's aliases (`default`, `opus`,
`sonnet`, `fable`, `haiku`) and full model ids, so newer models appear without a mod update.
The list is cached in `~/.commandcode/mods/.store/claude-agent.json`: the first start waits
for the CLI (about 0.6s), later starts use the cache immediately and refresh it in the
background.

Set `CLAUDE_AGENT_MOD_DEBUG=1` to log session, MCP call, tool-result handoff, replay, and
timeout events to stderr. Other knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_AGENT_MOD_TOOL_TIMEOUT_MS` | `600000` | Deadline for a suspended tool call |
| `CLAUDE_AGENT_MOD_IDLE_MS` | `7200000` | Idle time before a session is closed |

Requests carrying `temperature`, `topP`, `topK`, `stopSequences`, penalties, or
`maxOutputTokens` are accepted but reported through AI SDK warnings — the Agent SDK has no
per-request way to apply them.

## Known limitations

- **`providers.json` is generated state.** The host only reads extra `/model` groups from
  `~/.commandcode/providers.json`, so the mod must write the `claude-agent` entry there. It
  preserves every other provider and rewrites `baseURL` and `models` from the CLI list; later
  starts refresh that list in the background. If you uninstall the mod, remove that entry.
- **The model list comes from the CLI.** It is fetched with `supportedModels()` and cached in
  the mod store. If the CLI cannot be queried on a first start and there is no cache, the group
  is not written; delete `~/.commandcode/mods/.store/claude-agent.json` to force a refresh.
- **The model hook is version-specific.** Routing relies on the host's public
  `@ai-sdk/anthropic` module exposing `createAnthropic` and its model prototype. The hook is
  scoped to the sentinel `baseURL` and leaves other Anthropic models untouched; a host update
  that bundles or replaces the package can break it (the mod logs a warning).
- **Replay is capped** at roughly 400k characters of rendered transcript; anything beyond is
  truncated with a marker. A replay also forfeits prompt cache and any cached thinking
  signatures.
- **Side tasks that use this provider spawn a process.** A feature model pinned to
  `claude-agent/...` (titling, compaction, one-shot helpers) starts a `claude` subprocess per
  call. It closes when the turn ends, but the spawn cost is real; pin those features to a
  built-in model in `/config` if it matters.
- Sessions are closed after 2 hours idle, or when Command Code exits.
- Token usage is reported; dollar cost is not, because the subscription has no per-token price.
