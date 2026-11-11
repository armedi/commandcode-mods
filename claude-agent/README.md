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

1. Runs each conversation in a long-lived Agent SDK session, with the harness's system
   prompt, no built-in Claude Code tools (`tools: []`), no settings sources, no CLAUDE.md, and
   `verbatimPrompts: true` so Claude Code adds none of its own per-turn context (skill lists,
   reminders, nested memory files). The host passes no thread id, so a request finds its
   session by transcript (see 6).
2. Publishes the harness's tools to the SDK as an in-process MCP server, so the model sees
   exactly the tools Command Code offered — with their raw JSON schemas, without a zod
   conversion or tool-argument validation. Command Code owns argument validation; MCP still
   checks its protocol envelopes (see the schema boundary below).
3. Streams text, thinking, and tool calls back as AI SDK stream parts.
4. Suspends at a tool call: the MCP handler blocks on a promise. Command Code executes the tool
   in its own loop (permissions, diffs, plan mode, MCP/mod tools all intact), sends the result
   on the next request, and the handler resolves with it, so the SDK continues its turn.
5. Forwards token usage from the Anthropic stream events of each API response.
6. Treats the host transcript as the source of truth. Each request's user messages (including
   image and file data), tool results (id, success or error, content), and assistant messages
   are fingerprinted. A session records the transcript it holds, including the tool-call ids
   and text it produced itself. A request continues the live session whose record is the
   unique longest prefix of its transcript, and only the new user messages are sent, merged
   into one SDK message. If no session matches, or two match equally, a new session starts:
   with no history it gets the user messages as they are, otherwise the whole visible
   transcript is replayed as **one** message (user images stay images), matching OpenCode's
   Claude Agent provider. An edited turn, a compaction, or a model switch therefore costs one
   replay; the session that no longer matches is reaped later.

Reliability rules layered on top:

- **Session signature.** Only the system prompt is hashed into the signature (matching also
  requires the same model and a continuing transcript). A system-prompt change still starts
  a new session and replays; a changed tool list does not.
- **Live tool catalog.** Names, descriptions, and schemas update on the connected MCP server,
  including while a tool call is suspended. Before delivering any tool result or submitting
  input, the request takes the session lease, sends `notifications/tools/list_changed`, waits
  for a new `tools/list`, and checks that `mcpServerStatus()` reports the committed names.
  For same-name changes, it first commits an empty advertised list, then the new list, since
  status does not expose schemas. Neither phase releases suspended calls. A refresh that
  cannot be confirmed within `CLAUDE_AGENT_MOD_TOOL_LIST_TIMEOUT_MS` fails the request and
  closes the session rather than using stale tools; a retry then replays normally. The server
  instance is never replaced or disconnected for an update. New calls to unavailable tools
  return an MCP `InvalidParams` protocol error, not a tool-execution `isError` result; already
  issued calls may finish even if their tool was removed before its handler arrived.
- **One request per session.** A request holds its session exclusively until its API response
  ends. A tool-result request continues the same SDK turn; a session is matched for a new turn
  only after the previous turn's `result` has arrived.
- **Side requests stay apart.** Unmatched tool-free calls (titles, summaries, helpers) and
  `/btw` side questions get their own session, which closes as soon as their stream ends.
  A continuing conversation may remove its last tool and still keep its live session.
- **Esc keeps the session.** An aborted request interrupts the SDK turn, answers suspended tool
  calls with an error, and drains the interrupted turn; the next turn continues the same
  session without a replay. If the interrupt fails or the turn does not end within 10 s, the
  session is closed instead.
- **Tool-call deadline.** A suspended tool call that never gets a result resolves with an error
  after `CLAUDE_AGENT_MOD_TOOL_TIMEOUT_MS` (default 10 min) and the session is closed, so a dead
  harness turn can never wedge later requests.
- **Call matching by arguments.** Parallel calls of the same tool are bound to their tool_use id
  by exact JSON argument equality (ignoring object-key order), never by same-name arrival
  order. Handlers wait for their matching streamed call; identical-argument calls are
  interchangeable. Aborts and the tool-call deadline release both id and result waiters.
- **Cleanup.** Idle sessions are swept every few minutes, at most
  `CLAUDE_AGENT_MOD_MAX_SESSIONS` sessions are kept (least recently used idle ones close
  first; the cap is exceeded rather than closing a session in use), and `session_shutdown`,
  mod reload, and process exit dispose of every subprocess. Session state lives on
  `globalThis`, so a hot reload does not orphan them.
- **Content passthrough.** Image blocks in tool results and image file parts (base64 or URL) in
  user messages reach the model instead of being flattened to text. Text-like attachments
  (`text/*`, JSON, XML, ...) are sent as text; other files become a note naming them.
- **Visible failures.** An SDK failure or an API error ends the request's stream with an error
  instead of a normal finish.

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
| `CLAUDE_AGENT_MOD_TOOL_LIST_TIMEOUT_MS` | `10000` | Deadline per tool-list refresh phase |
| `CLAUDE_AGENT_MOD_IDLE_MS` | `7200000` | Idle time before a session is closed |
| `CLAUDE_AGENT_MOD_MAX_SESSIONS` | `6` | Soft cap on live sessions |

Requests carrying `temperature`, `topP`, `topK`, `stopSequences`, penalties, or
`maxOutputTokens` are accepted but reported through AI SDK warnings — the Agent SDK has no
per-request way to apply them.

## Known limitations

- **MCP schema boundary.** Object-root schemas are published verbatim, except that this MCP
  SDK requires direct `properties` values to be objects: boolean property schemas become
  `{ "allOf": [true] }` or `{ "allOf": [false] }`. A missing, union, or non-object root
  `type` is set to `"object"`, retaining other keywords; root `true`/absent schemas become
  `{ "type": "object" }`, and root `false` becomes `{ "type": "object", "not": {} }`.
  Scalar/array tool inputs therefore cannot be represented faithfully. Arguments must be
  MCP objects (omitted arguments mean `{}`); they are never coerced, stripped, or unwrapped,
  and the adapter never validates them against the tool schema. MCP still validates call
  envelopes and result content blocks.
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
- **Replay is capped** at roughly 400k characters of rendered transcript. The latest user
  request is always kept whole; the oldest middle of the conversation is dropped, with a
  marker. A replay also forfeits prompt cache and any cached thinking signatures.
- **Side tasks that use this provider spawn a process.** A feature model pinned to
  `claude-agent/...` (titling, compaction, one-shot helpers) starts a `claude` subprocess per
  call. It closes when the turn ends, but the spawn cost is real; pin those features to a
  built-in model in `/config` if it matters.
- Sessions are closed after 2 hours idle, or when Command Code exits.
- Token usage is reported; dollar cost is not, because the subscription has no per-token price.
