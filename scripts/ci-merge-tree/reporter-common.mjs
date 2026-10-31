import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeLog } from './evidence.mjs';

export function record(name, value) {
  appendFileSync(path.join(process.env.PAPERCLIP_FIXED_CI_PRIVATE, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
export function location(file, line, column) {
  const relative = path.relative(process.env.PAPERCLIP_FIXED_CI_SOURCE, file ?? '');
  return !relative.startsWith('..') && /^(tests|server|packages)\/[A-Za-z0-9_./-]+$/.test(relative)
    ? { file: relative, line, column } : { file: '[redacted]' };
}
export function setContext(index) {
  if (process.env.PAPERCLIP_FIXED_CI_CONTEXT) writeFileSync(process.env.PAPERCLIP_FIXED_CI_CONTEXT, JSON.stringify({ case: index }));
}
export function errorProjection(error) {
  return { ...location(error?.location?.file, error?.location?.line, error?.location?.column),
    signature: safeLog(`${error?.message ?? ''}\n${error?.stack ?? ''}`) };
}
