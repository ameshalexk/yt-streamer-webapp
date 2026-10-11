import crypto from "node:crypto";

// Verify Cloudflare Access's signed assertion for cast control requests only.
export function createCastAccess({issuer="", audience="", fetchImpl=fetch, now=Date.now}) {
  let origin="";
  try {
    const u=new URL(issuer);
    if (u.protocol==="https:" && u.pathname==="/" && u.hostname.endsWith(".cloudflareaccess.com")) origin=u.origin;
  } catch {}
  let cached=[], refreshAt=0;
  async function jwks(force=false) {
    if (!force && cached.length && now()<refreshAt) return cached;
    const response=await fetchImpl(origin+"/cdn-cgi/access/certs",{signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw Error("Access signing keys unavailable");
    const data=await response.json();
    if (!Array.isArray(data.keys)||data.keys.length<1||data.keys.length>20)throw Error("Invalid signing keys");
    cached=data.keys;refreshAt=now()+30*60_000;return cached;
  }
  function accessToken(req) {
    // The HttpOnly Access application cookie can be forwarded when the signed
    // assertion header is absent. Never accept an unsigned user header.
    const header=req.get("cf-access-jwt-assertion");
    if (header != null && header !== "") return header;
    const raw=req.get("cookie");
    if (!raw || raw.length > 32768) return null;
    for (const pair of raw.split(";")) {
      const split=pair.indexOf("=");
      if (split === -1 || pair.slice(0,split).trim() !== "CF_Authorization") continue;
      const token=pair.slice(split+1).trim();
      return token.startsWith('"') && token.endsWith('"') ? token.slice(1,-1) : token;
    }
    return null;
  }
  return async function authenticatedSubject(req) {
    if (!origin || !/^[A-Za-z0-9_-]{20,}$/.test(audience)) return null;
    const jwt=accessToken(req);
    if (typeof jwt !== "string" || !jwt || jwt.length>16000) return null;
    const parts=jwt.split(".");
    if (parts.length!==3) return null;
    let hdr, claims;
    try {
      hdr=JSON.parse(Buffer.from(parts[0],"base64url"));
      claims=JSON.parse(Buffer.from(parts[1],"base64url"));
    } catch {return null;}
    const stamp=now()/1000;
    if (hdr?.alg!=="RS256"||typeof hdr.kid!=="string"||claims?.iss!==origin||
      ![claims.aud].flat().includes(audience)||!Number.isFinite(claims.exp)||
      claims.exp<=stamp||(claims.nbf!=null&&claims.nbf>stamp)||
      typeof claims.sub!=="string"||!claims.sub||claims.sub.length>300) return null;
    for (const force of [false,true]) {
      let keys;
      try { keys=await jwks(force); } catch {return null;}
      const key=keys.find(k=>k.kid===hdr.kid&&k.kty==="RSA"&&k.use!=="enc");
      if (!key) continue;
      try {
        if (crypto.verify("RSA-SHA256",Buffer.from(parts[0]+"."+parts[1]),
          crypto.createPublicKey({format:"jwk",key}),Buffer.from(parts[2],"base64url")))return claims.sub;
      } catch {}
      return null;
    }
    return null;
  };
}
