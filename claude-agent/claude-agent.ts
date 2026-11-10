import {disposeAllSessions} from './src/bridge.ts';
import {installProviderHijack} from './src/hijack.ts';

type ModHost = {
	on?: (event: string, handler: (...args: unknown[]) => void) => unknown;
	store?: {
		get: (key: string) => unknown;
		set: (key: string, value: unknown) => Promise<void>;
	};
};

export default async function (cmd: ModHost): Promise<void> {
	// providers.json gives /model the `claude-agent` group; the hijack makes the host's
	// Anthropic model call the Agent SDK directly, so there is no wire translation or server.
	await installProviderHijack({store: cmd.store});

	// A reload or session teardown replaces the host; close the SDK subprocesses we own
	// instead of leaving them parentless.
	cmd.on?.('session_shutdown', () => disposeAllSessions());
	process.once('exit', () => {
		try {
			disposeAllSessions();
		} catch {}
	});
}
