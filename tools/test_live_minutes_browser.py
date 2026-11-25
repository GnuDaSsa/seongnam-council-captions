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
 cue={'id':'1','start':0,'end':8,'observedAt':'2026-11-25T04:00:00Z','text':'original statement','rawText':'original statement','flags':['low_confidence']}
 def route(r):
  u=r.request.url
  if '/api/live/minutes?' in u: r.fulfill(json={'meetingId':'2853','cues':[cue,{'id':'2','start':8,'end':16,'text':'bad segment secret','rawText':'bad segment secret','flags':['segment_review']}],'status':'live','updatedAt':'2026-11-25T04:00:00Z','gaps':[{'start':'2026-11-25T04:00:00Z','end':None,'reason':'interrupted'}]})
  elif '/api/live/captions?' in u: r.fulfill(status=404,body='')
  elif 'cast.sncouncil.go.kr' in u or 'youtube.com' in u: r.abort()
  else: r.continue_()
 page.route('**/*',route); page.goto(base_url,wait_until='domcontentloaded')
 page.wait_for_selector('#live-meeting-select option',state='attached')
 page.evaluate("() => { window.CouncilDepartmentReview = {suggestions: () => [{heard:'original',official:'corrected'}]}; }")
 page.locator('#minutes-open').click(); page.locator('#minutes-edit > summary').click(); page.wait_for_selector('.minutes-cue', state='visible')
 assert '1970' not in page.locator('#minutes-status').inner_text()
 assert page.locator('.minutes-cue').first.locator('textarea').input_value()=='original statement'
 page.locator('.minutes-cue').first.locator('button').click()
 assert page.locator('.minutes-cue').first.locator('textarea').input_value()=='corrected statement'
 assert 'original statement' in page.locator('#minutes-preview').inner_text()
 assert 'bad segment secret' not in page.locator('#minutes-preview').inner_text()
 page.locator('.minutes-cue').first.locator('input[aria-label]').fill('Test Person')
 page.locator('.minutes-cue').first.locator('select').select_option(index=3)
 assert 'Test Person' in page.locator('#minutes-preview').inner_text()
 page.locator('.minutes-cue').first.locator('input[type=checkbox]').check()
 assert page.locator('#minutes-preview').inner_text().count('edited statement') == 0
 assert 'original statement' in page.locator('#minutes-preview').inner_text()
 assert 'bad segment secret' not in page.locator('#minutes-preview').inner_text()
 page.locator('.minutes-cue').first.locator('textarea').fill('edited statement')
 preview=page.locator('#minutes-preview').inner_text()
 assert 'original statement' in preview and 'edited statement' in preview and 'Test Person' in preview
 with page.expect_download() as d: page.locator('#minutes-txt').click()
 assert open(d.value.path(),encoding='utf-8').read()==preview
 page.reload(wait_until='domcontentloaded'); page.locator('#minutes-open').click(); page.locator('#minutes-edit > summary').click()
 assert page.locator('.minutes-cue').first.locator('input[aria-label]').input_value() == 'Test Person'
 assert page.locator('.minutes-cue').first.locator('input[type=checkbox]').is_checked()
 page.evaluate("() => { Storage.prototype.setItem = function() { throw new Error('quota'); }; }")
 page.locator('.minutes-cue').first.locator('textarea').fill('quota edit')
 assert 'quota edit' in page.locator('#minutes-preview').inner_text()
 assert page.locator('.minutes-cue').first.locator('small').first.inner_text() != ''
 page.evaluate("window.CouncilTabCapture.start = async o => o.onCue({text:'personal cue',start:0,end:8,observedAt:1795579200000}); window.CouncilTabCapture.stop = () => {}")
 page.locator('.caption-footer details > summary').click(); page.locator('#capture-start').click(); page.wait_for_timeout(100)
 with page.expect_download() as d: page.locator('#local-save').click()
 hw=zipfile.ZipFile(d.value.path()).read('Preview/PrvText.txt').decode()
 with page.expect_download() as d: page.locator('#local-save-txt').click()
 txt=open(d.value.path(),encoding='utf-8').read()
 assert hw==txt and 'personal cue' in txt and '2026' in txt
 print('PASS: low confidence visible, edits retain original, personal HWPX/TXT timestamp parity')
 b.close()
