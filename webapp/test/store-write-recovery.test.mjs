import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

for (const failure of ["write", "rename"]) {
  test(`store saves recover after a ${failure} failure without hiding the error`, async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-store-recovery-"));
    try {
      const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import { addPlaylist, listPlaylists } from ${JSON.stringify(new URL("../src/lib/store.js", import.meta.url).href)};
        const storeFile = path.join(process.env.DATA_DIR, 'store.json');
        await listPlaylists();
        const blocker = ${JSON.stringify(failure)} === 'write' ? storeFile + '.tmp' : storeFile;
        if (blocker === storeFile) await fs.unlink(storeFile);
        await fs.mkdir(blocker);
        await assert.rejects(addPlaylist({ name: 'Failed save' }), error =>
          ['EISDIR', 'ENOTDIR'].includes(error.code) &&
          error.syscall === (${JSON.stringify(failure)} === 'write' ? 'open' : 'rename'));
        await fs.rmdir(blocker);
        await Promise.all(Array.from({ length: 12 }, (_, index) =>
          addPlaylist({ name: 'Recovered ' + index })));
        const saved = JSON.parse(await fs.readFile(storeFile, 'utf8'));
        assert.equal(saved.playlists.length, 13);
        assert.equal(new Set(saved.playlists.map(p => p.id)).size, 13);
        for (let index = 0; index < 12; index++) {
          assert.ok(saved.playlists.some(p => p.name === 'Recovered ' + index));
        }
        await assert.rejects(fs.stat(storeFile + '.tmp'), { code: 'ENOENT' });
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
}
