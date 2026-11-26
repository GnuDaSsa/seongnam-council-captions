import json
import threading
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import expect, sync_playwright

expect.set_options(timeout=15000)

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

prior_vote = {'vodId':'5403',
              'sourceUrl':'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5403',
              'registeredOn':'2026-07-07','position':7229.25}
catalog = {'meetings':[
    {'id':'5483','title':'Test council','date':'2026-10-07','officialPage':'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5483',
     'playlist':'https://cast.sncouncil.go.kr/vod/test.m3u8','minutesUrl':'https://www.sncouncil.go.kr/record/recordView.do?key=abc123',
     'cues':[{'id':'a','start':2,'end':5,'text':'first cache',
              'speaker':{'name':'Chair','registeredVodReference':prior_vote},'source':'minutes_aligned'},
             {'id':'b','start':8,'end':11,'text':'second cache','source':'asr',
              'speaker':{'registeredVodReference':{**prior_vote,'sourceUrl':'https://malicious.invalid/'}}}]},
    {'id':'2','title':'Other council','date':'2026-10-08','officialPage':'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=2',
     'playlist':'https://cast.sncouncil.go.kr/vod/test2.m3u8','staffRoster':[{'name':'김정아','role':'자원행정팀장','source':'https://www.seongnam.go.kr/'}],'cues':[]}]}

media_stub = '''
  Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{configurable:true,get(){return this._time || 0},set(v){this._time=v}});
  Object.defineProperty(HTMLMediaElement.prototype,'readyState',{configurable:true,get(){return 4}});
  Object.defineProperty(HTMLMediaElement.prototype,'paused',{configurable:true,get(){return this._paused !== false}});
  HTMLMediaElement.prototype.play=function(){this._paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve()};
  HTMLMediaElement.prototype.pause=function(){this._paused=true;this.dispatchEvent(new Event('pause'))};
  HTMLMediaElement.prototype.load=function(){};
'''

transcript_stub = '''
  window.transcriptRequests = [];
  const realFetch = window.fetch;
  window.fetch = (input, options) => {
    const url = new URL(input, location.href);
    if (url.pathname !== '/api/vod/transcript') return realFetch(input, options);
    return new Promise(resolve => {
      window.transcriptRequests.push({path:url.pathname + url.search, signal:options?.signal, resolve});
    });
  };
  window.finishTranscript = (index, status, data) => {
    window.transcriptRequests[index].resolve(new Response(JSON.stringify(data), {status}));
  };
'''

def start_personal(view, request_count):
    view.locator('#vod-mode-personal').check()
    view.evaluate("document.getElementById('vod-video').play()")
    view.locator('#vod-generate').click()
    view.wait_for_function('count => window.transcriptRequests.length === count', arg=request_count)
    expect(view.locator('#vod-track-summary')).to_contain_text('발언자 대조 자료를 불러오는 중')

def emit_personal(view, start, text):
    view.evaluate('''([start, text]) => {
      const video = document.getElementById('vod-video');
      window.captureArgs.onCue({start, end:start+5, text});
      video.currentTime = start+1;
      video.dispatchEvent(new Event('timeupdate'));
    }''', [start, text])

def official_transcript(meeting_id, turns):
    return {'meetingId':meeting_id,
            'sourceUrl':'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no='+meeting_id,
            'turns':turns}

def finish_transcript(view, index, status, data):
    view.evaluate('args => window.finishTranscript(...args)', [index, status, data])

with server() as base, sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page()
    page.add_init_script(media_stub)
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
    proof = page.get_by_role('link',name='발언자 근거 영상')
    prior_position = prior_vote['sourceUrl']+'&position=7229'
    expect(proof).to_have_count(1)
    expect(proof).to_have_attribute('href',prior_position)
    expect(proof).to_have_attribute('target','_blank')
    expect(proof).to_have_attribute('rel','noopener noreferrer')
    assert proof.evaluate("link => link.previousElementSibling?.matches('button.vod-cue')") is True
    page.context.route(prior_position,lambda r:r.fulfill(content_type='text/html',body='<title>Official evidence fixture</title>'))
    with page.expect_popup() as popup:
        proof.click()
    popup.value.wait_for_url(prior_position)
    assert popup.value.title() == 'Official evidence fixture'
    popup.value.close()
    assert page.evaluate('v.currentTime') == 9
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

    reference_page = browser.new_page()
    reference_page.add_init_script(media_stub + transcript_stub)
    reference_page.route('**/*',route)
    reference_page.goto(base+'?vod=5483',wait_until='domcontentloaded')
    select = reference_page.locator('#vod-meeting-select')
    now_speaker = reference_page.locator('#vod-caption-now .vod-now-speaker')
    now_source = reference_page.locator('#vod-caption-now .vod-now-source')
    track_summary = reference_page.locator('#vod-track-summary')
    expect(select).to_have_value('5483')
    start_personal(reference_page, 1)
    assert reference_page.evaluate('window.transcriptRequests[0].path') == '/api/vod/transcript?id=5483'
    heard = '폐기물 처리시설 관련 세부 사업비 자료를 위원님들께 별도로 제출하겠습니다.'
    next_heard = '연말에 시민 의견을 반영한 상세 보완계획을 별도로 안내하겠습니다.'
    emit_personal(reference_page, 3715, heard)
    expect(now_speaker).to_have_text('발언자 미확인')
    expect(now_source).to_have_text('지금 음성 인식 · 미검토')
    finish_transcript(reference_page, 0, 200, official_transcript('5483', [
        {'name':'정연화','role':'의원','start':3600,'end':3800,'text':heard+' '+next_heard}
    ]))
    reference_caption = '개인 자막 · 공식 회의록 대조 추정'
    expect(track_summary).to_contain_text('이 회의의 공식 발언록')
    expect(now_speaker).to_have_text('정연화 의원 · 추정')
    expect(now_source).to_have_text(reference_caption)
    expect(reference_page.locator('.vod-cue .vod-cue-speaker')).to_have_text('정연화 의원 · 추정')
    expect(reference_page.locator('.vod-cue .vod-cue-source')).to_have_text(reference_caption)
    emit_personal(reference_page, 3725, next_heard)
    expect(now_speaker).to_have_text('정연화 의원 · 추정')
    expect(now_source).to_have_text(reference_caption)
    expect(reference_page.locator('.vod-cue')).to_have_count(2)

    select.select_option('2')
    start_personal(reference_page, 2)
    staff_intro = '안녕하십니까. 자원행정팀장 김정아입니다.'
    emit_personal(reference_page, 127, staff_intro)
    expect(now_speaker).to_have_text('김정아 자원행정팀장 · 추정')
    expect(now_source).to_have_text('지금 음성 인식 · 미검토')
    finish_transcript(reference_page, 1, 200, official_transcript('2', [
        {'name':'김정아','role':'자원행정팀장','text':staff_intro}
    ]))
    expect(now_speaker).to_have_text('김정아 자원행정팀장 · 추정')
    expect(now_source).to_have_text(reference_caption)

    select.select_option('5483')
    start_personal(reference_page, 3)
    select.select_option('2')
    start_personal(reference_page, 4)
    assert reference_page.evaluate('window.transcriptRequests[2].signal.aborted')
    emit_personal(reference_page, 3715, heard)
    finish_transcript(reference_page, 2, 200, official_transcript('5483', [
        {'name':'정연화','role':'의원','text':heard}
    ]))
    expect(now_speaker).to_have_text('발언자 미확인')
    expect(track_summary).to_contain_text('발언자 대조 자료를 불러오는 중')
    finish_transcript(reference_page, 3, 200, official_transcript('2', []))
    expect(track_summary).to_contain_text('공식 발언록이 아직 없습니다')
    emit_personal(reference_page, 3725, staff_intro)
    expect(now_speaker).to_have_text('김정아 자원행정팀장 · 추정')
    expect(now_source).to_have_text('지금 음성 인식 · 미검토')

    select.select_option('5483')
    start_personal(reference_page, 5)
    finish_transcript(reference_page, 4, 503, {'error':'official_source_unavailable'})
    expect(track_summary).to_contain_text('공식 발언록을 불러오지 못했습니다')
    emit_personal(reference_page, 3725, '자원행정 과장입니다.')
    expect(now_speaker).to_have_text('과장 · 추정')
    expect(now_source).to_have_text('지금 음성 인식 · 미검토')
    reference_page.close()
    print('PASS: official transcript beyond static cues, late source updates, meeting isolation, empty and error fallback')
    # Hybrid corrections mutate one cue and preserve only evidence tied to displayed wording.
    hybrid = browser.new_page()
    hybrid.add_init_script(media_stub + transcript_stub)
    hybrid.route('**/*',route)
    hybrid.goto(base+'?vod=5483&asr=hybrid',wait_until='domcontentloaded')
    expect(hybrid.locator('#vod-meeting-select')).to_have_value('5483')
    start_personal(hybrid,1)
    speaker_a='폐기물 처리시설 관련 세부 사업비 자료를 위원님들께 별도로 제출하겠습니다.'
    speaker_b='우리 동네 도로 정비와 안전 문제를 살펴보고 필요한 조치를 조속히 추진하겠습니다.'
    finish_transcript(hybrid,0,200,official_transcript('5483',[
        {'name':'정연화','role':'의원','text':speaker_a},
        {'name':'조우현','role':'의원','text':speaker_b},
    ]))
    hybrid.wait_for_function("document.querySelector('#vod-track-summary').innerText.includes('공식 발언록과')")
    hybrid.evaluate('''([a])=>{let v=document.querySelector('#vod-video');window.savedHybrid=window.captureArgs;window.captureArgs.onCue({id:'fast-1',start:200,end:208,text:'아직 알아듣기 어려운 음성입니다.',stage:'draft'});v._time=201;v.dispatchEvent(new Event('timeupdate'));window.captureArgs.onCorrection({id:'fast-1',start:200,end:208,text:a,stage:'refined'});}''',[speaker_a])
    expect(hybrid.locator('.vod-cue')).to_have_count(1)
    expect(hybrid.locator('.vod-cue')).to_contain_text('정연화 의원 · 추정')
    expect(hybrid.locator('.vod-cue')).to_contain_text('재인식 · 공식 회의록 대조 추정')
    # Conflicting named references suppress the name instead of carrying it over.
    hybrid.evaluate('''([a,b])=>{let v=document.querySelector('#vod-video');window.captureArgs.onCue({id:'fast-2',start:210,end:218,text:a,stage:'draft'});v._time=211;v.dispatchEvent(new Event('timeupdate'));window.captureArgs.onCorrection({id:'fast-2',start:210,end:218,text:b,stage:'refined'});}''',[speaker_a,speaker_b])
    expect(hybrid.locator('.vod-cue')).to_have_count(2)
    expect(hybrid.locator('.vod-cue').nth(1)).to_contain_text('발언자 미확인')
    expect(hybrid.locator('.vod-cue').nth(1)).to_contain_text(speaker_b)
    # If only the draft has named evidence, retain its evidence-bearing text.
    hybrid.evaluate('''([a])=>{window.captureArgs.onCue({id:'fast-3',start:220,end:228,text:a.replaceAll(' ',''),rawText:a.replaceAll(' ',''),displayText:a,stage:'draft'});window.captureArgs.onCorrection({id:'fast-3',start:220,end:228,text:'다른 내용을 알아듣기 어렵습니다.',stage:'refined'});}''',[speaker_a])
    expect(hybrid.locator('.vod-cue').nth(2)).to_contain_text('보강 보류')
    expect(hybrid.locator('.vod-cue').nth(2)).to_contain_text(speaker_a)
    # A callback from a stopped meeting is never accepted in the new meeting.
    hybrid.select_option('#vod-meeting-select','2')
    hybrid.evaluate("window.savedHybrid.onCorrection({id:'fast-1',start:200,end:208,text:'stale result',stage:'refined'})")
    assert 'stale result' not in hybrid.locator('#vod-panel').inner_text()
    hybrid.close()
    print('PASS: hybrid same-cue correction, conflicting sources, one-sided evidence and meeting isolation')
    # A reference arriving after both variants must re-evaluate both, not just the final text.
    late = browser.new_page()
    late.add_init_script(media_stub + transcript_stub)
    late.route('**/*',route)
    late.goto(base+'?vod=5483&asr=hybrid',wait_until='domcontentloaded')
    expect(late.locator('#vod-meeting-select')).to_have_value('5483')
    start_personal(late,1)
    late.evaluate('''([a,b])=>{window.captureArgs.onCue({id:'late-conflict',start:200,end:208,text:a,stage:'draft'});window.captureArgs.onCorrection({id:'late-conflict',start:200,end:208,text:b,stage:'refined'});}''',[speaker_a,speaker_b])
    finish_transcript(late,0,200,official_transcript('5483',[{'name':'정연화','role':'의원','text':speaker_a},{'name':'조우현','role':'의원','text':speaker_b}]))
    expect(late.locator('.vod-cue')).to_contain_text('발언자 미확인')
    expect(late.locator('.vod-cue')).to_contain_text(speaker_b)
    late.close()
    print('PASS: late official source checks both hybrid versions')
    # Initial deep links apply once after matching video metadata, without autoplay.
    link = browser.new_page()
    link.add_init_script(media_stub + "Object.defineProperty(HTMLMediaElement.prototype,'duration',{configurable:true,get(){return 10000}});")
    link.route('**/*',route)
    link.goto(base+'?vod=5483&t=1195',wait_until='domcontentloaded')
    expect(link.locator('#vod-meeting-select')).to_have_value('5483')
    assert link.evaluate("document.querySelector('#vod-video').paused") is True
    link.evaluate("document.querySelector('#vod-video').dispatchEvent(new Event('loadedmetadata'))")
    assert link.evaluate("document.querySelector('#vod-video').currentTime") == 1195
    link.evaluate("let v=document.querySelector('#vod-video');v.currentTime=20;v.dispatchEvent(new Event('loadedmetadata'))")
    assert link.evaluate("document.querySelector('#vod-video').currentTime") == 20
    link.close()
    stale = browser.new_page()
    stale.add_init_script(media_stub + "Object.defineProperty(HTMLMediaElement.prototype,'duration',{configurable:true,get(){return 10000}});")
    stale.route('**/*',route)
    stale.goto(base+'?vod=5483&t=1195',wait_until='domcontentloaded')
    expect(stale.locator('#vod-meeting-select')).to_have_value('5483')
    stale.select_option('#vod-meeting-select','2')
    stale.evaluate("document.querySelector('#vod-video').dispatchEvent(new Event('loadedmetadata'))")
    assert stale.evaluate("document.querySelector('#vod-video').currentTime") == 0
    stale.close()
    print('PASS: deep-link seek once, no autoplay and meeting-change isolation')
    prior = browser.new_page()
    prior.add_init_script(media_stub + "Object.defineProperty(HTMLMediaElement.prototype,'duration',{configurable:true,get(){return 10000}});")
    prior.route('**/*',route)
    prior.goto(base+'?vod=5483&t=1195',wait_until='domcontentloaded')
    expect(prior.locator('#vod-meeting-select')).to_have_value('5483')
    prior.evaluate("let v=document.querySelector('#vod-video');v.currentTime=42;v.dispatchEvent(new Event('seeking'));v.dispatchEvent(new Event('loadedmetadata'))")
    assert prior.evaluate("document.querySelector('#vod-video').currentTime") == 42
    prior.close()
    outside = browser.new_page()
    outside.add_init_script(media_stub + "Object.defineProperty(HTMLMediaElement.prototype,'duration',{configurable:true,get(){return 10000}});")
    outside.route('**/*',route)
    outside.goto(base+'?vod=5483&t=10001',wait_until='domcontentloaded')
    expect(outside.locator('#vod-meeting-select')).to_have_value('5483')
    outside.evaluate("document.querySelector('#vod-video').dispatchEvent(new Event('loadedmetadata'))")
    assert outside.evaluate("document.querySelector('#vod-video').currentTime") == 0
    outside.close()
    print('PASS: pending user seek and out-of-range link do not override playback')
    role_page = browser.new_page()
    role_page.add_init_script(media_stub + transcript_stub)
    role_page.route('**/*',route)
    role_page.goto(base+'?vod=5483',wait_until='domcontentloaded')
    expect(role_page.locator('#vod-meeting-select')).to_have_value('5483')
    role_page.evaluate("window.CouncilLiveSpeaker={attribute:(_m,cues)=>({[cues[0].id]:{name:'가짜이름',role:'의사진행자',confidence:'low'}})}")
    start_personal(role_page,1)
    emit_personal(role_page,500,'다음 의원님 나오셔서 발언해 주시기 바랍니다.')
    expect(role_page.locator('.vod-cue')).to_contain_text('의사진행자 · 추정')
    assert '가짜이름' not in role_page.locator('.vod-cue').inner_text()
    role_page.close()
    print('PASS: no-roster procedural fallback retains role without a name')
    # An older candidate roster cannot augment a stronger same-meeting official roster.
    for only_candidates in (True, False):
        candidate_id='3' if only_candidates else '4'
        candidate={'id':candidate_id,'title':'Roster test','date':'2026-10-08',
          'officialPage':'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no='+candidate_id,
          'playlist':'https://cast.sncouncil.go.kr/vod/test.m3u8','members':['기존의원'],
          'staffRoster':[{'name':'기존담당','role':'기존과장','source':'https://example.org'}],
          'memberRoster':{'candidateOnly':only_candidates},'cues':[]}
        catalog['meetings'].append(candidate)
        rp=browser.new_page();rp.add_init_script(media_stub+transcript_stub);rp.route('**/*',route)
        rp.goto(base+'?vod='+candidate_id,wait_until='domcontentloaded');expect(rp.locator('#vod-meeting-select')).to_have_value(candidate_id)
        rp.evaluate("window.CouncilLiveSpeaker={attribute:(m,c)=>{window.lastRoster={members:m.members,staff:m.staffRoster};return {}}}")
        start_personal(rp,1);emit_personal(rp,500,'사업 내용을 확인해 주시기 바랍니다.')
        finish_transcript(rp,0,200,official_transcript(candidate_id,[{'name':'새로운','role':'의원','text':'공식 발언록은 이 회의의 내용을 별도로 설명합니다.'},{'name':'새담당','role':'새과장','text':'새로운 부서의 공식 자료입니다.'}]))
        rp.wait_for_function("window.lastRoster?.members?.includes('새로운')")
        roster=rp.evaluate('window.lastRoster')
        assert ('기존의원' in roster['members']) is not only_candidates
        assert any(row['name']=='기존담당' for row in roster['staff']) is not only_candidates
        assert '새로운' in roster['members'] and any(row['name']=='새담당' for row in roster['staff'])
        rp.close();catalog['meetings'].remove(candidate)
    print('PASS: exact official roster supersedes only candidate-only historical roster')

    # Live UI callbacks replay words captured in real Chrome for VOD 5479.
    # The audit export records displayed whole seconds, so fixture intervals
    # reconstruct the 8-second boundaries. The shipped reference stays intact.
    vod_index = json.loads((Path(__file__).resolve().parents[1] / 'dist/data/vod-index.json').read_text(encoding='utf-8'))
    meeting_5479 = next(row for row in vod_index['meetings'] if row['id'] == '5479')
    catalog['meetings'].append(meeting_5479)
    deferred = browser.new_page()
    deferred.add_init_script(media_stub)
    deferred.route('**/*',route)
    deferred.goto(base+'?vod=5479&asr=hybrid',wait_until='domcontentloaded')
    expect(deferred.locator('#vod-meeting-select')).to_have_value('5479')
    deferred.locator('#vod-mode-personal').check()
    expect(deferred.locator('#vod-track-summary')).to_contain_text('이 회의의 공식 발언록')
    deferred.evaluate("document.getElementById('vod-video').play()")
    deferred.locator('#vod-generate').click()
    deferred.wait_for_function("typeof window.captureArgs?.onCorrection === 'function'")

    weak_draft = '지리하신위한이만기시고요과장님. 그면제가몇가지만쫌질이좀드리겠습니다. 보니깐 7월 21일날.'
    weak_refined = '지리하실 위원이 많기시고요 과장님 그러면 제가 몇 가지만 좀 지리지 못 드리겠습니다. 보니까 7월 21일'
    next_same_turn = '사고발생이되었습니다. 그 24일이다보니까얘가원보고라고되어있는데요. 그러면성당시에서도 24일날'
    mixed_draft = '이사실을알았나요. 그렇더라면지금 3일뒤에 3망한이후에사고가발생되었다라고'
    mixed_refined = '이 사실을 알았나요. 그렇습니다. 그렇더라면 지금 3일 뒤에 사망한 이후에 사고가 발생되었다라고'
    after_mix = '실제적으로는 어떻게 보면 경찰이 신고가 된 이후에 성남시에 보고가 됐습니다. 보통 이런 사건 사고들이 생겼을 때는'
    unknown = '발언자 미확인'
    chair = '윤혜선 위원장 · 추정'
    deferred_basis = '다음 자막 수신 후 공식 회의록 대조'

    def caption_event(callback, identifier, start, text, stage='draft'):
        deferred.evaluate('''([callback, cue]) => {
          const video = document.getElementById('vod-video');
          video.currentTime = cue.end;
          video.dispatchEvent(new Event('timeupdate'));
          window.captureArgs[callback](cue);
        }''', [callback, {'id':identifier,'start':start,'end':start+8,'text':text,'rawText':text,'stage':stage}])

    def caption_row(identifier):
        return deferred.locator(f'.vod-cue[data-cue-id$="-{identifier}"]')

    def speaker_of(identifier):
        return caption_row(identifier).locator('.vod-cue-speaker')

    def label_of(identifier):
        return caption_row(identifier).locator('.vod-cue-source')

    def seek_to(when):
        deferred.evaluate('''when => {
          const video = document.getElementById('vod-video');
          video.currentTime = when;
          video.dispatchEvent(new Event('seeking'));
          video.dispatchEvent(new Event('seeked'));
        }''', when)

    def replay_pair(first_id, second_id):
        caption_event('onCue',first_id,1213,weak_draft)
        caption_event('onCorrection',first_id,1213,weak_refined,'refined')
        expect(speaker_of(first_id)).to_have_text(unknown)
        expect(label_of(first_id)).not_to_contain_text(deferred_basis)
        caption_event('onCue',second_id,1221,next_same_turn)
        expect(speaker_of(second_id)).to_have_text(chair)
        expect(speaker_of(first_id)).to_have_text(chair)
        expect(label_of(first_id)).to_contain_text(deferred_basis)

    replay_pair('actual-prior','actual-following')
    expect(deferred.locator('.vod-cue')).to_have_count(2)
    caption_event('onCue','actual-mixed',1229,mixed_draft)
    caption_event('onCue','actual-after-mixed',1237,after_mix,'refined')
    caption_event('onCorrection','actual-mixed',1229,mixed_refined,'refined')
    expect(caption_row('actual-mixed').locator('.vod-cue-text')).to_contain_text('알았나요. 그렇습니다.')
    expect(speaker_of('actual-mixed')).to_have_text(unknown)
    expect(label_of('actual-mixed')).not_to_contain_text(deferred_basis)
    expect(speaker_of('actual-after-mixed')).to_have_text(chair)
    expect(speaker_of('actual-prior')).to_have_text(chair)

    # Synthetic correction moves the observed mixed words onto the evidentiary
    # next cue's timestamp, invalidating the two-fragment inference.
    caption_event('onCorrection','actual-following',1221,mixed_refined,'refined')
    expect(speaker_of('actual-following')).to_have_text(unknown)
    expect(speaker_of('actual-prior')).to_have_text(unknown)
    expect(label_of('actual-prior')).not_to_contain_text(deferred_basis)

    # Rebuild positive contiguous evidence, then recapture only the successor
    # at the same interval after seeking. Its own match must not attach backwards.
    seek_to(1213)
    replay_pair('replayed-prior','replayed-following')
    expect(deferred.locator('.vod-cue')).to_have_count(4)
    seek_to(1221)
    caption_event('onCue','fresh-following',1221,next_same_turn)
    expect(deferred.locator('.vod-cue')).to_have_count(4)
    expect(caption_row('replayed-following')).to_have_count(0)
    expect(speaker_of('fresh-following')).to_have_text(chair)
    expect(speaker_of('replayed-prior')).to_have_text(unknown)
    expect(label_of('replayed-prior')).not_to_contain_text(deferred_basis)
    deferred.close()
    catalog['meetings'].remove(meeting_5479)
    print('PASS: real 5479 deferred speaker, mixed handoff, conflicting correction and seek replacement')

    # Original 5478 Chrome callback texts. Whole-second media bounds are reconstructed
    # from the recorded UI, and the official reference is served by its normal route.
    meeting_5478 = next(row for row in vod_index['meetings'] if row['id'] == '5478')
    catalog['meetings'].append(meeting_5478)
    predicate = browser.new_page()
    predicate.add_init_script(media_stub)
    predicate.route('**/*',route)
    predicate.goto(base+'?vod=5478&asr=hybrid',wait_until='domcontentloaded')
    expect(predicate.locator('#vod-meeting-select')).to_have_value('5478')
    predicate.locator('#vod-mode-personal').check()
    expect(predicate.locator('#vod-track-summary')).to_contain_text('이 회의의 공식 발언록')
    predicate.evaluate("document.getElementById('vod-video').play()")
    predicate.locator('#vod-generate').click()
    predicate.wait_for_function("typeof window.captureArgs?.onCorrection === 'function'")

    clause_draft = '긍까더중요한일이어딨으니까제발의뢰를무시하는행동을말아주시길간곡하게.'
    clause_refined = '더 중요한 일이 어디있습니까 제발 의외를 무시하는 행동을 말아주시길 간곡하게'
    predicate_draft = '부탁드립니다. 경찰이주셔서감사합니다.'
    predicate_refined = '부탁드립니다.'
    unrelated_refinement = '지난 회의에서 발언을 번복한 사정에 관해 별도로 제출하겠습니다.'
    assembly_member = '장정현 의원 · 추정'

    def callback_5478(callback, identifier, start, text, generation='captureArgs', stage=None, end=None, flags=None):
        predicate.evaluate('''([callback, cue, generation]) => {
          const video = document.getElementById('vod-video');
          video.currentTime = cue.end;
          window[generation][callback](cue);
          video.dispatchEvent(new Event('timeupdate'));
        }''', [callback, {'id':identifier,'start':start,'end':end if end is not None else start+8,
                         'text':text,'rawText':text,'flags':flags or [],
                         'stage':stage or ('draft' if callback=='onCue' else 'refined')}, generation])

    def predicate_row(identifier):
        return predicate.locator(f'.vod-cue[data-cue-id$="-{identifier}"]')

    def predicate_speaker(identifier):
        return predicate_row(identifier).locator('.vod-cue-speaker')

    def seek_5478(when):
        predicate.evaluate('''when => {
          const video = document.getElementById('vod-video');
          video.currentTime=when;
          video.dispatchEvent(new Event('seeking'));
          video.dispatchEvent(new Event('seeked'));
        }''', when)

    def pair_5478(previous, following):
        callback_5478('onCue',previous,1589,clause_draft)
        callback_5478('onCorrection',previous,1589,clause_refined)
        expect(predicate_speaker(previous)).to_have_text(assembly_member)
        callback_5478('onCue',following,1597,predicate_refined,stage='refined')
        expect(predicate_speaker(following)).to_have_text(assembly_member)

    callback_5478('onCue','actual-clause',1589,clause_draft)
    callback_5478('onCorrection','actual-clause',1589,clause_refined)
    callback_5478('onCue','actual-ambiguous-predicate',1597,predicate_draft)
    expect(predicate_speaker('actual-ambiguous-predicate')).to_have_text(unknown)
    callback_5478('onCorrection','actual-ambiguous-predicate',1597,predicate_refined)
    expect(predicate_speaker('actual-ambiguous-predicate')).to_have_text(assembly_member)
    callback_5478('onCorrection','actual-clause',1589,unrelated_refinement)
    expect(predicate_speaker('actual-ambiguous-predicate')).to_have_text(unknown)

    for identifier, unsupported_draft in [
        ('explicit-handoff','부탁드립니다. 네, 경청해 주셔서 감사합니다.'),
        ('different-suffix','부탁드립니다. 경청해 주셔서 죄송합니다.'),
    ]:
        seek_5478(1589)
        callback_5478('onCue',identifier+'-clause',1589,clause_draft)
        callback_5478('onCorrection',identifier+'-clause',1589,clause_refined)
        callback_5478('onCue',identifier,1597,unsupported_draft)
        expect(predicate_speaker(identifier)).to_have_text(unknown)
        callback_5478('onCorrection',identifier,1597,predicate_refined)
        expect(predicate_speaker(identifier)).to_have_text(unknown)

    # The recognition worker may deliver a first-and-only refined callback when
    # no draft is usable. Reuse the observed final text to exercise this path.
    seek_5478(1589)
    pair_5478('clause-one','predicate-one')
    callback_5478('onCorrection','clause-one',1589,unrelated_refinement)
    expect(predicate_speaker('predicate-one')).to_have_text(unknown)
    callback_5478('onCorrection','clause-one',1589,clause_refined)
    expect(predicate_speaker('predicate-one')).to_have_text(assembly_member)

    seek_5478(1589)
    callback_5478('onCue','same-time-new-clause',1589,unrelated_refinement)
    expect(predicate_row('clause-one')).to_have_count(0)
    expect(predicate_speaker('predicate-one')).to_have_text(unknown)

    seek_5478(1597)
    callback_5478('onCue','predicate-without-clause',1597,predicate_refined)
    expect(predicate_row('predicate-one')).to_have_count(0)
    expect(predicate_speaker('predicate-without-clause')).to_have_text(unknown)

    predicate.evaluate("window.oldCaptureArgs = window.captureArgs")
    predicate.locator('#vod-stop').click()
    seek_5478(1589)
    predicate.locator('#vod-generate').click()
    predicate.wait_for_function("window.captureArgs !== window.oldCaptureArgs")
    pair_5478('clause-two','predicate-two')
    callback_5478('onCorrection','clause-two',1589,unrelated_refinement,'oldCaptureArgs')
    expect(predicate_speaker('predicate-two')).to_have_text(assembly_member)

    # This separate 5478 trace actually measured 5.4503ms of overlap between
    # successive capture chunks. Combine those coordinates with the earlier
    # authenticated split wording to reproduce the clock edge, not an extra
    # observed identification.
    measured_start, measured_boundary = 1590.3628096666666, 1598.398441
    measured_current, measured_end = 1598.3929906666665, 1606.432676
    for identifier, start, flags, expected in [
        ('0-7',measured_current,[],assembly_member),
        ('0-7',measured_boundary-0.0101,[],unknown),
        ('1-7',measured_current,[],unknown),
        ('0-8',measured_current,[],unknown),
        ('0-7',measured_current,['mixed'],unknown),
    ]:
        seek_5478(measured_start)
        callback_5478('onCue','0-6',measured_start,clause_refined,stage='refined',end=measured_boundary)
        callback_5478('onCue',identifier,start,'부탁드립니다. 경청해주셔서감사합니다.',
                      end=measured_end,flags=flags)
        expect(predicate_speaker(identifier)).to_have_text(unknown)
        callback_5478('onCorrection',identifier,start,predicate_refined,end=measured_end)
        expect(predicate_speaker(identifier)).to_have_text(expected)
    predicate.close()
    catalog['meetings'].remove(meeting_5478)
    print('PASS: real 5478 attached predicate loses stale or corrected predecessor evidence')

    mixed_5476 = next(row for row in vod_index['meetings'] if row['id'] == '5476')
    catalog['meetings'].append(mixed_5476)
    predicate = browser.new_page()
    predicate.add_init_script(media_stub)
    predicate.route('**/*',route)
    predicate.goto(base+'?vod=5476&asr=hybrid',wait_until='domcontentloaded')
    expect(predicate.locator('#vod-meeting-select')).to_have_value('5476')
    predicate.locator('#vod-mode-personal').check()
    expect(predicate.locator('#vod-track-summary')).to_contain_text('이 회의의 공식 발언록')
    predicate.evaluate("document.getElementById('vod-video').play()")
    predicate.locator('#vod-generate').click()
    predicate.wait_for_function("typeof window.captureArgs?.onCorrection === 'function'")
    # Visible callback order and text from the real 5476 trial; seconds are rounded.
    callback_5478('onCue','preceding-question',1411,'그받으라고요청하는것이부담이까? 시장있게실장나오셔서시정질문을받을수')
    callback_5478('onCorrection','preceding-question',1411,'받으라고 요청하는 것이 부당합니까? 시장님께 실정 나오셔서 실정 질문을 받으시니까')
    expect(predicate_speaker('preceding-question')).to_have_text('윤혜선 위원 · 추정')
    callback_5478('onCue','question-reply-question',1419,'사립니다라고말하는것이의외에서부당한요청을하는겁니까? 그거는아니죠. 저희가')
    expect(predicate_speaker('question-reply-question')).to_have_text(unknown)
    callback_5478('onCorrection','question-reply-question',1419,'가야 됩니다라고 말하는 것이 의외에서 부당한 요청을 하는 겁니까?')
    expect(predicate_speaker('question-reply-question')).to_have_text(unknown)
    expect(predicate_speaker('preceding-question')).to_have_text('윤혜선 위원 · 추정')
    predicate.close()
    catalog['meetings'].remove(mixed_5476)
    print('PASS: 5476 short intervening reply keeps its whole mixed interval unnamed after refinement')

    # Exercise public HTTPS behavior with local fixture responses and no external issue request.
    public_origin = 'https://council-preview.test'
    dist = Path(__file__).resolve().parents[1] / 'dist'
    live_id = '2853'
    live_source = 'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=' + live_id
    shared = {'id':'shared-one','start':1,'end':4,'text':'공유 자막 예제','rawText':'공유 음성 원문',
              'observedAt':'2026-11-25T07:30:00.000Z','flags':[]}
    live_manifest = {'date':'2026-11-25','defaultMeetingId':live_id,'meetings':[
        {'id':live_id,'title':'공개 시험 회의','label':'제1차','scheduledAt':'2026-11-25T04:00:00Z',
         'endsAt':'2026-11-25T11:00:00Z','officialPage':live_source,'source':live_source,
         'provider':'hls','playlist':'https://cast.sncouncil.go.kr/vod/test.m3u8'}]}

    submissions=[]
    def public_route(r):
        req = urlsplit(r.request.url)
        if req.netloc != 'council-preview.test':
            r.abort()
        elif req.path == '/api/reports':
            payload=r.request.post_data_json
            submissions.append(payload)
            r.fulfill(json={'id':payload['id'],'receipt':True,'deliveryDay':'2026-11-25'})
        elif req.path in ('/api/live/schedule','/data/live-meetings.json'):
            r.fulfill(json=live_manifest)
        elif req.path == '/api/live/captions':
            r.fulfill(json={'meetingId':live_id,'status':'ended','updatedAt':shared['observedAt'],'cues':[shared]})
        elif req.path == '/api/vod/transcript':
            r.fulfill(json=official_transcript('2', []))
        elif req.path in ('/data/vod-catalog.json','/data/vod-index.json','/api/live/nameplates',
                          '/vendor/hls.light.min.js','/tab-captions.js'):
            route(r)
        else:
            asset = (dist / (req.path.lstrip('/') or 'index.html')).resolve()
            if asset.is_relative_to(dist) and asset.is_file():
                r.fulfill(path=asset)
            else:
                r.fulfill(status=404,body='')

    public = browser.new_page()
    public.add_init_script(media_stub + "Object.defineProperty(HTMLMediaElement.prototype,'duration',{get(){return 500}});")
    public.clock.set_fixed_time('2026-11-25T07:30:00Z')
    public.route('**/*',public_route)
    public.goto(public_origin+'/',wait_until='domcontentloaded')
    expect(public.locator('.maker-credit')).to_have_text('AI반도체과 사진우 제작')
    public.wait_for_function("document.querySelector('.brand img').naturalWidth > 0")
    expect(public.locator('#live-report-hold')).to_be_visible()
    public.evaluate("document.getElementById('live-video').play()")
    public.locator('[data-report-cue=shared-one]').click()
    expect(public.locator('#live-report-hold')).to_have_attribute('aria-pressed','true')
    assert public.evaluate("document.getElementById('live-video').paused")
    form=public.locator('#live-report form')
    expect(form.locator('blockquote')).to_have_text('공유 자막 예제')
    expect(form.get_by_role('button',name='제보 보내기')).to_be_disabled()
    form.get_by_label('수정 의견').fill('공유 원문 확인 요청')
    form.get_by_role('button',name='제보 보내기').click()
    expect(form.get_by_role('status')).to_contain_text('접수했습니다')
    assert submissions[-1]['context']['source']=='live-shared'
    assert submissions[-1]['context']['meetingId']==live_id
    expect(public.get_by_role('link',name='등록된 이슈 ↗')).to_have_attribute('href',
        'https://github.com/GnuDaSsa/seongnam-council-captions/issues')
    public.locator('#live-report-cancel').click()
    expect(form).to_be_hidden()
    public.locator('#live-report-hold').click()
    assert public.evaluate("!document.getElementById('live-video').paused")

    public.locator('#player-captions').click()
    public.evaluate("window.captureArgs.onCue({start:10,end:15,text:'이 방송의 개인 자막',observedAt:Date.now()})")
    public.locator('[data-report-cue="1"]').click()
    form.get_by_label('수정 의견').fill('개인 인식 수정')
    public.evaluate("window.captureArgs.onCue({start:15,end:20,text:'다음 자막',observedAt:Date.now()+5000})")
    expect(form.get_by_label('수정 의견')).to_have_value('개인 인식 수정')
    form.get_by_role('button',name='제보 보내기').click()
    expect(form.get_by_role('status')).to_contain_text('접수했습니다')
    assert submissions[-1]['context']['source']=='live-personal'
    public.locator('#capture-stop').click()
    public.locator('#tab-vod').click()
    expect(public.locator('#vod-meeting-select')).to_have_value('5483')
    public.locator('.vod-cue').first.click()
    assert public.evaluate("document.getElementById('vod-video').currentTime")==2
    public.locator('.vod-report-cue').nth(1).click()
    assert public.evaluate("document.getElementById('vod-video').currentTime")==2
    vod_form=public.locator('#vod-report form')
    vod_form.get_by_label('수정 의견').fill('기존 자막 수정')
    vod_form.get_by_role('button',name='제보 보내기').click()
    expect(vod_form.get_by_role('status')).to_contain_text('접수했습니다')
    assert submissions[-1]['context']['source']=='vod-existing'
    public.locator('#vod-meeting-select').select_option('2')
    public.evaluate("const video=document.getElementById('vod-video'); video.currentTime=126.25; video.dispatchEvent(new Event('timeupdate'))")
    fast = public.get_by_role('link',name='빠른 자막 사용')
    settings = parse_qs(urlsplit(fast.get_attribute('href')).query)
    assert all(settings[key] == [value] for key,value in {'vod':'2','t':'126.25','asr':'hybrid','track':'personal'}.items())
    fast.click()
    expect(public.locator('#vod-asr-current')).to_have_text('빠른 자막 선택됨')
    expect(public.locator('#vod-meeting-select')).to_have_value('2')
    expect(public.locator('#vod-mode-personal')).to_be_checked()
    public.evaluate("document.getElementById('vod-video').dispatchEvent(new Event('loadedmetadata'))")
    assert public.evaluate("document.getElementById('vod-video').currentTime") == 126.25
    public.evaluate("document.getElementById('vod-video').play()")
    public.locator('#vod-generate').click()
    emit_personal(public, 126.25, '다시보기에서 발생한 자막 예제')
    public.locator('.vod-cue').click()
    expect(public.locator('.vod-cue')).to_have_attribute('aria-pressed','true')
    assert public.evaluate("document.getElementById('vod-video').paused")
    expect(vod_form.locator('blockquote')).to_have_text('다시보기에서 발생한 자막 예제')
    vod_form.get_by_label('수정 의견').fill('다시보기 오류')
    vod_form.get_by_role('button',name='제보 보내기').click()
    expect(vod_form.get_by_role('status')).to_contain_text('접수했습니다')
    assert submissions[-1]['context']['source']=='vod-personal' and submissions[-1]['context']['start']==126.25
    public.locator('#vod-report-cancel').click()
    expect(vod_form).to_be_hidden()
    back = public.get_by_role('link',name='기본 인식으로 돌아가기')
    settings = parse_qs(urlsplit(back.get_attribute('href')).query)
    assert 'asr' not in settings and settings['vod']==['2'] and settings['t']==['126.25']
    back.click()
    expect(public.locator('#vod-asr-current')).to_have_text('기본 인식 선택됨')
    public.close()
    print('PASS: public live hold, caption reports, and mode switches preserve the selected VOD and seek position')
    browser.close()
