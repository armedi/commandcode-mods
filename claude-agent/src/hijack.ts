import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {LanguageModelV3CallOptions} from '@ai-sdk/provider';
import {createClaudeAgentModel} from './bridge.ts';
import {fetchCliModelSpecs, normalizeModelSpecs, type ModelSpec} from './models.ts';

const PROVIDER_ID = 'claude-agent';
const PROVIDER_NAME = 'Claude Agent';
const BRIDGE_BASE_URL = 'http://claude-agent.local/v1';
const MODEL_PREFIX = 'claude-agent/';
const CACHE_KEY = 'modelSpecs';
const DEBUG = process.env.CLAUDE_AGENT_MOD_DEBUG === '1';

type ModelStore = {
	get: (key: string) => unknown;
	set: (key: string, value: unknown) => Promise<void>;
};

function debug(...args: unknown[]): void {
	if (DEBUG) console.error('[claude-agent]', ...args);
}

function writeProviderEntry(specs: readonly ModelSpec[]): void {
	const file = join(homedir(), '.commandcode', 'providers.json');
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
	const models: Record<string, unknown> = {};
	for (const spec of specs) {
		models[spec.id] = {
			name: spec.name,
			...(spec.reasoningEfforts?.length
				? {reasoningEfforts: [...spec.reasoningEfforts]}
				: {}),
		};
	}
	const entry = {
		...existing,
		name: typeof existing.name === 'string' && existing.name ? existing.name : PROVIDER_NAME,
		api: 'anthropic-messages',
		baseURL: BRIDGE_BASE_URL,
		apiKey: existing.apiKey ?? false,
		models,
	};
	if (JSON.stringify(config[key][PROVIDER_ID] ?? null) === JSON.stringify(entry)) return;
	config[key][PROVIDER_ID] = entry;
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(file), {recursive: true});
		writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
		renameSync(tmp, file);
		debug('providers.json updated', file, specs.length);
	} catch (error) {
		console.error('[claude-agent] could not write providers.json', error);
	}
}

function bareModelId(modelId: string): string {
	return modelId.startsWith(MODEL_PREFIX) ? modelId.slice(MODEL_PREFIX.length) : modelId;
}

function isBridgeModel(model: any): boolean {
	const baseURL = model?.config?.baseURL;
	return (
		typeof baseURL === 'string' &&
		baseURL.replace(/\/+$/, '') === BRIDGE_BASE_URL.replace(/\/+$/, '')
	);
}

type HijackMark = {doStream: Function; doGenerate: Function};
const HIJACK = Symbol.for('cmd.claude-agent.hijack');

function patchModelPrototype(proto: any): void {
	const previous: HijackMark | undefined = proto[HIJACK];
	const originalDoStream = previous?.doStream ?? proto.doStream;
	const originalDoGenerate = previous?.doGenerate ?? proto.doGenerate;

	proto.doStream = function (this: any, options: LanguageModelV3CallOptions) {
		if (isBridgeModel(this))
			return createClaudeAgentModel(this.modelId, bareModelId(this.modelId)).doStream(options);
		return originalDoStream.call(this, options);
	};
	proto.doGenerate = function (this: any, options: LanguageModelV3CallOptions) {
		if (isBridgeModel(this))
			return createClaudeAgentModel(this.modelId, bareModelId(this.modelId)).doGenerate(options);
		return originalDoGenerate.call(this, options);
	};
	proto[HIJACK] = {doStream: originalDoStream, doGenerate: originalDoGenerate};
}

async function patchAnthropicModels(probeModelId: string): Promise<void> {
	const require = createRequire(process.argv[1] ?? import.meta.url);
	const cjs = require.resolve('@ai-sdk/anthropic');
	const esm = cjs.replace(/index\.c?js$/, 'index.mjs');
	const mod: any = await import(pathToFileURL(esm).href);
	if (typeof mod.createAnthropic !== 'function')
		throw new Error('@ai-sdk/anthropic does not export createAnthropic');
	const probe = mod.createAnthropic({baseURL: BRIDGE_BASE_URL, apiKey: 'claude-agent'})(probeModelId);
	patchModelPrototype(Object.getPrototypeOf(probe));
}

async function refreshModelSpecs(store?: ModelStore, current?: readonly ModelSpec[]): Promise<void> {
	try {
		const specs = await fetchCliModelSpecs();
		if (specs.length === 0) return;
		if (current && JSON.stringify(current) === JSON.stringify(specs)) return;
		writeProviderEntry(specs);
		try {
			await store?.set(CACHE_KEY, specs);
		} catch {}
		debug('model list refreshed', specs.length);
	} catch (error) {
		debug('model list refresh failed', error);
	}
}

export async function installProviderHijack(options: {store?: ModelStore} = {}): Promise<void> {
	const cached = normalizeModelSpecs(options.store?.get(CACHE_KEY));
	let specs = cached;

	if (cached) {
		writeProviderEntry(cached);
		void refreshModelSpecs(options.store, cached);
	} else {
		try {
			specs = await fetchCliModelSpecs();
			if (specs.length > 0) {
				writeProviderEntry(specs);
				try {
					await options.store?.set(CACHE_KEY, specs);
				} catch {}
			} else {
				console.error('[claude-agent] the Claude CLI returned no models');
				specs = undefined;
			}
		} catch (error) {
			console.error('[claude-agent] could not read the Claude model list', error);
			specs = undefined;
		}
	}

	try {
		await patchAnthropicModels(specs?.[0]?.id ?? 'sonnet');
		debug('anthropic model hijack installed', BRIDGE_BASE_URL);
	} catch (error) {
		console.error(
			'[claude-agent] could not hook @ai-sdk/anthropic; the Claude Agent group will not route',
			error,
		);
	}
}
