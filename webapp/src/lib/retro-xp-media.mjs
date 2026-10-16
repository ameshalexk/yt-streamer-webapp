import path from "node:path";
import fs from "node:fs/promises";

export const XP_ISO_NAME = "xp-pro-sp3-x86.iso";
export const XP_ISO_LENGTH = 617756672;

export function createXPMediaHandler({root,authenticate,fsImpl=fs}) {
  if (typeof authenticate !== "function") throw Error("Signed Access verifier required");
  const isoPath=path.join(root,"private","retro-pc",XP_ISO_NAME);
  return async (req,res) => {
    res.set({
      "Cache-Control":"private, no-store",
      "Referrer-Policy":"no-referrer",
      "X-Content-Type-Options":"nosniff",
      "Cross-Origin-Resource-Policy":"same-origin"
    });
    if (req.hostname!=="stream.ameshalex.com") return res.status(404).end();
    let subject=null;
    try {subject=await authenticate(req);} catch {}
    if (!subject) return res.status(401).json({error:"Valid signed Cloudflare Access session required"});
    let stats;
    try {stats=await fsImpl.stat(isoPath);} catch {return res.status(503).json({error:"Windows XP installer media unavailable"});}
    if (!stats.isFile() || stats.size!==XP_ISO_LENGTH)
      return res.status(503).json({error:"XP installer verification failed"});
    // Express sendFile handles single Range requests and HEAD with 206/Content-Range.
    // File is kept outside public/ and never copied into GitHub or public static assets.
    res.type("application/octet-stream");
    return res.sendFile(isoPath, {acceptRanges:true,cacheControl:false}, error => {
      if (error && !res.headersSent) res.status(500).end();
    });
  };
}


export const XP_DISK_VIRTUAL_BYTES=3*1024*1024*1024;
export function createBlankDiskHandler() {
  return (req,res) => {
    res.set({"Cache-Control":"no-store","Content-Type":"application/octet-stream","Accept-Ranges":"bytes","X-Content-Type-Options":"nosniff"});
    const match=/^bytes=(\d+)-(\d+)?$/.exec(req.get("range")||"");
    if(!match)return res.status(416).set("Content-Range",`bytes */${XP_DISK_VIRTUAL_BYTES}`).end();
    const start=Number(match[1]),end=match[2]?Number(match[2]):Math.min(start+65535,XP_DISK_VIRTUAL_BYTES-1);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=XP_DISK_VIRTUAL_BYTES||end<start||end>=XP_DISK_VIRTUAL_BYTES||end-start+1>1048576)
      return res.status(416).end();
    res.status(206).set({"Content-Range":`bytes ${start}-${end}/${XP_DISK_VIRTUAL_BYTES}`,"Content-Length":String(end-start+1)});
    if(req.method==="HEAD")return res.end();
    return res.end(Buffer.alloc(end-start+1));
  };
}
