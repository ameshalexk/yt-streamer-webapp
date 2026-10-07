import { spawn } from "node:child_process";
import path from "node:path";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_LIMIT = 16 * 1024;

// Return an error category only when the message identifies an extractor failure.
// Timeouts, missing executables, malformed output, and local IO failures do not retry.
export function classifyExtractorError(message = "") {
  const text = String(message).toLowerCase();
  if (/unsupported url|no suitable extractor|unable to extract|could not extract|failed to extract|extractor error|confirm you.re not a bot|po token|challenge solving|challenge solver|requested format is not available/.test(text)) return "extraction";
  return null;
}

export function sanitizeExtractorMessage(message = "") {
  return String(message)
    .replace(/https?:\/\/[^\s\])}>'"]+/gi, "[URL redacted]")
    .replace(/(?:cookie|authorization|proxy-authorization|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]")
    .slice(-16 * 1024);
}

function runProbe(binary, args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { resolve({ ok: false, error: error.code || "start_failed" }); return; }
    let output = "";
    let settled = false;
    const done = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done({ ok: false, error: "timeout" }); }, PROBE_TIMEOUT_MS);
    const read = (chunk) => { output = (output + chunk.toString()).slice(0, PROBE_OUTPUT_LIMIT); };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (error) => done({ ok: false, error: error.code || "start_failed" }));
    child.on("close", (code) => done({ ok: code === 0, code, output: output.trim() }));
  });
}

/** Inspect explicitly configured executable paths only. Probes never access the network. */
export async function probeExtractorCandidates(paths, { jsRuntime = "node", selfTest = false } = {}) {
  const candidates = [];
  for (const binary of [...new Set(paths.filter(Boolean))]) {
    const version = await runProbe(binary, ["--version"]);
    const result = {
      executable: path.basename(binary),
      available: version.ok && /^\d{4}\.\d{2}\.\d{2}/.test(version.output),
      version: version.ok ? version.output.split(/\s+/)[0].slice(0, 40) : null,
      error: version.ok ? null : version.error,
    };
    if (selfTest && result.available) {
      const help = await runProbe(binary, ["--ignore-config", "--js-runtimes", jsRuntime, "--help"]);
      result.compatibility = help.ok ? "passed" : help.error || `exit_${help.code}`;
    }
    candidates.push(result);
  }
  return { jsRuntime, fallbackConfigured: candidates.length > 1, candidates };
}
