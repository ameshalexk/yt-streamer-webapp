class ChiakiAudioOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.queueSamples = 0;
    this.sourcePosition = 0;
    this.sourceRate = sampleRate;
    this.maxQueuedSamples = Math.round(sampleRate * 0.24);
    this.port.onmessage = ({ data }) => this.receive(data);
  }
  receive(message) {
    if (message.clear) {
      this.queue = [];
      this.queueSamples = 0;
      this.sourcePosition = 0;
      return;
    }
    if (message.sourceRate) this.sourceRate = message.sourceRate;
    if (!message.pcm) return;
    const channels = Math.max(1, message.channels || 2);
    const sampleCount = Math.floor(message.pcm.length / channels);
    const planes = Array.from({ length: channels }, (_, channel) => {
      const plane = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++)
        plane[i] = message.pcm[i * channels + channel] / 32768;
      return plane;
    });
    this.queue.push(planes);
    this.queueSamples += sampleCount;
    while (this.queue.length > 1 && this.queueSamples > this.maxQueuedSamples) {
      this.queueSamples -= this.queue[0][0].length;
      this.queue.shift();
      this.sourcePosition = 0;
    }
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const increment = this.sourceRate / sampleRate;
    for (let frame = 0; frame < output[0].length; frame++) {
      const samples = this.queue[0];
      if (!samples) {
        for (const channel of output) channel[frame] = 0;
        continue;
      }
      const left = Math.floor(this.sourcePosition);
      const right = Math.min(left + 1, samples[0].length - 1);
      const fraction = this.sourcePosition - left;
      for (let channel = 0; channel < output.length; channel++) {
        const source = samples[Math.min(channel, samples.length - 1)];
        output[channel][frame] =
          source[left] * (1 - fraction) + source[right] * fraction;
      }
      this.sourcePosition += increment;
      if (this.sourcePosition >= samples[0].length) {
        this.queueSamples -= samples[0].length;
        this.sourcePosition -= samples[0].length;
        this.queue.shift();
      }
    }
    return true;
  }
}
registerProcessor("chiaki-audio-output", ChiakiAudioOutput);
