"""Run the deployed browser worker on the same 600-second WAV using Chromium."""
import http.server, json, os, pathlib, socketserver, subprocess, sys, threading, time
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parents[1]
audio = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
revision = sys.argv[3] if len(sys.argv)>3 else 'b96f6c7'
worker = subprocess.check_output(['git','show',revision+':dist/asr/worker.js'],cwd=root)
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(root / 'dist'), **kwargs)
    def do_GET(self):
        if self.path == '/asr/worker.js':
            self.send_response(200); self.send_header('Content-Type','text/javascript'); self.end_headers(); self.wfile.write(worker)
        elif self.path == '/eval.wav':
            self.send_response(200); self.send_header('Content-Type','audio/wav'); self.end_headers()
            with audio.open('rb') as f:
                while data := f.read(1024*1024): self.wfile.write(data)
        else: super().do_GET()
server = socketserver.TCPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page()
    page.goto(f'http://127.0.0.1:{server.server_address[1]}/')
    page.set_default_timeout(1200000)
    result = page.evaluate('''async () => {
      const wav = await (await fetch('/eval.wav')).arrayBuffer();
      const ctx = new AudioContext({sampleRate:16000});
      const a = await ctx.decodeAudioData(wav); const samples = a.getChannelData(0);
      if (a.sampleRate !== 16000 || samples.length !== 9600000) throw Error('Unexpected audio geometry');
      const worker = new Worker('/asr/worker.js', {type:'module'});
      const waitFor = wanted => new Promise((resolve,reject) => { worker.onmessage = e => {
        if(e.data.type === 'error') reject(Error(e.data.message));
        else if(e.data.type === wanted) resolve(e.data);
      }; worker.onerror = e => reject(Error(e.message)); });
      const init = performance.now(); const ready = waitFor('ready'); worker.postMessage({type:'init'}); await ready;
      const initSeconds=(performance.now()-init)/1000, start=performance.now(), chunks=[];
      for(let i=0;i<samples.length;i+=128000) {
        const done=waitFor('result'); worker.postMessage({type:'audio',samples:samples.slice(i,i+128000), start:i/16000,end:(i+128000)/16000});
        chunks.push(await done);
      }
      worker.terminate(); await ctx.close();
      return {init_seconds:initSeconds,wall_seconds:(performance.now()-start)/1000,chunks};
    }''')
    result['worker_revision'] = revision
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
    browser.close()
server.shutdown()
