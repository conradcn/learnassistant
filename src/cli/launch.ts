// FRACTAL: implements F6 | component C2
/**
 * One place that knows how to turn "the Claude CLI binary" into arguments Node's
 * `spawn` will actually accept.
 *
 * WHY this exists: on Windows the Claude CLI is installed as a `claude.cmd` shim, and
 * since Node 18.20/20.12 `spawn` refuses to execute a `.cmd` or `.bat` unless it is
 * routed through a command interpreter — it raises EINVAL/ENOENT instead. Every call
 * site here previously passed `shell: false` and so could never invoke the CLI on
 * Windows at all; the failure surfaced as a permanent `cli-missing`.
 *
 * The fix deliberately does NOT set `shell: true`. Doing so would concatenate the
 * binary path and every argument into a single string parsed by cmd.exe, which turns
 * any `&`, `|` or `^` in a module directory name into a command separator. Instead the
 * interpreter is invoked directly with the batch file as a discrete argument, and
 * `windowsVerbatimArguments` is used with explicit quoting so cmd.exe receives exactly
 * the tokens intended. Non-Windows platforms, and Windows executables that are not
 * batch shims, are spawned unchanged.
 */

const BATCH_SHIM = /\.(cmd|bat)$/i;

export type LaunchPlan = {
  /** The executable to hand to `spawn`. */
  command: string;
  /** The full argument vector to hand to `spawn`. */
  args: string[];
  /** Whether `spawn` must be given `windowsVerbatimArguments`. */
  verbatim: boolean;
};

/** Quotes a token for cmd.exe verbatim-argument passing. */
function quoteForCmd(token: string): string {
  // WHY: with windowsVerbatimArguments the caller owns quoting entirely. Wrapping in
  // double quotes protects spaces; a literal double quote inside a token is escaped so
  // it cannot terminate the quoted run and let the rest be read as a new argument.
  return `"${token.replace(/"/g, '\\"')}"`;
}

export function planLaunch(bin: string, argv: readonly string[]): LaunchPlan {
  if (process.platform !== 'win32' || !BATCH_SHIM.test(bin)) {
    return { command: bin, args: [...argv], verbatim: false };
  }
  const interpreter = process.env.ComSpec ?? 'cmd.exe';
  return {
    command: interpreter,
    // /d skips AutoRun commands from the registry, /c runs the command and exits, and
    // /s makes cmd strip exactly one enclosing pair of quotes from the rest of the line
    // — which is why the whole command is wrapped in its own pair here. Without that
    // wrapper /s would strip the quotes around the executable instead and cmd would
    // read the path and its arguments as a single unrecognised command name.
    args: ['/d', '/s', '/c', `"${[quoteForCmd(bin), ...argv.map(quoteForCmd)].join(' ')}"`],
    verbatim: true,
  };
}
