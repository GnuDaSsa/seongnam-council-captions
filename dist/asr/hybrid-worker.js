/* Sherpa browser runtime (Apache-2.0): https://pub.dev/packages/sherpa_onnx_web/versions/1.13.8 */
const qualityUrl=new URL('quality.js',self.location.href);
qualityUrl.search=self.location.search;
importScripts(qualityUrl.href);
const localAssets='/asr-local/';
const runtimeArchive='https://pub.dev/api/archives/sherpa_onnx_web-1.13.8.tar.gz';
const modelRoot='https://huggingface.co/k2-fsa/sherpa-onnx-zipformer-korean-2024-06-24/resolve/4eecf29bd7799383116985ee57ec79239dbab8b4/';
const runtimeFiles={
  'sherpa-onnx-wasm-web.js':[93039,'28f909145d93018c90c181035a008880ceaa94a72b66603dc7bb7c619714c23c'],
  'sherpa-onnx-asr.js':[53867,'d51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178'],
  'sherpa-onnx-wasm-web.wasm':[15133855,'e0d84744c39a28121f7738a161a21612788f4e8f07879a7224e74919e9831573'],
};
const modelFiles={
  encoder:['encoder-epoch-99-avg-1.int8.onnx',70784728,'8b196d723421a0513c98ec25da2c43420c029e817f5e4a90b29ff80291c0af2b'],
  decoder:['decoder-epoch-99-avg-1.onnx',11309084,'b486221625f4680659c21eaf0505c50e64a897583af4f9ca6f87dea762a33885'],
  joiner:['joiner-epoch-99-avg-1.int8.onnx',2581421,'eb654db1ea2cc9d63474855f65958b6059084692a9f2eb4f3812aceb1e416a20'],
  tokens:['tokens.txt',60246,'016bdf0965029263b7ad01b742366ee542ef0bef38261510e8176ff6f2e9e668'],
};

async function verifyAsset(bytes, length, expected) {
  if (bytes.byteLength!==length) throw new Error('음성 모델 파일 크기가 일치하지 않습니다.');
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  if (hash!==expected) throw new Error('음성 모델 파일 검증에 실패했습니다.');
  return bytes;
}

async function downloadAsset(url, integrity) {
  const response=await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer'});
  if (!response.ok) throw new Error('음성 모델 파일을 불러올 수 없습니다.');
  const bytes=new Uint8Array(await response.arrayBuffer());
  return integrity ? verifyAsset(bytes,...integrity) : bytes;
}

async function publicRuntime() {
  const packed=await downloadAsset(runtimeArchive,[4351745,'e25a3813eb080636280b23dd4b0098252902675158b66dceda1efba061adf5d7']);
  const stream=new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const archive=new Uint8Array(await new Response(stream).arrayBuffer());
  const decoder=new TextDecoder(), assets={};
  const headerField=(start,end)=>decoder.decode(archive.subarray(start,end)).split('\0',1)[0].trim();
  for (let offset=0;offset+512<=archive.length && archive[offset];) {
    const path=headerField(offset,offset+100), size=Number.parseInt(headerField(offset+124,offset+136),8);
    const start=offset+512;
    if (!Number.isSafeInteger(size) || size<0 || start+size>archive.length) throw new Error('음성 모듈 묶음을 읽을 수 없습니다.');
    const name=path.startsWith('assets/') && path.slice(7);
    if (name && Object.hasOwn(runtimeFiles,name)) assets[name]=await verifyAsset(archive.subarray(start,start+size),...runtimeFiles[name]);
    offset=start+Math.ceil(size/512)*512;
  }
  if (Object.keys(assets).length!==Object.keys(runtimeFiles).length) throw new Error('음성 모듈 파일을 찾을 수 없습니다.');
  for (const name of ['sherpa-onnx-wasm-web.js','sherpa-onnx-asr.js']) {
    const script=URL.createObjectURL(new Blob([assets[name]],{type:'text/javascript'}));
    try { importScripts(script); } finally { URL.revokeObjectURL(script); }
  }
  return SherpaOnnx({wasmBinary:assets['sherpa-onnx-wasm-web.wasm']});
}

async function openRuntime(usePublicAssets) {
  if (usePublicAssets) return publicRuntime();
  importScripts(localAssets+'sherpa-onnx-wasm-web.js',localAssets+'sherpa-onnx-asr.js');
  return SherpaOnnx({locateFile:file=>localAssets+file});
}
let recognizer;
self.onmessage = async ({data}) => {
  if (data.type === 'init') {
    try {
      const usePublicAssets=data.assetMode==='public';
      const Module=await openRuntime(usePublicAssets);
      for (const [name,[file,...integrity]] of Object.entries(modelFiles)) {
        const url=usePublicAssets ? modelRoot+file : localAssets+name+(name==='tokens'?'.txt':'.onnx');
        const bytes=await downloadAsset(url,usePublicAssets?integrity:null);
        Module.FS_createDataFile('/', name + (name==='tokens' ? '.txt' : '.onnx'), bytes, true, true);
      }
      recognizer = new OfflineRecognizer({modelConfig:{transducer:{encoder:'/encoder.onnx',decoder:'/decoder.onnx',joiner:'/joiner.onnx'},tokens:'/tokens.txt',numThreads:1,provider:'cpu',debug:0},decodingMethod:'greedy_search'},Module);
      if (!recognizer.handle) throw new Error('로컬 음성 모델을 초기화할 수 없습니다.');
      self.postMessage({type:'ready',model:usePublicAssets?'public-zipformer':'local-zipformer'});
    } catch(error) { self.postMessage({type:'error',message:String(error?.message || error)}); }
  } else if (data.type === 'audio' && recognizer) {
    let stream;
    try {
      stream=recognizer.createStream();stream.acceptWaveform(16000,data.samples);recognizer.decode(stream);
      const result=recognizer.getResult(stream);
      const text=self.CouncilQuality.spokenText(result.text);
      const displayText=self.CouncilQuality.koreanTokenSpacing(text,result.tokens);
      self.postMessage({type:'result',text,displayText,rejected:self.CouncilQuality.repeated(text),start:data.start,end:data.end});
    } catch(error) { self.postMessage({type:'error',message:String(error?.message || error)}); }
    finally { stream?.free(); }
  }
};
