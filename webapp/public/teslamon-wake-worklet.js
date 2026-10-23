// Local 16-kHz resampler for the openWakeWord 'hey_jarvis' model.

class TeslaMonAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.output = new Float32Array(1280);
    this.position = 0;
    this.sampleIndex = 0;
    this.nextOutputAt = 0;
    this.previous = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    const stride = sampleRate / 16000;
    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const index = this.sampleIndex++;
      while (this.nextOutputAt <= index) {
        const alpha = Math.max(0, Math.min(1, this.nextOutputAt - (index - 1)));
        this.output[this.position++] = this.previous + (current - this.previous) * alpha;
        this.nextOutputAt += stride;
        if (this.position === 1280) {
          this.port.postMessage(this.output);
          this.output = new Float32Array(1280);
          this.position = 0;
        }
      }
      this.previous = current;
    }
    return true;
  }
}
registerProcessor('teslamon-audio-processor', TeslaMonAudioProcessor);
