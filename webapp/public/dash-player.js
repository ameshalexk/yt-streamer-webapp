/* Optional DASH/fMP4 player. No native video/MSE path and no changes to MJPEG. */
(() => {
  'use strict';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const MODE_KEY = 'yt-streamer-playback-mode';
  const normalizeMode = value => value === 'dash' ? 'dash' : 'mjpeg';
  function readMode() { try { return normalizeMode(localStorage.getItem(MODE_KEY)); } catch { return 'mjpeg'; } }
  function writeMode(mode) { try { localStorage.setItem(MODE_KEY, normalizeMode(mode)); } catch {} }
  function supported() { return !!(window.isSecureContext && window.VideoDecoder && window.AudioDecoder && window.AudioContext); }

  // We consume only the server's bounded, single-period SegmentTemplate contract.
  function parseManifest(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Invalid DASH manifest');
    const tracks = [...doc.querySelectorAll('Representation')].map(rep => {
      const parent = rep.parentElement;
      const template = rep.querySelector('SegmentTemplate') || parent.querySelector('SegmentTemplate');
      if (!template) throw new Error('Missing DASH segment template');
      const kind = (rep.getAttribute('mimeType') || parent.getAttribute('mimeType') || parent.getAttribute('contentType') || '').split('/')[0];
      const id = rep.getAttribute('id');
      const expand = (pattern, number) => pattern.replace(/\$RepresentationID\$/g, id).replace(/\$Number(?:%0(\d+)d)?\$/g, (_, width) => String(number).padStart(Number(width) || 0, '0'));
      const timescale = Number(template.getAttribute('timescale')) || 1;
      let number = Number(template.getAttribute('startNumber')) || 1;
      let time = 0;
      const segments = [];
      for (const entry of template.querySelectorAll('S')) {
        if (entry.hasAttribute('t')) time = Number(entry.getAttribute('t'));
        const duration = Number(entry.getAttribute('d'));
        const repeat = Number(entry.getAttribute('r') || 0);
        if (!(duration > 0) || repeat < 0 || repeat > 1000) throw new Error('Unsupported DASH timeline');
        for (let i = 0; i <= repeat; i++) {
          segments.push({ number, start: time / timescale, end: (time + duration) / timescale, name: expand(template.getAttribute('media'), number) });
          number++; time += duration;
        }
      }
      return { id, kind, codec: rep.getAttribute('codecs') || parent.getAttribute('codecs'), init: expand(template.getAttribute('initialization'), 0), segments };
    }).filter(track => track.kind === 'video' || track.kind === 'audio');
    if (!tracks.some(track => track.kind === 'video')) throw new Error('DASH video missing');
    return { tracks, done: doc.documentElement.getAttribute('type') === 'static' };
  }

  class DashPlayer {
    constructor({ url, canvas, muted, onPlaying, onError, onEnded, onBlocked }) {
      Object.assign(this, { url, canvas, onPlaying, onError, onEnded, onBlocked });
      this.abort = new AbortController();
      this.frames = []; this.audio = []; this.nodes = new Set(); this.tracks = new Map();
      this.dead = false; this.paused = false; this.started = false; this.base = null; this.origin = 0;
      this.videoEnd = 0; this.audioEnd = 0; this.rendered = 0; this.dropped = 0; this.lastAdvance = performance.now();
      // Construct and resume synchronously in the initiating gesture, before any fetch.
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain(); this.gain.gain.value = muted ? 0 : 1; this.gain.connect(this.ctx.destination);
      this.ctx.resume().catch(() => {});
    }
    currentTime() { return this.base == null ? 0 : Math.max(0, this.ctx.currentTime - this.base); }
    getStats() { return { state: this.paused ? 'paused' : this.ctx.state !== 'running' ? 'autoplay-blocked' : this.started ? 'playing' : 'buffering', renderedFrames: this.rendered, droppedFrames: this.dropped, queueSeconds: Math.max(0, this.videoEnd - this.origin - this.currentTime()), avDriftMs: this.drift || 0 }; }
    setMuted(muted) { this.gain.gain.value = muted ? 0 : 1; }
    retryFromGesture() {
      if (this.dead || this.paused || this.ctx.state === 'running') return false;
      this.ctx.resume().catch(error => this.fail(error)); return true;
    }
    pauseUser() { this.paused = true; this.ctx.suspend().catch(error => this.fail(error)); void this.heartbeat(); }
    resumeUser() { this.paused = false; this.lastAdvance = performance.now(); this.ctx.resume().then(() => this.onPlaying?.()).catch(error => this.fail(error)); void this.heartbeat(); }
    async request(url, options = {}) {
      const ctrl = new AbortController();
      const abort = () => ctrl.abort();
      this.abort.signal.addEventListener('abort', abort, { once: true });
      if (this.dead) ctrl.abort();
      const timer = setTimeout(abort, 30000);
      try {
        const response = await fetch(url, { cache: 'no-store', ...options, signal: ctrl.signal });
        if (!response.ok) throw new Error(`DASH request failed (${response.status})`);
        // Include body reads in the timeout and abort boundary.
        return options.binary ? await response.arrayBuffer() : await response.text();
      } finally { clearTimeout(timer); this.abort.signal.removeEventListener('abort', abort); }
    }
    async heartbeat() {
      if (this.dead || !this.id || this.beating) return;
      this.beating = true;
      try {
        const result = JSON.parse(await this.request(`/api/dash/${this.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: this.currentTime(), paused: this.paused || this.ctx.state !== 'running' }) }));
        if (result.error) throw new Error(result.error);
      } catch (error) { if (!this.dead) this.fail(error); }
      finally { this.beating = false; }
    }
    async start() {
      try {
        this.mp4 = await import('/mp4box.all.mjs');
        if (this.dead) return;
        const source = new URL(this.url, location.origin); source.searchParams.set('transport', 'dash');
        const session = JSON.parse(await this.request(source));
        this.id = session.id;
        this.manifestUrl = new URL(session.manifestUrl, location.origin);
        if (this.dead) { this.releaseSession(); return; }
        this.heartbeatTimer = setInterval(() => void this.heartbeat(), 1000);
        this.lastAdvance = performance.now();
        this.tick();
        while (!this.dead) {
          const manifest = parseManifest(await this.request(this.manifestUrl));
          this.hasAudio = manifest.tracks.some(track => track.kind === 'audio');
          await Promise.all(manifest.tracks.map(async spec => {
            let track = this.tracks.get(spec.id);
            if (!track) { track = await this.createTrack(spec); this.tracks.set(spec.id, track); }
            for (const segment of spec.segments) {
              if (segment.number <= track.last) continue;
              if (track.last && segment.number !== track.last + 1) throw new Error('DASH buffer expired');
              while (!this.dead && (this.paused || (this.started && segment.start - this.origin > this.currentTime() + 4))) await sleep(40);
              if (this.dead) return;
              await this.append(track, segment.name);
              track.last = segment.number;
              await this.feed(track);
            }
          }));
          if (manifest.done) { this.done = true; break; }
          await sleep(200);
        }
      } catch (error) { if (!this.dead) this.fail(error); }
    }
    async createTrack(spec) {
      const file = this.mp4.createFile();
      const track = { ...spec, file, offset: 0, pending: [], last: 0, info: null, configured: false };
      file.onError = () => this.fail(new Error('DASH demux failed'));
      file.onReady = info => {
        track.info = spec.kind === 'video' ? info.videoTracks[0] : info.audioTracks[0];
        if (!track.info) return this.fail(new Error('DASH track missing'));
        file.setExtractionOptions(track.info.id, null, { nbSamples: 1, rapAlignement: false });
        file.start();
      };
      file.onSamples = (_id, _user, samples) => track.pending.push(...samples);
      track.decoder = spec.kind === 'video' ? new VideoDecoder({
        output: frame => {
          if (this.dead) { frame.close(); return; }
          if (this.frames.length >= 180) { frame.close(); this.fail(new Error('DASH video buffer limit')); return; }
          this.frames.push(frame); this.frames.sort((a, b) => a.timestamp - b.timestamp);
          this.videoEnd = Math.max(this.videoEnd, (frame.timestamp + (frame.duration || 33333)) / 1e6);
        }, error: error => this.fail(error),
      }) : new AudioDecoder({
        output: data => {
          try {
            if (this.dead) return;
            if (this.audio.length >= 600 || this.nodes.size >= 600) throw new Error('DASH audio buffer limit');
            const buffer = this.ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
            for (let c = 0; c < data.numberOfChannels; c++) data.copyTo(buffer.getChannelData(c), { planeIndex: c, format: 'f32-planar' });
            this.audioEnd = Math.max(this.audioEnd, data.timestamp / 1e6 + buffer.duration);
            const item = { time: data.timestamp / 1e6, buffer };
            if (this.base == null) this.audio.push(item); else this.scheduleAudio(item);
          } catch (error) { this.fail(error); } finally { data.close(); }
        }, error: error => this.fail(error),
      });
      this.tracks.set(spec.id, track);
      await this.append(track, spec.init);
      if (!track.info) { track.decoder.close(); throw new Error('DASH init unavailable'); }

      return track;
    }
    async append(track, name) {
      const url = new URL(name, this.manifestUrl);
      if (url.origin !== location.origin || !url.pathname.startsWith(`/stream/dash/${this.id}/`)) throw new Error('Invalid DASH segment URL');
      const buffer = await this.request(url, { binary: true });
      if (this.dead) return;
      if (buffer.byteLength > 16 * 1024 * 1024) throw new Error('DASH segment too large');
      buffer.fileStart = track.offset; track.offset += buffer.byteLength; track.file.appendBuffer(buffer);
    }
    async feed(track) {
      while (track.pending.length && !this.dead) {
        // Allow the deep startup queue proved by the Tesla probe; bound running decode.
        while (!this.dead && (track.decoder.decodeQueueSize >= (track.kind === 'video' ? 40 : 200)
          || (this.started && track.kind === 'video' && this.frames.length >= 90))) await sleep(10);
        if (this.dead) return;
        const sample = track.pending.shift();
        if (!track.configured) {
          if (track.kind === 'video') {
            const stream = new this.mp4.DataStream(undefined, 0, this.mp4.DataStream.BIG_ENDIAN);
            if (!sample.description?.avcC) throw new Error('DASH AVC configuration missing');
            sample.description.avcC.write(stream);
            const config = { codec: track.info.codec, codedWidth: track.info.video.width, codedHeight: track.info.video.height,
              description: new Uint8Array(stream.buffer.slice(8)), hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true };
            let support = await VideoDecoder.isConfigSupported(config);
            if (!support.supported) { config.hardwareAcceleration = 'prefer-software'; support = await VideoDecoder.isConfigSupported(config); }
            if (!support.supported) throw new Error('H.264 decoder unsupported');
            if (this.dead) return;
            track.decoder.configure(config);
          } else {
            // Server output contract: AAC-LC, 48kHz, stereo. Do not guess other AAC profiles.
            const config = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) };
            if (!(await AudioDecoder.isConfigSupported(config)).supported) throw new Error('AAC decoder unsupported');
            if (this.dead) return;
            track.decoder.configure(config);
          }
          track.configured = true;
        }
        const Chunk = track.kind === 'video' ? EncodedVideoChunk : EncodedAudioChunk;
        track.decoder.decode(new Chunk({ type: track.kind === 'audio' || sample.is_sync ? 'key' : 'delta',
          timestamp: Math.round(sample.cts * 1e6 / sample.timescale), duration: Math.max(1, Math.round(sample.duration * 1e6 / sample.timescale)), data: sample.data }));
        track.file.releaseUsedSamples(track.info.id, sample.number + 1);
      }
    }
    scheduleAudio({ time, buffer }) {
      if (this.dead) return;
      const when = this.base + time - this.origin;
      const late = Math.max(0, this.ctx.currentTime - when);
      if (late >= buffer.duration) return;
      const node = this.ctx.createBufferSource(); node.buffer = buffer; node.connect(this.gain);
      this.nodes.add(node); node.onended = () => { this.nodes.delete(node); node.disconnect(); };
      node.start(Math.max(when, this.ctx.currentTime), late);
    }
    tick() {
      if (this.dead) return;
      try {
        if (!this.started && this.frames.length >= (this.done ? 1 : 3) && (!this.hasAudio || this.audio.length)) {
          if (this.ctx.state !== 'running') { if (!this.blocked) { this.blocked = true; this.onBlocked?.(); } }
          else {
            this.origin = Math.min(this.frames[0].timestamp / 1e6, this.audio[0]?.time ?? Infinity);
            this.base = this.ctx.currentTime + 0.6; this.started = true;
            for (const item of this.audio.splice(0)) this.scheduleAudio(item);
          }
        }
        if (this.started && !this.paused && this.ctx.state === 'running') {
          const now = this.currentTime() + this.origin;
          while (this.frames.length > 1 && this.frames[1].timestamp / 1e6 < now - 0.045) { this.frames.shift().close(); this.dropped++; }
          if (this.ctx.currentTime >= this.base) while (this.frames.length && this.frames[0].timestamp / 1e6 <= now + 0.012) {
            const frame = this.frames.shift();
            try {
              if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) { this.canvas.width = frame.displayWidth; this.canvas.height = frame.displayHeight; }
              this.canvas.getContext('2d').drawImage(frame, 0, 0);
              this.drift = (frame.timestamp / 1e6 - now) * 1000;
              this.rendered++; this.lastAdvance = performance.now();
              if (this.rendered === 1) this.onPlaying?.();
            } finally { frame.close(); }
          }
          if (this.done && !this.frames.length && now >= Math.max(this.videoEnd, this.audioEnd) + 0.1) { this.onEnded?.(); this.destroy(); return; }
        }
        if (!this.paused && this.ctx.state === 'running' && performance.now() - this.lastAdvance > 12000) throw new Error('DASH playback stalled');
        if (this.paused || this.ctx.state !== 'running') this.lastAdvance = performance.now();
        let fired = false;
        const run = () => { if (fired) return; fired = true; cancelAnimationFrame(this.raf); clearTimeout(this.timer); this.tick(); };
        this.raf = requestAnimationFrame(run); this.timer = setTimeout(run, 50);
      } catch (error) { this.fail(error); }
    }
    fail(error) { if (this.dead) return; const time = this.currentTime(); this.destroy(); this.onError?.(error, time); }
    releaseSession() { if (this.id) { fetch(`/api/dash/${this.id}`, { method: 'DELETE', keepalive: true }).catch(() => {}); this.id = null; } }
    destroy() {
      if (this.dead) return;
      this.dead = true; this.abort.abort(); clearInterval(this.heartbeatTimer); clearTimeout(this.timer); cancelAnimationFrame(this.raf);
      for (const track of this.tracks.values()) { try { track.decoder.close(); } catch {} track.file.stop(); track.pending.length = 0; }
      this.tracks.clear();
      for (const frame of this.frames.splice(0)) frame.close();
      for (const node of this.nodes) { try { node.stop(); node.disconnect(); } catch {} }
      this.nodes.clear(); this.audio.length = 0; this.ctx.close().catch(() => {}); this.releaseSession();
    }
  }
  window.DashPlayback = { DashPlayer, supported, parseManifest, MODE_KEY, readMode, writeMode, normalizeMode };
})();
