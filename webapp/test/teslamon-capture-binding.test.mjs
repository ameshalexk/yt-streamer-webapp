import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTeslaMonCaptureButton } from '../public/teslamon-capture-binding.js';

class FakeTarget {
  listeners = new Map();
  addEventListener(type, listener) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, properties = {}) {
    let prevented = false;
    const event = { type, preventDefault() { prevented = true; }, ...properties };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return { event, prevented };
  }
  count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}

class FakeButton extends FakeTarget {
  disabled = false;
  captured = new Set();
  throwCapture = false;
  setPointerCapture(id) { if (this.throwCapture) throw new Error('capture denied'); this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
}

function setup({ start = async () => true } = {}) {
  const button = new FakeButton(); const document = new FakeTarget(); document.hidden = false;
  const window = new FakeTarget(); const calls = []; const errors = [];
  const capture = Object.fromEntries(['start', 'release', 'cancel', 'targetChanged', 'dispose'].map(name => [name, (...args) => { calls.push(name); return name === 'start' ? start(...args) : undefined; }]));
  const binding = bindTeslaMonCaptureButton({ button, document, window, capture, onError: e => errors.push(e) });
  return { button, document, window, calls, errors, binding };
}

test('primary pointer press starts once, release completes, normal lost capture does not cancel', () => {
  const s = setup();
  assert.equal(s.calls.length, 0);
  assert.equal(s.button.dispatch('pointerdown', { pointerId: 7, button: 0, isPrimary: true }).prevented, true);
  assert.deepEqual(s.calls, ['start']);
  assert.equal(s.button.captured.has(7), true);
  assert.equal(s.button.dispatch('pointerup', { pointerId: 7, button: 0 }).prevented, true);
  s.button.dispatch('lostpointercapture', { pointerId: 7 });
  assert.deepEqual(s.calls, ['start', 'release']);
  assert.equal(s.button.captured.has(7), false);
  s.binding.dispose();
});

test('pointer cancellation and active lost capture cancel, and capture failure fails closed', () => {
  const s = setup();
  s.button.dispatch('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
  s.button.dispatch('pointercancel', { pointerId: 1 });
  assert.deepEqual(s.calls, ['start', 'cancel']);
  s.button.dispatch('pointerdown', { pointerId: 2, button: 0, isPrimary: true });
  s.button.dispatch('lostpointercapture', { pointerId: 2 });
  assert.deepEqual(s.calls, ['start', 'cancel', 'start', 'cancel']);
  s.button.throwCapture = true;
  s.button.dispatch('pointerdown', { pointerId: 3, button: 0, isPrimary: true });
  assert.deepEqual(s.calls, ['start', 'cancel', 'start', 'cancel']);
  assert.equal(s.errors.length, 1);
  s.binding.dispose();
});

test('keyboard Space and Enter start on non-repeat keydown and release on matching keyup', () => {
  const s = setup();
  assert.equal(s.button.dispatch('keydown', { key: ' ', repeat: false }).prevented, true);
  assert.equal(s.button.dispatch('keydown', { key: ' ', repeat: true }).prevented, true);
  s.button.dispatch('keyup', { key: 'Enter' });
  s.button.dispatch('keyup', { key: ' ' });
  s.button.dispatch('keydown', { key: 'Enter', repeat: false });
  s.button.dispatch('keyup', { key: 'Enter' });
  assert.deepEqual(s.calls, ['start', 'release', 'start', 'release']);
  s.binding.dispose();
});

test('ignored inputs, explicit clicks, disabled state, and modifiers never start', () => {
  const s = setup();
  s.button.dispatch('pointerdown', { pointerId: 1, button: 2, isPrimary: true });
  s.button.dispatch('pointerdown', { pointerId: 2, button: 0, isPrimary: false });
  s.button.dispatch('pointerdown', { pointerId: 3, button: 0, isPrimary: true, ctrlKey: true });
  s.button.dispatch('keydown', { key: ' ', repeat: false, shiftKey: true });
  s.button.dispatch('keydown', { key: 'Enter', repeat: true });
  s.button.dispatch('click');
  s.button.disabled = true;
  s.button.dispatch('pointerdown', { pointerId: 4, button: 0, isPrimary: true });
  s.button.dispatch('keydown', { key: ' ', repeat: false });
  assert.deepEqual(s.calls, []);
  s.binding.dispose();
});

test('visibility, blur, pagehide, Escape, target change, and dispose cancel held sessions', () => {
  for (const end of [
    s => { s.document.hidden = true; s.document.dispatch('visibilitychange'); },
    s => s.window.dispatch('blur'),
    s => s.window.dispatch('pagehide'),
    s => s.button.dispatch('keydown', { key: 'Escape' }),
    s => s.binding.targetChanged(),
    s => s.binding.dispose(),
  ]) {
    const s = setup();
    s.button.dispatch('keydown', { key: ' ', repeat: false });
    end(s);
    assert.equal(s.calls.includes('cancel'), true);
    if (s.calls.includes('dispose')) assert.equal(s.calls.at(-1), 'dispose');
    else s.binding.dispose();
  }
});

test('only one pointer or key can be held at once; teardown removes listeners and ignores later events', () => {
  const s = setup();
  s.button.dispatch('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
  s.button.dispatch('pointerdown', { pointerId: 2, button: 0, isPrimary: true });
  s.button.dispatch('keydown', { key: 'Enter', repeat: false });
  assert.deepEqual(s.calls, ['start']);
  s.binding.dispose();
  assert.equal(s.button.count() + s.document.count() + s.window.count(), 0);
  s.button.dispatch('pointerup', { pointerId: 1 });
  s.button.dispatch('keydown', { key: ' ' });
  assert.deepEqual(s.calls, ['start', 'cancel', 'dispose']);
});

test('start rejection is reported and does not become an unhandled rejection', async () => {
  const s = setup({ start: () => Promise.reject(new Error('permission denied')) });
  s.button.dispatch('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0].message, /permission denied/);
  s.button.dispatch('pointerup', { pointerId: 1 });
  assert.deepEqual(s.calls, ['start', 'cancel']);
  s.binding.dispose();
});

test('pending permission completion after cancellation or disposal has no follow-up action', async () => {
  let resolveStart;
  const s = setup({ start: () => new Promise(resolve => { resolveStart = resolve; }) });
  s.button.dispatch('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
  s.button.dispatch('pointercancel', { pointerId: 1 });
  resolveStart(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(s.calls, ['start', 'cancel']);
  s.binding.dispose();
});


test('blur cancels even after release, and failed start clears its held input', async () => {
  const s = setup({ start: () => Promise.reject(new Error('denied')) });
  s.button.dispatch('keydown', { key: ' ', repeat: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(s.calls, ['start', 'cancel']);
  s.button.dispatch('pointerdown', { pointerId: 9, button: 0, isPrimary: true });
  s.button.dispatch('pointerup', { pointerId: 9 });
  s.window.dispatch('blur');
  assert.deepEqual(s.calls, ['start', 'cancel', 'start', 'release', 'cancel']);
  s.binding.dispose();
});

test('late start rejection does not cancel a newer press; target change after disposal is inert', async () => {
  let rejectFirst; let starts = 0;
  const s = setup({ start: () => { starts++; return starts === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : Promise.resolve(true); } });
  s.button.dispatch('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
  s.button.dispatch('pointerup', { pointerId: 1 });
  s.button.dispatch('pointerdown', { pointerId: 2, button: 0, isPrimary: true });
  rejectFirst(new Error('late denial'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(s.calls, ['start', 'release', 'start']);
  s.binding.dispose();
  s.binding.targetChanged();
  assert.deepEqual(s.calls, ['start', 'release', 'start', 'cancel', 'dispose']);
});


test('hidden document and Escape cancel after release while capture is still stopping', () => {
  const s = setup();
  s.button.dispatch('pointerdown', { pointerId: 21, button: 0, isPrimary: true });
  s.button.dispatch('pointerup', { pointerId: 21 });
  s.document.hidden = true;
  s.document.dispatch('visibilitychange');
  assert.deepEqual(s.calls, ['start', 'release', 'cancel']);

  s.button.dispatch('keydown', { key: 'Enter', repeat: false });
  s.button.dispatch('keyup', { key: 'Enter' });
  s.button.dispatch('keydown', { key: 'Escape' });
  assert.deepEqual(s.calls, ['start', 'release', 'cancel', 'start', 'release', 'cancel']);
  s.binding.dispose();
});
