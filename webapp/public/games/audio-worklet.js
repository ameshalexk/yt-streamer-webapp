class TeslaMonMonoCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let channel = 0; channel < channels.length; channel++) sample += channels[channel][i] || 0;
      sample /= channels.length;
      this.buffer[this.offset++] = sample;
      if (this.offset === this.buffer.length) {
        const chunk = this.buffer;
        this.buffer = new Float32Array(2048);
        this.offset = 0;
        this.port.postMessage(chunk, [chunk.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('teslamon-mono-capture', TeslaMonMonoCapture);
