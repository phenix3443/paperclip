import { safeLog } from './evidence.mjs';
import { sourceLocations } from './source-locations.mjs';

const MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'toBeTruthy', 'toBeFalsy',
  'toBeVisible', 'toBeHidden', 'toBeEnabled', 'toBeDisabled', 'toHaveText', 'toContainText',
  'toHaveCount', 'toHaveURL', 'toHaveAttribute', 'toContain', 'toThrow']);
const NUMBERS = new Set([0, 1, 200, 201, 202, 204, 400, 401, 403, 404, 409, 422, 500, 502, 503]);
const CODES = new Set(['55P03', '40P01', '57014', '23505', '23503', '42P01']);

export function assertionProjection(root) {
  const sources = sourceLocations(root);
  const aliases = new Map();
  const scalar = value => {
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && NUMBERS.has(value))) return value;
    if (value === undefined) return { type: 'undefined' };
    const type = Array.isArray(value) ? 'array' : typeof value;
    const key = type === 'object' || type === 'array' ? value : `${type}:${String(value)}`;
    if (!aliases.has(key)) aliases.set(key, `assertion-value-${aliases.size + 1}`);
    return { type, alias: aliases.get(key), ...(typeof value === 'string' ? { length: value.length } : {}) };
  };
  const parseScalar = value => {
    const text = value?.trim();
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null') return null;
    if (/^-?\d+$/.test(text ?? '') && NUMBERS.has(Number(text))) return Number(text);
    return value;
  };
  return error => {
    const message = String(error?.message ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    const matcher = error?.matcherResult?.name ?? message.match(/\.(to[A-Za-z]+)\(/)?.[1];
    const pair = message.match(/expected (true|false|null) to be (true|false|null)/);
    const actual = Object.hasOwn(error ?? {}, 'actual') ? error.actual
      : error?.matcherResult && Object.hasOwn(error.matcherResult, 'actual') ? error.matcherResult.actual
      : parseScalar(message.match(/^Received:\s*(.*)$/m)?.[1] ?? pair?.[1]);
    const expected = Object.hasOwn(error ?? {}, 'expected') ? error.expected
      : error?.matcherResult && Object.hasOwn(error.matcherResult, 'expected') ? error.matcherResult.expected
      : parseScalar(message.match(/^Expected:\s*(.*)$/m)?.[1] ?? pair?.[2]);
    return {
      ...sources.location(error?.location?.file, error?.location?.line, error?.location?.column),
      matcher: MATCHERS.has(matcher) ? matcher : 'unknown', actual: scalar(actual), expected: scalar(expected),
      ...(CODES.has(error?.code) ? { code: error.code } : {}),
      signature: safeLog(`${message}\n${error?.stack ?? ''}`, sources.files),
    };
  };
}
