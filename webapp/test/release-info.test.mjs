import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readReleaseRevision } from "../src/lib/release-info.js";

test("release metadata accepts only schema 1 with a full git revision", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-release-info-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "release.json");
  const revision = "abcdef0123456789abcdef0123456789abcdef01";
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, revision }));
  assert.equal(await readReleaseRevision(file), revision);

  for (const value of [
    { schemaVersion: 2, revision },
    { schemaVersion: 1, revision: "abc" },
    { schemaVersion: 1, revision: "g".repeat(40) },
    { schemaVersion: 1, revision, extra: true },
    [],
  ]) {
    await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(readReleaseRevision(file), /invalid release metadata/);
  }
  await fs.writeFile(file, "{");
  await assert.rejects(readReleaseRevision(file), SyntaxError);
  assert.equal(await readReleaseRevision(path.join(dir, "missing.json")), null);
});
