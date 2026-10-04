import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RELEASE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "release.json");

// Metadata is deliberately small and strictly validated so health never exposes
// arbitrary fields from a release file.
export async function readReleaseRevision(file = DEFAULT_RELEASE_FILE) {
  const stat = await fs.stat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 4096) throw new TypeError("invalid release metadata size");
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).some((key) => !["schemaVersion", "revision"].includes(key))
      || parsed.schemaVersion !== 1
      || typeof parsed.revision !== "string"
      || !/^[a-f0-9]{40}$/i.test(parsed.revision)) {
    throw new TypeError("invalid release metadata");
  }
  return parsed.revision.toLowerCase();
}
