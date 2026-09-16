// FRACTAL: implements F1 | component C9
import type { z } from 'zod';
import { err } from '@/core/errors';

function fieldList(issues: z.ZodIssue[]): string[] {
  const names = issues.map((i) => (i.path.length === 0 ? 'request' : i.path.join('.')));
  return Array.from(new Set(names));
}

/**
 * WHY (H12): the learner is told WHICH field is wrong and never shown their own
 * submitted value echoed back, and zod's own message text is discarded because it
 * embeds the received value.
 */
function validationError(issues: z.ZodIssue[], subject: string): Error {
  const fields = fieldList(issues);
  return err('validation', {
    detail: `${subject} failed validation on: ${fields.join(', ')}`,
    userMessage:
      fields.length === 1
        ? `Check the "${fields[0]}" field — that value isn't valid.`
        : `Check these fields — those values aren't valid: ${fields.join(', ')}.`,
  });
}

export function parseValue<S extends z.ZodTypeAny>(schema: S, value: unknown, subject: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError(parsed.error.issues, subject);
  return parsed.data;
}

export async function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await req.text());
  } catch {
    throw err('validation', {
      detail: 'request body was not valid JSON',
      userMessage: "We couldn't read that request. Try again.",
    });
  }
  return parseValue(schema, raw, 'request body');
}

export function parseQuery<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  const url = new URL(req.url);
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams) raw[k] = v;
  return parseValue(schema, raw, 'query string');
}

/** Every `:id` segment is pattern-constrained here, before it can reach a service or a path. */
export function parseParam<S extends z.ZodTypeAny>(schema: S, value: string | undefined, field: string): z.infer<S> {
  if (typeof value !== 'string') {
    throw err('validation', { detail: `route parameter ${field} was absent`, userMessage: `That link is missing its ${field}.` });
  }
  const decoded = ((): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      throw err('validation', { detail: `route parameter ${field} was not decodable`, userMessage: 'That link is not valid.' });
    }
  })();
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw err('validation', {
      detail: `route parameter ${field} did not match its id pattern`,
      userMessage: 'That link is not valid.',
    });
  }
  return parsed.data;
}
