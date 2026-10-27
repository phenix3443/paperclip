import { describe, expect, it } from "vitest";
import vectors from "./execution-reconciliation-canonical.vectors.json" with { type: "json" };
import {
  ReconciliationCanonicalError,
  canonicalReconciliationDigest,
  canonicalizeReconciliationJson,
  findDuplicateJsonKey,
  isCanonicalReconciliationBody,
} from "./execution-reconciliation-canonical.js";

describe("execution reconciliation canonical JSON", () => {
  it.each(vectors.valid)("matches the fixed vector: $name", (vector) => {
    expect(canonicalizeReconciliationJson(vector.input)).toBe(vector.canonical);
    expect(canonicalReconciliationDigest(vector.input)).toBe(vector.sha256);
  });

  it("sorts keys by Unicode code point, not UTF-16 unit or locale", () => {
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

  it.each([
    ["no duplicates", '{"a": {"b": [1, {"c": "}\\"{"}]}, "d": null}', null],
    ["a top-level duplicate", '{"note": "x", "a": 1, "note": "y"}', ".note"],
    ["a nested duplicate", '{"a": {"b": 1, "b": 2}}', ".a.b"],
    ["a duplicate inside an array", '{"list": [{"k": 1}, {"k": 1, "k": 2}]}', ".list[1].k"],
    ["an escaped duplicate", '{"a": 1, "\\u0061": 2}', ".a"],
  ])("finds duplicate keys in raw JSON: %s", (_name, text, expected) => {
    expect(findDuplicateJsonKey(text)).toBe(expected);
  });
});
