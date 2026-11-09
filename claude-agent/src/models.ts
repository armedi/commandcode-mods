export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelSpec = {
	id: string;
	provider: 'claude-agent';
	contextWindow: number;
	reasoningEfforts?: readonly ReasoningEffort[];
	inputModalities: readonly ['text', 'image'];
	interleavedThinking?: boolean;
};

const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function spec(id: string, contextWindow = 1_000_000, reasoning = true): ModelSpec {
	return {
		id,
		provider: 'claude-agent',
		contextWindow,
		reasoningEfforts: reasoning ? EFFORTS : undefined,
		inputModalities: ['text', 'image'],
		interleavedThinking: true,
	};
}

export const MODEL_SPECS: readonly ModelSpec[] = [
	spec('claude-sonnet-5-5'),
	spec('claude-sonnet-5'),
	spec('claude-sonnet-4-6'),
	spec('claude-opus-5-5'),
	spec('claude-opus-5'),
	spec('claude-opus-4-8'),
	spec('claude-opus-4-7'),
	spec('claude-fable-5-1'),
	spec('claude-fable-5'),
	spec('claude-haiku-5-5'),
	spec('claude-haiku-4-5-20251001', 200_000, false),
];

export const MODEL_IDS: ReadonlySet<string> = new Set(MODEL_SPECS.map(model => model.id));

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
	return SDK_MODEL_IDS[modelId] ?? modelId;
}
