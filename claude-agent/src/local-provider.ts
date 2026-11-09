import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import type {LanguageModelV3CallOptions, LanguageModelV3FinishReason} from '@ai-sdk/provider';
import {createClaudeAgentModel} from './bridge.ts';
import {MODEL_SPECS, sdkModelId} from './models.ts';

const PROVIDER_ID = 'claude-agent';
const PROVIDER_NAME = 'Claude Agent';
const DEBUG = process.env.CLAUDE_AGENT_MOD_DEBUG === '1';

type LocalProvider = {server: Server; port: number};
const host = globalThis as typeof globalThis & {__cmdClaudeAgentLocal?: LocalProvider};

function debug(...args: unknown[]): void {
	if (DEBUG) console.error('[claude-agent]', ...args);
}

function providersPath(): string {
	return join(homedir(), '.commandcode', 'providers.json');
}

function modelsConfig(): Record<string, unknown> {
	const models: Record<string, unknown> = {};
	for (const spec of MODEL_SPECS) {
		models[spec.id] = {
			name: spec.name,
			contextWindow: spec.contextWindow,
			maxOutput: 32_000,
			...(spec.reasoningEfforts ? {reasoningEfforts: [...spec.reasoningEfforts]} : {}),
		};
	}
	return models;
}

function writeProviderEntry(port: number): void {
	const file = providersPath();
	let config: Record<string, any> = {provider: {}};
	if (existsSync(file)) {
		try {
			const parsed = JSON.parse(readFileSync(file, 'utf8'));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
		} catch {
			console.error('[claude-agent] providers.json is not valid JSON; leaving it untouched');
			return;
		}
	}
	const key = config.provider ? 'provider' : 'providers';
	if (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key])) config[key] = {};
	const existing =
		config[key][PROVIDER_ID] && typeof config[key][PROVIDER_ID] === 'object'
			? config[key][PROVIDER_ID]
			: {};
	const entry = {
		...existing,
		name: typeof existing.name === 'string' && existing.name ? existing.name : PROVIDER_NAME,
		api: 'anthropic-messages',
		baseURL: `http://127.0.0.1:${port}/v1`,
		apiKey: existing.apiKey ?? false,
		models: modelsConfig(),
	};
	if (JSON.stringify(config[key][PROVIDER_ID] ?? null) === JSON.stringify(entry)) return;
	config[key][PROVIDER_ID] = entry;
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(file), {recursive: true});
		writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
		renameSync(tmp, file);
		debug('providers.json updated', file, port);
	} catch (error) {
		console.error('[claude-agent] could not write providers.json', error);
	}
}

function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content))
		return content
			.map(part => {
				if (typeof part === 'string') return part;
				if (!part || typeof part !== 'object') return '';
				const block = part as {type?: string; text?: unknown};
				return block.type === 'text' ? String(block.text ?? '') : '';
			})
			.join('');
	if (content && typeof content === 'object' && 'text' in content)
		return String((content as {text?: unknown}).text ?? '');
	return '';
}

type AnthropicBlock = {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
	source?: {type?: string; media_type?: string; data?: string; url?: string};
};

type AnthropicMessage = {role?: string; content?: string | AnthropicBlock[]};

function promptFromRequest(
	system: unknown,
	messages: AnthropicMessage[],
): LanguageModelV3CallOptions['prompt'] {
	const prompt: any[] = [];
	const systemText = textOf(system);
	if (systemText) prompt.push({role: 'system', content: systemText});

	const toolNames = new Map<string, string>();

	for (const message of messages) {
		const blocks =
			typeof message.content === 'string'
				? [{type: 'text', text: message.content}]
				: Array.isArray(message.content)
					? message.content
					: [];

		if (message.role === 'assistant') {
			const content: any[] = [];
			for (const block of blocks) {
				if (block.type === 'text' && block.text) content.push({type: 'text', text: block.text});
				else if (block.type === 'tool_use' && block.id && block.name) {
					toolNames.set(block.id, block.name);
					content.push({
						type: 'tool-call',
						toolCallId: block.id,
						toolName: block.name,
						input: block.input ?? {},
					});
				}
			}
			if (content.length > 0) prompt.push({role: 'assistant', content});
			continue;
		}

		if (message.role === 'user') {
			const userContent: any[] = [];
			const toolResults: any[] = [];
			for (const block of blocks) {
				if (block.type === 'text' && block.text) {
					userContent.push({type: 'text', text: block.text});
					continue;
				}
				if (block.type === 'image' && block.source) {
					if (block.source.type === 'base64' && block.source.data) {
						userContent.push({
							type: 'file',
							mediaType: block.source.media_type ?? 'image/png',
							data: block.source.data,
						});
					} else if (block.source.type === 'url' && block.source.url) {
						userContent.push({
							type: 'file',
							mediaType: 'image/*',
							data: new URL(block.source.url),
						});
					}
					continue;
				}
				if (block.type === 'tool_result' && block.tool_use_id) {
					const value = textOf(block.content);
					toolResults.push({
						type: 'tool-result',
						toolCallId: block.tool_use_id,
						toolName: toolNames.get(block.tool_use_id) ?? 'tool',
						output: block.is_error ? {type: 'error-text', value} : {type: 'text', value},
					});
				}
			}
			if (userContent.length > 0) prompt.push({role: 'user', content: userContent});
			if (toolResults.length > 0) prompt.push({role: 'tool', content: toolResults});
		}
	}

	return prompt as LanguageModelV3CallOptions['prompt'];
}

function toolsFromRequest(tools: unknown): LanguageModelV3CallOptions['tools'] {
	if (!Array.isArray(tools)) return [];
	return tools
		.filter((tool: any) => tool && typeof tool.name === 'string' && tool.name)
		.map((tool: any) => ({
			type: 'function' as const,
			name: String(tool.name),
			description: typeof tool.description === 'string' ? tool.description : '',
			inputSchema: tool.input_schema ?? {type: 'object', properties: {}},
		})) as LanguageModelV3CallOptions['tools'];
}

function finishReason(reason: LanguageModelV3FinishReason | undefined): string {
	if (reason?.unified === 'tool-calls') return 'tool_use';
	if (reason?.unified === 'length') return 'max_tokens';
	return 'end_turn';
}

function toolInput(input: unknown): Record<string, unknown> {
	if (input && typeof input === 'object' && !Array.isArray(input))
		return input as Record<string, unknown>;
	if (typeof input === 'string') {
		try {
			const parsed = JSON.parse(input);
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}
	return {};
}

function completionResponse(
	result: {content: any[]; finishReason: LanguageModelV3FinishReason; usage: any},
	model: string,
) {
	const content: any[] = [];
	for (const part of result.content) {
		if (part.type === 'text' && part.text) content.push({type: 'text', text: part.text});
		else if (part.type === 'tool-call')
			content.push({
				type: 'tool_use',
				id: part.toolCallId,
				name: part.toolName,
				input: toolInput(part.input),
			});
	}
	return {
		id: `msg_${randomUUID()}`,
		type: 'message',
		role: 'assistant',
		model,
		content,
		stop_reason: finishReason(result.finishReason),
		stop_sequence: null,
		usage: {
			input_tokens: result.usage?.inputTokens?.total ?? 0,
			output_tokens: result.usage?.outputTokens?.total ?? 0,
		},
	};
}

async function handleMessages(request: IncomingMessage, response: ServerResponse): Promise<void> {
	let body = '';
	for await (const chunk of request) body += chunk;
	const parsed = JSON.parse(body || '{}') as any;
	const messages: AnthropicMessage[] = Array.isArray(parsed.messages) ? parsed.messages : [];
	const prompt = promptFromRequest(parsed.system, messages);
	const tools = toolsFromRequest(parsed.tools);
	const model = String(parsed.model ?? 'claude-sonnet-5-5');
	const options = {
		prompt,
		tools,
		maxOutputTokens: parsed.max_tokens,
	} as unknown as LanguageModelV3CallOptions;
	const client = createClaudeAgentModel(model, sdkModelId(model));

	if (parsed.stream !== true) {
		const result = await client.doGenerate(options);
		response.writeHead(200, {'content-type': 'application/json'});
		response.end(JSON.stringify(completionResponse(result as never, model)));
		return;
	}

	response.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': 'no-cache',
		connection: 'keep-alive',
	});
	const {stream} = await client.doStream(options);
	const reader = stream.getReader();
	const id = `msg_${randomUUID()}`;
	let nextIndex = 0;
	let stopReason = 'end_turn';
	let usage: any;
	const openBlocks = new Map<string, number>();
	const write = (event: string, payload: unknown) =>
		response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
	const closeBlock = (index: number) =>
		write('content_block_stop', {type: 'content_block_stop', index});

	write('message_start', {
		type: 'message_start',
		message: {
			id,
			type: 'message',
			role: 'assistant',
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: {input_tokens: 0, output_tokens: 0},
		},
	});

	for (;;) {
		const {value, done} = await reader.read();
		if (done) break;
		if (value.type === 'text-start') {
			const index = nextIndex++;
			openBlocks.set(value.id, index);
			write('content_block_start', {
				type: 'content_block_start',
				index,
				content_block: {type: 'text', text: ''},
			});
		} else if (value.type === 'text-delta') {
			write('content_block_delta', {
				type: 'content_block_delta',
				index: openBlocks.get(value.id) ?? 0,
				delta: {type: 'text_delta', text: value.delta},
			});
		} else if (value.type === 'text-end') {
			const index = openBlocks.get(value.id);
			if (index !== undefined) {
				closeBlock(index);
				openBlocks.delete(value.id);
			}
		} else if (value.type === 'tool-call') {
			const index = nextIndex++;
			write('content_block_start', {
				type: 'content_block_start',
				index,
				content_block: {type: 'tool_use', id: value.toolCallId, name: value.toolName, input: {}},
			});
			write('content_block_delta', {
				type: 'content_block_delta',
				index,
				delta: {
					type: 'input_json_delta',
					partial_json: JSON.stringify(toolInput(value.input)),
				},
			});
			closeBlock(index);
		} else if (value.type === 'finish') {
			usage = value.usage;
			stopReason = finishReason(value.finishReason);
		} else if (value.type === 'error') {
			write('error', {
				type: 'error',
				error: {type: 'api_error', message: String((value.error as Error)?.message ?? value.error)},
			});
		}
	}

	for (const index of openBlocks.values()) closeBlock(index);
	write('message_delta', {
		type: 'message_delta',
		delta: {stop_reason: stopReason, stop_sequence: null},
		usage: {
			input_tokens: usage?.inputTokens?.total ?? 0,
			output_tokens: usage?.outputTokens?.total ?? 0,
		},
	});
	write('message_stop', {type: 'message_stop'});
	response.end();
}

function handle(request: IncomingMessage, response: ServerResponse): void {
	const url = request.url ?? '';
	if (request.method === 'GET' && url.startsWith('/v1/models')) {
		response.writeHead(200, {'content-type': 'application/json'});
		response.end(
			JSON.stringify({
				object: 'list',
				data: MODEL_SPECS.map(spec => ({id: spec.id, object: 'model', owned_by: PROVIDER_NAME})),
			}),
		);
		return;
	}
	if (request.method !== 'POST' || !url.startsWith('/v1/messages')) {
		response.writeHead(404, {'content-type': 'application/json'});
		response.end(JSON.stringify({error: {message: 'not found'}}));
		return;
	}
	void handleMessages(request, response).catch(error => {
		console.error('[claude-agent] local provider error', error);
		if (!response.headersSent) {
			response.writeHead(500, {'content-type': 'application/json'});
			response.end(JSON.stringify({error: {message: String(error?.message ?? error)}}));
			return;
		}
		try {
			response.write(
				`event: error\ndata: ${JSON.stringify({
					type: 'error',
					error: {type: 'api_error', message: String(error?.message ?? error)},
				})}\n\n`,
			);
			response.end();
		} catch {}
	});
}

export async function startLocalProvider(): Promise<void> {
	const existing = host.__cmdClaudeAgentLocal;
	if (existing) {
		await new Promise<void>(resolve => existing.server.close(() => resolve()));
		host.__cmdClaudeAgentLocal = undefined;
	}
	const server = createServer(handle);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	if (port === 0) {
		server.close();
		throw new Error('could not bind the Claude Agent provider port');
	}
	host.__cmdClaudeAgentLocal = {server, port};
	server.unref();
	writeProviderEntry(port);
	debug('local provider listening', port);
}
