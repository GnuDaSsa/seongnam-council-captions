"""Check the archive UI against a running preview, including its downloads."""

import argparse
from pathlib import Path
import re
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
from zipfile import ZipFile

REAL_COUNTS = {'2852': 959, '2853': 2094, '2855': 1035}


def archive_json(page, base_url, endpoint):
    response = page.request.get(base_url + endpoint)
    assert response.ok, f'{endpoint} returned HTTP {response.status}'
    return response.json()


def check_download(page, button, extension, title, example):
    with page.expect_download() as event:
        button.click()
    item = event.value
    downloaded = item.path()
    assert downloaded and item.suggested_filename.endswith('.' + extension)
    if extension == 'txt':
        body = downloaded.read_text(encoding='utf-8')
    else:
        with ZipFile(downloaded) as archive:
            assert archive.testzip() is None
            assert archive.read('mimetype') == b'application/hwp+zip'
            for name in ('META-INF/container.xml', 'Contents/content.hpf', 'Contents/header.xml'):
                ET.fromstring(archive.read(name))
            section = ET.fromstring(archive.read('Contents/section0.xml'))
            assert section.tag.endswith('}sec')
            body = '\n'.join(section.itertext())
    assert title + ' AI 생성 회의록 초안' in body
    assert '공식 회의록이 아닙니다' in body
    assert example in body
    print(extension.upper(), downloaded.stat().st_size, 'bytes')


def check_archive(page, args):
    from playwright.sync_api import expect

    status = page.locator('#archive-library-status')
    rows = page.locator('.archive-library-row')
    page.goto(args.url, wait_until='domcontentloaded')
    catalog = archive_json(page, args.url, '/api/archive/catalog')['meetings']
    page.locator('#tab-archive').click()
    if args.expect_empty:
        assert not catalog
        expect(status).to_have_text('현재 내려받을 수 있는 수집본이 없습니다.')
        expect(rows).to_have_count(0)
        if args.screenshot:
            page.screenshot(path=args.screenshot, full_page=True)
        return

    assert catalog, 'Pass --expect-empty to check a preview without archived captures.'
    expect(rows).to_have_count(len(catalog))
    if args.expect_real:
        assert {row['id'] for row in catalog} == REAL_COUNTS.keys()
        for meeting_id, expected in REAL_COUNTS.items():
            details = archive_json(page, args.url, f'/api/archive/meetings/{meeting_id}')
            assert len(details['minutes']['cues']) == expected
    meeting_id = args.meeting_id or ('2852' if args.expect_real else catalog[0]['id'])
    details = archive_json(page, args.url, f'/api/archive/meetings/{meeting_id}')
    meeting = details['meeting']
    assert meeting['id'] == meeting_id
    example = next(cue['text'].strip() for cue in details['minutes']['cues'] if cue['text'].strip())
    for suffix in ('txt', 'hwpx'):
        button = page.locator(f'[data-archive-id="{meeting_id}"][data-archive-kind="{suffix}"]')
        check_download(page, button, suffix, meeting['title'], example)
    if args.screenshot:
        page.screenshot(path=args.screenshot, full_page=True)

    # A cancelled fetch must restore the button and never emit a partial document.
    next_downloads = []
    page.on('download', lambda item: next_downloads.append(item))
    page.route('**/api/archive/meetings/' + meeting_id, lambda route: route.abort())
    button = page.locator(f'[data-archive-id="{meeting_id}"][data-archive-kind="txt"]')
    button.click()
    expect(status).to_contain_text('수집본이 만료됐거나 불러오지 못했습니다.')
    expect(button).to_be_enabled()
    assert not next_downloads


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True, help='Origin of the running preview or packaged deployment')
    parser.add_argument('--meeting-id', help='ID for TXT and HWPX downloads')
    parser.add_argument('--screenshot', type=Path, help='Optional screenshot file after checks')
    parser.add_argument('--channel', default='chrome', help='Playwright Chromium channel (default: chrome)')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--expect-empty', action='store_true')
    modes.add_argument('--expect-real', action='store_true', help='Check the three packaged capture counts')
    args = parser.parse_args()
    origin = urlsplit(args.url)
    if origin.scheme not in ('http', 'https') or not origin.netloc or origin.path not in ('', '/') or origin.query or origin.fragment:
        parser.error('--url must be an HTTP or HTTPS origin')
    if args.meeting_id is not None and not re.fullmatch(r'[1-9][0-9]{0,11}', args.meeting_id):
        parser.error('--meeting-id must be a positive ID of up to 12 digits')
    args.url = args.url.rstrip('/')

    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=args.channel, headless=True)
        try:
            page = browser.new_page(accept_downloads=True, viewport={'width': 1440, 'height': 900})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            check_archive(page, args)
            assert not errors, errors
            print('PASS archive browser checks')
        finally:
            browser.close()


if __name__ == '__main__':
    main()
