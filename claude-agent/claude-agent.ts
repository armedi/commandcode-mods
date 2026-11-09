import {disposeAllSessions} from './src/bridge.ts';
import {claudeAgentProvider} from './src/provider.ts';

type ModHost = {
	addProvider: (module: unknown) => unknown;
	on?: (event: string, handler: (...args: unknown[]) => void) => unknown;
};

export default function (cmd: ModHost): void {
	cmd.addProvider(claudeAgentProvider);

	// A reload or session teardown replaces the host; close the SDK subprocesses we own
	// instead of leaving them parentless.
	cmd.on?.('session_shutdown', () => disposeAllSessions());
	process.once('exit', () => {
		try {
			disposeAllSessions();
		} catch {}
	});
}
