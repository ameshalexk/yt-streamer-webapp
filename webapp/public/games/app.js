import { TRICKS, matchTrick } from './phrase-matcher.js?v=62156ea68fa8';
import { captureUtterance } from './audio-capture.js?v=e7ecb194ea4f';
import { VoiceEngine } from './voice-engine.js?v=eb11584ae7f9';
import { createVoiceController } from './voice-ui.js?v=0d7527a1083c';

const $ = id => document.getElementById(id);
const dog = $('dog');
const status = $('status');
const speak = $('speak');
const stop = $('stop');
const voiceNote = $('voiceNote');
const motionToggle = $('motionToggle');

let currentTrick = null;
let pendingTrick = null;
let trickTimer = null;
const voiceEngine = new VoiceEngine();
const voice = createVoiceController({
  engine: voiceEngine, capture: captureUtterance, button: speak, note: voiceNote, supported: voiceSupport,
  setListening: listening => document.body.classList.toggle('is-listening', listening), say,
  onTranscript: phrase => {
    const trick = matchTrick(phrase);
    if (trick) runTrick(trick);
    else say('No trick heard. Try Jump, Roll over, Sit or Spin.', 'warn');
  }
});

const trickDurations = Object.freeze({ jump: 900, roll: 1100, sit: 950, spin: 1050 });
const gentleTrickDurations = Object.freeze({ jump: 760, roll: 780, sit: 800, spin: 780 });
const motionStorageKey = 'teslamon-play-motion';

function systemPrefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

function readMotionPreference() {
  try {
    const stored = window.localStorage.getItem(motionStorageKey);
    return stored === 'gentle' || stored === 'playful' ? stored : null;
  } catch { return null; }
}

let explicitMotion = readMotionPreference();
let motionMode = explicitMotion || (systemPrefersReducedMotion() ? 'gentle' : 'playful');

function applyMotionMode() {
  document.body.dataset.motion = motionMode;
  motionToggle.textContent = motionMode === 'gentle' ? 'Motion: Gentle' : 'Motion: Playful';
  motionToggle.setAttribute('aria-label', 'Game motion: ' + motionMode + '. Activate to switch.');
  motionToggle.setAttribute('aria-pressed', String(motionMode === 'playful'));
  motionToggle.title = motionMode === 'gentle' ? 'Switch to playful motion' : 'Switch to gentle motion';
}

function say(message, tone = '') {
  status.textContent = message;
  status.dataset.tone = tone;
}

function trickLabel(trick) {
  return trick === 'roll' ? 'Roll over' : trick[0].toUpperCase() + trick.slice(1);
}

function cancelVoice() { voice.cancel(); }

function runTrick(trick) {
  if (currentTrick) {
    if (trick === currentTrick || trick === pendingTrick) {
      say(trickLabel(trick) + ' is already happening or waiting.');
      return;
    }
    if (pendingTrick) {
      say('One trick is already waiting. Press Stop to clear it.', 'warn');
      return;
    }
    pendingTrick = trick;
    say('Finishing ' + trickLabel(currentTrick) + ', then ' + trickLabel(pendingTrick) + '.');
    return;
  }

  currentTrick = trick;
  document.body.classList.add('is-running');
  dog.classList.remove(...TRICKS.map(item => 'action-' + item));
  // SVG elements have no offsetWidth. Flush layout so a stopped trick can restart.
  dog.getBoundingClientRect();
  dog.classList.add('action-' + trick);
  say(trickLabel(trick) + '!', 'ok');

  const duration = motionMode === 'gentle' ? gentleTrickDurations[trick] : trickDurations[trick];
  trickTimer = setTimeout(() => {
    dog.classList.remove('action-' + trick);
    currentTrick = null;
    trickTimer = null;
    document.body.classList.remove('is-running');
    const next = pendingTrick;
    pendingTrick = null;
    if (next) runTrick(next);
    else say('Ready for another trick!');
  }, duration);
}

function stopEverything(message = 'Stopped. TeslaMon is ready.') {
  clearTimeout(trickTimer);
  trickTimer = null;
  currentTrick = null;
  pendingTrick = null;
  dog.classList.remove(...TRICKS.map(item => 'action-' + item));
  document.body.classList.remove('is-running');
  cancelVoice();
  say(message);
}

function voiceSupport() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia
    && window.AudioContext && window.AudioWorkletNode && window.Worker && window.WebAssembly);
}

document.querySelectorAll('[data-trick]').forEach(button => {
  button.addEventListener('click', () => runTrick(button.dataset.trick));
});
speak.addEventListener('click', voice.activate);
stop.addEventListener('click', () => stopEverything());
motionToggle.addEventListener('click', () => {
  motionMode = motionMode === 'gentle' ? 'playful' : 'gentle';
  explicitMotion = motionMode;
  try { window.localStorage.setItem(motionStorageKey, motionMode); } catch {}
  stopEverything('Motion set to ' + motionMode + '. TeslaMon is ready.');
  applyMotionMode();
});
applyMotionMode();
try {
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onSystemMotionChange = event => {
    if (explicitMotion !== null) return;
    motionMode = event.matches ? 'gentle' : 'playful';
    stopEverything('Motion follows your system preference: ' + motionMode + '.');
    applyMotionMode();
  };
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', onSystemMotionChange);
  else motionQuery.addListener?.(onSystemMotionChange);
} catch {}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopEverything('Paused while this page is hidden.');
});
window.addEventListener('pagehide', () => stopEverything('Game paused.'));

if (!voiceSupport()) {
  voice.cancel();
  speak.title = 'Local voice needs HTTPS, microphone capture, AudioWorklet and WebAssembly.';
  voiceNote.textContent = speak.title + ' Touch tricks remain available.';
}
