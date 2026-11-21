import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("history deletion and fresh replay survive a blocked earlier disk write", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-history-barrier-"));
  try {
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import { listWatchHistory, recordWatchHistory, deleteWatchHistoryEntry } from ${JSON.stringify(new URL("../src/lib/store.js", import.meta.url).href)};
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
        const deletion = deleteWatchHistoryEntry('barrier-video');
        const replay = recordWatchHistory({ youtubeId: 'barrier-video', playbackSessionId: 'fresh-session', restartProgress: true });
        releaseWrite();
        await Promise.all([record, deletion, replay]);
        const history = await listWatchHistory();
        assert.equal(history.length, 1);
        assert.equal(history[0].playbackSessionId, 'fresh-session');
        assert.equal(history[0].playCount, 1);
        const disk = JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR, 'store.json'), 'utf8'));
        assert.deepEqual(disk.watchHistory, history, 'disk must match the final replay');
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
