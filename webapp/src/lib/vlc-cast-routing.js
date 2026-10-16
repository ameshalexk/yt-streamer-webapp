// Keep a public Chromecast receiver hostname strictly limited to short-lived HLS assets.
export function canUseCastReceiver({method, path, hostname, receiverHost}) {
  return Boolean(receiverHost && hostname === receiverHost
    && (method === "GET" || method === "HEAD")
    && /^\/cast\/media\/[A-Za-z0-9_-]{16}\/[A-Za-z0-9_-]{43}\/(?:index\.m3u8|segment_[0-9]{5}\.ts)$/.test(path));
}

// Hide receiver bearer tokens in application exception paths. The Cloudflare
// edge logging policy is separately controlled and must be reviewed there.
export function redactCastMediaPath(value){
  return String(value ?? "").replace(
    /\/cast\/media\/[A-Za-z0-9_-]{16}\/[A-Za-z0-9_-]{43}(?=\/|$)/g,
    "/cast/media/[redacted]"
  );
}
