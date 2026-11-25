/* Audio stays in this browser. The model and runtime are downloaded from their public hosts. */
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
let transcriber;
self.onmessage = async ({data}) => {
  if (data.type === 'init') {
    try {
      const { pipeline, env } = await import(TRANSFORMERS);
      env.allowLocalModels = false;
      env.backends.onnx.wasm.numThreads = 1;
      transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
        quantized: true,
        progress_callback: p => self.postMessage({type:'progress', progress:p})
      });
      self.postMessage({type:'ready'});
    } catch (error) { self.postMessage({type:'error', message:String(error?.message || error)}); }
  } else if (data.type === 'audio' && transcriber) {
    try {
      const result = await transcriber(data.samples, {language:'korean', task:'transcribe'});
      self.postMessage({type:'result', text:result.text || '', start:data.start, end:data.end});
    } catch (error) { self.postMessage({type:'error', message:String(error?.message || error)}); }
  }
};
