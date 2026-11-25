import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import prepare_staff_roster as roster


SOURCE = 'https://www.sncouncil.go.kr/record/recordView.do?key=' + 'a' * 80
HTML = """
<p><strong>○출석 위원</strong><span class='ib w200'>공원과장</span><span class='ib w80'>김하나</span></p>
<strong>○출석 공무원 </strong><br />
<span class='ib w200'>공원과장</span>&nbsp;<span class='ib w80'>이하나</span><br />
<span class='w250 ib'>푸른도시사업소장</span><span class='w80 ib'>김나리</span><br />
<strong>○기타 참석자</strong><br /><span class='ib w250'>문화재단대표이사</span><span class='ib w80'>박다라</span>
<strong>○출석 재단 및 기관 관계자</strong><br />
<span class='ib w400'>재단대표</span><span class='ib w80'>최하나</span><br />
<strong>○출석 사무국 직원</strong><br /><span class='ib w200'>팀장</span><span class='ib w80'>홍길동</span>
"""


class RosterTests(unittest.TestCase):
    def test_only_recognized_sections_and_exact_ordered_roles(self):
        items = roster.prepare(HTML, SOURCE, ['공원과장', '재단대표', '문화재단대표이사', '공원과장'])
        self.assertEqual(items, [
            {'name':'이하나', 'role':'공원과장', 'source':SOURCE},
            {'name':'최하나', 'role':'재단대표', 'source':SOURCE},
            {'name':'박다라', 'role':'문화재단대표이사', 'source':SOURCE},
        ])
        with self.assertRaisesRegex(ValueError, 'not found'):
            roster.prepare(HTML, SOURCE, ['팀장'])

    def test_conflicts_and_missing_fail_without_partial_json(self):
        conflict = HTML.replace("<strong>○기타 참석자</strong>", "<span class='ib w200'>공원과장</span><span class='ib w80'>박다라</span><strong>○기타 참석자</strong>")
        with self.assertRaisesRegex(ValueError, 'conflicting'):
            roster.prepare(conflict, SOURCE, ['공원과장'])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'record.html'
            path.write_text(HTML, encoding='utf-8')
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = roster.main(['--html', str(path), '--source', SOURCE, '--role', '공원과장', '--role', '없는직책'])
            self.assertEqual(code, 2)
            self.assertEqual(out.getvalue(), '')
            self.assertIn('없는직책', err.getvalue())

    def test_rejects_unofficial_urls_and_unpaired_cells(self):
        for url in [SOURCE.replace('www.sncouncil.go.kr', 'evil.example'),
                    SOURCE.replace('https:', 'http:'), SOURCE + '&other=1', SOURCE + '#fragment',
                    'https://www.sncouncil.go.kr@evil.example/record/recordView.do?key=' + 'a' * 80]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                roster.validate_source(url)
        unpaired = "<strong>○출석 공무원</strong><span class='ib w200'>공원과장</span><br><span class='ib w80'>이하나</span>"
        with self.assertRaisesRegex(ValueError, 'not found'):
            roster.prepare(unpaired, SOURCE, ['공원과장'])
        intervening = "<strong>○출석 공무원</strong><span class='ib w200'>공원과장</span>다른 내용<span class='ib w80'>이하나</span>"
        with self.assertRaisesRegex(ValueError, 'not found'):
            roster.prepare(intervening, SOURCE, ['공원과장'])

    def test_plain_next_heading_stops_and_cli_outputs_json(self):
        sample = "<strong>○출석 공무원</strong><span class='ib w200'>공원과장</span><span class='ib w80'>이하나</span><br>○출석 위원<span class='ib w200'>팀장</span><span class='ib w80'>홍길동</span>"
        with self.assertRaisesRegex(ValueError, 'not found'):
            roster.prepare(sample, SOURCE, ['팀장'])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'record.html'
            path.write_text(sample, encoding='utf-8')
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(roster.main(['--html', str(path), '--source', SOURCE, '--role', '공원과장']), 0)
            self.assertEqual(json.loads(output.getvalue())[0]['name'], '이하나')


if __name__ == '__main__':
    unittest.main()
