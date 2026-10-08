import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("restart uses signed Cloudflare Access protection and explicit confirmation", () => {
  const route = server.match(/app\.post\("\/api\/app\/restart",[\s\S]*?\n\}\)\);/)?.[0];
  assert.ok(route, "restart endpoint exists");
  assert.match(route, /requireMoneyAccess/);
  assert.match(route, /isSameOriginRequest\(req\)/);
  assert.match(route, /req\.body\?\.confirm !== "restart-app"/);
  assert.match(route, /process\.env\.XPC_SERVICE_NAME !== LAUNCHD_SERVICE_NAME/);
  assert.match(route, /activeBackgroundJobCount\(\)/);
  assert.match(route, /restartPending/);
  assert.match(route, /shutdownForRestart\(\)/);
  assert.doesNotMatch(route, /authorizeOwnerControl|owner.code|money_dashboard_token|setAccessCookie|accessToken\(/i);
});

test("restart button submits same-origin request without owner code", () => {
  const confirmation = client.slice(client.indexOf("function openRestartConfirmation"), client.indexOf("function restartActionError"));
  const request = client.slice(client.indexOf("async function requestAppRestart"), client.indexOf("function renderRestartWaiting"));
  const action = client.slice(client.indexOf("async function runRestartAction"), client.indexOf("function fullscreenElement"));
  assert.doesNotMatch(confirmation, /restartOwnerCode|Owner access code/);
  assert.doesNotMatch(request, /X-YT-Streamer-Owner-Code|ownerCode|money_dashboard_token/);
  assert.match(request, /credentials: "same-origin"/);
  assert.match(request, /confirm: "restart-app"/);
  assert.match(action, /requestAppRestart\(\)/);
  assert.match(action, /waitForAppRestart\(result\.instanceId\)/);
  assert.doesNotMatch(action, /restartOwnerCode|codeInput/);
});

test("stream-only and reload options remain independent of full app restart", () => {
  assert.match(client, /if \(actionName === "stream"\)/);
  assert.match(client, /if \(actionName === "reload"\)/);
});
