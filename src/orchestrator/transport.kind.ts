// FRACTAL: implements F2, F12 | component C4
import { assertNotInRelease } from '@/core/release';
import type { CliChildHandle, CliTransport, SpawnOptions } from '@/cli/run-session';

assertNotInRelease('orchestrator/transport.kind');

export type KindResponder = (kind: string, prompt: string) => unknown | 'fail' | 'hang';

export type KindTransportOptions = {
  responder: KindResponder;
  latencyMs?: number;
};

class KindChildHandle implements CliChildHandle {
  readonly pid = 5150;
  private buffer = '';
  private killed = false;
  private exited = false;
  private readonly stdoutCbs: ((chunk: Buffer) => void)[] = [];
  private readonly exitCbs: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private readonly errorCbs: ((e: Error) => void)[] = [];

  constructor(private readonly opts: KindTransportOptions) {}

  write(data: string): void {
    this.buffer += data;
  }

  endStdin(): void {
    const firstLine = this.buffer.split('\n')[0] ?? '';
    const match = /^KIND:\s*(.+)$/.exec(firstLine.trim());
    const kind = match ? match[1].trim() : 'author-module';
    const reply = this.opts.responder(kind, this.buffer);
    if (reply === 'hang') return;
    const emit = (): void => {
      if (this.killed || this.exited) return;
      if (reply === 'fail') {
        this.finish(1, null);
        return;
      }
      const line = `${JSON.stringify(reply)}\n`;
      for (const cb of this.stdoutCbs) cb(Buffer.from(line, 'utf8'));
      this.finish(0, null);
    };
    if (this.opts.latencyMs && this.opts.latencyMs > 0) {
      setTimeout(emit, this.opts.latencyMs);
    } else {
      queueMicrotask(emit);
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb(code, signal);
  }

  onStdout(cb: (chunk: Buffer) => void): void {
    this.stdoutCbs.push(cb);
  }
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitCbs.push(cb);
  }
  onError(cb: (e: Error) => void): void {
    this.errorCbs.push(cb);
  }
  kill(signal: NodeJS.Signals): void {
    this.killed = true;
    this.finish(null, signal);
  }
}

// WHY: the out-of-process twin at e2e/fixtures/fake-claude.mjs selects its reply
// from the same "KIND: <kind>" first line that src/cli/prompt.ts emits. This
// in-process transport reads that same line, so the orchestrator tests exercise
// the real SessionRunner, the real argv build and the real schema validation
// without ever spawning the real `claude` CLI.
export class KindTransport implements CliTransport {
  readonly spawns: { kind: string; argv: string[] }[] = [];

  constructor(private readonly opts: KindTransportOptions) {}

  spawn(_bin: string, argv: string[], _spawnOpts: SpawnOptions): CliChildHandle {
    this.spawns.push({ kind: 'pending', argv });
    return new KindChildHandle(this.opts);
  }
}
