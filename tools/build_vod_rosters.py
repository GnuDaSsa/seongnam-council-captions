"""Build conservative archive member candidates from saved final official minutes.

Usage: python tools/build_vod_rosters.py --work-dir ../
The work directory contains live-research and vod-repair with archived official HTML.
No network requests are made. Article 4 provides a normal 30-day allowance
after the meeting. We use the later session closing date where possible,
add 31 days, and use the attendance list only as a spelling candidate list.
"""

import argparse
from datetime import date, timedelta
from hashlib import sha256
import json
from pathlib import Path
import re

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
RECORD = 'https://www.sncouncil.go.kr/record/recordView.do?key='
TERMS = [
    {'number': 9, 'start': '2022-07-01', 'end': '2026-06-30'},
    {'number': 10, 'start': '2026-07-01', 'end': '2030-06-30'},
]
TERM_SOURCE = 'https://www.sncouncil.go.kr/kr/chairman/chairmanlist.do'
DISCLOSURE_RULE = 'https://www.elis.go.kr/allalr/selectAlrBdtOne?alrNo=41130101250024&histNo=003&menuNm=main'
AVAILABILITY_BASIS = 'final-record-publication-allowance-plus-one-day'
STAFF_BASIS = 'official-assigned-committee-support-team'
STAFF_CONTACT_BASIS = 'official-recorded-committee-contact'
SESSION_CLOSURES = {
    '2026-09-07': ('live-research/roster-plenary-20260827.html',
                   'fe4625cdedd808bd4c839af6aa981f49d19963aecf119e33d122b25cfb05bb36cb4f192eb100112c'),
    '2026-10-21': ('vod-repair/minutes5488.html',
                   '4300cf9258cf00a674762ce73920f00cc36d3b01b1abb2c4a3e3342a6813887af6aa9a78649e8f3b'),
}
SNAPSHOTS = (
    (9, 309, '본회의', '2026-03-18', '2026-03-18', 'live-research/podium-blind/prior-20260318.html',
     'd9a62d06f8e18a177f69f13dac6221e8fd9c5f77b80705001513679ff0fbbedb9a17322f6f4f5539'),
    (10, 311, '본회의', '2026-07-08', '2026-07-08', 'live-research/roster-311-plenary.html',
     'eb4f36637b2332e6abd4544a0a868f2825cdc82c07d691ae160dd514d88e5a04d66ae99255391580'),
    (10, 311, '도시건설위원회', '2026-07-08', '2026-07-08', 'live-research/roster-city-20260708.html',
     '7256853f1eccee0d78448a1ed16b02a272750997287342e457dc6511a0bc50e73e8234ffcdd0bc64'),
    (10, 311, '의회운영위원회', '2026-08-20', '2026-08-20', 'live-research/roster-ops-20260820.html',
     'ca0ff291424a696bede011f0d754cea2aaaa294ac179ef07670a2497d17b96c57768d9fe43d634f4'),
    (10, 312, '본회의', '2026-08-27', '2026-09-07', 'live-research/roster-plenary-20260827.html',
     '1b96d07fe07ff916fe5a85214761624c8a171c16073589b3604d8e5275447de6856e55685d528051'),
    (10, 312, '경제환경위원회', '2026-08-28', '2026-09-07', 'live-research/roster-economy-20260828.html',
     '93842ffcffb3b2558e3d8a99be9a79fca13c61805d31bc9afb0409320c5d0e026abbf1ec4717cffd'),
    (10, 312, '본회의', '2026-09-07', '2026-09-07', 'vod-repair/minutes5467.html',
     'fe4625cdedd808bd4c839af6aa981f49d19963aecf119e33d122b25cfb05bb36cb4f192eb100112c'),
    (10, 312, '의회운영위원회', '2026-09-22', '2026-09-22', 'vod-repair/minutes5476.html',
     'f1e5b9ce13dd8d144188bcb5c1c1f5b3e2ed97797ab4564334c60fb00aeb555c0b04d415f1d21448'),
    (10, 313, '의회운영위원회', '2026-10-07', '2026-10-21', 'vod-repair/minutes5480.html',
     '3a92da6bd9b09a6eb0bfd1d52dcc93fb2da5c741dbdea1297187b32b37df8bf2f673d8bf6f3c1707'),
    (10, 313, '행정교육위원회', '2026-10-07', '2026-10-21', 'vod-repair/minutes5481.html',
     'd5096a59117e05628d68628087ece0e98b223662685adc6f1f3098d748de7beb5203d3a0929015ad'),
    (10, 313, '도시건설위원회', '2026-10-07', '2026-10-21', 'vod-repair/minutes5482.html',
     '1d984bf04da30663f8c0722f356eeb1f426b9fd9a819e7c41aa123e3c326691f4620c633f58361e8'),
    (10, 313, '경제환경위원회', '2026-10-07', '2026-10-21', 'vod-repair/minutes5483.html',
     'f7f9e3bdabe55a260dbc2f63deadb037a9b872f30f039ee3a648425eb7bc0019c7107cbab4d13d8b'),
    (10, 313, '문화복지체육위원회', '2026-10-07', '2026-10-21', 'vod-repair/minutes5484.html',
     '43a132950930886bbd9802454ab1aa5a792025394b19810a0bff3c0f2809603fb8c5a459400ef4be'),
    (10, 313, '본회의', '2026-10-08', '2026-10-21', 'vod-repair/minutes5488.html',
     '9e541f3ec5c4b06519c98928bcb655736f08e71cbdb3cf4d92979c06b633d267b4bc0f9f62571a45'),
)


def attendance(canvas, body):
    title = '의원' if body == '본회의' else '위원'
    pattern = re.compile(rf'○\s*출석\s*{title}\s*\(\s*(\d+)인\s*\)')
    matches = [(tag, m) for tag in canvas.find_all('strong') if (m := pattern.fullmatch(tag.get_text(' ', strip=True)))]
    if len(matches) != 1:
        raise ValueError('expected a unique official attendance section')
    heading, match = matches[0]
    members = []
    for node in heading.next_siblings:
        if node.name == 'strong' and node.get_text(' ', strip=True).startswith('○'):
            break
        if node.name == 'a' and node.get('href', '').startswith('/kr/profile/profile.do?key='):
            members.append(node.get_text(' ', strip=True))
    if (len(members) != int(match[1]) or not 0 < len(members) <= 40 or len(members) != len(set(members))
            or not all(re.fullmatch(r'[가-힣]{2,4}', name) for name in members)):
        raise ValueError('official attendance count, spelling or uniqueness check failed')
    return members


def closure_sources(work_dir):
    links = {}
    for day, (path, record_key) in SESSION_CLOSURES.items():
        soup = BeautifulSoup((work_dir / path).read_bytes(), 'html.parser')
        closing = soup.find('a', href='/record/recordView.do?key=' + record_key)
        dotted = re.escape(date.fromisoformat(day).strftime('%Y.%m.%d'))
        if not closing or not re.fullmatch(rf'제\d+회 본회의 제\d+차\({dotted} [가-힣]+\)', closing.get('title', '')):
            raise ValueError(f'{path}: closing plenary link for {day} not found')
        links[day] = RECORD + record_key
    return links


def assigned_committee_staff(canvas, term, body, members, source_url):
    speeches = canvas.find_all('spk')
    chair = speeches[0]
    chair_name = re.fullmatch(r'○위원장 ([가-힣]{2,4})', chair.strong.get_text(' ', strip=True))
    if not chair_name or chair_name[1] not in members:
        raise ValueError('expected committee chair to introduce the assigned support team')
    chair_text = ' '.join(chair.get_text(' ', strip=True).split())
    team = re.search(rf'제{term}대 전반기 회기 동안 우리 위원회를 보좌하게 될 의회사무국 직원들을 소개하겠습니다\.(.*?)\(인사\)', chair_text)
    listed = re.findall(r'([가-힣]{2,4}) (전문위원|주무관)입니다\.', team[1]) if team else []
    names = {name for name, _ in listed}
    if ([role for _, role in listed] != ['전문위원', '주무관', '주무관', '주무관'] or len(names) != len(listed)
            or names.intersection(members)):
        raise ValueError('expected a full, uniquely named assigned committee support team')
    intros = set()
    designation = body + ' 담당'
    for speech in speeches:
        text = ' '.join(speech.get_text(' ', strip=True).split())
        match = re.match(rf'○의회사무국직원 ([가-힣]{{2,4}}) 안녕하십니까[?.] {designation} \1입니다\.', text)
        if match and match[1] in names:
            intros.add(match[1])
    if len(intros) != 1:
        raise ValueError('expected one independently introduced committee contact')
    return [{'name': name, 'role': designation if name in intros else role, 'officialRole': role,
             'roleBasis': 'recorded-self-introduction' if name in intros else 'chair-assigned-role',
             'source': source_url, 'basis': STAFF_BASIS, 'candidateOnly': True}
            for name, role in listed]


def recorded_committee_contact(canvas, body, members, source_url):
    chair, contact, *_ = canvas.find_all('spk')
    chair_name = re.fullmatch(r'○위원장 ([가-힣]{2,4})', chair.strong.get_text(' ', strip=True))
    handoff = '의회사무국 주무관 나오셔서 보고해 주시기 바랍니다.'
    if not chair_name or chair_name[1] not in members or not chair.get_text(' ', strip=True).endswith(handoff):
        raise ValueError('expected a chair handoff to the same committee contact')
    designation = body + ' 담당'
    verified = re.match(rf'○의회사무국직원 ([가-힣]{{2,4}}) 안녕하십니까[?.] {designation} \1입니다\.',
                        ' '.join(contact.get_text(' ', strip=True).split()))
    if not verified or verified[1] in members:
        raise ValueError('contact self-introduction is absent or ambiguous')
    headings = [tag for tag in canvas.find_all('strong') if tag.get_text(' ', strip=True) == '○출석 사무국 직원']
    if len(headings) != 1:
        raise ValueError('expected a unique official staff role section')
    entries = []
    for node in headings[0].next_siblings:
        if node.name == 'strong':
            break
        if node.name == 'span' and 'ib' in node.get('class', []):
            entries.append(node.get_text(' ', strip=True))
    pairs = list(zip(entries[::2], entries[1::2]))
    if len(entries) % 2 or pairs.count(('주무관', verified[1])) != 1 or entries[1::2].count(verified[1]) != 1:
        raise ValueError('contact official role is absent or ambiguous')
    return [{'name': verified[1], 'role': designation, 'officialRole': '주무관',
             'roleBasis': 'recorded-self-introduction', 'source': source_url,
             'basis': STAFF_CONTACT_BASIS, 'candidateOnly': True}]


def load_snapshot(work_dir, spec, closing_links):
    term, session, body, source_date, session_end, html_path, record_key = spec
    day, end = map(date.fromisoformat, (source_date, session_end))
    term_row = next(row for row in TERMS if row['number'] == term)
    if not term_row['start'] <= source_date <= session_end <= term_row['end']:
        raise ValueError(f'{html_path}: invalid term or session dates')
    actual = (work_dir / html_path).read_bytes()
    soup = BeautifulSoup(actual, 'html.parser')
    title = ' '.join(soup.title.get_text().split()) if soup.title else ''
    expected = rf'제{session}회 {body} (?:제\d+차|개회식)\({day:%Y.%m.%d.}\)'
    canvas = soup.select_one('#canvas')
    heading = canvas.find('h1') if canvas else None
    header = re.sub(r'\s+', '', canvas.get_text(' ', strip=True)[:260]) if canvas else ''
    written_date = f'일시{day.year}년{day.month}월{day.day}일'
    if (not re.fullmatch(expected, title) or not heading or heading.get_text(strip=True) != body + '회의록'
            or written_date not in header or '임시회의록' in header or '잠정회의록' in header):
        raise ValueError(f'{html_path}: source is not the expected final same-body record')
    source_url = RECORD + record_key
    members = attendance(canvas, body)
    row = {'term': term, 'session': session, 'body': body, 'sourceDate': source_date, 'sessionEnd': session_end,
            'sessionEndSourceUrl': source_url if day == end else closing_links[session_end],
            'availableFrom': (end + timedelta(days=31)).isoformat(), 'availabilityBasis': AVAILABILITY_BASIS,
            'sourceUrl': source_url, 'sourceSha256': sha256(actual).hexdigest(),
            'basis': 'official-final-minutes-attendance', 'members': members}
    # Only this verified record appoints a full same-body support team for the term.
    if (term, session, body, source_date) == (10, 311, '도시건설위원회', '2026-07-08'):
        row['staffRoster'] = assigned_committee_staff(canvas, term, body, members, source_url)
    if (term, session, body, source_date) == (10, 311, '의회운영위원회', '2026-08-20'):
        row['staffRoster'] = recorded_committee_contact(canvas, body, members, source_url)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, default=ROOT.parent)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/data/vod-rosters.json')
    args = parser.parse_args()
    closing_links = closure_sources(args.work_dir)
    snapshots = [load_snapshot(args.work_dir, spec, closing_links) for spec in SNAPSHOTS]
    result = {'schemaVersion': 1, 'termSource': TERM_SOURCE, 'availabilityRuleSource': DISCLOSURE_RULE,
              'terms': TERMS, 'snapshots': snapshots}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(f'Prepared {len(snapshots)} dated official attendance snapshots')


if __name__ == '__main__':
    main()
