// FRACTAL: implements F2, F12 | component C4
import { randomBytes } from 'node:crypto';
import { moduleIdSchema, isoDateStringSchema, type ISODateString, type ModuleId } from '@/shapes';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newModuleId(): ModuleId {
  const bytes = randomBytes(16);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return moduleIdSchema.parse(`m_${out}`);
}

export function newJobId(): string {
  return `j_${randomBytes(8).toString('hex')}`;
}

export function nowIso(): ISODateString {
  return isoDateStringSchema.parse(new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z'));
}
