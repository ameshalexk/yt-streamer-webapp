---
base_model: openai/whisper-tiny.en
library_name: transformers.js
license: apache-2.0
---


# Whisper

[openai/whisper-tiny.en](https://huggingface.co/openai/whisper-tiny.en) with ONNX weights to be compatible with [Transformers.js](https://huggingface.co/docs/transformers.js).



## Usage (Transformers.js)

If you haven't already, you can install the [Transformers.js](https://huggingface.co/docs/transformers.js) JavaScript library from [NPM](https://www.npmjs.com/package/@huggingface/transformers) using:
```bash
npm i @huggingface/transformers
```

**Example:** Transcribe English.


```js
import { pipeline } from '@huggingface/transformers';

// Create speech recognition pipeline
const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');

// Transcribe audio from URL
const url = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';
const output = await transcriber(url);
// { text: " And so my fellow Americans ask not what your country can do for you, ask what you can do for your country." }
```

**Example:** Transcribe English w/ timestamps.

```js
import { pipeline } from '@huggingface/transformers';

// Create speech recognition pipeline
const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');

// Transcribe audio from URL with timestamps
const url = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';
const output = await transcriber(url, { return_timestamps: true });
// {
//   text: " And so my fellow Americans ask not what your country can do for you, ask what you can do for your country."
//   chunks: [
//     { timestamp: [0, 8],  text: " And so my fellow Americans ask not what your country can do for you" }
//     { timestamp: [8, 11], text: " ask what you can do for your country." }
//   ]
// }
```

**Example:** Transcribe English w/ word-level timestamps.

```js
import { pipeline } from '@huggingface/transformers';

// Create speech recognition pipeline
const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');

// Transcribe audio from URL with word-level timestamps
const url = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';
const output = await transcriber(url, { return_timestamps: 'word' });
// {
//   "text": " And so my fellow Americans ask not what your country can do for you ask what you can do for your country.",
//   "chunks": [
//     { "text": " And", "timestamp": [0, 0.78] },
//     { "text": " so", "timestamp": [0.78, 1.06] },
//     { "text": " my", "timestamp": [1.06, 1.46] },
//     ...
//     { "text": " for", "timestamp": [9.72, 9.92] },
//     { "text": " your", "timestamp": [9.92, 10.22] },
//     { "text": " country.", "timestamp": [10.22, 13.5] }
//   ]
// }
```

---

Note: Having a separate repo for ONNX weights is intended to be a temporary solution until WebML gains more traction. If you would like to make your models web-ready, we recommend converting to ONNX using [🤗 Optimum](https://huggingface.co/docs/optimum/index) and structuring your repo like this one (with ONNX weights located in a subfolder named `onnx`).