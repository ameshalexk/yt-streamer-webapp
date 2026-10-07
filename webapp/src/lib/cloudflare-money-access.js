// Verify Cloudflare Access's signed identity assertion for the private Money page.
import crypto from "node:crypto";

const ISSUER = "https://ameshalex.cloudflareaccess.com";
const AUDIENCE = "8ff285867dc898e9c64d0fc7664a63d12972f3002d8a564c0e6277342d1af3d5";
let keyCache = [];
let expiresAt = 0;

function decoded(s) {
  try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")); }
  catch { return null; }
}

export function verifyMoneyJwt(token, keys, now = Date.now() / 1000) {
  if (typeof token !== "string" || token.length > 16000) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const header = decoded(parts[0]);
  const claims = decoded(parts[1]);
  if (header?.alg !== "RS256" || !header.kid || !claims) return false;
  if (claims.iss !== ISSUER || ![claims.aud].flat().includes(AUDIENCE)) return false;
  if (!Number.isFinite(claims.exp) || claims.exp <= now) return false;
  if (claims.nbf && claims.nbf > now) return false;
  const key = keys.find(k => k.kid === header.kid && k.kty === "RSA");
  if (!key) return false;
  try {
    return crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]),
      crypto.createPublicKey({key, format: "jwk"}), Buffer.from(parts[2], "base64url"));
  } catch { return false; }
}

async function publicKeys(force = false) {
  if (!force && keyCache.length && Date.now() < expiresAt) return keyCache;
  const response = await fetch(ISSUER + "/cdn-cgi/access/certs", {signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error("Cloudflare Access key endpoint unavailable");
  const json = await response.json();
  if (!Array.isArray(json.keys) || json.keys.length < 1 || json.keys.length > 20) throw new Error("Bad Access JWKS");
  keyCache = json.keys;
  expiresAt = Date.now() + 30 * 60_000;
  return keyCache;
}

export async function requireMoneyAccess(req, res, next) {
  res.set({"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY"});
  if (req.hostname !== "stream.ameshalex.com") return res.status(404).end();
  const assertion = req.get("cf-access-jwt-assertion");
  if (!assertion) return res.status(401).json({error: "Cloudflare Access login required"});
  try {
    if (verifyMoneyJwt(assertion, await publicKeys())) return next();
    if (verifyMoneyJwt(assertion, await publicKeys(true))) return next();
  } catch (err) { console.error("[money-access]", err.message); }
  return res.status(401).json({error: "Invalid Cloudflare Access session"});
}
