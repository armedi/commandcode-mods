import {createClaudeAgentModel} from './bridge.ts';
import {MODEL_IDS, MODEL_SPECS, sdkModelId} from './models.ts';

export const claudeAgentProvider = {
	id: 'claude-agent',
	displayName: 'Claude Agent',
	models: MODEL_SPECS,
	matchesModelId: (modelId: string) => MODEL_IDS.has(modelId),
	transport: {
		kind: 'aisdk',
		buildModel: ({model, threadId}: {model: string; threadId?: string}) =>
			createClaudeAgentModel(model, sdkModelId(model), threadId),
	},
};
