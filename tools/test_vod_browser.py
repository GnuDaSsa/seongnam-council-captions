import json
import threading
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

@contextmanager
def server():
    handler = partial(SimpleHTTPRequestHandler, directory=str(Path(__file__).resolve().parents[1] / 'dist'))
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{httpd.server_port}/'
    finally:
        httpd.shutdown(); httpd.server_close(); thread.join()

catalog = {'meetings':[
    {'id':'5483','title':'Test council','date':'2026-10-07','officialPage':'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5483',
     'playlist':'https://cast.sncouncil.go.kr/vod/test.m3u8','minutesUrl':'https://www.sncouncil.go.kr/record/recordView.do?key=abc123','cues':[{'id':'a','start':2,'end':5,'text':'first cache','speaker':'Chair','source':'minutes_aligned'},{'id':'b','start':8,'end':11,'text':'second cache','source':'asr'}]},
    {'id':'2','title':'Other council','date':'2026-10-08','officialPage':'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=2',
     'playlist':'https://cast.sncouncil.go.kr/vod/test2.m3u8','staffRoster':[{'name':'김정아','role':'자원행정팀장'}],'cues':[]}]}

with server() as base, sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page()
    page.add_init_script('''
      Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{configurable:true,get(){return this._time || 0},set(v){this._time=v}});
      Object.defineProperty(HTMLMediaElement.prototype,'readyState',{configurable:true,get(){return 4}});
      Object.defineProperty(HTMLMediaElement.prototype,'paused',{configurable:true,get(){return this._paused !== false}});
      HTMLMediaElement.prototype.play=function(){this._paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve()};
      HTMLMediaElement.prototype.pause=function(){this._paused=true;this.dispatchEvent(new Event('pause'))};
      HTMLMediaElement.prototype.load=function(){};
    ''')
    def route(r):
        url = r.request.url
        if '/data/vod-catalog.json' in url: r.fulfill(json=catalog)
        elif '/data/vod-index.json' in url: r.fulfill(json={'meetings':[]})
        elif '/api/live/captions?' in url or '/api/live/nameplates?' in url: r.fulfill(status=404,body='')
        elif '/vendor/hls.light.min.js' in url: r.fulfill(content_type='text/javascript', body="window.Hls=class {static isSupported(){return true} static Events={ERROR:'error'};on(){}loadSource(){}attachMedia(){}destroy(){}}")
        elif '/tab-captions.js' in url: r.fulfill(content_type='text/javascript',body="window.CouncilTabCapture={async startPlayer(o){window.captureArgs=o},stop(){window.stopped=(window.stopped||0)+1;window.captureArgs?.onEnd()}}")
        elif 'cast.sncouncil.go.kr' in url or 'youtube.com' in url: r.abort()
        else: r.continue_()
    page.route('**/*',route)
    page.goto(base,wait_until='domcontentloaded')
    page.locator('#tab-vod').click()
    page.wait_for_function("document.querySelectorAll('#vod-meeting-select option').length === 2")
    assert page.locator('#vod-meeting-select').input_value() == '5483'
    assert page.locator('#vod-mode-existing').is_checked()
    assert page.locator('#vod-generate').is_hidden()
    page.locator('#vod-resolve-input').fill('https://evil.example/vod/vod_view.jsp?pk_vod_no=123')
    page.locator('#vod-resolve-form button').click()
    assert page.locator('#vod-resolve-status').inner_text()
    assert page.locator('#vod-meeting-select').input_value() == '5483'
    page.evaluate('''() => {
      window.pendingVod={}; const originalFetch=window.fetch;
      window.fetch=(url,opts)=>String(url).startsWith('/api/vod/resolve?')
        ? new Promise(resolve => window.pendingVod[new URL(url,location.href).searchParams.get('id')]=resolve)
        : originalFetch(url,opts);
      window.finishVod=id=>window.pendingVod[id](new Response(JSON.stringify({id,title:'Resolved '+id,
        officialPage:'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no='+id,
        playlist:'https://cast.sncouncil.go.kr:4443/vod/valid.m3u8',cues:[]})));
    }''')
    page.locator('#vod-resolve-input').fill('123')
    page.locator('#vod-resolve-form button').click()
    page.wait_for_function("typeof window.pendingVod['123'] === 'function'")
    page.evaluate("window.finishVod('123')")
    page.wait_for_function("document.querySelector('#vod-meeting-select').value === '123'")
    assert page.locator('#vod-meeting-select option').count() == 3
    page.locator('#vod-resolve-input').fill('https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5483')
    page.locator('#vod-resolve-form button').click()
    assert page.locator('#vod-meeting-select').input_value() == '5483'
    page.locator('#vod-resolve-input').fill('124')
    page.locator('#vod-resolve-form button').click()
    page.wait_for_function("typeof window.pendingVod['124'] === 'function'")
    page.select_option('#vod-meeting-select',value='2')
    page.evaluate("window.finishVod('124')")
    page.wait_for_timeout(100)
    assert page.locator('#vod-meeting-select').input_value() == '2'
    assert page.locator('#vod-meeting-select option[value="124"]').count() == 0
    page.select_option('#vod-meeting-select',value='5483')
    page.evaluate("v=document.querySelector('#vod-video');v._time=3;v.dispatchEvent(new Event('timeupdate'))")
    assert 'first cache' in page.locator('#vod-caption-now').inner_text()
    assert 'Chair' in page.locator('#vod-caption-now').inner_text()
    assert '기록 확인' in page.locator('#vod-caption-now').inner_text()
    assert '공식 회의록 대조' in page.locator('#vod-caption-now').inner_text()
    assert '발언자 미확인' in page.locator('.vod-cue').nth(1).inner_text()
    page.evaluate("v._time=9;v.dispatchEvent(new Event('timeupdate'))")
    assert 'second cache' in page.locator('#vod-caption-now').inner_text()
    page.locator('.vod-cue').first.click()
    assert page.evaluate('v.currentTime') == 2
    page.locator('#vod-mode-personal').check()
    assert page.locator('#vod-generate').is_visible()
    assert page.locator('.vod-cue').count() == 0
    assert 'first cache' not in page.locator('#vod-caption-now').inner_text()
    page.evaluate('''() => { window.CouncilLiveSpeaker = {attribute: (_meeting,cues) =>
      ({[cues[0].id]:{name:'홍길동',role:'홍길동 과장',confidence:'low',method:'자기소개'}})}; }''')
    page.evaluate('v.play()')
    page.locator('#vod-generate').click()
    assert page.evaluate('window.captureArgs.mediaTimeline') is True
    page.evaluate("window.oldCapture=window.captureArgs;window.captureArgs.onCue({start:12,end:15,text:'new speech'});v._time=13;v.dispatchEvent(new Event('timeupdate'))")
    assert 'new speech' in page.locator('#vod-caption-now').inner_text()
    assert '지금 음성 인식 · 미검토' in page.locator('#vod-caption-now').inner_text()
    assert '과장 · 추정' in page.locator('#vod-caption-now').inner_text()
    assert '홍길동' not in page.locator('#vod-caption-now').inner_text()
    assert 'Chair' not in page.locator('#vod-caption-now').inner_text()
    assert 'first cache' not in page.locator('#vod-captions').inner_text()
    assert page.locator('.vod-cue').count() == 1
    assert 'first cache' not in page.locator('#vod-captions').inner_text()
    page.evaluate("v._time=16;v.dispatchEvent(new Event('timeupdate'))")
    assert 'new speech' in page.locator('#vod-caption-now').inner_text()
    page.evaluate("v.dispatchEvent(new Event('seeking'));v.dispatchEvent(new Event('seeked'))")
    assert 'new speech' not in page.locator('#vod-caption-now').inner_text()
    page.evaluate("v.pause()")
    assert '대기' in page.locator('#vod-caption-status').inner_text()
    page.evaluate("v.play()")
    assert page.locator('#vod-stop').is_visible()
    before = page.evaluate('v.currentTime')
    page.locator('#vod-mode-existing').check()
    assert page.evaluate('v.currentTime') == before
    assert page.locator('#vod-stop').is_hidden()
    assert page.locator('#vod-generate').is_hidden()
    assert page.locator('.vod-cue').count() == 2
    assert 'new speech' not in page.locator('#vod-captions').inner_text()
    page.locator('#vod-mode-personal').check()
    assert page.locator('#vod-generate').is_visible()
    assert page.locator('.vod-cue').count() == 1
    assert 'new speech' in page.locator('#vod-captions').inner_text()
    assert page.locator('#vod-minutes').is_visible()
    page.select_option('#vod-meeting-select','2')
    assert page.locator('#vod-minutes').is_hidden()
    assert page.locator('#vod-stop').is_hidden()
    assert page.locator('.vod-cue').count() == 0
    page.evaluate("window.oldCapture.onCue({start:1,end:2,text:'stale'});")
    assert 'stale' not in page.locator('#vod-captions').inner_text()
    assert page.locator('#vod-mode-existing').is_checked()
    assert '자막이 없습니다' in page.locator('#vod-caption-status').inner_text()
    page.locator('#vod-mode-personal').check()
    page.evaluate('v.play()'); page.locator('#vod-generate').click()
    page.evaluate('''() => {
      window.CouncilLiveSpeaker = {attribute: (_meeting,cues) =>
        ({[cues[0].id]:{name:'김정아',role:'자원행정팀장',confidence:'medium',method:'명부 자기소개'}})};
      window.captureArgs.onCue({start:12,end:15,text:'name from the roster'});
      v._time=13; v.dispatchEvent(new Event('timeupdate'));
    }''')
    assert '김정아 자원행정팀장 · 추정' in page.locator('#vod-caption-now').inner_text()
    page.locator('#tab-archive').click()
    assert page.evaluate('v.paused') is True
    assert page.evaluate('window.stopped') >= 2
    page.locator('#tab-vod').click()
    page.evaluate("() => { v.play(); window.CouncilTabCapture.startPlayer=async o=>{o.onEnd();throw Error('Audio access failure')}; }")
    page.locator('#vod-generate').click()
    page.wait_for_function("document.querySelector('#vod-caption-status').textContent.includes('Audio access failure')")
    assert page.locator('#vod-generate').is_visible()
    page.evaluate("() => { window.CouncilTabCapture.startPlayer=async o=>{o.onStatus('음성 인식 오류: model');o.onEnd()}; }")
    page.locator('#vod-generate').click()
    page.wait_for_function("document.querySelector('#vod-caption-status').textContent.includes('model')")
    direct = browser.new_page()
    direct.route('**/*', route)
    direct.goto(base + '?vod=2', wait_until='domcontentloaded')
    direct.wait_for_function("document.querySelector('#vod-meeting-select').value === '2'")
    assert direct.locator('#tab-vod').get_attribute('aria-selected') == 'true'
    direct.locator('#tab-archive').click()
    direct.wait_for_timeout(200)
    assert direct.locator('#tab-archive').get_attribute('aria-selected') == 'true'
    assert direct.locator('#vod-panel').is_hidden()
    direct.close()
    print('PASS: VOD tab, cached sync/seek, media timeline generation, stale callback, direct link and tab cleanup')
    browser.close()
