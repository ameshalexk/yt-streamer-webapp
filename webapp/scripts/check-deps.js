// Verifies ffmpeg + yt-dlp are installed and reachable. Run: npm run setup
import { spawnSync } from "node:child_process";
import { config } from "../src/config.js";

function check(name, bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.error) { console.log(`  ✗ ${name}: NOT FOUND (${bin})`); return false; }
  const ver = (r.stdout || r.stderr || "").split("\n")[0].trim();
  console.log(`  ✓ ${name}: ${ver}`);
  return true;
}

console.log("\nChecking dependencies:\n");
const a = check("ffmpeg", config.ffmpegPath, ["-version"]);
const b = check("yt-dlp", config.ytdlpPath, ["--version"]);
console.log("");
if (a && b) {
  console.log("All good. Start with:  npm start\n");
  process.exit(0);
} else {
  console.log("Install the missing tools, then re-run `npm run setup`.");
  console.log("  macOS:  brew install ffmpeg yt-dlp\n");
  process.exit(1);
}
