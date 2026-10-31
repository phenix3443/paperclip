import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sourceLocations } from './source-locations.mjs';
import { assertionProjection } from './assertions.mjs';

export function record(name, value) {
  appendFileSync(path.join(process.env.PAPERCLIP_FIXED_CI_PRIVATE, name), `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, { mode: 0o600 });
}
const sources = sourceLocations(process.env.PAPERCLIP_FIXED_CI_SOURCE);
export const location = sources.location;
export function setContext(index) {
  if (process.env.PAPERCLIP_FIXED_CI_CONTEXT) writeFileSync(process.env.PAPERCLIP_FIXED_CI_CONTEXT, JSON.stringify({ case: index }));
}
export const errorProjection = assertionProjection(process.env.PAPERCLIP_FIXED_CI_SOURCE);
