import {createHash} from 'node:crypto';
import type {LanguageModelV3CallOptions} from '@ai-sdk/provider';

type Prompt = LanguageModelV3CallOptions['prompt'];
type PromptMessage = Prompt[number];
export type UserMessage = Extract<PromptMessage, {role: 'user'}>;
type FilePart = Extract<UserMessage['content'][number], {type: 'file'}>;
export type ToolResultPart = Extract<
	Extract<PromptMessage, {role: 'tool'}>['content'][number],
	{type: 'tool-result'}
>;
type ToolOutput = ToolResultPart['output'];

/** An Anthropic Messages API content block, as an SDK user message carries it. */
export type ContentBlock = Record<string, unknown>;

export const MAX_REPLAY_CHARS = 400_000;
const SIDE_QUESTION_PREFIX = '<system-reminder>\nThe user asked a quick side question with /btw';
const IMAGE_REPLAY_COST = 1_000;

export function hashText(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function stableValue(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
	if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(',')}}`;
}

// ---------------------------------------------------------------------------------------------
// File data

function isUrlLike(data: unknown): data is URL {
	return data instanceof URL || (typeof data === 'object' && data !== null && !(data instanceof Uint8Array) && 'href' in data);
}

/** The URL a file part points at, when it is not inline data. */
function dataUrl(data: FilePart['data']): string | undefined {
	if (isUrlLike(data)) return String(data.href);
	if (typeof data === 'string' && /^(https?|file):/i.test(data)) return data;
	return undefined;
}

/** Inline bytes of a file part (base64 string, data: URL, or byte array). */
function dataBytes(data: FilePart['data']): Buffer | undefined {
	if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (typeof data !== 'string' || dataUrl(data)) return undefined;
	const inline = /^data:[^,]*?(;base64)?,(.*)$/is.exec(data);
	if (inline) {
		return inline[1] ? Buffer.from(inline[2]!, 'base64') : Buffer.from(decodeURIComponent(inline[2]!), 'utf8');
	}
	return Buffer.from(data, 'base64');
}

function dataIdentity(data: FilePart['data']): string {
	const url = dataUrl(data);
	if (url) return `url:${url}`;
	return `bytes:${hashText(dataBytes(data) ?? new Uint8Array())}`;
}

const TEXT_MEDIA_TYPES = new Set([
	'application/json',
	'application/xml',
	'application/javascript',
	'application/ecmascript',
	'application/x-javascript',
	'application/typescript',
	'application/x-typescript',
	'application/yaml',
	'application/x-yaml',
	'application/toml',
	'application/x-toml',
	'application/sql',
	'application/graphql',
	'application/x-sh',
	'application/x-shellscript',
	'application/ndjson',
	'application/x-ndjson',
	'application/csv',
	'image/svg+xml',
]);

export function isTextMediaType(mediaType: string): boolean {
	const type = mediaType.split(';')[0]!.trim().toLowerCase();
	return type.startsWith('text/') || type.endsWith('+json') || type.endsWith('+xml') || TEXT_MEDIA_TYPES.has(type);
}

function fileBlock(part: FilePart): ContentBlock {
	const mediaType = part.mediaType || 'application/octet-stream';
	const url = dataUrl(part.data);
	if (mediaType.startsWith('image/') && !isTextMediaType(mediaType)) {
		if (url) return {type: 'image', source: {type: 'url', url}};
		const bytes = dataBytes(part.data) ?? Buffer.alloc(0);
		return {type: 'image', source: {type: 'base64', media_type: mediaType, data: bytes.toString('base64')}};
	}
	const label = part.filename ? `${part.filename} (${mediaType})` : mediaType;
	if (url) return {type: 'text', text: `[Attached file ${label} at ${url}; its content was not fetched]`};
	const bytes = dataBytes(part.data) ?? Buffer.alloc(0);
	if (isTextMediaType(mediaType)) return {type: 'text', text: `[Attached file ${label}]\n${bytes.toString('utf8')}`};
	return {type: 'text', text: `[Attached file ${label}, ${bytes.length} bytes; this content type cannot be shown]`};
}

/**
 * A host user message as SDK content blocks. Nothing is dropped: images stay images, text-like
 * files are decoded, other files become a placeholder naming them.
 */
export function userContentBlocks(message: UserMessage): ContentBlock[] {
	const content: ContentBlock[] = [];
	for (const part of message.content) {
		if (part.type === 'text') {
			if (part.text) content.push({type: 'text', text: part.text});
		} else if (part.type === 'file') {
			content.push(fileBlock(part));
		}
	}
	if (content.length === 0) content.push({type: 'text', text: '[empty message]'});
	return content;
}

/** `/btw` side questions carry the main thread's history but must never touch its session. */
export function isSideQuestion(prompt: Prompt): boolean {
	const last = [...prompt].reverse().find(message => message.role === 'user');
	if (last?.role !== 'user') return false;
	const first = last.content.find(part => part.type === 'text');
	return first?.type === 'text' && first.text.startsWith(SIDE_QUESTION_PREFIX);
}

// ---------------------------------------------------------------------------------------------
// Transcript fingerprints

export type ToolOutcome = 'ok' | 'error' | 'denied';

/**
 * One fingerprinted transcript step. `at`/`part` point back into the prompt an incoming entry
 * came from; they are dropped when a session records the entry.
 */
export type Entry =
	| {kind: 'user'; hash: string; at?: number}
	| {kind: 'tool'; id: string; outcome: ToolOutcome; hash: string; at?: number; part?: number}
	| {
			kind: 'assistant';
			hash: string;
			calls: string[];
			/** Normalized text: always on incoming entries, kept on recorded partial ones. */
			text?: string;
			/** Produced by a response the host interrupted; the host may hold less of it, or none. */
			partial?: boolean;
			/** The host may leave this step out of its transcript. */
			optional?: boolean;
	  };

/**
 * Whitespace is dropped entirely, not just collapsed: the host may split our text into parts or
 * join our text blocks with or without separators, and none of that is divergence.
 */
export function normalizeAssistantText(text: string): string {
	return text.replace(/\s+/g, '');
}

const EMPTY_TEXT_HASH = hashText('');

export function userFingerprint(message: UserMessage): string {
	const parts = message.content.map(part => {
		if (part.type === 'text') return `t:${part.text}`;
		if (part.type === 'file') return `f:${part.mediaType}:${part.filename ?? ''}:${dataIdentity(part.data)}`;
		return `?:${(part as {type: string}).type}`;
	});
	return hashText(parts.join('\u0000'));
}

function contentIdentity(block: Record<string, unknown>): string {
	switch (block.type) {
		case 'text':
			return `text:${String(block.text ?? '')}`;
		case 'file-data':
		case 'image-data':
			return `${block.type}:${String(block.mediaType ?? '')}:${hashText(Buffer.from(String(block.data ?? ''), 'base64'))}`;
		case 'file-url':
		case 'image-url':
			return `${block.type}:${String(block.url ?? '')}`;
		default: {
			const {providerOptions: _ignored, ...rest} = block;
			return `${String(block.type)}:${stableValue(rest)}`;
		}
	}
}

export function toolResultFingerprint(output: ToolOutput): {outcome: ToolOutcome; hash: string} {
	switch (output.type) {
		case 'text':
			return {outcome: 'ok', hash: hashText(`text:${output.value}`)};
		case 'json':
			return {outcome: 'ok', hash: hashText(`json:${stableValue(output.value)}`)};
		case 'error-text':
			return {outcome: 'error', hash: hashText(`text:${output.value}`)};
		case 'error-json':
			return {outcome: 'error', hash: hashText(`json:${stableValue(output.value)}`)};
		case 'execution-denied':
			return {outcome: 'denied', hash: hashText(`denied:${output.reason ?? ''}`)};
		case 'content':
			return {
				outcome: 'ok',
				hash: hashText((output.value as Array<Record<string, unknown>>).map(contentIdentity).join('\u0000')),
			};
		default:
			return {outcome: 'ok', hash: hashText(stableValue(output))};
	}
}

export function transcriptEntries(prompt: Prompt): Entry[] {
	const entries: Entry[] = [];
	prompt.forEach((message, at) => {
		if (message.role === 'user') {
			entries.push({kind: 'user', hash: userFingerprint(message), at});
		} else if (message.role === 'assistant') {
			let text = '';
			const calls: string[] = [];
			for (const part of message.content) {
				if (part.type === 'text') text += part.text;
				else if (part.type === 'tool-call') calls.push(part.toolCallId);
			}
			const normalized = normalizeAssistantText(text);
			entries.push({kind: 'assistant', hash: hashText(normalized), calls, text: normalized});
		} else if (message.role === 'tool') {
			message.content.forEach((part, index) => {
				if (part.type !== 'tool-result') return;
				entries.push({kind: 'tool', id: part.toolCallId, ...toolResultFingerprint(part.output), at, part: index});
			});
		}
	});
	return entries;
}

/** What a session keeps of a transcript it now holds: fingerprints only. */
export function recordEntries(entries: readonly Entry[]): Entry[] {
	return entries.map((entry): Entry => {
		if (entry.kind === 'user') return {kind: 'user', hash: entry.hash};
		if (entry.kind === 'tool') return {kind: 'tool', id: entry.id, outcome: entry.outcome, hash: entry.hash};
		if (entry.partial) return {...entry, calls: [...entry.calls]};
		const optional = entry.calls.length === 0 && entry.hash === EMPTY_TEXT_HASH;
		return {kind: 'assistant', hash: entry.hash, calls: [...entry.calls], ...(optional ? {optional} : {})};
	});
}

/** The record of one API response the session produced (`partial` when it was interrupted). */
export function producedEntry(text: string, calls: readonly string[], partial: boolean): Entry {
	const normalized = normalizeAssistantText(text);
	const entry = {kind: 'assistant' as const, hash: hashText(normalized), calls: [...calls]};
	if (partial) return {...entry, text: normalized, partial: true, optional: true};
	if (!normalized && calls.length === 0) return {...entry, optional: true};
	return entry;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every(id => set.has(id));
}

/** Whether an incoming transcript step is the step a session recorded. */
export function entryAgrees(recorded: Entry, incoming: Entry): boolean {
	if (recorded.kind === 'user') return incoming.kind === 'user' && incoming.hash === recorded.hash;
	if (recorded.kind === 'tool') {
		return (
			incoming.kind === 'tool' &&
			incoming.id === recorded.id &&
			incoming.outcome === recorded.outcome &&
			incoming.hash === recorded.hash
		);
	}
	if (incoming.kind !== 'assistant') return false;
	if (recorded.partial) {
		// The host holds at most what was streamed before the interrupt.
		if (incoming.calls.length > 0) return incoming.calls.every(id => recorded.calls.includes(id));
		return (recorded.text ?? '').startsWith(incoming.text ?? '');
	}
	// Tool-call ids are unique per response, so they decide on their own when present.
	if (recorded.calls.length > 0 || incoming.calls.length > 0) return sameIds(recorded.calls, incoming.calls);
	return incoming.hash === recorded.hash;
}

/**
 * How many incoming entries a session's record covers, or undefined when the record is not a
 * prefix of the incoming transcript. Optional recorded steps the host left out are skipped.
 */
export function matchRecord(record: readonly Entry[], incoming: readonly Entry[]): number | undefined {
	let j = 0;
	for (const recorded of record) {
		const next = incoming[j];
		if (recorded.kind === 'assistant' && recorded.optional && next?.kind !== 'assistant') continue;
		if (!next || !entryAgrees(recorded, next)) return undefined;
		j++;
	}
	return j;
}

/**
 * Picks the session whose record is the unique longest prefix of the incoming transcript.
 * `accept` vets each prefix match (session state, what is left to send). Two or more equally
 * long matches are `'ambiguous'`: the caller must not guess between them.
 */
export function chooseContinuation<T>(
	candidates: ReadonlyArray<{item: T; record: readonly Entry[]}>,
	incoming: readonly Entry[],
	accept: (item: T, consumed: number) => boolean = () => true,
): {item: T; consumed: number} | 'ambiguous' | undefined {
	let best: Array<{item: T; consumed: number}> = [];
	for (const {item, record} of candidates) {
		const consumed = matchRecord(record, incoming);
		if (!consumed || !accept(item, consumed)) continue;
		if (best.length === 0 || consumed > best[0]!.consumed) best = [{item, consumed}];
		else if (consumed === best[0]!.consumed) best.push({item, consumed});
	}
	if (best.length === 0) return undefined;
	if (best.length > 1) return 'ambiguous';
	return best[0];
}

// ---------------------------------------------------------------------------------------------
// Replay

function outputText(output: ToolOutput): string {
	switch (output.type) {
		case 'text':
		case 'error-text':
			return output.value;
		case 'json':
		case 'error-json':
			return JSON.stringify(output.value);
		case 'execution-denied':
			return `denied${output.reason ? `: ${output.reason}` : ''}`;
		case 'content':
			return (output.value as Array<Record<string, unknown>>)
				.map(block => {
					if (block.type === 'text') return String(block.text ?? '');
					if (String(block.type).startsWith('image')) return '[image]';
					return `[${String(block.type)}${block.mediaType ? ` ${String(block.mediaType)}` : ''}]`;
				})
				.join('\n');
		default:
			return String((output as {value?: unknown}).value ?? '');
	}
}

type ReplayItem = {text: string} | {block: ContentBlock};
type ReplayUnit = {items: ReplayItem[]; size: number; user: boolean};

function replayUnits(prompt: Prompt): ReplayUnit[] {
	const units: ReplayUnit[] = [];
	const unit = (items: ReplayItem[], user = false): void => {
		if (items.length === 0) return;
		const size = items.reduce((sum, item) => sum + ('text' in item ? item.text.length + 1 : IMAGE_REPLAY_COST), 0);
		units.push({items, size, user});
	};
	for (const message of prompt) {
		if (message.role === 'user') {
			const blocks = userContentBlocks(message);
			const items: ReplayItem[] = [];
			blocks.forEach((block, index) => {
				if (block.type === 'text') {
					items.push({text: index === 0 ? `user: ${String(block.text)}` : String(block.text)});
				} else {
					if (index === 0) items.push({text: 'user:'});
					items.push({block});
				}
			});
			unit(items, true);
		} else if (message.role === 'assistant') {
			const items: ReplayItem[] = [];
			for (const part of message.content) {
				if (part.type === 'text' && part.text.trim()) items.push({text: `assistant: ${part.text}`});
				else if (part.type === 'tool-call') {
					const input = typeof part.input === 'string' ? part.input : JSON.stringify(part.input);
					items.push({text: `assistant -> ${part.toolName} ${input}`});
				}
			}
			unit(items);
		} else if (message.role === 'tool') {
			const items: ReplayItem[] = [];
			for (const part of message.content) {
				if (part.type === 'tool-result') items.push({text: `tool result (${part.toolName}): ${outputText(part.output)}`});
			}
			unit(items);
		}
	}
	return units;
}

/**
 * Which units fit `maxChars`. The latest user request is always kept, then the newest steps
 * after and before it, plus the opening message when it is small: what falls out is the oldest
 * middle of the conversation.
 */
function selectReplayUnits(units: readonly ReplayUnit[], maxChars: number): boolean[] {
	const total = units.reduce((sum, unit) => sum + unit.size, 0);
	if (total <= maxChars) return units.map(() => true);
	const keep = units.map(() => false);
	if (units.length === 0) return keep;
	let latest = units.length - 1;
	while (latest > 0 && !units[latest]!.user) latest--;
	if (!units[latest]!.user) latest = units.length - 1;
	keep[latest] = true;
	let budget = maxChars - units[latest]!.size;
	if (latest > 0 && units[0]!.size <= Math.min(budget, maxChars / 8)) {
		keep[0] = true;
		budget -= units[0]!.size;
	}
	for (let index = units.length - 1; index > latest; index--) {
		if (units[index]!.size > budget) break;
		keep[index] = true;
		budget -= units[index]!.size;
	}
	for (let index = latest - 1; index > 0; index--) {
		if (units[index]!.size > budget) break;
		keep[index] = true;
		budget -= units[index]!.size;
	}
	return keep;
}

/**
 * The host's history is the source of truth. Render everything it holds as ONE user message so
 * a fresh session sees what the Command Code session sees. User images stay image blocks.
 */
export function replayContent(prompt: Prompt, maxChars = MAX_REPLAY_CHARS): ContentBlock[] {
	const units = replayUnits(prompt);
	const keep = selectReplayUnits(units, maxChars);
	const items: ReplayItem[] = [
		{
			text: [
				'[Replayed host transcript]',
				"The Command Code session's history is authoritative. This single message replays what this",
				'session missed or already holds, so treat it as prior conversation rather than new input.',
				'Continue from the final user request below.',
				'',
			].join('\n'),
		},
	];
	let omitted = 0;
	const flushOmitted = () => {
		if (omitted === 0) return;
		items.push({text: `[... ${omitted} message${omitted === 1 ? '' : 's'} omitted to fit the replay size limit ...]`});
		omitted = 0;
	};
	units.forEach((unit, index) => {
		if (!keep[index]) {
			omitted++;
			return;
		}
		flushOmitted();
		items.push(...unit.items);
	});
	flushOmitted();

	const blocks: ContentBlock[] = [];
	let text: string[] = [];
	const flushText = () => {
		if (text.length === 0) return;
		blocks.push({type: 'text', text: text.join('\n')});
		text = [];
	};
	for (const item of items) {
		if ('text' in item) text.push(item.text);
		else {
			flushText();
			blocks.push(item.block);
		}
	}
	flushText();
	return blocks;
}
