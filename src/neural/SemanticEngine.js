import { fallbackEmbedding } from '../core/seed.js';
import onnxWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import onnxModuleUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

export class SemanticEngine extends EventTarget {
  constructor() {
    super();
    this.extractor = null;
    this.loading = null;
    this.mode = 'latent';
    this.inferenceQueue = Promise.resolve();
  }

  announce(detail) {
    this.dispatchEvent(new CustomEvent('state', { detail }));
  }

  warmup() {
    if (this.loading) return this.loading;
    this.loading = this.loadModel();
    return this.loading;
  }

  async loadModel() {
    this.mode = 'waking';
    this.announce({ mode: this.mode, message: 'a deeper cortex is waking behind the glass' });

    try {
      const { env, pipeline } = await import('@huggingface/transformers');
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = { wasm: onnxWasmUrl, mjs: onnxModuleUrl };
        env.backends.onnx.wasm.numThreads = 1;
      }

      const progress_callback = (progress) => {
        if (progress?.status === 'ready') {
          this.announce({ mode: 'waking', message: 'language is finding its shape' });
        }
      };

      const wantsWebGpu = 'gpu' in navigator;
      if (wantsWebGpu) {
        try {
          this.extractor = await pipeline('feature-extraction', MODEL_ID, {
            device: 'webgpu',
            dtype: 'q8',
            progress_callback,
          });
          this.mode = 'webgpu';
        } catch (webGpuError) {
          console.info('Neural WebGPU path yielded to the portable path.', webGpuError);
        }
      }

      if (!this.extractor) {
        this.extractor = await pipeline('feature-extraction', MODEL_ID, {
          device: 'wasm',
          dtype: 'q8',
          progress_callback,
        });
        this.mode = 'wasm';
      }

      this.announce({ mode: this.mode, message: 'the language cortex is awake' });
      return this.extractor;
    } catch (error) {
      console.info('The pretrained language cortex is unavailable; deterministic latent mapping remains active.', error);
      this.mode = 'latent';
      this.extractor = null;
      this.announce({ mode: this.mode, message: '' });
      return null;
    }
  }

  immediate(text) {
    return fallbackEmbedding(text);
  }

  async embed(text) {
    const phrase = String(text);
    const task = async () => {
      const extractor = await this.warmup();
      if (!extractor) return fallbackEmbedding(phrase);
      try {
        const tensor = await extractor(phrase, { pooling: 'mean', normalize: true });
        return Float32Array.from(tensor.data);
      } catch (error) {
        console.info('Neural phrase inference yielded to deterministic mapping.', error);
        return fallbackEmbedding(phrase);
      }
    };

    const result = this.inferenceQueue.then(task, task);
    this.inferenceQueue = result.catch(() => {});
    return result;
  }
}
