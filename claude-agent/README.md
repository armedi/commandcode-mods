# cmd-mod-claude-agent

A Command Code mod that registers a **Claude Agent** provider. It runs Claude models through
the official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) on your local
`claude auth login` credentials — subscription, API key, or cloud account — instead of an
Anthropic API key wired into `providers.json`.

This is the supported path: the Agent SDK is what Anthropic publishes for programmatic agents.
No OAuth tokens are reused, no headers are spoofed, no billing headers are forged.

## How it works

Command Code providers expose a `transport` seam. The built-in Copilot and ChatGPT providers
implement `{kind: 'aisdk', buildModel}`; this mod does the same, but the model it builds is a
`LanguageModelV3` adapter around `@anthropic-ai/claude-agent-sdk`.

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

Nothing re-implements Command Code's tool execution, and nothing re-implements Anthropic's API.

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

Pick a model in `/model` under the **Claude Agent** heading, or:

```bash
cmd --model claude-agent/claude-sonnet-5-5
```

## Model ids

The catalog lists ids that exist both in Command Code's built-in catalog (required for
`--model` resolution) and on your Claude account. Newest models are exposed by the CLI only as
aliases, so they are mapped before they reach the SDK:

| Command Code id | Claude Code id |
| --- | --- |
| `claude-sonnet-5-5` | `sonnet` |
| `claude-opus-5-5` | `opus` |
| `claude-haiku-5-5` | `haiku` |
| `claude-haiku-4-5-20251001` | same |

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

- **Model resolution** only accepts ids present in the built-in catalog. Aliases that Command
  Code reserves (`sonnet`, `opus`, `haiku`) cannot be declared directly.
- **Replay is capped** at roughly 400k characters of rendered transcript; anything beyond is
  truncated with a marker. A replay also forfeits prompt cache and any cached thinking
  signatures.
- **Side tasks spawn a process.** Titling, compaction, and one-shot helper calls each start a
  `claude` subprocess. They are closed as soon as the turn ends, but the spawn cost is real;
  pin them to a built-in model in `/config` if it matters.
- Sessions are closed after 2 hours idle, or when Command Code exits.
- Token usage is reported; dollar cost is not, because the subscription has no per-token price.
