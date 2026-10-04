import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fifoReadStream } from "../src/lib/nonblocking-fifo.js";
const exec = promisify(execFile);

async function deadline(operation, message) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

test("silent FIFO readers and repeated cancellation do not starve filesystem workers", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-fifo-test-"));
  const resources = [];
  try {
    // More readers than the default four-thread libuv pool reproduces the old
    // blocking createReadStream failure without invoking native audio/routing.
    for (let i = 0; i < 8; i++) {
      const file = path.join(dir, String(i));
      await exec("mkfifo", [file]);
      const handle = await fs.open(file, constants.O_RDWR | constants.O_NONBLOCK);
      const stream = fifoReadStream(handle);
      resources.push({ handle, stream });
      stream.resume();
    }
    await deadline(fs.writeFile(path.join(dir, "probe"), "responsive"), "filesystem workers blocked by silent audio");
    assert.equal(await deadline(fs.readFile(path.join(dir, "probe"), "utf8"), "filesystem read blocked"), "responsive");
    for (const { stream, handle } of resources) {
      stream.destroy();
      await deadline(handle.close(), "cancelled FIFO handle did not close");
    }
  } finally {
    for (const { stream, handle } of resources) { stream.destroy(); await handle.close().catch(() => {}); }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("nonblocking FIFO delivers bytes in order and honors reader backpressure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-fifo-data-"));
  let handle, writer, stream;
  try {
    const file = path.join(dir, "audio");
    await exec("mkfifo", [file]);
    handle = await fs.open(file, constants.O_RDWR | constants.O_NONBLOCK);
    writer = await fs.open(file, constants.O_WRONLY | constants.O_NONBLOCK);
    stream = fifoReadStream(handle, { chunkSize: 4 });
    stream.read(0);
    await writer.write(Buffer.from("abcdefgh"));
    await deadline(new Promise(resolve => stream.once("readable", resolve)), "FIFO data not delivered");
    assert.equal(stream.readableLength, 4);
    assert.equal(stream.read(4).toString(), "abcd");
    const next = await deadline(new Promise(resolve => {
      const read = () => { const chunk = stream.read(4); if (chunk) resolve(chunk); else stream.once("readable", read); };
      read();
    }), "second FIFO chunk not delivered");
    assert.equal(next.toString(), "efgh");
  } finally {
    stream?.destroy();
    await writer?.close(); await handle?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
