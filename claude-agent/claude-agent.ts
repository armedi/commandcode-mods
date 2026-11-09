import {disposeAllSessions} from './src/bridge.ts';
import {startLocalProvider} from './src/local-provider.ts';

type ModHost = {
	on?: (event: string, handler: (...args: unknown[]) => void) => unknown;
};

export default async function (cmd: ModHost): Promise<void> {
	// Bind a loopback port and write its URL into providers.json, which is what makes the
	// host draw the `claude-agent` group in /model. Requests to it run through the SDK.
	await startLocalProvider();

	// A reload or session teardown replaces the host; close the SDK subprocesses we own
	// instead of leaving them parentless.
	cmd.on?.('session_shutdown', () => disposeAllSessions());
	process.once('exit', () => {
		try {
			disposeAllSessions();
		} catch {}
	});
}
