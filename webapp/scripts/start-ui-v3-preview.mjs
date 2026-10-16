// Local UI review uses the unchanged backend with isolated writable state.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previewRoot = path.join(appRoot, '.local-ui-v3');
const port = Number(process.env.UI_PREVIEW_PORT || 8113);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8099 || port === 8100) {
  throw new Error('Choose a separate UI_PREVIEW_PORT between 1024 and 65535 (not 8099/8100).');
}
for (const dir of ['data', 'library', 'icloud']) {
  const target = path.join(previewRoot, dir);
  await fs.mkdir(target, { recursive: true });
  if (await fs.realpath(target) !== target) throw new Error('Preview state must not be a symlink.');
}
// Pass only what this isolated instance needs. In particular, no Cloudflare,
// OAuth, desktop-control, or Tesla credentials reach the preview process.
const env = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  LANG: process.env.LANG || 'en_US.UTF-8',
  HOST: '127.0.0.1', PORT: String(port),
  DATA_DIR: path.join(previewRoot, 'data'),
  LIBRARY_DIR: path.join(previewRoot, 'library'),
  APNE_ICLOUD_DIR: path.join(previewRoot, 'icloud'),
  YOUTUBE_OAUTH_TOKEN_FILE: path.join(previewRoot, 'data', 'youtube-oauth.json'),
  TESLA_PASSIVE_CONFIG: path.join(previewRoot, 'tesla-unconfigured'),
  DESKTOP_STREAM_ENABLED: '0', DESKTOP_INPUT_ENABLED: '0',
};
console.log(`UI preview: http://127.0.0.1:${port}/ (Classic default; use the UI switch)`);
console.log(`Preview state: ${previewRoot}; production state is not mounted.`);
const child = spawn(process.execPath, ['src/server.js'], { cwd: appRoot, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
