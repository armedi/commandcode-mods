import {createHash} from 'node:crypto';
import type {LanguageModelV3CallOptions} from '@ai-sdk/provider';

type PromptMessage = LanguageModelV3CallOptions['prompt'][number];
type ToolResultPart = Extract<
	Extract<PromptMessage, {role: 'tool'}>['content'][number],
	{type: 'tool-result'}
>;

const MAX_REPLAY_CHARS = 400_000;

export function hashText(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function textOfUserMessage(message: PromptMessage): string {
	if (message.role !== 'user') return '';
	return message.content
		.map(part => (part.type === 'text' ? part.text : '[image]'))
		.join('\n')
		.trim();
}

function outputText(output: ToolResultPart['output']): string {
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
				.map(block => (block.type === 'text' ? String(block.text ?? '') : `[${String(block.type)}]`))
				.join('\n');
		default:
			return String((output as {value?: unknown}).value ?? '');
	}
}

/**
 * The part of the prompt the SDK session is expected to already hold: user turns and tool
 * results (the SDK generates the assistant halves itself). Assistant messages are skipped so a
 * host-side re-render of our own output never reads as divergence.
 */
export function promptSequence(prompt: LanguageModelV3CallOptions['prompt']): string[] {
	const sequence: string[] = [];
	for (const message of prompt) {
		if (message.role === 'user') {
			sequence.push(`u:${hashText(textOfUserMessage(message))}`);
		} else if (message.role === 'tool') {
			for (const part of message.content) {
				if (part.type === 'tool-result') {
					sequence.push(`t:${part.toolCallId}:${hashText(outputText(part.output))}`);
				}
			}
		}
	}
	return sequence;
}

function isPrefix(conveyed: readonly string[], incoming: readonly string[]): boolean {
	if (conveyed.length > incoming.length) return false;
	return conveyed.every((entry, index) => entry === incoming[index]);
}

/** True when the host's transcript can be continued incrementally. */
export function continuesSession(conveyed: readonly string[], incoming: readonly string[]): boolean {
	return conveyed.length > 0 && isPrefix(conveyed, incoming);
}

/** True when a fresh SDK session must be primed with the host's existing transcript. */
export function needsReplay(prompt: LanguageModelV3CallOptions['prompt']): boolean {
	if (prompt.some(message => message.role === 'assistant')) return true;
	return prompt.filter(message => message.role === 'user').length > 1;
}

/**
 * The host's history is the source of truth. Render everything it currently holds as ONE user
 * message, so a resumed or switched session sees exactly what the Command Code session sees.
 */
export function replayText(prompt: LanguageModelV3CallOptions['prompt']): string {
	const lines: string[] = [];
	for (const message of prompt) {
		if (message.role === 'system') continue;
		if (message.role === 'user') {
			lines.push(`user: ${textOfUserMessage(message)}`);
			continue;
		}
		if (message.role === 'assistant') {
			for (const part of message.content) {
				if (part.type === 'text' && part.text.trim()) lines.push(`assistant: ${part.text}`);
				else if (part.type === 'tool-call') lines.push(`assistant -> ${part.toolName} ${part.input}`);
			}
			continue;
		}
		for (const part of message.content) {
			if (part.type === 'tool-result') {
				lines.push(`tool result (${part.toolName}): ${outputText(part.output)}`);
			}
		}
	}

	let body = lines.join('\n');
	if (body.length > MAX_REPLAY_CHARS) body = `${body.slice(0, MAX_REPLAY_CHARS)}\n[... transcript truncated ...]`;

	return [
		'[Replayed host transcript]',
		"The Command Code session's history is authoritative. This single message replays what this",
		'session missed or already holds, so treat it as prior conversation rather than new input.',
		'Continue from the final user request below.',
		'',
		body,
	].join('\n');
}
