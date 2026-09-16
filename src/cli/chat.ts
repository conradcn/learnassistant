// FRACTAL: implements F6 | component C2
/**
 * The one thing every provider that is a chat endpoint shares: turning the single prompt
 * buildPrompt produced, plus the role instruction SessionRunner passes the CLI as
 * `--system-prompt`, into the system/user pair a chat API expects.
 */

export type ChatMessage = { role: 'system' | 'user'; content: string };

/**
 * The `--system-prompt` value out of the argv SessionRunner built.
 *
 * WHY it is read from argv rather than passed as a second field: the argv is already the
 * one description of a session every transport is handed, and the CLI reads exactly this
 * flag from it. A chat adapter that ignored it ran the tutor prompt without ever being
 * told it was a tutor — the same session, silently a different job. Reading it here means
 * every HTTP provider gets the instruction the CLI gets, and no adapter has to know.
 */
export function systemPromptOf(argv: readonly string[]): string {
  const at = argv.indexOf('--system-prompt');
  if (at < 0 || at + 1 >= argv.length) return '';
  return argv[at + 1];
}

/**
 * WHY there is no second copy of the prompt text here: the halves are exactly the text
 * C4 previewed to the learner (H8), only addressed to the right roles. A small local
 * model follows an output contract given as a system instruction and ignores the same
 * words buried at the end of a long user message.
 *
 * WHY the role instruction goes first and the contract second: they are read in that
 * order — who you are, then what shape your answer takes — and the contract is the part a
 * weaker model most needs adjacent to the end of the system message.
 */
export function splitPrompt(prompt: string, systemPrefix = ''): ChatMessage[] {
  const role = systemPrefix.trim();
  const marker = prompt.indexOf('OUTPUT CONTRACT');
  if (marker < 0) {
    const user: ChatMessage = { role: 'user', content: prompt };
    return role === '' ? [user] : [{ role: 'system', content: role }, user];
  }
  const contract = prompt.slice(marker).trim();
  return [
    { role: 'system', content: role === '' ? contract : `${role}\n\n${contract}` },
    { role: 'user', content: prompt.slice(0, marker).trim() },
  ];
}
