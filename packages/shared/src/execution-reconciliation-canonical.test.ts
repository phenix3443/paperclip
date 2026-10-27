import { describe, expect, it } from "vitest";
import vectors from "./execution-reconciliation-canonical.vectors.json" with { type: "json" };
import {
  ReconciliationCanonicalError,
  canonicalReconciliationDigest,
  canonicalizeReconciliationJson,
  isCanonicalReconciliationBody,
} from "./execution-reconciliation-canonical.js";

describe("execution reconciliation canonical JSON", () => {
  it.each(vectors.valid)("matches the fixed vector: $name", (vector) => {
    expect(canonicalizeReconciliationJson(vector.input)).toBe(vector.canonical);
    expect(canonicalReconciliationDigest(vector.input)).toBe(vector.sha256);
  });

  it("sorts keys by Unicode code point, not UTF-16 unit or locale", () => {
    // U+FF61 sorts before U+1F600 by UTF-16 unit, after it by code point.
    expect(canonicalizeReconciliationJson({ "\u{ff61}": 1, "\u{1f600}": 2, B: 3, a: 4 })).toBe(
      '{"B":3,"a":4,"\u{ff61}":1,"\u{1f600}":2}',
    );
  });

  it.each([
    ["a fraction", { value: 1.5 }],
    ["an unsafe integer", { value: Number.MAX_SAFE_INTEGER + 1 }],
    ["NaN", { value: Number.NaN }],
    ["infinity", { value: Number.POSITIVE_INFINITY }],
    ["undefined", { value: undefined }],
    ["a bigint", { value: 1n }],
    ["a date object", { value: new Date(0) }],
    ["a function", { value: () => 1 }],
  ])("rejects %s", (_name, input) => {
    expect(() => canonicalizeReconciliationJson(input)).toThrow(ReconciliationCanonicalError);
  });

  it("accepts only bodies that re-canonicalize to the same bytes", () => {
    expect(isCanonicalReconciliationBody('{"a":1,"b":[true,null]}')).toBe(true);
    expect(isCanonicalReconciliationBody('{"b":1,"a":1}')).toBe(false);
    expect(isCanonicalReconciliationBody('{"a": 1}')).toBe(false);
    expect(isCanonicalReconciliationBody('{"a":1,"a":1}')).toBe(false);
    expect(isCanonicalReconciliationBody('```json\n{"a":1}\n```')).toBe(false);
    expect(isCanonicalReconciliationBody('{"a":1}{"b":2}')).toBe(false);
    expect(isCanonicalReconciliationBody('{"a":1.5}')).toBe(false);
    expect(isCanonicalReconciliationBody('{"a":1}\n')).toBe(false);
  });
});
