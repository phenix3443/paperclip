import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(process.argv[2]);
const manifest = JSON.parse(await fs.readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const summary = { manifest, passed: false, comparisons: [], errors: [] };
try {
  const [baseline, candidate] = await Promise.all(["baseline", "candidate"].map(async arm => {
    const result = JSON.parse(await fs.readFile(path.join(directory, `${arm}.json`), "utf8"));
    assert.equal(result.arm, arm);
    assert.equal(result.sha, manifest[arm]);
    assert.deepEqual(result.manifest, manifest);
    assert.equal(result.passed, true, `${arm}: ${result.error}`);
    assert.equal(result.batches.length, 16);
    assert.equal(result.coverage.length, 2);
    for (const coverage of result.coverage) assert.equal(coverage.distinctWorkspaces, 75);
    for (const batch of result.batches) {
      assert.equal(batch.samples.length, 20);
      assert.ok(batch.samples.every(sample => sample.ok === true));
      assert.ok(batch.wallMs < 120000);
    }
    return result;
  }));
  assert.equal(candidate.skillCatalogEntries, baseline.skillCatalogEntries);
  for (const batch of candidate.batches) {
    if (batch.path === "detail" || batch.path === "context") {
      assert.equal(batch.gitCommands, 0);
      continue;
    }
    const before = baseline.batches.find(value => value.phase === batch.phase && value.path === batch.path && value.concurrency === batch.concurrency);
    assert.ok(before);
    const ratio = batch.medianMs / before.medianMs;
    summary.comparisons.push({ phase: batch.phase, path: batch.path, concurrency: batch.concurrency,
      baselineMedianMs: before.medianMs, candidateMedianMs: batch.medianMs, ratio });
    if (ratio > 1.1) summary.errors.push(`${batch.phase}/${batch.path}/${batch.concurrency}: median ratio ${ratio} exceeds 1.10`);
  }
  assert.equal(summary.errors.length, 0, summary.errors.join("\n"));
  summary.passed = true;
} catch (error) {
  summary.errors.push(String(error));
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(directory, "comparison.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
