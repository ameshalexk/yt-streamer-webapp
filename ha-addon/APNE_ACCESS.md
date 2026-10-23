# Signed APNE playback on Home Assistant

The APNE episode library is visible without a local Chrome engine, but the
player, thumbnails, source selection and watch progress use a separate signed
Cloudflare Access guard. If the add-on has no signed-access configuration,
clicking an episode returns HTTP 503 with an empty body; iOS Safari may offer
to download a file named like the episode date.

The maintained Amesh HA add-on now supplies StreamHA's existing Cloudflare
Access origin, team issuer, and public application audience as default options.
An existing installation should receive those defaults during the Supervisor
upgrade. Confirm the three values in the add-on Configuration screen after
upgrade; if the Access application changes, update them there.

Configure these **three** Supervisor options for the **StreamHA** hostname:

- `access_control_origin`: the HTTPS origin of the HA site (for example,
  `https://streamha.example.com`).
- `access_issuer`: the HTTPS Cloudflare Access team domain
  (`https://YOUR-TEAM.cloudflareaccess.com`).
- `access_audience`: the Access application's audience tag (AUD), not an API
  token, service token or JWT.

The add-on validates and exports the corresponding `CAST_CONTROL_ORIGIN`,
`CAST_ACCESS_ISSUER` and `CAST_ACCESS_AUDIENCE` variables consumed by the
existing application verifier. All three must be set together. The service
remains fail-closed if the Access session is missing, expired or invalid.
Do not configure `APNE_NATIVE_LOOPBACK_PREVIEW=1` on a published installation.
Cloudflare Access login is unchanged.

After the add-on starts, an unsigned direct local request with
`Host: streamha.example.com` to
`/apne/live/watch/anupamaa/YYYY-MM-DD` must yield HTTP **401**, not 200;
the signed-in public browser session should receive HTML. The normal
`/api/health` endpoint remains available.

Show subscriptions are separate runtime data. To display the same APNE shows
on the Mac and Pi, copy the reviewed `apne-daily-shows.json` to the Pi's
persistent `/data` while preserving independent media libraries, watch
progress, settings and account credentials.

Chrome-dependent APNE extraction and Mac desktop capture are separate
capabilities. This change does not bundle Chromium or enable remote Chrome
on the Pi.
