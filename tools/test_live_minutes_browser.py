import zipfile
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

@contextmanager
def serve_dist():
    directory = Path(__file__).resolve().parents[1] / 'dist'
    handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

from playwright.sync_api import sync_playwright
with serve_dist() as base_url, sync_playwright() as p:
 b=p.chromium.launch(channel='chrome',headless=True); page=b.new_page(accept_downloads=True)
 cue={'id':'1','start':0,'end':8,'observedAt':'2026-11-25T04:00:00Z','text':'original statement','rawText':'original statement','flags':['low_confidence','number','name']}
 def route(r):
  u=r.request.url
  if '/api/live/minutes?' in u: r.fulfill(json={'meetingId':u.split('meetingId=')[1].split('&')[0],'cues':[cue,{'id':'2','start':8,'end':16,'text':'bad segment secret','rawText':'bad segment secret','flags':['segment_review']},{'id':'3','start':17,'end':20,'text':'placeholder','rawText':'user retained source','flags':['segment_review']}],'status':'live','updatedAt':'2026-11-25T04:00:00Z','gaps':[{'start':'2026-11-25T04:00:00Z','end':None,'reason':'interrupted'}]})
  elif '/api/live/captions?' in u: r.fulfill(status=404,body='')
  elif 'cast.sncouncil.go.kr' in u or 'youtube.com' in u: r.abort()
  else: r.continue_()
 page.add_init_script("localStorage.setItem('council-live-minutes:2853:2', '[음성 인식 오류 · 원음 재확인 필요]'); localStorage.setItem('council-live-minutes:2853:3', '[음성 인식 오류 · 원음 재확인 필요]'); localStorage.setItem('council-live-minutes:2853:3:explicit', '1');")
 page.route('**/*',route); page.goto(base_url,wait_until='domcontentloaded')
 page.wait_for_selector('#live-meeting-select option',state='attached')
 page.evaluate("() => { window.CouncilCommitteeTerms = {suggestions: () => [{heard:'original',official:'corrected',source:'https://example.test/'}]}; window.CouncilSpeakerReview = {guesses: m => String(m.id) === '2853' ? ({'1':{name:'Candidate',role:'Chair',evidence:['1']}}) : ({})}; }")
 page.locator('#minutes-open').click(); page.locator('#minutes-edit > summary').click(); page.wait_for_selector('.minutes-cue', state='visible')
 assert not page.locator('#minutes-speaker-filter').is_checked()
 assert '1' in page.locator('#minutes-speaker-filter-label').inner_text()
 assert page.locator('.minutes-cue:visible').count() == 3
 full_preview = page.locator('#minutes-preview').inner_text()
 page.locator('#minutes-speaker-filter').check()
 assert page.locator('.minutes-cue:visible').count() == 1
 assert page.locator('#minutes-preview').inner_text() == full_preview
 with page.expect_download() as d: page.locator('#minutes-txt').click()
 assert open(d.value.path(),encoding='utf-8').read() == full_preview
 with page.expect_download() as d: page.locator('#minutes-hwpx').click()
 assert zipfile.ZipFile(d.value.path()).read('Preview/PrvText.txt').decode() == full_preview
 page.locator('#minutes-speaker-filter').uncheck()
 assert page.locator('.minutes-cue:visible').count() == 3
 assert '1970' not in page.locator('#minutes-status').inner_text()
 assert page.locator('.minutes-cue').nth(1).locator('textarea').input_value() == 'bad segment secret'
 assert page.locator('.minutes-cue').nth(2).locator('textarea').input_value() == '[음성 인식 오류 · 원음 재확인 필요]'
 assert '숫자 확인' in page.locator('.minutes-cue').first.locator('.cue-review').inner_text()
 assert '이름 확인' in page.locator('.minutes-cue').first.locator('.cue-review').inner_text()
 assert '숫자 확인' not in page.locator('#minutes-preview').inner_text()
 assert page.locator('.minutes-cue').first.locator('textarea').input_value()=='original statement'
 assert 'Candidate' not in page.locator('#minutes-preview').inner_text()
 page.locator('.minutes-cue').first.locator('button').nth(0).click()
 assert 'Candidate' in page.locator('#minutes-preview').inner_text()
 page.locator('.minutes-cue').first.locator('button').nth(1).click()
 assert page.locator('.minutes-cue').first.locator('textarea').input_value()=='corrected statement'
 assert 'original statement' not in page.locator('#minutes-preview').inner_text()
 assert 'bad segment secret' in page.locator('#minutes-preview').inner_text()
 page.locator('.minutes-cue').first.locator('input[aria-label]').fill('Test Person')
 page.locator('.minutes-cue').first.locator('select').select_option(index=3)
 assert 'Test Person' in page.locator('#minutes-preview').inner_text()
 page.locator('.minutes-cue').first.locator('input[type=checkbox]').check()
 assert page.locator('#minutes-preview').inner_text().count('edited statement') == 0
 assert 'original statement' not in page.locator('#minutes-preview').inner_text()
 assert 'bad segment secret' in page.locator('#minutes-preview').inner_text()
 page.locator('.minutes-cue').first.locator('textarea').fill('edited statement\nsecond paragraph')
 preview=page.locator('#minutes-preview').inner_text()
 assert 'original statement' not in preview and 'edited statement\nsecond paragraph' in preview and 'Test Person' in preview
 with page.expect_download() as d: page.locator('#minutes-txt').click()
 assert open(d.value.path(),encoding='utf-8').read()==preview
 with page.expect_download() as d: page.locator('#minutes-hwpx').click()
 assert zipfile.ZipFile(d.value.path()).read('Preview/PrvText.txt').decode()==preview
 assert 'bad segment secret' in preview and 'original statement' not in preview
 first_card=page.locator('.minutes-cue').first
 first_card.get_by_text('발언자 후보 근거',exact=True).click()
 assert 'original statement' in first_card.locator('details[open]').inner_text()
 first_card.get_by_text('수집 원문·정리 결과·편집 이력',exact=True).click()
 assert 'original statement' in first_card.locator('details').last.inner_text()
 page.reload(wait_until='domcontentloaded'); page.evaluate("() => { window.CouncilSpeakerReview = {guesses: m => String(m.id) === '2853' ? ({'1':{name:'Candidate',role:'Chair',evidence:['1']}}) : ({})}; }"); page.locator('#minutes-open').click(); page.locator('#minutes-edit > summary').click()
 assert page.locator('.minutes-cue').first.locator('input[aria-label]').input_value() == 'Test Person'
 assert page.locator('.minutes-cue').first.locator('input[type=checkbox]').is_checked()
 page.locator('#minutes-speaker-filter').check()
 page.locator('#minutes-refresh').click()
 page.wait_for_function("!document.querySelector('#minutes-content').hidden && !document.querySelector('#minutes-speaker-filter').checked")
 assert page.locator('.minutes-cue:visible').count() == 3
 page.locator('#minutes-speaker-filter').check()
 page.select_option('#live-meeting-select',value='2852')
 page.wait_for_function("!document.querySelector('#minutes-content').hidden && document.querySelector('#minutes-speaker-filter-label').textContent.includes('(0')")
 assert not page.locator('#minutes-speaker-filter').is_checked()
 assert page.locator('#minutes-speaker-empty').is_visible()
 assert page.locator('.minutes-cue:visible').count() == 3
 page.locator('#minutes-speaker-filter').check()
 assert page.locator('.minutes-cue:visible').count() == 0
 assert page.locator('#minutes-speaker-empty').is_visible()
 page.select_option('#live-meeting-select',value='2853')
 page.wait_for_function("!document.querySelector('#minutes-content').hidden && document.querySelector('#minutes-speaker-filter-label').textContent.includes('(1')")
 assert not page.locator('#minutes-speaker-filter').is_checked()
 assert page.locator('.minutes-cue').first.locator('input[aria-label]').input_value() == 'Test Person'
 page.evaluate("() => { Storage.prototype.setItem = function() { throw new Error('quota'); }; }")
 page.locator('.minutes-cue').first.locator('textarea').fill('quota edit')
 assert 'quota edit' in page.locator('#minutes-preview').inner_text()
 assert page.locator('.minutes-cue').first.locator('small').first.inner_text() != ''
 page.evaluate("window.CouncilTabCapture.start = async o => o.onCue({text:'유인물로 가름하겠습니다.',start:0,end:8,observedAt:1795579200000}); window.CouncilTabCapture.stop = () => {}")
 page.locator('.caption-footer details > summary').click(); page.locator('#capture-start').click(); page.wait_for_timeout(100)
 with page.expect_download() as d: page.locator('#local-save').click()
 hw=zipfile.ZipFile(d.value.path()).read('Preview/PrvText.txt').decode()
 with page.expect_download() as d: page.locator('#local-save-txt').click()
 txt=open(d.value.path(),encoding='utf-8').read()
 assert hw==txt and '유인물로 갈음하겠습니다.' in txt and '유인물로 가름하겠습니다.' in txt and '문맥 교정됨' in txt and '2026' in txt
 print('PASS: low confidence visible, edits retain original, personal HWPX/TXT timestamp parity')
 b.close()
