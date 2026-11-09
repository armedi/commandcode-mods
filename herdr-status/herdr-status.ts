import { closeSync, openSync, writeSync } from 'node:fs';

type ModHost = {
	getSessionName?: () => string | undefined;
	hooks: (hooks: {
		onSessionStart?: () => void;
		onSessionEnd?: () => void;
		onPermissionRequest?: (request: { description?: string; toolName: string }) =>
			| 'allow'
			| 'deny'
			| undefined;
		beforeToolCall?: (call: { toolName: string; input?: any }) => unknown;
	}) => unknown;
	on: (event: string, handler: (event?: any) => void) => unknown;
};

const APP = 'command-code';
const OSC = '\x1b]7501;';
const ST = '\x1b\\';

let title: string | undefined;

function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 2000);
}

function encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function emit(state: string, extra: Record<string, string> = {}): void {
  if (!process.env.HC_TERMINAL_ID) return;
  const pairs = [`state=${state}`, `app=${APP}`];
  for (const [key, value] of Object.entries(extra)) if (value) pairs.push(`${key}=${value}`);
  const sequence = `${OSC}${pairs.join(':')}${ST}`;
  try {
    const fd = openSync('/dev/tty', 'w');
    try {
      writeSync(fd, sequence);
    } finally {
      closeSync(fd);
    }
  } catch {
    // No controlling terminal (headless runs): status is not observable there.
  }
}

export default function herdrStatus(cmd: ModHost): void {
  if (!process.env.HC_TERMINAL_ID) return;

  let working = false;

  const report = (state: string, opts: { msg?: string; kind?: string } = {}) => {
    emit(state, {
      ...(title ? { title: encode(oneLine(title)) } : {}),
      ...(opts.msg ? { msg: encode(oneLine(opts.msg)) } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
    });
  };

  const rememberTitle = () => {
    const name = cmd.getSessionName?.();
    if (name) title = name;
  };

  cmd.hooks({
    onSessionStart: () => {
      rememberTitle();
      report('idle');
    },
    onSessionEnd: () => emit('clear'),
    onPermissionRequest: ({ description, toolName }) => {
      report('blocked', {
        kind: 'permission',
        msg: description || `Approve ${toolName}`,
      });
      return undefined;
    },
    beforeToolCall: ({ toolName, input }) => {
      if (toolName === 'ask_user_question') {
        const questions = Array.isArray(input?.questions) ? input.questions : [];
        report('blocked', {
          kind: 'question',
          msg: questions[0]?.question ?? 'Waiting for your answer',
        });
      }
      return undefined;
    },
  });

  cmd.on('run_start', () => {
    working = true;
    report('working');
  });

  cmd.on('tool_running', () => {
    if (working) report('working');
  });

  cmd.on('tool_completed', () => {
    if (working) report('working');
  });

  cmd.on('tool_errored', () => {
    if (working) report('working');
  });

  cmd.on('interrupted', () => {
    working = false;
    report('idle');
  });

  cmd.on('run_end', (event: any) => {
    working = false;
    const reason = event?.result?.stopReason;
    if (reason === 'interrupted' || reason === 'permission_denied') report('idle');
    else if (reason === 'error') report('error', { msg: 'Run failed' });
    else report('done');
  });

  cmd.on('run_error', () => report('error', { msg: 'Run failed' }));

  cmd.on('session_titled', (event: any) => {
    if (event?.title) {
      title = event.title;
      report(working ? 'working' : 'idle');
    }
  });
}
