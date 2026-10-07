import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyMoneyJwt, requireMoneyAccess } from "../src/lib/cloudflare-money-access.js";

const issuer = "https://ameshalex.cloudflareaccess.com";
const audience = "8ff285867dc898e9c64d0fc7664a63d12972f3002d8a564c0e6277342d1af3d5";

function token(claimOverrides = {}, headerOverrides = {}) {
  const {privateKey, publicKey} = crypto.generateKeyPairSync("rsa", {modulusLength: 2048});
  const jwk = publicKey.export({format: "jwk"});
  jwk.kid = "local-test-key";
  const now = Math.floor(Date.now()/1000);
  const header = Buffer.from(JSON.stringify({alg: "RS256", kid: jwk.kid, ...headerOverrides})).toString("base64url");
  const claims = Buffer.from(JSON.stringify({iss: issuer, aud: [audience], exp: now + 120, nbf: now - 10, ...claimOverrides})).toString("base64url");
  const body = header + "." + claims;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url");
  return {jwt: body + "." + signature, jwk};
}

test("valid signed Cloudflare Access JWT is accepted", () => {
  const t = token();
  assert.equal(verifyMoneyJwt(t.jwt, [t.jwk]), true);
});

test("wrong audience, expiry and unsupported algorithm fail closed", () => {
  for (const changes of [{aud:["different"]},{exp:1},{nbf:9999999999}]) {
    const t = token(changes);
    assert.equal(verifyMoneyJwt(t.jwt,[t.jwk]), false);
  }
  const t = token({}, {alg:"none"});
  assert.equal(verifyMoneyJwt(t.jwt,[t.jwk]), false);
});

test("tampered signatures and missing assertion fail closed", () => {
  const t=token();
  const other=token();
  assert.equal(verifyMoneyJwt(t.jwt,[other.jwk]), false);
  assert.equal(verifyMoneyJwt(t.jwt.slice(0,-5)+"AAAAA",[t.jwk]),false);
  assert.equal(verifyMoneyJwt("",[]),false);
});

test("Money route only accepts stream hostname and requires Access identity", async () => {
  for (const host of ["money.ameshalex.com","stream.ameshalex.com"]) {
    let nextCalled = false;
    const res = {statusCode:200, headers:{}, set(h){Object.assign(this.headers,h); return this;},
      status(n){this.statusCode=n;return this;}, end(){return this;},
      json(obj){this.payload=obj;return this;}};
    await requireMoneyAccess({hostname:host, get:()=>null},res,()=>{nextCalled=true});
    assert.equal(nextCalled,false);
    assert.equal(res.statusCode,host==="money.ameshalex.com"?404:401);
    assert.equal(res.headers["Cache-Control"],"no-store");
  }
});
