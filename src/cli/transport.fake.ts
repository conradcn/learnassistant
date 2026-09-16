// FRACTAL: implements F6 | component C2
import { assertNotInRelease } from '@/core/release';
import type { CliChildHandle, CliTransport, SpawnOptions } from '@/cli/run-session';

assertNotInRelease('cli/transport.fake');

export type FakeScript = {
  stdoutChunks?: string[];
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  neverExit?: boolean;
  spawnError?: NodeJS.ErrnoException;
  delayMsBeforeExit?: number;
};

class FakeChildHandle implements CliChildHandle {
  readonly pid = 4242;
  private killed = false;
  private killedSignals: NodeJS.Signals[] = [];
  private stdoutCbs: ((chunk: Buffer) => void)[] = [];
  private exitCbs: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private errorCbs: ((err: Error) => void)[] = [];
  private exited = false;

  constructor(private readonly script: FakeScript) {
    if (script.spawnError) {
      queueMicrotask(() => {
        for (const cb of this.errorCbs) cb(script.spawnError as Error);
      });
      return;
    }
    void this.play();
  }

  private async play(): Promise<void> {
    for (const chunk of this.script.stdoutChunks ?? []) {
      if (this.killed) return;
      await new Promise((r) => setTimeout(r, 0));
      for (const cb of this.stdoutCbs) cb(Buffer.from(chunk, 'utf8'));
    }
    if (this.script.neverExit) return;
    if (this.script.delayMsBeforeExit) {
      await new Promise((r) => setTimeout(r, this.script.delayMsBeforeExit));
    }
    if (this.killed) return;
    this.finishExit(this.script.exitCode ?? 0, this.script.exitSignal ?? null);
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb(code, signal);
  }

  write(): void {}
  endStdin(): void {}
  onStdout(cb: (chunk: Buffer) => void): void {
    this.stdoutCbs.push(cb);
  }
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitCbs.push(cb);
  }
  onError(cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
  }
  kill(signal: NodeJS.Signals): void {
    this.killed = true;
    this.killedSignals.push(signal);
    this.finishExit(null, signal);
  }
}

export class FakeTransport implements CliTransport {
  private nextScript: FakeScript = { stdoutChunks: ['{}'], exitCode: 0 };

  queue(script: FakeScript): void {
    this.nextScript = script;
  }

  spawn(_bin: string, _argv: string[], _opts: SpawnOptions): CliChildHandle {
    return new FakeChildHandle(this.nextScript);
  }
}
