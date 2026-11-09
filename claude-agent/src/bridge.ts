import {query} from '@anthropic-ai/claude-agent-sdk/core';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
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
	continuesSession,
	hashText,
	needsReplay,
	promptSequence,
	replayText,
	textOfUserMessage,
} from './history.ts';

const MCP_SERVER = 'cmd';
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
const DEBUG = process.env.CLAUDE_AGENT_MOD_DEBUG === '1';
const IDLE_SESSION_MS = Number(process.env.CLAUDE_AGENT_MOD_IDLE_MS ?? 2 * 60 * 60 * 1000);
const TOOL_CALL_TIMEOUT_MS = Number(process.env.CLAUDE_AGENT_MOD_TOOL_TIMEOUT_MS ?? 10 * 60 * 1000);

function debug(...args: unknown[]): void {
	if (DEBUG) console.error('[claude-agent]', ...args);
}

type FunctionTool = Extract<
	NonNullable<LanguageModelV3CallOptions['tools']>[number],
	{type: 'function'}
>;

type ToolResultPart = Extract<
	Extract<LanguageModelV3CallOptions['prompt'][number], {role: 'tool'}>['content'][number],
	{type: 'tool-result'}
>;

type CallToolResult = {
	// MCP content blocks (text/image/resource). Kept loose so both text-only results and
	// image passthrough stay assignable to the MCP server's handler type.
	content: any[];
	isError?: boolean;
};

type PendingCall = {id: string; name: string; input: string};

type Session = {
	key: string;
	modelId: string;
	anonymous: boolean;
	input: Queue<Record<string, unknown>>;
	events: Queue<Record<string, unknown>>;
	handle: {close: () => void; interrupt?: () => Promise<unknown>} | undefined;
	pending: Map<string, (result: CallToolResult) => void>;
	results: Map<string, CallToolResult>;
	calls: PendingCall[];
	callWaiters: Array<{name: string; args: unknown; resolve: (id: string) => void}>;
	conveyed: string[];
	lastUsed: number;
	signature: string;
	closed: boolean;
};

type SessionRegistry = {
	sessions: Map<string, Session>;
	timer?: ReturnType<typeof setInterval>;
};

// Kept on globalThis so a mod hot-reload re-imports this module without orphaning the
// `claude` subprocesses owned by the previous instance.
const registryHost = globalThis as typeof globalThis & {__cmdClaudeAgent?: SessionRegistry};
const registry: SessionRegistry = (registryHost.__cmdClaudeAgent ??= {sessions: new Map()});
const sessions = registry.sessions;

function sweepIdleSessions(): void {
	const now = Date.now();
	for (const [key, session] of sessions) {
		if (now - session.lastUsed > IDLE_SESSION_MS) {
			debug('closing idle session', key);
			closeSession(session);
		}
	}
}

if (!registry.timer) {
	registry.timer = setInterval(sweepIdleSessions, Math.min(5 * 60_000, Math.max(30_000, IDLE_SESSION_MS / 4)));
	registry.timer.unref?.();
}

export function disposeAllSessions(): void {
	for (const session of [...sessions.values()]) closeSession(session);
	sessions.clear();
}

function emptyUsage(): LanguageModelV3Usage {
	return {
		inputTokens: {total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined},
		outputTokens: {total: undefined, text: undefined, reasoning: undefined},
	};
}

function isFunctionTool(tool: NonNullable<LanguageModelV3CallOptions['tools']>[number]): tool is FunctionTool {
	return tool.type === 'function';
}

function systemText(prompt: LanguageModelV3CallOptions['prompt']): string | undefined {
	const parts = prompt.filter(message => message.role === 'system').map(message => message.content);
	const text = parts.join('\n\n').trim();
	return text || undefined;
}

function userMessages(prompt: LanguageModelV3CallOptions['prompt']) {
	return prompt.filter(message => message.role === 'user');
}

function firstUserText(prompt: LanguageModelV3CallOptions['prompt']): string {
	return textOfUserMessage(userMessages(prompt)[0] ?? prompt[0]!);
}

function sessionKey(
	modelId: string,
	threadId: string | undefined,
	prompt: LanguageModelV3CallOptions['prompt'],
	system: string | undefined,
): string {
	if (threadId) return `${modelId}:${threadId}`;
	const fingerprint = `${process.cwd()}\u0000${system ?? ''}\u0000${firstUserText(prompt)}`;
	return `${modelId}:anon:${hashText(fingerprint)}`;
}

function sessionSignature(system: string | undefined, tools: FunctionTool[]): string {
	const toolPart = tools
		.map(tool => `${tool.name}:${JSON.stringify(tool.inputSchema ?? {})}`)
		.sort()
		.join('\u0000');
	return hashText(`${system ?? ''}\u0000${toolPart}`);
}

function toZodShape(schema: unknown, label: string): Record<string, z.ZodTypeAny> {
	try {
		if (!schema || typeof schema !== 'object') return {};
		const converted = z.fromJSONSchema(schema as never) as unknown as {shape?: Record<string, z.ZodTypeAny>};
		const shape = converted.shape ?? {};
		const properties = (schema as {properties?: Record<string, unknown>}).properties;
		if (!properties || Object.keys(properties).length === 0) return shape;
		if (Object.keys(shape).length > 0) return shape;
		debug('schema converted to an empty shape; falling back to permissive fields', label);
		return permissiveShape(schema as {properties: Record<string, unknown>; required?: string[]});
	} catch (error) {
		debug('schema conversion failed; falling back to permissive fields', label, error);
		const properties = (schema as {properties?: Record<string, unknown>} | null)?.properties;
		if (!properties) return {};
		return permissiveShape(schema as {properties: Record<string, unknown>; required?: string[]});
	}
}

/**
 * Last-resort shape for a JSON Schema zod cannot express: keep the field names (and whether
 * they were required) so the model still sees a usable tool signature instead of `{}`.
 */
function permissiveShape(schema: {properties: Record<string, unknown>; required?: string[]}): Record<string, z.ZodTypeAny> {
	const required = new Set(schema.required ?? []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const key of Object.keys(schema.properties)) {
		shape[key] = required.has(key) ? z.any() : z.any().optional();
	}
	return shape;
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
	if (block.type === 'file-data') {
		const mediaType = String(block.mediaType ?? 'application/octet-stream');
		if (mediaType.startsWith('image/')) {
			return {type: 'image', data: String(block.data ?? ''), mimeType: mediaType};
		}
		const name = block.filename ? String(block.filename) : mediaType;
		return {type: 'text', text: `[${name} attached as base64 ${mediaType}, ${String(block.data ?? '').length} chars]`};
	}
	return {type: 'text', text: `[${String(block.type ?? 'unknown')} content omitted]`};
}

function stableValue(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
	if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(',')}}`;
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

function takeCallId(session: Session, name: string, args: unknown): Promise<string> {
	const exact = session.calls.findIndex(call => call.name === name && sameArguments(call.input, args));
	const index = exact >= 0 ? exact : session.calls.findIndex(call => call.name === name);
	if (index >= 0) return Promise.resolve(session.calls.splice(index, 1)[0]!.id);
	return new Promise(resolve => session.callWaiters.push({name, args, resolve}));
}

function registerCall(session: Session, call: PendingCall): void {
	debug('tool call', call.id, call.name);
	const exact = session.callWaiters.findIndex(
		entry => entry.name === call.name && sameArguments(call.input, entry.args),
	);
	const index = exact >= 0 ? exact : session.callWaiters.findIndex(entry => entry.name === call.name);
	if (index >= 0) {
		const [waiter] = session.callWaiters.splice(index, 1);
		waiter!.resolve(call.id);
		return;
	}
	session.calls.push(call);
}

function awaitToolResult(session: Session, id: string, toolName: string): Promise<CallToolResult> {
	const buffered = session.results.get(id);
	if (buffered) {
		session.results.delete(id);
		return Promise.resolve(buffered);
	}
	return new Promise<CallToolResult>(resolve => {
		const timer = setTimeout(() => {
			if (!session.pending.delete(id)) return;
			debug('tool call timed out', toolName, id);
			resolve({
				content: [
					{
						type: 'text',
						text: `No tool result arrived within ${TOOL_CALL_TIMEOUT_MS}ms. Treat this call as failed and continue without it.`,
					},
				],
				isError: true,
			});
			// A turn nobody is driving anymore must not keep running in the background:
			// the next request replays the host transcript into a fresh session instead.
			closeSession(session);
		}, TOOL_CALL_TIMEOUT_MS);
		timer.unref?.();
		session.pending.set(id, result => {
			clearTimeout(timer);
			resolve(result);
		});
	});
}

function isKnownCall(session: Session, id: string): boolean {
	return (
		session.pending.has(id) ||
		session.calls.some(call => call.id === id) ||
		[...session.results.keys()].includes(id)
	);
}

function buildMcpServer(tools: FunctionTool[], session: Session) {
	const server = new McpServer({name: 'cmd-tools', version: '1.0.0'});
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: toZodShape(tool.inputSchema, tool.name),
			},
			async (args: unknown) => {
				const id = await takeCallId(session, tool.name, args ?? {});
				debug('mcp call', tool.name, id);
				if (!id) {
					return {
						content: [{type: 'text', text: 'The Claude Agent session closed before this tool call ran.'}],
						isError: true,
					} satisfies CallToolResult;
				}
				return await awaitToolResult(session, id, tool.name);
			},
		);
	}
	return {type: 'sdk' as const, name: MCP_SERVER, instance: server};
}

function createSession(
	key: string,
	modelId: string,
	system: string | undefined,
	tools: FunctionTool[],
): Session {
	const session: Session = {
		key,
		modelId,
		anonymous: false,
		input: new Queue(),
		events: new Queue(),
		handle: undefined,
		pending: new Map(),
		results: new Map(),
		calls: [],
		callWaiters: [],
		conveyed: [],
		lastUsed: Date.now(),
		signature: '',
		closed: false,
	};

	const mcpServers = tools.length > 0 ? {[MCP_SERVER]: buildMcpServer(tools, session)} : {};
	const abortController = new AbortController();

	const handle = query({
		prompt: session.input as never,
		options: {
			model: modelId,
			cwd: process.cwd(),
			abortController,
			mcpServers: mcpServers as never,
			tools: [] as never,
			settingSources: [],
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

	session.handle = handle as never;
	debug('session created', key, tools.map(tool => tool.name));

	void (async () => {
		try {
			for await (const message of handle as AsyncIterable<Record<string, unknown>>) {
				debug('sdk message', message.type, (message as {subtype?: string}).subtype ?? '');
				session.events.push(message);
			}
		} catch (error) {
			debug('sdk error', error);
			session.events.fail(error);
		} finally {
			session.closed = true;
			session.events.close();
		}
	})();

	return session;
}

function closeSession(session: Session): void {
	if (session.closed) return;
	debug('session closed', session.key, session.anonymous ? '(anonymous)' : '');
	session.closed = true;
	sessions.delete(session.key);
	for (const resolve of session.pending.values()) {
		resolve({content: [{type: 'text', text: 'The request was aborted.'}], isError: true});
	}
	session.pending.clear();
	for (const waiter of session.callWaiters.splice(0)) waiter.resolve('');
	try {
		session.handle?.close();
	} catch {}
	session.input.close();
	session.events.close();
}

function obtainSession(
	modelId: string,
	threadId: string | undefined,
	system: string | undefined,
	tools: FunctionTool[],
	key: string,
	signature: string,
): Session {
	const existing = sessions.get(key);
	if (existing && !existing.closed) {
		existing.lastUsed = Date.now();
		return existing;
	}
	const session = createSession(key, modelId, system, tools);
	session.anonymous = !threadId;
	session.signature = signature;
	sessions.set(key, session);
	return session;
}

function pushUserMessage(session: Session, message: LanguageModelV3CallOptions['prompt'][number]): void {
	if (message.role !== 'user') return;
	const content: Array<Record<string, unknown>> = [];
	for (const part of message.content) {
		if (part.type === 'text' && part.text) {
			content.push({type: 'text', text: part.text});
			continue;
		}
		if (part.type === 'file' && part.mediaType?.startsWith('image/')) {
			const data = part.data;
			if (data instanceof URL || (typeof data === 'object' && data !== null && 'href' in data)) {
				content.push({
					type: 'image',
					source: {type: 'url', url: String(data)},
				});
				continue;
			}
			const base64 =
				typeof data === 'string'
					? data
					: data instanceof Uint8Array
						? Buffer.from(data).toString('base64')
						: undefined;
			if (base64) {
				content.push({
					type: 'image',
					source: {type: 'base64', media_type: part.mediaType, data: base64},
				});
			}
		}
	}
	if (content.length === 0) return;
	session.input.push({
		type: 'user',
		message: {role: 'user', content},
		parent_tool_use_id: null,
	} as never);
}

function pushText(session: Session, text: string): void {
	session.input.push({
		type: 'user',
		message: {role: 'user', content: [{type: 'text', text}]},
		parent_tool_use_id: null,
	} as never);
}

function feedSession(session: Session, options: LanguageModelV3CallOptions): void {
	for (const message of options.prompt) {
		if (message.role !== 'tool') continue;
		for (const part of message.content) {
			if (part.type !== 'tool-result') continue;
			const result = toCallToolResult(part.output);
			const resolve = session.pending.get(part.toolCallId);
			if (resolve) {
				debug('tool result', part.toolCallId, 'pending');
				session.pending.delete(part.toolCallId);
				resolve(result);
			} else if (isKnownCall(session, part.toolCallId)) {
				debug('tool result', part.toolCallId, 'buffered');
				session.results.set(part.toolCallId, result);
			} else {
				debug('tool result', part.toolCallId, 'dropped (unknown or timed out)');
			}
		}
	}

	const incoming = promptSequence(options.prompt);
	const last = userMessages(options.prompt).at(-1);

	if (session.conveyed.length === 0 && needsReplay(options.prompt)) {
		debug('replay transcript', incoming.length, 'entries');
		pushText(session, replayText(options.prompt));
		session.conveyed = incoming;
		return;
	}

	if (session.conveyed.length === 0) {
		if (!last) return;
		pushUserMessage(session, last);
		session.conveyed = incoming;
		return;
	}

	const conveyedUsers = session.conveyed.filter(entry => entry.startsWith('u:')).length;
	if (last && userMessages(options.prompt).length > conveyedUsers) {
		pushUserMessage(session, last);
	}
	session.conveyed = incoming;
}

function applyUsage(usage: LanguageModelV3Usage, raw: Record<string, number> | undefined): void {
	if (!raw) return;
	const input = raw.input_tokens ?? 0;
	const cacheRead = raw.cache_read_input_tokens ?? 0;
	const cacheWrite = raw.cache_creation_input_tokens ?? 0;
	const output = raw.output_tokens ?? 0;
	usage.inputTokens = {
		total: input + cacheRead + cacheWrite,
		noCache: input,
		cacheRead,
		cacheWrite,
	};
	if (output > 0) {
		usage.outputTokens = {total: output, text: output, reasoning: undefined};
	}
	usage.raw = raw as never;
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

type ToolBlock = {kind: 'tool'; id: string; name: string; json: string};

function requestWarnings(options: LanguageModelV3CallOptions): Array<{type: 'unsupported'; feature: string; details?: string}> {
	const warnings: Array<{type: 'unsupported'; feature: string; details?: string}> = [];
	const unsupported: Array<[string, unknown]> = [
		['temperature', options.temperature],
		['topP', options.topP],
		['topK', options.topK],
		['stopSequences', options.stopSequences],
		['presencePenalty', options.presencePenalty],
		['frequencyPenalty', options.frequencyPenalty],
		['maxOutputTokens', options.maxOutputTokens],
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

function streamFor(
	options: LanguageModelV3CallOptions,
	threadId: string | undefined,
	sdkModelId: string,
): {stream: ReadableStream<LanguageModelV3StreamPart>} {
	const tools = (options.tools ?? []).filter(isFunctionTool);
	const system = systemText(options.prompt);
	const key = sessionKey(sdkModelId, threadId, options.prompt, system);
	const signature = sessionSignature(system, tools);

	const running = sessions.get(key);
	if (running && !running.closed) {
		if (running.signature !== signature) {
			debug('system prompt or tool set changed; restarting session');
			closeSession(running);
		} else if (running.conveyed.length > 0) {
			const incoming = promptSequence(options.prompt);
			if (!continuesSession(running.conveyed, incoming)) {
				debug('host transcript diverged; restarting session', incoming.length, 'entries');
				closeSession(running);
			}
		}
	}

	const session = obtainSession(sdkModelId, threadId, system, tools, key, signature);

	options.abortSignal?.addEventListener(
		'abort',
		() => {
			const interruption = session.handle?.interrupt?.();
			interruption?.catch?.(() => {});
			closeSession(session);
		},
		{once: true},
	);
	feedSession(session, options);

	const warnings = requestWarnings(options);

	const stream = new ReadableStream<LanguageModelV3StreamPart>({
		async start(controller) {
			const send = (part: LanguageModelV3StreamPart) => controller.enqueue(part);
			const usage = emptyUsage();
			const toolBlocks = new Map<number, ToolBlock>();
			const openBlocks = new Map<number, 'text' | 'thinking'>();
			let stop = 'end_turn';

			send({type: 'stream-start', warnings});

			try {
				for (;;) {
					const {value, done} = await session.events.next();
					if (done) {
						send({type: 'finish', usage, finishReason: finishReason(stop)});
						break;
					}

					const message = value as Record<string, any>;

					if (message.type === 'result') {
						// A turn's trailer. The previous turn's result often lands before the next
						// request starts, so only an error ends this stream; success is closed by
						// the turn's own message_stop.
						if (message.is_error) {
							applyUsage(usage, message.usage);
							debug('turn failed', message.subtype);
							send({type: 'finish', usage, finishReason: {unified: 'error', raw: message.subtype}});
							break;
						}
						continue;
					}

					if (message.type !== 'stream_event' || message.parent_tool_use_id) continue;
					const event = message.event;
					if (!event || event.type === 'ping') continue;

					if (event.type === 'message_start') {
						applyUsage(usage, event.message?.usage);
						continue;
					}

					if (event.type === 'content_block_start') {
						const block = event.content_block;
						if (block?.type === 'text') {
							openBlocks.set(event.index, 'text');
							send({type: 'text-start', id: `text-${event.index}`});
						} else if (block?.type === 'thinking') {
							openBlocks.set(event.index, 'thinking');
							send({type: 'reasoning-start', id: `thinking-${event.index}`});
						} else if (block?.type === 'tool_use') {
							const name = String(block.name ?? '');
							const id = String(block.id ?? '');
							toolBlocks.set(event.index, {kind: 'tool', id, name, json: ''});
						}
						continue;
					}

					if (event.type === 'content_block_delta') {
						const delta = event.delta;
						if (delta?.type === 'text_delta') {
							send({type: 'text-delta', id: `text-${event.index}`, delta: String(delta.text ?? '')});
						} else if (delta?.type === 'thinking_delta') {
							send({type: 'reasoning-delta', id: `thinking-${event.index}`, delta: String(delta.thinking ?? '')});
						} else if (delta?.type === 'input_json_delta') {
							const block = toolBlocks.get(event.index);
							if (block) block.json += String(delta.partial_json ?? '');
						}
						continue;
					}

					if (event.type === 'content_block_stop') {
						const block = toolBlocks.get(event.index);
						if (block) {
							const toolName = block.name.startsWith(MCP_PREFIX)
								? block.name.slice(MCP_PREFIX.length)
								: block.name;
							registerCall(session, {id: block.id, name: toolName, input: block.json || '{}'});
							send({
								type: 'tool-call',
								toolCallId: block.id,
								toolName,
								input: block.json || '{}',
							});
							toolBlocks.delete(event.index);
							continue;
						}
						const open = openBlocks.get(event.index);
						if (open === 'text') send({type: 'text-end', id: `text-${event.index}`});
						if (open === 'thinking') send({type: 'reasoning-end', id: `thinking-${event.index}`});
						openBlocks.delete(event.index);
						continue;
					}

					if (event.type === 'message_delta') {
						applyUsage(usage, event.usage);
						if (event.delta?.stop_reason) stop = String(event.delta.stop_reason);
						continue;
					}

					if (event.type === 'message_stop') {
						debug('message_stop', stop, [...toolBlocks.values()].map(block => block.name));
						for (const [index, open] of openBlocks) {
							if (open === 'text') send({type: 'text-end', id: `text-${index}`});
							if (open === 'thinking') send({type: 'reasoning-end', id: `thinking-${index}`});
						}
						openBlocks.clear();
						send({type: 'finish', usage, finishReason: finishReason(stop)});
						break;
					}
				}
			} catch (error) {
				try {
					controller.error(error);
				} catch {}
				return;
			}

			try {
				controller.close();
			} catch {}

			// Anonymous calls (titling, summarization, one-shot helpers) have no host thread to
			// return to, so drop their subprocess as soon as a tool-free turn ends.
			if (session.anonymous && stop !== 'tool_use') closeSession(session);
		},
	});

	return {stream};
}

export function createClaudeAgentModel(displayModelId: string, sdkModelId: string, threadId?: string): LanguageModelV3 {
	const model: LanguageModelV3 = {
		specificationVersion: 'v3',
		provider: 'claude-agent',
		modelId: displayModelId,
		supportedUrls: {},
		async doGenerate(options: LanguageModelV3CallOptions) {
			const {stream} = streamFor(options, threadId, sdkModelId);
			const reader = stream.getReader();
			const content: LanguageModelV3Content[] = [];
			let text = '';
			let usage = emptyUsage();
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
			return streamFor(options, threadId, sdkModelId);
		},
	};

	return model;
}
