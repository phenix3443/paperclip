import { createHash } from "node:crypto";

// Canonical JSON for execution reconciliation admission. The server, the
// tests and the operator must produce the same bytes, so the rules are exact:
// UTF-8, object keys sorted by Unicode code point, no whitespace, null kept,
// safe integers only. Fixed digests live in the sibling vectors file.

export class ReconciliationCanonicalError extends Error {
  constructor(public readonly path: string, reason: string) {
    super(`Cannot canonicalize ${path || "<root>"}: ${reason}`);
    this.name = "ReconciliationCanonicalError";
  }
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new ReconciliationCanonicalError(path, "numbers must be safe integers");
      return Object.is(value, -0) ? "0" : String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((entry, index) => write(entry, `${path}[${index}]`)).join(",")}]`;
      }
      if (!isPlainObject(value)) throw new ReconciliationCanonicalError(path, "only plain objects are allowed");
      const keys = Object.keys(value).sort(compareCodePoints);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${write(value[key], `${path}.${key}`)}`).join(",")}}`;
    }
    default:
      throw new ReconciliationCanonicalError(path, `${typeof value} is not a JSON value`);
  }
}

export function canonicalizeReconciliationJson(value: unknown): string {
  return write(value, "");
}

export function sha256HexOfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalReconciliationDigest(value: unknown): string {
  return sha256HexOfText(canonicalizeReconciliationJson(value));
}

/**
 * True when `body` is exactly the canonical form of one JSON value. Duplicate
 * keys, whitespace, fences, trailing bytes and fractions all fail, because the
 * re-canonicalized bytes differ from the body.
 */
export function isCanonicalReconciliationBody(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  try {
    return canonicalizeReconciliationJson(parsed) === body;
  } catch {
    return false;
  }
}
