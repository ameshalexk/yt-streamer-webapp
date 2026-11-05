import test from "node:test";
import assert from "node:assert/strict";
import { createCyberdashPlayer } from "../public/cyberdash-embedded.mjs";

// Cancel while the server is still resolving/creating its encoder, before any
// decoder is needed. A successful late response must not leak that encoder.
for (const preparedStatic of [false, true]) {
  test(`canceled late start ${preparedStatic ? "leaves static cache alone" : "releases its encoder"}`, async (t) => {
    class AudioContext {
      state = "running";
      resume() { return Promise.resolve(); }
      close() { this.state = "closed"; return Promise.resolve(); }
      createGain() { return { gain: { value: 1 }, connect() {} }; }
    }
    t.mock.method(globalThis, "fetch", async (url) => {
      if (String(url).endsWith("/start")) {
        requested();
        return response;
      }
      stops.push(String(url));
      return new Response("{}", { status: 200 });
    });
    const priorWindow = globalThis.window;
    globalThis.window = { AudioContext };
    let requested, respond;
    const started = new Promise(resolve => { requested = resolve; });
    const response = new Promise(resolve => { respond = resolve; });
    const stops = [], errors = [];
    const player = createCyberdashPlayer({ canvas: {}, onError: error => errors.push(error) });
    try {
      const playing = player.play({ url: "https://www.youtube.com/watch?v=fixture", preparedId: preparedStatic ? "cached-item" : null });
      await started;
      await player.stop();
      respond(new Response(JSON.stringify({ id: "late-session", preparedStatic }), { status: 200 }));
      await playing;
      assert.deepEqual(stops, preparedStatic ? [] : ["/api/experimental/cyberdash/late-session/stop"]);
      assert.equal(player.isActive(), false);
      assert.deepEqual(errors, []);
    } finally {
      await player.stop();
      if (priorWindow === undefined) delete globalThis.window;
      else globalThis.window = priorWindow;
    }
  });
}
