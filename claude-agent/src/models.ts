export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelSpec = {
	id: string;
	name: string;
	contextWindow: number;
	reasoningEfforts?: readonly ReasoningEffort[];
};

const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function spec(
	id: string,
	name: string,
	contextWindow = 1_000_000,
	reasoning = true,
): ModelSpec {
	return {
		id,
		name,
		contextWindow,
		reasoningEfforts: reasoning ? EFFORTS : undefined,
	};
}

export const MODEL_SPECS: readonly ModelSpec[] = [
	spec('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
	spec('claude-sonnet-5', 'Claude Sonnet 5'),
	spec('claude-sonnet-4-6', 'Claude Sonnet 4.6'),
	spec('claude-opus-5-5', 'Claude Opus 5.5'),
	spec('claude-opus-5', 'Claude Opus 5'),
	spec('claude-opus-4-8', 'Claude Opus 4.8'),
	spec('claude-opus-4-7', 'Claude Opus 4.7'),
	spec('claude-fable-5-1', 'Claude Fable 5.1'),
	spec('claude-fable-5', 'Claude Fable 5'),
	spec('claude-haiku-5-5', 'Claude Haiku 5.5'),
	spec('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200_000, false),
];

/**
 * The Claude Code CLI names the newest models by alias. Catalog ids that this account
 * exposes only through an alias are mapped here before they reach the Agent SDK.
 */
export const SDK_MODEL_IDS: Readonly<Record<string, string>> = {
	'claude-sonnet-5-5': 'sonnet',
	'claude-opus-5-5': 'opus',
	'claude-haiku-5-5': 'haiku',
};

export function sdkModelId(modelId: string): string {
	const bare = modelId.startsWith('claude-agent/')
		? modelId.slice('claude-agent/'.length)
		: modelId;
	return SDK_MODEL_IDS[bare] ?? bare;
}
