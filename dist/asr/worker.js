/* Audio stays in this browser. The model and runtime are downloaded from their public hosts. */
import './quality.js';
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
let transcriber;
self.onmessage = async ({data}) => {
  if (data.type === 'init') {
    try {
      const { pipeline, env } = await import(TRANSFORMERS);
      env.allowLocalModels = false;
      env.backends.onnx.wasm.numThreads = 1;
      const options = {
        quantized: true,
        progress_callback: p => self.postMessage({type:'progress', progress:p})
      };
      let model = data.mediaTimeline ? 'Xenova/whisper-base' : 'Xenova/whisper-tiny';
      try {
        transcriber = await pipeline('automatic-speech-recognition', model, options);
      } catch (error) {
        if (!data.mediaTimeline) throw error;
        model = 'Xenova/whisper-tiny';
        transcriber = await pipeline('automatic-speech-recognition', model, options);
      }
      self.postMessage({type:'ready', model});
    } catch (error) { self.postMessage({type:'error', message:String(error?.message || error)}); }
  } else if (data.type === 'audio' && transcriber) {
    try {
      const result = await transcriber(data.samples, {language:'korean', task:'transcribe', max_new_tokens:128});
      const text = self.CouncilQuality.spokenText(result.text);
      self.postMessage({type:'result', text, rejected:self.CouncilQuality.repeated(text), start:data.start, end:data.end});
    } catch (error) { self.postMessage({type:'error', message:String(error?.message || error)}); }
  }
};
