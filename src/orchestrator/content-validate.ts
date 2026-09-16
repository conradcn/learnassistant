// FRACTAL: implements F2, F12 | component C4
import { z } from 'zod';
import {
  explanationSchema,
  moduleContentSchema,
  prereqEdgeSchema,
  type Explanation,
  type ModuleContent,
  type ModuleId,
  type PrereqEdge,
} from '@/shapes';
import { err } from '@/core/errors';
import { contractIssuesOf } from '@/core/contract-issues';
import { log } from '@/core/log';

export const CONTENT_VERSION = 1;
export const MAX_CONTENT_BYTES = 1024 * 1024;
export const VIDEO_HOST_ALLOWLIST: readonly string[] = ['youtube.com', 'youtu.be', 'vimeo.com'];

export const contentEnvelopeSchema = z.object({
  contentVersion: z.number().int().min(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  content: moduleContentSchema,
});
export type ContentEnvelope = z.infer<typeof contentEnvelopeSchema>;

export type ContentLoad =
  | { ok: true; content: ModuleContent; digest: string }
  | { ok: false; degradedReason: string };

export type ValidatedContent = { content: ModuleContent; coercions: string[] };

function hostAllowed(host: string): boolean {
  const lower = host.toLowerCase();
  return VIDEO_HOST_ALLOWLIST.some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`));
}

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i;

// WHY (security default-deny): the allow condition is computed and everything
// else is refused — an unparseable, non-https, credentialed, private-range or
// non-allowlisted URL all fall through to the same rejection.
export function isAllowedVideoUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  if (PRIVATE_HOST_RE.test(parsed.hostname)) return false;
  return hostAllowed(parsed.hostname);
}

export function sanitizeExplanation(raw: unknown): { explanation: Explanation; coercion: string | null } {
  const parsed = explanationSchema.safeParse(raw);
  if (!parsed.success) {
    throw err('validation', { detail: 'model explanation failed shape validation' });
  }
  const value = parsed.data;
  if (value.kind !== 'video') return { explanation: value, coercion: null };
  if (isAllowedVideoUrl(value.url)) return { explanation: value, coercion: null };
  return {
    explanation: {
      kind: 'text',
      markdown: `A video link was suggested for this lesson but it wasn't from a site we trust, so here is the written version instead.\n\n**${value.title}** — ${value.why}`,
    },
    coercion: 'video link replaced with text: the link was not an https link to YouTube or Vimeo',
  };
}

export { contractIssuesOf };

export type ContentValidation =
  | { ok: true; content: ModuleContent; coercions: string[] }
  | { ok: false; issues: string[] };

// WHY the `explanation.` prefix is applied here: the explanation is parsed on its own,
// before the whole object, so its issue paths come back rooted at the explanation rather
// than at the lesson. Handed to a session unchanged, `kind:invalid_union_discriminator`
// reads as the block kind that is wrong far more often than it reads as the explanation.
function underExplanation(issues: string[]): string[] {
  return issues.map((i) => (i.startsWith('(root):') ? `explanation:${i.slice('(root):'.length)}` : `explanation.${i}`));
}

// WHY: this is the ingest point for UNTRUSTED model-generated content — every
// field is schema-validated and the one field that becomes a clickable URL is
// host-allowlisted before anything is persisted.
//
// WHY it reports the issues rather than only refusing: a lesson that fails this check is
// thrown away whole, and the one thing that would let the session fix it — which field was
// wrong — used to die inside the exception. The contract patch loop (C4) hands these paths
// back to the session that wrote them, so the paths are part of the return value now and
// not merely a log line.
export function tryValidateModuleContent(raw: unknown): ContentValidation {
  const refused = (issues: string[]): ContentValidation => {
    // WHY logged here rather than left to the caller: an authoring session that answers but
    // fails this check is the one failure the learner pays for and nobody can explain —
    // the caller reports "wasn't in a form we could save", and the reason died with the
    // exception. Only the field path and the zod issue code are recorded, so the record
    // says which part of the lesson was malformed without copying the lesson.
    log({ level: 'error', event: 'content-validation-failed', component: 'C4', contractIssues: issues });
    return { ok: false, issues };
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refused(['(root):invalid_type']);
  }
  const record = raw as Record<string, unknown>;
  const explanation = explanationSchema.safeParse(record.explanation);
  if (!explanation.success) {
    return refused(underExplanation(contractIssuesOf(explanation.error)));
  }
  // The video allowlist is a coercion and never a refusal: a bad link becomes text.
  const sanitized = sanitizeExplanation(explanation.data);
  const parsed = moduleContentSchema.safeParse({ ...record, explanation: sanitized.explanation });
  if (!parsed.success) {
    return refused(contractIssuesOf(parsed.error));
  }
  return { ok: true, content: parsed.data, coercions: sanitized.coercion === null ? [] : [sanitized.coercion] };
}

/** The refusing form, for callers with no round left to spend on a patch. */
export function validateModuleContent(raw: unknown): ValidatedContent {
  const result = tryValidateModuleContent(raw);
  if (!result.ok) {
    throw err('validation', { detail: 'model module content failed shape validation' });
  }
  return { content: result.content, coercions: result.coercions };
}

// WHY: a proposed edge may only join modules that already exist in THIS topic;
// an id the model invented, or one belonging to another topic, is a boundary
// violation rather than a value to be repaired.
export function validateProposedEdges(raw: unknown, knownIds: ReadonlySet<ModuleId>): PrereqEdge[] {
  const listed = z.array(prereqEdgeSchema).safeParse(raw);
  if (!listed.success) {
    throw err('validation', { detail: 'proposed prerequisite edges failed shape validation' });
  }
  for (const edge of listed.data) {
    if (!knownIds.has(edge.from) || !knownIds.has(edge.to)) {
      throw err('validation', {
        detail: 'proposed edge referenced a module id that is not part of this topic',
        userMessage: 'The lesson plan referred to a lesson that is not part of this subject, so that link was refused.',
      });
    }
    if (edge.from === edge.to) {
      throw err('validation', { detail: 'proposed edge is a self-loop' });
    }
  }
  return listed.data;
}

export function assertContentSize(bytes: number): void {
  if (bytes > MAX_CONTENT_BYTES) {
    throw err('validation', {
      detail: `content.json is ${bytes} bytes, over the ${MAX_CONTENT_BYTES} byte cap`,
      userMessage: 'That lesson file is too large to open safely.',
    });
  }
}

export function loadEnvelope(bytes: Buffer, expectedDigest: (c: ModuleContent) => string): ContentLoad {
  if (bytes.byteLength > MAX_CONTENT_BYTES) {
    return { ok: false, degradedReason: 'This lesson file is too large to open safely.' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, degradedReason: 'This lesson file is damaged and could not be read.' };
  }
  const envelope = contentEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    const version = (raw as { contentVersion?: unknown } | null)?.contentVersion;
    if (typeof version === 'number' && version > CONTENT_VERSION) {
      return { ok: false, degradedReason: 'This lesson was written by a newer version of the app.' };
    }
    return { ok: false, degradedReason: 'This lesson file is damaged and could not be read.' };
  }
  if (envelope.data.contentVersion > CONTENT_VERSION) {
    return { ok: false, degradedReason: 'This lesson was written by a newer version of the app.' };
  }
  const digest = expectedDigest(envelope.data.content);
  if (digest !== envelope.data.digest) {
    return { ok: false, degradedReason: 'This lesson file does not match its checksum.' };
  }
  return { ok: true, content: envelope.data.content, digest };
}
