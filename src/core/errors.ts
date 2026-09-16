// FRACTAL: implements (none) | component C0
import { randomBytes } from 'node:crypto';
import type { ErrorCode, AppErrorShape } from '@/shapes';
import { log } from '@/core/log';

export type { ErrorCode, AppErrorShape };

const USER_MESSAGES: Record<ErrorCode, string> = {
  validation: 'Some of the information you entered isn\'t valid.',
  'not-found': 'We couldn\'t find that.',
  conflict: 'That already exists.',
  unauthorized: 'You need to sign in again.',
  'store-corrupt': 'Something went wrong reading your saved data.',
  'store-key-missing': 'We couldn\'t find that record.',
  'store-schema-ahead': 'Your data was saved by a newer version of the app.',
  'cli-missing': 'The AI assistant isn\'t available right now.',
  'cli-failed': 'The AI assistant ran into a problem.',
  'sandbox-violation': 'That action wasn\'t allowed for safety reasons.',
  timeout: 'That took too long and was stopped.',
  cancelled: 'That was cancelled.',
  internal: 'Something went wrong on our end.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly correlationId: string;

  constructor(code: ErrorCode, message: string, correlationId: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.correlationId = correlationId;
  }

  toShape(): AppErrorShape {
    return { code: this.code, message: this.message, correlationId: this.correlationId };
  }
}

export function newCorrelationId(): string {
  return `c_${randomBytes(4).toString('hex')}`;
}

export function err(
  code: ErrorCode,
  opts?: { detail?: string; userMessage?: string; cause?: unknown },
): AppError {
  const correlationId = newCorrelationId();
  const safeMessage = opts?.userMessage ?? USER_MESSAGES[code];
  log({
    level: 'error',
    event: 'error',
    code,
    correlationId,
    detail: opts?.detail ?? null,
    cause: opts?.cause instanceof Error ? opts.cause.message : (opts?.cause ?? null),
  });
  return new AppError(code, safeMessage, correlationId);
}

export function toApiError(e: unknown): AppErrorShape {
  if (e instanceof AppError) {
    return e.toShape();
  }
  const wrapped = err('internal', {
    detail: e instanceof Error ? e.message : String(e),
    cause: e,
  });
  return wrapped.toShape();
}
