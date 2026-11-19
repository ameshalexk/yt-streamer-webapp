import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isConsoleIpv4 } from "../src/lib/tesla-remote-play-relay.mjs";

const args = process.argv.slice(2);
const disable = args.length === 1 && args[0] === "--disable";
if (args.length && !disable) throw new Error("Use with no arguments, or with --disable");
const dataDir = process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url));
const dir = path.join(dataDir, "tesla-remote-play");
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const info = await fs.lstat(dir);
if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid()) {
  throw new Error("The Remote Play state directory must be private and owned by this user");
}
async function save(name, value) {
  const temporary = path.join(dir, `.config-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, `${value}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, path.join(dir, name));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

if (disable) {
  await save("disabled", "1");
  console.log("Tesla Remote Play is hidden. Any current session will close on its next heartbeat.");
} else {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let host;
  try {
    host = (await input.question("PS5 LAN IPv4 address: ")).trim();
  } finally {
    input.close();
  }
  if (!isConsoleIpv4(host)) throw new Error("Enter the PS5's private LAN IPv4 address");
  await save("console-ip", host);
  await fs.rm(path.join(dir, "disabled"), { force: true });
  console.log("PS5 address saved. Reload Tesla Remote Play to pair or connect.");
}
