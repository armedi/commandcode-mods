import {randomUUID} from 'node:crypto';
import {query, type EffortLevel, type Query} from '@anthropic-ai/claude-agent-sdk/core';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3Content,
	LanguageModelV3FinishReason,
	LanguageModelV3StreamPart,
	LanguageModelV3Usage,
} from '@ai-sdk/provider';
import {Queue} from './queue.ts';
import {
	chooseContinuation,
	hashText,
	isSideQuestion,
	matchRecord,
	producedEntry,
	recordEntries,
	replayContent,
	stableValue,
	transcriptEntries,
	userContentBlocks,
	type ContentBlock,
	type Entry,
	type ToolResultPart,
	type UserMessage,
} from './history.ts';
import {mergeUsage, toUsage, type RawUsage} from './usage.ts';

const MCP_SERVER = 'cmd';
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
const DEBUG = process.env.CLAUDE_AGENT_MOD_DEBUG === '1';
const IDLE_SESSION_MS = Number(process.env.CLAUDE_AGENT_MOD_IDLE_MS ?? 2 * 60 * 60 * 1000);
const TOOL_CALL_TIMEOUT_MS = Number(process.env.CLAUDE_AGENT_MOD_TOOL_TIMEOUT_MS ?? 10 * 60 * 1000);
const TOOL_LIST_TIMEOUT_MS = Number(process.env.CLAUDE_AGENT_MOD_TOOL_LIST_TIMEOUT_MS ?? 10_000);
/** How long a mid-session effort change may take before it is dropped for this request. */
const EFFORT_TIMEOUT_MS = 5000;
const MAX_SESSIONS = Math.max(1, Number(process.env.CLAUDE_AGENT_MOD_MAX_SESSIONS ?? 6) || 6);
/** How long a turn's `result` trailer may lag its last message_stop or an interrupt. */
const TRAILER_TIMEOUT_MS = 10_000;
const MAX_REINTERRUPTS = 3;
const ABORTED_TEXT = 'The request was interrupted before this tool call finished.';
const CLOSED_TEXT = 'The Claude Agent session closed before this tool call finished.';

function debug(...args: unknown[]): void {
	if (DEBUG) console.error('[claude-agent]', ...args);
}

type FunctionTool = Extract<
	NonNullable<LanguageModelV3CallOptions['tools']>[number],
	{type: 'function'}
>;

type Prompt = LanguageModelV3CallOptions['prompt'];
type ToolMessage = Extract<Prompt[number], {role: 'tool'}>;
type ToolEntry = Extract<Entry, {kind: 'tool'}>;
type UserEntry = Extract<Entry, {kind: 'user'}>;
type SdkMessage = Record<string, any>;

type CallToolResult = {
	// MCP content blocks (text/image/resource). Kept loose so both text-only results and
	// image passthrough stay assignable to the MCP server's handler type.
	content: any[];
	isError?: boolean;
};

type PendingCall = {id: string; name: string; input: string; offered: boolean};

/** The connected server never changes; each lease may replace the catalog it reads. */
type ToolCatalog = {
	server: McpServer;
	/** The host's current catalog, used for dispatch even during a refresh. */
	tools: Map<string, Tool>;
	/** The list currently advertised; briefly empty to acknowledge same-name changes. */
	published: Map<string, Tool>;
	/** Undefined until the CLI has committed the entire update (also after an abort). */
	fingerprint: string | undefined;
	refresh: {
		listed: () => void;
		fail: (error: unknown) => void;
	} | undefined;
};

/**
 * - `streaming`: a host request holds the lease and receives the open SDK turn's events.
 * - `awaiting-tools`: the SDK turn is open, suspended in MCP handlers until the host sends the
 *   tool results on its next request.
 * - `draining`: the turn's last message_stop was seen, or an interrupt was sent; its `result`
 *   trailer has not arrived yet. Events seen now are stale and dropped.
 * Only unleased `idle` and `awaiting-tools` sessions are matched against new requests.
 */
type SessionState = 'idle' | 'streaming' | 'awaiting-tools' | 'draining' | 'closed';

/** One host request's exclusive hold on a session. It receives exactly one API response. */
type Lease = {
	parts: Queue<LanguageModelV3StreamPart>;
	usage: RawUsage;
	sawUsage: boolean;
	started: boolean;
	stop: string | undefined;
	open: Map<number, 'text' | 'thinking'>;
	tools: Map<number, {id: string; name: string; json: string}>;
	text: string;
	calls: string[];
};

/** Starts when one SDK user message is submitted; ends with that turn's single `result`. */
type Turn = {
	uuid: string;
	discarded: number;
	aborting?: {receipt: boolean; startedSince: boolean; reinterrupts: number};
};

type Session = {
	id: number;
	modelId: string;
	signature: string;
	ephemeral: boolean;
	/** The effort the CLI session currently runs at; undefined is the model default. */
	effort: EffortLevel | undefined;
	state: SessionState;
	lease: Lease | undefined;
	turn: Turn | undefined;
	/** Fingerprints of the transcript this session holds, including what it produced. */
	record: Entry[];
	/** Tool calls of the open turn still waiting for a host result. */
	outstanding: Set<string>;
	/** Tool calls an interrupt answered; host results for them are accepted and dropped. */
	abortedCalls: Set<string>;
	input: Queue<Record<string, unknown>>;
	handle: Pick<Query, 'applyFlagSettings' | 'close' | 'interrupt' | 'mcpServerStatus'> | undefined;
	mcp: ToolCatalog;
	pending: Map<string, (result: CallToolResult) => void>;
	results: Map<string, CallToolResult>;
	calls: PendingCall[];
	callWaiters: Array<{name: string; args: unknown; resolve: (id: string) => void}>;
	trailerTimer: ReturnType<typeof setTimeout> | undefined;
	drainWaiters: Array<() => void>;
	lastUsed: number;
	closed: boolean;
};

type SessionRegistry = {
	version: number;
	sessions: Set<Session>;
	nextId: number;
	timer?: ReturnType<typeof setInterval>;
};

const REGISTRY_VERSION = 3;

// Kept on globalThis so a mod hot-reload re-imports this module without orphaning the
// `claude` subprocesses owned by the previous instance.
const registryHost = globalThis as typeof globalThis & {__cmdClaudeAgent?: SessionRegistry};
const registry = adoptRegistry();
const sessions = registry.sessions;

function adoptRegistry(): SessionRegistry {
	const existing = registryHost.__cmdClaudeAgent;
	if (existing?.version === REGISTRY_VERSION) return existing;
	if (existing) {
		// Sessions from a build with another shape cannot be driven by this code; close them.
		if (existing.timer) clearInterval(existing.timer);
		const previous = (existing as {sessions?: {values(): Iterable<unknown>}}).sessions;
		for (const session of previous?.values() ?? []) {
			try {
				(session as {handle?: {close(): void}}).handle?.close();
			} catch {}
		}
	}
	return (registryHost.__cmdClaudeAgent = {version: REGISTRY_VERSION, sessions: new Set(), nextId: 1});
}

function sweepIdleSessions(): void {
	const now = Date.now();
	for (const session of [...sessions]) {
		if (session.lease) continue;
		if (now - session.lastUsed > IDLE_SESSION_MS) closeSession(session, 'idle timeout');
	}
}

if (registry.timer) clearInterval(registry.timer);
registry.timer = setInterval(sweepIdleSessions, Math.min(5 * 60_000, Math.max(30_000, IDLE_SESSION_MS / 4)));
registry.timer.unref?.();

export function disposeAllSessions(): void {
	for (const session of [...sessions]) closeSession(session, 'disposed');
	sessions.clear();
}

function isFunctionTool(tool: NonNullable<LanguageModelV3CallOptions['tools']>[number]): tool is FunctionTool {
	return tool.type === 'function';
}

function systemText(prompt: Prompt): string | undefined {
	const parts = prompt.filter(message => message.role === 'system').map(message => message.content);
	const text = parts.join('\n\n').trim();
	return text || undefined;
}

function sessionSignature(system: string | undefined): string {
	return hashText(system ?? '');
}

/**
 * MCP requires an object root, and this SDK's tools/list envelope requires object-valued
 * property schemas. Otherwise retain the host schema verbatim, without compiling it.
 * Normalization changes only those envelope constraints; arguments are never unwrapped.
 */
function mcpInputSchema(schema: FunctionTool['inputSchema']): Tool['inputSchema'] {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
		return schema === false ? {type: 'object', not: {}} : {type: 'object'};
	}
	const properties = schema.properties;
	const booleanProperties = properties && Object.values(properties).some(value => typeof value === 'boolean');
	if (schema.type === 'object' && !booleanProperties) return schema as Tool['inputSchema'];
	return {
		...schema,
		type: 'object',
		...(booleanProperties ? {
			properties: Object.fromEntries(Object.entries(properties).map(([name, value]) => [
				name, typeof value === 'boolean' ? {allOf: [value]} : value,
			])),
		} : {}),
	} as Tool['inputSchema'];
}

function toolMap(tools: FunctionTool[]): Map<string, Tool> {
	return new Map(tools.map(tool => [tool.name, {
		name: tool.name,
		description: tool.description,
		inputSchema: mcpInputSchema(tool.inputSchema),
	}]));
}

function toolFingerprint(tools: Map<string, Tool>): string {
	return stableValue([...tools.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

function errorResult(text: string): CallToolResult {
	return {content: [{type: 'text', text}], isError: true};
}

function toCallToolResult(output: ToolResultPart['output']): CallToolResult {
	switch (output.type) {
		case 'text':
			return {content: [{type: 'text', text: output.value}]};
		case 'json':
			return {content: [{type: 'text', text: JSON.stringify(output.value)}]};
		case 'error-text':
			return {content: [{type: 'text', text: output.value}], isError: true};
		case 'error-json':
			return {content: [{type: 'text', text: JSON.stringify(output.value)}], isError: true};
		case 'execution-denied':
			return {content: [{type: 'text', text: output.reason ?? 'Tool call denied by the host.'}], isError: true};
		case 'content': {
			return {content: (output.value as Array<Record<string, unknown>>).map(blockToMcp)};
		}
		default:
			return {content: [{type: 'text', text: String((output as {value?: unknown}).value ?? '')}]};
	}
}

function blockToMcp(block: Record<string, unknown>): Record<string, unknown> {
	if (block.type === 'text') return {type: 'text', text: String(block.text ?? '')};
	if (block.type === 'file-data' || block.type === 'image-data') {
		const mediaType = String(block.mediaType ?? 'application/octet-stream');
		if (mediaType.startsWith('image/')) {
			return {type: 'image', data: String(block.data ?? ''), mimeType: mediaType};
		}
		const name = block.filename ? String(block.filename) : mediaType;
		return {type: 'text', text: `[${name} attached as base64 ${mediaType}, ${String(block.data ?? '').length} chars]`};
	}
	return {type: 'text', text: `[${String(block.type ?? 'unknown')} content omitted]`};
}

/** An SDK (Messages API) content block as an MCP tool-result block. */
function sdkBlockToMcp(block: ContentBlock): Record<string, unknown> {
	if (block.type === 'image') {
		const source = block.source as {type?: string; data?: string; media_type?: string; url?: string};
		if (source?.type === 'base64') return {type: 'image', data: source.data ?? '', mimeType: source.media_type};
		return {type: 'text', text: `[image: ${String(source?.url ?? '')}]`};
	}
	return {type: 'text', text: String(block.text ?? '')};
}

function sameArguments(callInput: string, args: unknown): boolean {
	let parsed: unknown;
	try {
		parsed = callInput.trim() ? JSON.parse(callInput) : {};
	} catch {
		return false;
	}
	return stableValue(parsed) === stableValue(args);
}

function takeCallId(session: Session, name: string, args: unknown, deadline: number): Promise<string> {
	const index = session.calls.findIndex(call => call.name === name && sameArguments(call.input, args));
	if (index >= 0) return Promise.resolve(session.calls.splice(index, 1)[0]!.id);
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			debug('tool call id timed out', name);
			closeSession(session, 'tool call id timed out');
		}, Math.max(0, deadline - Date.now()));
		timer.unref?.();
		session.callWaiters.push({name, args, resolve: id => {
			clearTimeout(timer);
			resolve(id);
		}});
	});
}

function registerCall(session: Session, call: PendingCall): void {
	debug('tool call', call.id, call.name);
	const index = session.callWaiters.findIndex(
		entry => entry.name === call.name && sameArguments(call.input, entry.args),
	);
	if (index >= 0) {
		const [waiter] = session.callWaiters.splice(index, 1);
		waiter!.resolve(call.id);
		return;
	}
	session.calls.push(call);
}

function awaitToolResult(session: Session, id: string, toolName: string, deadline: number): Promise<CallToolResult> {
	const buffered = session.results.get(id);
	if (buffered) {
		session.results.delete(id);
		return Promise.resolve(buffered);
	}
	return new Promise<CallToolResult>(resolve => {
		const timer = setTimeout(() => {
			if (!session.pending.delete(id)) return;
			debug('tool call timed out', toolName, id);
			resolve(errorResult(`No tool result arrived within ${TOOL_CALL_TIMEOUT_MS}ms. Treat this call as failed and continue without it.`));
			// A turn nobody is driving anymore must not keep running in the background:
			// the next request replays the host transcript into a fresh session instead.
			closeSession(session, 'tool call timed out');
		}, Math.max(0, deadline - Date.now()));
		timer.unref?.();
		session.pending.set(id, result => {
			clearTimeout(timer);
			resolve(result);
		});
	});
}

/** Releases every MCP handler still waiting, for a call id or for its result. */
function releaseToolWaiters(session: Session, text: string): void {
	for (const resolve of session.pending.values()) resolve(errorResult(text));
	session.pending.clear();
	for (const waiter of session.callWaiters.splice(0)) waiter.resolve('');
	session.calls = [];
	session.results.clear();
}

function buildMcpServer(session: Session) {
	const {server} = session.mcp;
	server.server.registerCapabilities({tools: {listChanged: true}});
	server.server.setRequestHandler(ListToolsRequestSchema, () => {
		const catalog = session.mcp;
		const tools = [...catalog.published.values()];
		debug('mcp tools/list', `#${session.id}`, JSON.stringify(tools));
		catalog.refresh?.listed();
		return {tools};
	});
	// The low-level Server validates only the MCP envelope/result, never tool arguments.
	server.server.setRequestHandler(CallToolRequestSchema, async request => {
		const {name, arguments: args = {}} = request.params;
		// A handler can arrive after the host has already returned an issued call's result
		// and removed its tool. Such a call may finish; a new unknown call must fail now.
		const issued = session.calls.some(call => call.offered && call.name === name && sameArguments(call.input, args));
		if (!session.mcp.tools.has(name) && !issued) {
			debug('unknown mcp tool', `#${session.id}`, name);
			// Finding a tool is a protocol failure, not a host tool-execution isError result.
			throw new McpError(ErrorCode.InvalidParams, `Tool ${name} is not available.`);
		}
		if (session.closed) return errorResult(CLOSED_TEXT);
		if (session.turn?.aborting) return errorResult(ABORTED_TEXT);
		const deadline = Date.now() + TOOL_CALL_TIMEOUT_MS;
		const id = await takeCallId(session, name, args, deadline);
		debug('mcp call', name, id, JSON.stringify(args));
		if (session.closed) return errorResult(CLOSED_TEXT);
		if (!id || !session.turn || session.turn.aborting) return errorResult(ABORTED_TEXT);
		return await awaitToolResult(session, id, name, deadline);
	});
	return {type: 'sdk' as const, name: MCP_SERVER, instance: server};
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly EffortLevel[];

/**
 * The reasoning effort this request asks for, or undefined when it asks for none. The host
 * sends nothing both for "no effort" and for "off", so absence means "model default", not
 * "thinking disabled".
 */
function requestedEffort(options: LanguageModelV3CallOptions): EffortLevel | undefined {
	const effort = options.providerOptions?.anthropic?.effort;
	if (typeof effort !== 'string') return undefined;
	return EFFORT_LEVELS.find(level => level === effort);
}

/**
 * Applies a mid-session effort change through the CLI's flag-settings overlay (`null` resets
 * to the model default). Runs with the lease held and behind the tool-list barrier, before any
 * tool result is resolved, so it lands on the turn about to start. A change that fails or
 * takes longer than `EFFORT_TIMEOUT_MS` is dropped for this request only: the answer still
 * goes out at the effort the session already had.
 */
async function updateEffort(session: Session, requested: EffortLevel | undefined): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			session.handle!.applyFlagSettings({effortLevel: requested ?? null}),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`applyFlagSettings did not finish within ${EFFORT_TIMEOUT_MS}ms`)),
					EFFORT_TIMEOUT_MS,
				);
				timer.unref?.();
			}),
		]);
		session.effort = requested;
		debug('effort', `#${session.id}`, 'applyFlagSettings', JSON.stringify({effortLevel: requested ?? null}));
	} catch (error) {
		debug('effort update failed', `#${session.id}`, error);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Refresh while leased, before resolving any result that could let the CLI call the API. */
async function updateTools(session: Session, tools: FunctionTool[], signal: AbortSignal | undefined): Promise<void> {
	const catalog = session.mcp;
	const next = toolMap(tools);
	const fingerprint = toolFingerprint(next);
	if (catalog.fingerprint === fingerprint) return;
	const needsEmptyList = catalog.fingerprint === undefined ||
		stableValue([...catalog.tools.keys()].sort()) === stableValue([...next.keys()].sort());
	catalog.tools = next;
	catalog.fingerprint = undefined;
	debug('updating tools', `#${session.id}`, [...next.keys()]);
	// Status exposes names, not schemas/descriptions. With unchanged names it cannot
	// distinguish an old catalog from the new one. After an interrupted refresh the CLI's
	// list is also unknown. Commit an empty list first in either case, then the new list;
	// neither phase allows an API call. Dispatch still uses `tools`, so
	// suspensions and late handlers for tools that remain available are not disconnected.
	const publications = needsEmptyList && next.size > 0 ? [new Map<string, Tool>(), next] : [next];
	for (const published of publications) {
		catalog.published = published;
		let listed!: () => void;
		const refetched = new Promise<void>(resolve => { listed = resolve; });
		let reject!: (error: unknown) => void;
		const failed = new Promise<never>((_resolve, fail) => { reject = fail; });
		const controller = new AbortController();
		const refresh = {
			listed,
			fail(error: unknown) {
				controller.abort(error);
				listed();
				reject(error);
			},
		};
		catalog.refresh = refresh;
		const onAbort = () => refresh.fail(abortReason(signal!));
		signal?.addEventListener('abort', onAbort, {once: true});
		const timer = setTimeout(() => refresh.fail(new Error(`MCP tool list was not refreshed within ${TOOL_LIST_TIMEOUT_MS}ms.`)), TOOL_LIST_TIMEOUT_MS);
		timer.unref?.();
		try {
			await Promise.race([
				(async () => {
					await catalog.server.server.sendToolListChanged();
					await refetched;
					// A tools/list handler running is not an acknowledgement: the CLI must
					// validate its response and commit the catalog before we release a result.
					const expected = [...published.keys()].sort();
					for (;;) {
						controller.signal.throwIfAborted();
						const status = (await session.handle!.mcpServerStatus()).find(server => server.name === MCP_SERVER);
						controller.signal.throwIfAborted();
						const offered = (status?.tools ?? []).map(tool => tool.name).sort();
						if (status?.status === 'connected' && stableValue(offered) === stableValue(expected)) {
							debug('tool list refreshed', `#${session.id}`, offered);
							return;
						}
						await new Promise(resolve => setTimeout(resolve, 25));
					}
				})(),
				failed,
			]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			if (catalog.refresh === refresh) catalog.refresh = undefined;
		}
	}
	catalog.fingerprint = fingerprint;
}

/**
 * Soft cap: make room by closing least-recently-used idle sessions. Sessions in use (leased,
 * awaiting tools, draining) are never closed for this; the cap is exceeded instead.
 */
function enforceSessionCap(): void {
	if (sessions.size < MAX_SESSIONS) return;
	const idle = [...sessions]
		.filter(session => session.state === 'idle' && !session.lease)
		.sort((a, b) => a.lastUsed - b.lastUsed);
	while (sessions.size >= MAX_SESSIONS && idle.length > 0) closeSession(idle.shift()!, 'session cap (least recently used)');
	if (sessions.size >= MAX_SESSIONS) {
		debug('session cap exceeded', `${sessions.size + 1} > ${MAX_SESSIONS}`, '(no idle session to close)');
	}
}

function createSession(
	modelId: string,
	system: string | undefined,
	tools: FunctionTool[],
	signature: string,
	ephemeral: boolean,
	effort: EffortLevel | undefined,
): Session {
	enforceSessionCap();
	const publishedTools = toolMap(tools);
	const session: Session = {
		id: registry.nextId++,
		modelId,
		signature,
		ephemeral,
		effort,
		state: 'idle',
		lease: undefined,
		turn: undefined,
		record: [],
		outstanding: new Set(),
		abortedCalls: new Set(),
		input: new Queue(),
		handle: undefined,
		mcp: {
			server: new McpServer({name: 'cmd-tools', version: '1.0.0'}),
			tools: publishedTools,
			published: publishedTools,
			fingerprint: toolFingerprint(publishedTools),
			refresh: undefined,
		},
		pending: new Map(),
		results: new Map(),
		calls: [],
		callWaiters: [],
		trailerTimer: undefined,
		drainWaiters: [],
		lastUsed: Date.now(),
		closed: false,
	};

	const mcpServers = tools.length > 0 ? {[MCP_SERVER]: buildMcpServer(session)} : undefined;
	const abortController = new AbortController();

	const handle = query({
		prompt: session.input as never,
		options: {
			model: modelId,
			...(effort ? {effort} : {}),
			cwd: process.cwd(),
			abortController,
			mcpServers,
			tools: [] as never,
			settingSources: [],
			// `env` replaces the subprocess environment (it is not merged), so spread it. The
			// host owns the transcript and compacts it itself, so CLI-side auto-compaction
			// would only add a summarization call and diverge from the host's history.
			env: {...process.env, DISABLE_AUTO_COMPACT: '1'},
			strictMcpConfig: true,
			persistSession: false,
			includePartialMessages: true,
			verbatimPrompts: true,
			permissionMode: 'default',
			allowedTools: tools.map(tool => `${MCP_PREFIX}${tool.name}`),
			canUseTool: (async (_name: string, input: Record<string, unknown>) => ({
				behavior: 'allow',
				updatedInput: input,
			})) as never,
			systemPrompt: system ? ({type: 'custom', prompt: system} as never) : undefined,
		},
	});

	session.handle = handle;
	sessions.add(session);
	debug(
		'session created',
		`#${session.id}`,
		modelId,
		ephemeral ? '(ephemeral)' : '',
		effort ? `effort=${effort}` : 'effort=model default',
		tools.map(tool => tool.name),
	);
	void pumpSession(session, handle as AsyncIterable<SdkMessage>);
	return session;
}

async function pumpSession(session: Session, handle: AsyncIterable<SdkMessage>): Promise<void> {
	try {
		for await (const message of handle) onSdkMessage(session, message);
		closeSession(session, 'SDK stream ended');
	} catch (error) {
		debug('sdk error', `#${session.id}`, error);
		closeSession(session, 'SDK stream failed', error);
	}
}

function closeSession(session: Session, reason: string, error?: unknown): void {
	if (session.closed) return;
	debug('session closed', `#${session.id}`, reason);
	session.closed = true;
	session.state = 'closed';
	sessions.delete(session);
	session.mcp.refresh?.fail(error ?? new Error(`Claude Agent session closed: ${reason}`));
	clearTrailer(session);
	const lease = session.lease;
	session.lease = undefined;
	lease?.parts.fail(error ?? new Error(`Claude Agent session closed: ${reason}`));
	releaseToolWaiters(session, CLOSED_TEXT);
	session.outstanding.clear();
	session.turn = undefined;
	notifyDrained(session);
	try {
		session.handle?.close();
	} catch {}
	session.input.close();
}

function clearTrailer(session: Session): void {
	if (session.trailerTimer) clearTimeout(session.trailerTimer);
	session.trailerTimer = undefined;
}

function notifyDrained(session: Session): void {
	for (const resolve of session.drainWaiters.splice(0)) resolve();
}

function startDraining(session: Session): void {
	session.state = 'draining';
	clearTrailer(session);
	session.trailerTimer = setTimeout(() => {
		if (session.state === 'draining') closeSession(session, `no turn result within ${TRAILER_TIMEOUT_MS}ms`);
	}, TRAILER_TIMEOUT_MS);
	session.trailerTimer.unref?.();
}

/** The turn's `result` arrived: the session is idle again and its transcript record stands. */
function endTurn(session: Session): void {
	session.turn = undefined;
	clearTrailer(session);
	// Calls the turn left unanswered are not aborted ones: a later host result for them
	// means the transcripts diverged, so they no longer match this session.
	session.outstanding.clear();
	releaseToolWaiters(session, ABORTED_TEXT);
	session.state = 'idle';
	session.lastUsed = Date.now();
	notifyDrained(session);
}

/** Events stamped with another submission's uuid belong to an earlier turn. */
function isStale(message: SdkMessage, turn: Turn): boolean {
	const ids: unknown[] | undefined = Array.isArray(message.user_message_uuids)
		? message.user_message_uuids
		: typeof message.user_message_uuid === 'string'
			? [message.user_message_uuid]
			: undefined;
	return ids !== undefined && !ids.includes(turn.uuid);
}

function onSdkMessage(session: Session, message: SdkMessage): void {
	if (session.closed) return;
	if (message.type === 'result') {
		onResult(session, message);
		return;
	}
	if (message.type !== 'stream_event') {
		if (message.type === 'system' && message.subtype !== 'init' && message.subtype !== 'status') {
			debug('sdk message', `#${session.id}`, message.type, message.subtype ?? '');
		}
		return;
	}
	if (message.parent_tool_use_id) return;
	const event = message.event;
	if (!event || event.type === 'ping') return;
	const turn = session.turn;
	if (!turn || isStale(message, turn)) {
		debug('stale event skipped', `#${session.id}`, event.type);
		return;
	}
	if (session.state === 'draining') {
		onDrainingEvent(session, turn, event);
		return;
	}
	const lease = session.lease;
	if (!lease) {
		// Nobody asked for this response: the CLI went on without the host (for example after
		// rejecting a tool input itself). The host transcript can no longer describe it.
		if (event.type === 'message_start') closeSession(session, 'the SDK turn continued without a host request');
		return;
	}
	onStreamEvent(session, lease, event);
}

function onDrainingEvent(session: Session, turn: Turn, event: SdkMessage): void {
	turn.discarded++;
	if (event.type !== 'message_start' || !turn.aborting) return;
	turn.aborting.startedSince = true;
	reinterruptIfStarted(session, turn);
}

/**
 * An interrupt that lands before the submitted message is dequeued does not stop it (the
 * receipt lists it in `still_queued`), so the turn starts anyway. A response starting after an
 * interrupt was sent gets one more interrupt, once that interrupt's receipt is in.
 */
function reinterruptIfStarted(session: Session, turn: Turn): void {
	const aborting = turn.aborting;
	if (!aborting?.receipt || !aborting.startedSince || aborting.reinterrupts >= MAX_REINTERRUPTS) return;
	aborting.reinterrupts++;
	aborting.receipt = false;
	aborting.startedSince = false;
	debug('turn started after the interrupt; interrupting again', `#${session.id}`);
	interruptTurn(session, turn);
}

function closeOpenBlocks(lease: Lease): void {
	for (const [index, open] of lease.open) {
		if (open === 'text') lease.parts.push({type: 'text-end', id: `text-${index}`});
		else lease.parts.push({type: 'reasoning-end', id: `thinking-${index}`});
	}
	lease.open.clear();
	lease.tools.clear();
}

/** The request's response is over: record what it produced and give the session back. */
function releaseLease(session: Session, lease: Lease, partial: boolean): void {
	if (lease.started) session.record.push(producedEntry(lease.text, lease.calls, partial));
	if (session.lease === lease) session.lease = undefined;
	session.lastUsed = Date.now();
}

function onStreamEvent(session: Session, lease: Lease, event: SdkMessage): void {
	const send = (part: LanguageModelV3StreamPart) => lease.parts.push(part);
	switch (event.type) {
		case 'message_start':
			lease.started = true;
			if (mergeUsage(lease.usage, event.message?.usage)) lease.sawUsage = true;
			return;
		case 'content_block_start': {
			const block = event.content_block;
			if (block?.type === 'text') {
				lease.open.set(event.index, 'text');
				send({type: 'text-start', id: `text-${event.index}`});
			} else if (block?.type === 'thinking') {
				lease.open.set(event.index, 'thinking');
				send({type: 'reasoning-start', id: `thinking-${event.index}`});
			} else if (block?.type === 'tool_use') {
				lease.tools.set(event.index, {id: String(block.id ?? ''), name: String(block.name ?? ''), json: ''});
			}
			return;
		}
		case 'content_block_delta': {
			const delta = event.delta;
			if (delta?.type === 'text_delta') {
				const text = String(delta.text ?? '');
				lease.text += text;
				send({type: 'text-delta', id: `text-${event.index}`, delta: text});
			} else if (delta?.type === 'thinking_delta') {
				send({type: 'reasoning-delta', id: `thinking-${event.index}`, delta: String(delta.thinking ?? '')});
			} else if (delta?.type === 'input_json_delta') {
				const tool = lease.tools.get(event.index);
				if (tool) tool.json += String(delta.partial_json ?? '');
			}
			return;
		}
		case 'content_block_stop': {
			const tool = lease.tools.get(event.index);
			if (tool) {
				lease.tools.delete(event.index);
				const toolName = tool.name.startsWith(MCP_PREFIX) ? tool.name.slice(MCP_PREFIX.length) : tool.name;
				const input = tool.json || '{}';
				registerCall(session, {id: tool.id, name: toolName, input, offered: session.mcp.tools.has(toolName)});
				session.outstanding.add(tool.id);
				lease.calls.push(tool.id);
				send({type: 'tool-call', toolCallId: tool.id, toolName, input});
				return;
			}
			const open = lease.open.get(event.index);
			lease.open.delete(event.index);
			if (open === 'text') send({type: 'text-end', id: `text-${event.index}`});
			if (open === 'thinking') send({type: 'reasoning-end', id: `thinking-${event.index}`});
			return;
		}
		case 'message_delta':
			if (mergeUsage(lease.usage, event.usage)) lease.sawUsage = true;
			if (event.delta?.stop_reason) lease.stop = String(event.delta.stop_reason);
			return;
		case 'message_stop': {
			debug('message_stop', `#${session.id}`, lease.stop, lease.calls);
			closeOpenBlocks(lease);
			send({type: 'finish', usage: toUsage(lease.usage), finishReason: finishReason(lease.stop)});
			releaseLease(session, lease, false);
			lease.parts.close();
			if (session.ephemeral) closeSession(session, 'ephemeral request finished');
			else if (lease.stop === 'tool_use' && session.outstanding.size > 0) session.state = 'awaiting-tools';
			else startDraining(session);
			return;
		}
	}
}

function resultErrorText(message: SdkMessage): string {
	if (typeof message.result === 'string' && message.result) return message.result;
	if (Array.isArray(message.errors) && message.errors.length > 0) return message.errors.join('; ');
	return `Claude Agent turn failed (${String(message.subtype)})`;
}

function onResult(session: Session, message: SdkMessage): void {
	const turn = session.turn;
	if (!turn || isStale(message, turn)) {
		debug('stale result skipped', `#${session.id}`, message.subtype);
		return;
	}
	debug(
		'turn result',
		`#${session.id}`,
		message.subtype,
		message.is_error ? 'is_error' : '',
		message.terminal_reason ?? '',
		turn.discarded > 0 ? `(dropped ${turn.discarded} stale events while draining)` : '',
	);
	const lease = session.lease;
	if (lease) {
		// The turn ended inside this request's response, without its message_stop: an API error
		// before streaming, or a turn the CLI ended on its own. Finish instead of waiting.
		// A result's usage spans the whole SDK turn, so it only stands in for missing numbers.
		if (!lease.sawUsage) mergeUsage(lease.usage, message.usage);
		closeOpenBlocks(lease);
		if (message.is_error) lease.parts.push({type: 'error', error: new Error(resultErrorText(message))});
		lease.parts.push({
			type: 'finish',
			usage: toUsage(lease.usage),
			finishReason: message.is_error
				? {unified: 'error', raw: String(message.subtype)}
				: finishReason(lease.stop ?? message.stop_reason ?? undefined),
		});
		releaseLease(session, lease, true);
		lease.parts.close();
	}
	endTurn(session);
	if (session.ephemeral) closeSession(session, 'ephemeral request finished');
}

function interruptTurn(session: Session, turn: Turn): void {
	let pending: Promise<unknown>;
	try {
		pending = session.handle!.interrupt();
	} catch (error) {
		pending = Promise.reject(error);
	}
	pending.then(
		receipt => {
			if (session.turn !== turn || !turn.aborting) return;
			turn.aborting.receipt = true;
			debug('interrupt receipt', `#${session.id}`, JSON.stringify(receipt ?? null));
			const queued = (receipt as {still_queued?: unknown} | undefined)?.still_queued;
			if (Array.isArray(queued) && queued.includes(turn.uuid)) {
				debug('interrupted message is still queued; its turn will be stopped and drained', `#${session.id}`);
			}
			reinterruptIfStarted(session, turn);
		},
		error => {
			debug('interrupt failed', `#${session.id}`, error);
			if (session.turn === turn) closeSession(session, 'interrupt failed');
		},
	);
}

/**
 * Esc on the host: stop the SDK turn but keep the session and its transcript record. The
 * session drains the interrupted turn's trailer before anyone can match it again.
 */
function abortLease(session: Session, lease: Lease, reason: unknown): void {
	if (session.lease !== lease) {
		debug('abort ignored: the request no longer holds the session', `#${session.id}`);
		return;
	}
	debug('request aborted', `#${session.id}`);
	releaseLease(session, lease, true);
	lease.parts.fail(reason);
	if (session.ephemeral) {
		closeSession(session, 'ephemeral request aborted');
		return;
	}
	const turn = session.turn;
	if (!turn) {
		session.state = 'idle';
		notifyDrained(session);
		return;
	}
	turn.aborting = {receipt: false, startedSince: false, reinterrupts: 0};
	for (const id of session.outstanding) session.abortedCalls.add(id);
	session.outstanding.clear();
	releaseToolWaiters(session, ABORTED_TEXT);
	startDraining(session);
	interruptTurn(session, turn);
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/** Waits until no draining session that could continue this transcript is still draining. */
async function settleDrains(
	modelId: string,
	signature: string,
	incoming: readonly Entry[],
	signal: AbortSignal | undefined,
): Promise<void> {
	for (;;) {
		const draining = [...sessions].find(
			session =>
				session.state === 'draining' &&
				!session.ephemeral &&
				session.modelId === modelId &&
				session.signature === signature &&
				!!matchRecord(session.record, incoming),
		);
		if (!draining) return;
		debug('waiting for session to drain', `#${draining.id}`);
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => reject(abortReason(signal!));
			draining.drainWaiters.push(() => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			});
			signal?.addEventListener('abort', onAbort, {once: true});
		});
	}
}

type ContinuationPlan = {deliver: ToolEntry[]; users: UserEntry[]; progress: boolean};

/**
 * What continuing `session` with the unmatched rest of the transcript would take, or undefined
 * when the rest is not something this session can be fed: steps it never produced, results for
 * calls it does not have open, or an `awaiting-tools` turn not getting all of its results.
 */
function planContinuation(session: Session, remainder: readonly Entry[]): ContinuationPlan | undefined {
	const deliver: ToolEntry[] = [];
	const users: UserEntry[] = [];
	for (const entry of remainder) {
		if (entry.kind === 'assistant') {
			// An empty response the host kept from an interrupted request carries nothing to send.
			if (entry.calls.length === 0 && !entry.text) continue;
			return undefined;
		}
		if (entry.kind === 'user') {
			users.push(entry);
			continue;
		}
		if (users.length > 0) return undefined;
		if (session.state === 'awaiting-tools' && session.outstanding.has(entry.id)) deliver.push(entry);
		else if (!session.abortedCalls.has(entry.id)) return undefined;
	}
	if (session.state === 'awaiting-tools') {
		for (const id of session.outstanding) {
			if (!deliver.some(entry => entry.id === id)) return undefined;
		}
	}
	return {deliver, users, progress: deliver.length > 0 || users.length > 0};
}

function findContinuation(
	modelId: string,
	signature: string,
	incoming: readonly Entry[],
): {session: Session; plan: ContinuationPlan} | 'ambiguous' | undefined {
	const candidates = [...sessions].filter(
		session =>
			!session.closed &&
			!session.ephemeral &&
			!session.lease &&
			session.modelId === modelId &&
			session.signature === signature &&
			(session.state === 'idle' || session.state === 'awaiting-tools'),
	);
	const plans = new Map<Session, ContinuationPlan>();
	const choice = chooseContinuation(
		candidates.map(session => ({item: session, record: session.record})),
		incoming,
		(session, consumed) => {
			const plan = planContinuation(session, incoming.slice(consumed));
			if (plan) plans.set(session, plan);
			return plan !== undefined;
		},
	);
	if (choice === undefined || choice === 'ambiguous') return choice;
	return {session: choice.item, plan: plans.get(choice.item)!};
}

function attachLease(session: Session): Lease {
	const lease: Lease = {
		parts: new Queue(),
		usage: {},
		sawUsage: false,
		started: false,
		stop: undefined,
		open: new Map(),
		tools: new Map(),
		text: '',
		calls: [],
	};
	session.lease = lease;
	session.state = 'streaming';
	session.lastUsed = Date.now();
	return lease;
}

function submit(session: Session, content: ContentBlock[]): void {
	const uuid = randomUUID();
	session.turn = {uuid, discarded: 0};
	session.input.push({
		type: 'user',
		message: {role: 'user', content},
		parent_tool_use_id: null,
		uuid,
	});
	debug('submit', `#${session.id}`, uuid, `${content.length} block(s)`);
}

function deliverToolResult(session: Session, id: string, result: CallToolResult): void {
	session.outstanding.delete(id);
	const resolve = session.pending.get(id);
	if (resolve) {
		debug('tool result', id, 'delivered');
		session.pending.delete(id);
		resolve(result);
	} else {
		debug('tool result', id, 'buffered');
		session.results.set(id, result);
	}
}

function toolResultPart(prompt: Prompt, entry: ToolEntry): ToolResultPart {
	return (prompt[entry.at!] as ToolMessage).content[entry.part!] as ToolResultPart;
}

function continueSession(session: Session, plan: ContinuationPlan, prompt: Prompt, incoming: readonly Entry[]): void {
	debug(
		'continuing session',
		`#${session.id}`,
		`tool results=${plan.deliver.length}`,
		`user messages=${plan.users.length}`,
	);
	session.record = recordEntries(incoming);
	// Results for interrupted calls are now part of the record, so they are matched from there.
	session.abortedCalls.clear();
	const extra = plan.users.flatMap(entry => userContentBlocks(prompt[entry.at!] as UserMessage));
	if (plan.deliver.length === 0) {
		submit(session, extra);
		return;
	}
	plan.deliver.forEach((entry, index) => {
		let result = toCallToolResult(toolResultPart(prompt, entry).output);
		// The SDK turn is still open, so user messages sent along with tool results ride on the
		// last result rather than starting a second turn.
		if (extra.length > 0 && index === plan.deliver.length - 1) {
			result = {
				...result,
				content: [
					...result.content,
					{type: 'text', text: 'The user sent a new message while this tool was running:'},
					...extra.map(sdkBlockToMcp),
				],
			};
		}
		deliverToolResult(session, entry.id, result);
	});
}

/** First message for a new session: the prompt's user messages, or a replay of its history. */
function initialContent(prompt: Prompt, incoming: readonly Entry[]): {content: ContentBlock[]; replay: boolean} | undefined {
	if (incoming.some(entry => entry.kind !== 'user')) return {content: replayContent(prompt), replay: true};
	const users = prompt.filter((message): message is UserMessage => message.role === 'user');
	if (users.length === 0) return undefined;
	return {content: users.flatMap(userContentBlocks), replay: false};
}

function finishReason(rawStop: string | undefined): LanguageModelV3FinishReason {
	switch (rawStop) {
		case 'tool_use':
			return {unified: 'tool-calls', raw: rawStop};
		case 'max_tokens':
			return {unified: 'length', raw: rawStop};
		case 'refusal':
			return {unified: 'content-filter', raw: rawStop};
		case 'end_turn':
		case 'stop_sequence':
		case undefined:
			return {unified: 'stop', raw: rawStop};
		default:
			return {unified: 'other', raw: rawStop};
	}
}

function requestWarnings(options: LanguageModelV3CallOptions): Array<{type: 'unsupported'; feature: string; details?: string}> {
	const warnings: Array<{type: 'unsupported'; feature: string; details?: string}> = [];
	const unsupported: Array<[string, unknown]> = [
		['temperature', options.temperature],
		['topP', options.topP],
		['topK', options.topK],
		['stopSequences', options.stopSequences],
		['presencePenalty', options.presencePenalty],
		['frequencyPenalty', options.frequencyPenalty],
	];
	for (const [feature, value] of unsupported) {
		if (value === undefined) continue;
		warnings.push({
			type: 'unsupported',
			feature,
			details: 'The Claude Agent SDK manages this setting through Claude Code, not per request.',
		});
	}
	return warnings;
}

/** The host-facing stream of one leased response. The abort listener lives exactly as long. */
function leaseStream(
	session: Session,
	lease: Lease,
	options: LanguageModelV3CallOptions,
): ReadableStream<LanguageModelV3StreamPart> {
	const signal = options.abortSignal;
	const warnings = requestWarnings(options);
	const onAbort = () => abortLease(session, lease, abortReason(signal!));
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		signal?.removeEventListener('abort', onAbort);
		if (session.ephemeral) closeSession(session, 'ephemeral request finished');
	};
	signal?.addEventListener('abort', onAbort, {once: true});

	return new ReadableStream<LanguageModelV3StreamPart>({
		start(controller) {
			controller.enqueue({type: 'stream-start', warnings});
		},
		async pull(controller) {
			try {
				const {value, done} = await lease.parts.next();
				if (done) {
					end();
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				end();
				controller.error(error);
			}
		},
		cancel(reason) {
			abortLease(session, lease, reason ?? new DOMException('The stream was cancelled', 'AbortError'));
			end();
		},
	});
}

async function streamFor(
	options: LanguageModelV3CallOptions,
	sdkModelId: string,
): Promise<{stream: ReadableStream<LanguageModelV3StreamPart>}> {
	const signal = options.abortSignal;
	if (signal?.aborted) throw abortReason(signal);
	const tools = (options.tools ?? []).filter(isFunctionTool);
	const system = systemText(options.prompt);
	const signature = sessionSignature(system);
	const sideQuestion = isSideQuestion(options.prompt);
	const incoming = transcriptEntries(options.prompt);

	if (!sideQuestion) await settleDrains(sdkModelId, signature, incoming, signal);
	if (signal?.aborted) throw abortReason(signal);

	// Nothing below awaits until the lease is taken, so no other request can claim the session.
	if (!sideQuestion) {
		const found = findContinuation(sdkModelId, signature, incoming);
		if (found === 'ambiguous') {
			debug('several sessions continue this transcript equally; starting a new one');
		} else if (found && !found.plan.progress) {
			// Nothing to submit and no tool call to answer (a host retry): reading events now would
			// wait on nothing, so replay into a fresh session instead.
			debug('nothing new for session', `#${found.session.id}`, '- replaying into a new session');
			if (tools.length > 0 && found.session.state === 'idle' && !found.session.lease) closeSession(found.session, 'superseded by a replay');
		} else if (found) {
			const {session, plan} = found;
			const lease = attachLease(session);
			// Install abort handling before the refresh barrier, not after its awaits.
			const stream = leaseStream(session, lease, options);
			try {
				await updateTools(session, tools, signal);
				if (signal?.aborted) throw abortReason(signal);
				if (session.lease !== lease) throw new Error('The session ended while its tool list was being refreshed.');
				const effort = requestedEffort(options);
				if (effort !== session.effort) await updateEffort(session, effort);
				if (signal?.aborted) throw abortReason(signal);
				if (session.lease !== lease) throw new Error('The session ended while its effort was being updated.');
				continueSession(session, plan, options.prompt, incoming);
				return {stream};
			} catch (error) {
				if (!signal?.aborted) {
					debug('tool list refresh failed', `#${session.id}`, error);
					closeSession(session, 'tool list refresh failed', error);
				}
				await stream.cancel(error).catch(() => {});
				if (signal?.aborted) throw abortReason(signal);
				throw error;
			}
		}
	}

	// A live conversation may remove even its last tool. Only unmatched tool-free helpers
	// (titles, summaries, etc.) and /btw requests need an isolated, short-lived session.
	const ephemeral = tools.length === 0 || sideQuestion;
	const initial = initialContent(options.prompt, incoming);
	if (!initial) throw new Error('The prompt has no user message to send to Claude.');
	const session = createSession(sdkModelId, system, tools, signature, ephemeral, requestedEffort(options));
	const lease = attachLease(session);
	if (initial.replay) debug('replay transcript', `#${session.id}`, incoming.length, 'entries');
	session.record = recordEntries(incoming);
	submit(session, initial.content);
	return {stream: leaseStream(session, lease, options)};
}

export function createClaudeAgentModel(displayModelId: string, sdkModelId: string): LanguageModelV3 {
	const model: LanguageModelV3 = {
		specificationVersion: 'v3',
		provider: 'claude-agent',
		modelId: displayModelId,
		supportedUrls: {},
		async doGenerate(options: LanguageModelV3CallOptions) {
			const {stream} = await streamFor(options, sdkModelId);
			const reader = stream.getReader();
			const content: LanguageModelV3Content[] = [];
			let text = '';
			let usage: LanguageModelV3Usage = toUsage({});
			let reason: LanguageModelV3FinishReason = {unified: 'stop', raw: undefined};

			for (;;) {
				const {value, done} = await reader.read();
				if (done) break;
				if (value.type === 'text-delta') text += value.delta;
				else if (value.type === 'tool-call') {
					content.push({type: 'tool-call', toolCallId: value.toolCallId, toolName: value.toolName, input: value.input});
				} else if (value.type === 'finish') {
					usage = value.usage;
					reason = value.finishReason;
				} else if (value.type === 'error') {
					throw value.error;
				}
			}

			if (text) content.unshift({type: 'text', text});
			return {content, finishReason: reason, usage, warnings: requestWarnings(options)};
		},
		async doStream(options: LanguageModelV3CallOptions) {
			return streamFor(options, sdkModelId);
		},
	};

	return model;
}
