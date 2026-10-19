import { env } from '@huggingface/transformers';
import { WhisperModelConfig } from './types';

// Share the same browser Cache API bucket as the Gemma worker so models persist
// across reloads, and never look for local model files (we always fetch from HF).
env.useBrowserCache = true;
env.cacheKey = 'observer-transformers-cache';
env.allowLocalModels = false;

const TASK = 'automatic-speech-recognition';

// transformers.js APIs are imported lazily so the heavy library is only pulled
// in when a whisper worker is actually spun up.
let transformersModule: any = null;
let pipeline: any = null;
let WhisperTextStreamer: any = null;

async function loadTransformers() {
  if (!transformersModule) {
    transformersModule = await import('@huggingface/transformers');
    pipeline = transformersModule.pipeline;
    WhisperTextStreamer = transformersModule.WhisperTextStreamer;
  }
  return transformersModule;
}

// Resolve per-module dtypes.
//
// transformers.js v4 bundles a newer onnxruntime-web whose QDQ graph optimizer
// crashes on the legacy `Xenova/whisper-*` q8 decoders:
//   "Missing required scale ... TransposeDQWeightsForMatMulNBits".
// The `onnx-community/whisper-*` repos ship clean per-dtype ONNX files, so we
// select them explicitly instead of relying on the wasm default (which is q8
// for every module and re-triggers the same path):
//   - encoder stays fp32 (accuracy-sensitive; fp16/q8 degrade or break on wasm)
//   - decoder uses q4 when quantization is requested, else fp32
function resolveDtype(quantized: boolean) {
  return {
    encoder_model: 'fp32',
    decoder_model_merged: quantized ? 'q4' : 'fp32',
  };
}

class WhisperPipelineFactory {
  static task = TASK;
  static model: string | null = null;
  static config: WhisperModelConfig | null = null;
  static instance: any = null;

  static configure(config: WhisperModelConfig) {
    this.model = config.modelId;
    this.config = config;
    this.instance = null;
  }

  static async getInstance(progress_callback?: (data: any) => void) {
    if (this.instance === null && this.model && this.config) {
      try {
        await loadTransformers();
        // Device is opt-in via settings; default to wasm for broad compatibility.
        // The dtype config (fp32 encoder + q4/fp32 decoder) is valid on both backends.
        this.instance = await pipeline(this.task, this.model, {
          progress_callback,
          device: this.config.device ?? 'wasm',
          dtype: resolveDtype(this.config.quantized),
        });
      } catch (error) {
        this.instance = null;
        throw error;
      }
    }
    return this.instance;
  }

  static reset() {
    this.instance = null;
    this.model = null;
    this.config = null;
  }
}

self.onmessage = async (event) => {
  const { type, data } = event.data;

  try {
    switch (type) {
      case 'configure': {
        const config = data as WhisperModelConfig;
        WhisperPipelineFactory.configure(config);

        await WhisperPipelineFactory.getInstance((progress) => {
          self.postMessage({
            type: 'progress',
            data: progress
          });
        });

        self.postMessage({ type: 'ready' });
        break;
      }

      case 'transcribe': {
        const { audio, chunkId } = data;

        const instance = await WhisperPipelineFactory.getInstance();
        const currentConfig = WhisperPipelineFactory.config;

        if (!instance || !currentConfig) {
          throw new Error('Pipeline not initialized');
        }

        // Build transcription options - only for multilingual models
        const isEnglishOnlyModel = currentConfig.modelId.endsWith('.en');
        const transcribeOptions: any = {};

        if (!isEnglishOnlyModel) {
          // Only add parameters for multilingual models
          if (currentConfig.task) {
            transcribeOptions.task = currentConfig.task;
          }

          if (currentConfig.language && currentConfig.language !== 'auto') {
            transcribeOptions.language = currentConfig.language;
          }

          // Set default chunking for different model types
          const isDistilWhisper = currentConfig.modelId.includes('distil');
          transcribeOptions.chunk_length_s = isDistilWhisper ? 20 : 30;
          transcribeOptions.stride_length_s = isDistilWhisper ? 3 : 5;
        }

        // Create streamer for interim results if WhisperTextStreamer is available
        if (WhisperTextStreamer && instance.tokenizer) {
          let lastInterimText = '';
          const streamer = new WhisperTextStreamer(instance.tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: (text: string) => {
              // Only send if text has changed to reduce message spam
              const trimmedText = text.trim();
              if (trimmedText && trimmedText !== lastInterimText) {
                lastInterimText = trimmedText;
                self.postMessage({
                  type: 'transcription-interim',
                  data: { text: trimmedText, chunkId }
                });
              }
            }
          });
          transcribeOptions.streamer = streamer;
        }

        const output = Object.keys(transcribeOptions).length > 0
          ? await instance(audio, transcribeOptions)
          : await instance(audio);
        const newText = (output.text as string).trim();

        if (newText) {
          self.postMessage({
            type: 'transcription-complete',
            data: {
              text: newText,
              chunkId
            }
          });
        } else {
          self.postMessage({
            type: 'error',
            data: {
              message: 'No text transcribed',
              chunkId
            }
          });
        }
        break;
      }

      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      data: {
        message: `Error: ${error}`,
        chunkId: data?.chunkId
      }
    });
  }
};
