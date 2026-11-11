import type {LanguageModelV3Usage} from '@ai-sdk/provider';

export type RawUsage = {
	input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	output_tokens?: number;
};

const FIELDS = [
	'input_tokens',
	'cache_read_input_tokens',
	'cache_creation_input_tokens',
	'output_tokens',
] as const;

/**
 * Copies only the counters `raw` reports as numbers. A `message_delta` often carries just
 * `output_tokens`, so the input and cache numbers from `message_start` must survive it.
 * Returns whether anything was merged.
 */
export function mergeUsage(into: RawUsage, raw: unknown): boolean {
	if (!raw || typeof raw !== 'object') return false;
	let merged = false;
	for (const field of FIELDS) {
		const value = (raw as Record<string, unknown>)[field];
		if (typeof value === 'number' && Number.isFinite(value)) {
			into[field] = value;
			merged = true;
		}
	}
	return merged;
}

export function toUsage(raw: RawUsage): LanguageModelV3Usage {
	const input = raw.input_tokens;
	const cacheRead = raw.cache_read_input_tokens;
	const cacheWrite = raw.cache_creation_input_tokens;
	const output = raw.output_tokens;
	const anyInput = input !== undefined || cacheRead !== undefined || cacheWrite !== undefined;
	return {
		inputTokens: {
			total: anyInput ? (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) : undefined,
			noCache: input,
			cacheRead,
			cacheWrite,
		},
		outputTokens: {total: output, text: output, reasoning: undefined},
		raw: {...raw},
	};
}
