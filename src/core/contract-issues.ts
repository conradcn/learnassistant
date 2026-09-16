// FRACTAL: implements (none) | component C0
import type { z } from 'zod';

/**
 * The field paths and issue codes of a failed parse, and nothing else. `path` is a list of
 * schema keys and array indices, and `code` is one of zod's own enum values, so neither can
 * carry model-authored text — which is why `contractIssues` is exempt from scrubbing.
 *
 * WHY it lives in C0: both the component that runs a model session and the one that
 * validates what a session wrote need to say which field of a contract was wrong, and a
 * copy in each would drift into two different formats in the one log field meant to be
 * read across both.
 */
export function contractIssuesOf(error: z.ZodError, limit = 12): string[] {
  return error.issues
    .slice(0, limit)
    .map((i) => `${i.path.length === 0 ? '(root)' : i.path.join('.')}:${i.code}`);
}
