import {query} from '@anthropic-ai/claude-agent-sdk/core';

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelSpec = {
	id: string;
	name: string;
	reasoningEfforts?: readonly ReasoningEffort[];
};

type CliModel = {
	value: string;
	displayName?: string;
	supportedEffortLevels?: readonly string[];
};

const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function specsFromCli(models: readonly CliModel[]): ModelSpec[] {
	const specs: ModelSpec[] = [];
	const seen = new Set<string>();
	for (const model of models) {
		const id = typeof model.value === 'string' ? model.value.trim() : '';
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const efforts = Array.isArray(model.supportedEffortLevels)
			? model.supportedEffortLevels.filter((level): level is ReasoningEffort => EFFORTS.has(level))
			: [];
		specs.push({
			id,
			name:
				typeof model.displayName === 'string' && model.displayName ? model.displayName : id,
			...(efforts.length > 0 ? {reasoningEfforts: efforts} : {}),
		});
	}
	return specs;
}

/** Ask the Claude CLI which models this account can use. */
export async function fetchCliModelSpecs(): Promise<ModelSpec[]> {
	const session = query({
		prompt: 'ready',
		options: {
			persistSession: false,
			settingSources: [],
			strictMcpConfig: true,
		},
	} as never);
	try {
		return specsFromCli(await session.supportedModels());
	} finally {
		session.close();
	}
}

export function normalizeModelSpecs(value: unknown): ModelSpec[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const specs = value.filter((spec): spec is ModelSpec => {
		if (!spec || typeof spec !== 'object') return false;
		const candidate = spec as Partial<ModelSpec>;
		return (
			typeof candidate.id === 'string' &&
			candidate.id.length > 0 &&
			typeof candidate.name === 'string'
		);
	});
	return specs.length > 0 ? specs : undefined;
}
