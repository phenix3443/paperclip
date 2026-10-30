import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export function verifyDispatchEvidenceSource() {
  const sourceSha = process.env.DISPATCH_EVIDENCE_SOURCE_SHA;
  if (!sourceSha) return;
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("Evidence requires a full source SHA");
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const entries = execFileSync("git", ["ls-tree", "-rz", sourceSha], { cwd: root, maxBuffer: 10_000_000 }).toString().split("\0").filter(Boolean);
  for (const entry of entries) {
    const [header, path] = entry.split("\t");
    const [mode, kind, expected] = header.split(" ");
    if (kind !== "blob") throw new Error(`Unverified evidence source entry: ${path}`);
    const content = mode === "120000" ? Buffer.from(readlinkSync(join(root, path))) : readFileSync(join(root, path));
    const actual = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    if (actual !== expected) throw new Error(`Evidence source differs from ${sourceSha}: ${path}`);
  }
}
