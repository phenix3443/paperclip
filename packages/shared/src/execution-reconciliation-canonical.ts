import { createHash } from "node:crypto";

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

export function findDuplicateJsonKey(text: string): string | null {
  JSON.parse(text);
  let index = 0;
  const skipWhitespace = () => {
    while (index < text.length && " \t\n\r".includes(text[index]!)) index += 1;
  };
  const readString = () => {
    const start = index;
    index += 1;
    while (text[index] !== "\"") index += text[index] === "\\" ? 2 : 1;
    index += 1;
    return JSON.parse(text.slice(start, index)) as string;
  };
  const readValue = (path: string): string | null => {
    skipWhitespace();
    const opener = text[index];
    if (opener === "{" || opener === "[") {
      const closer = opener === "{" ? "}" : "]";
      const seen = new Set<string>();
      index += 1;
      skipWhitespace();
      if (text[index] === closer) {
        index += 1;
        return null;
      }
      for (let position = 0; ; position += 1) {
        let entryPath = `${path}[${position}]`;
        if (opener === "{") {
          skipWhitespace();
          const key = readString();
          entryPath = `${path}.${key}`;
          if (seen.has(key)) return entryPath;
          seen.add(key);
          skipWhitespace();
          index += 1;
        }
        const duplicate = readValue(entryPath);
        if (duplicate) return duplicate;
        skipWhitespace();
        if (text[index++] === closer) return null;
      }
    }
    if (opener === "\"") {
      readString();
      return null;
    }
    while (index < text.length && !",]} \t\n\r".includes(text[index]!)) index += 1;
    return null;
  };
  return readValue("");
}
