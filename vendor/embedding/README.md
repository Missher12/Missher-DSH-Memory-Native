# Local embedding runtime

- ONNX Runtime Web `1.22.0-dev.20250409-89f8206ba4`, MIT; `ort.wasm.min.mjs` and matching single-threaded SIMD WASM runtime. Source: https://github.com/microsoft/onnxruntime . See `onnxruntime-LICENSE.txt`.
- Transformers.js `3.8.1`, Apache-2.0; browser bundle used only for the XLM-R tokenizer. Source: https://github.com/huggingface/transformers.js . See `transformers-LICENSE.txt`.

The worker uses pure WASM, no native Node addons. Model weights are not bundled. `host/embedding.js` downloads the pinned public `Xenova/multilingual-e5-small` revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, checks each asset, and caches it locally. Its base model is https://huggingface.co/intfloat/multilingual-e5-small . No memory or query text is sent to that download endpoint.

Only the listed runtime files are packaged; source maps, npm caches, model weights and development fixtures are excluded.
