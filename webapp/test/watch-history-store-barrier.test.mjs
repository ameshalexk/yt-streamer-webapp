import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("history clear supersedes an in-flight save despite a blocked disk write", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-history-barrier-"));
  try {
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import { listWatchHistory, recordWatchHistory, clearWatchHistory } from ${JSON.stringify(new URL("../src/lib/store.js", import.meta.url).href)};
      await listWatchHistory(); // Complete initial store creation before injecting the barrier.
      const originalWrite = fs.writeFile;
      let releaseWrite;
      let signalEntered;
      const entered = new Promise(resolve => { signalEntered = resolve; });
      const barrier = new Promise(resolve => { releaseWrite = resolve; });
      let held = false;
      fs.writeFile = async (...args) => {
        if (!held && String(args[0]).endsWith('store.json.tmp')) {
          held = true;
          signalEntered();
          await barrier;
        }
        return originalWrite(...args);
      };
      try {
        const record = recordWatchHistory({ youtubeId: 'barrier-video', playbackSessionId: 'barrier-session' });
        await entered;
        const clear = clearWatchHistory();
        releaseWrite();
        await Promise.all([record, clear]);
        assert.deepEqual(await listWatchHistory(), []);
        const disk = JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR, 'store.json'), 'utf8'));
        assert.deepEqual(disk.watchHistory, [], 'serialized writes must not resurrect a cleared entry');
      } finally {
        releaseWrite();
        fs.writeFile = originalWrite;
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, DATA_DIR: dataDir, LIBRARY_DIR: path.join(dataDir, "library") },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
