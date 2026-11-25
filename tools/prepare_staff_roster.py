"""Prepare review-only staffRoster entries from a locally saved official record.

Example: python tools/prepare_staff_roster.py --html record.html --source
  https://www.sncouncil.go.kr/record/recordView.do?key=... --role 공원과장

The source is evidence of attendance at that recorded meeting only. This
command does not infer attendance at any other meeting or modify a roster.
"""
import argparse
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, urlsplit


OFFICIAL_HOSTS = {'www.sncouncil.go.kr', 'sncouncil.go.kr'}
HEADING = re.compile(r'^(?:○\s*출석(?:한)?\s*(?:공무원|관계\s*공무원|재단(?:\s*(?:관계자|직원|임직원))?|기관(?:\s*(?:관계자|직원|임직원))?|재단\s*(?:및|·|/)\s*기관(?:\s*(?:관계자|직원|임직원))?)|○\s*기타\s*참석자)\s*$')
ROLE = re.compile(r'^[가-힣A-Za-z0-9·\- ]{1,40}$')
NAME = re.compile(r'^[가-힣]{2,4}$')


def validate_source(value):
    try:
        parsed = urlsplit(value)
        params = parse_qs(parsed.query, keep_blank_values=True)
        valid = (parsed.scheme == 'https' and parsed.hostname in OFFICIAL_HOSTS and
                 parsed.port in (None, 443) and not parsed.username and not parsed.password and
                 parsed.path == '/record/recordView.do' and not parsed.fragment and
                 set(params) == {'key'} and len(params['key']) == 1 and
                 re.fullmatch(r'[a-fA-F0-9]{64,128}', params['key'][0]))
    except ValueError:
        valid = False
    if not valid:
        raise ValueError('source must be a direct official Seongnam recordView URL')
    return value


def compact(value):
    return ' '.join(value.split())


class AttendanceParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.section = False
        self.strong = None
        self.span = None
        self.pending_role = None
        self.entries = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'strong':
            self.strong = []
        elif tag == 'br' and self.span is None:
            self.pending_role = None
        elif tag == 'span' and self.section:
            classes = set(attrs.get('class', '').split())
            widths = [int(item[1:]) for item in classes if re.fullmatch(r'w[0-9]{1,4}', item)]
            kind = None
            if 'ib' in classes and len(widths) == 1:
                if widths[0] == 80:
                    kind = 'name'
                elif 80 < widths[0] <= 1000:
                    kind = 'role'
            if kind:
                self.span = (kind, [])
            else:
                self.pending_role = None

    def handle_data(self, data):
        if self.section and self.strong is None and self.span is None and re.search(r'(?:^|\n)\s*○', data):
            self.section = False
            self.pending_role = None
        elif self.pending_role and self.strong is None and self.span is None and data.strip():
            self.pending_role = None
        if self.strong is not None:
            self.strong.append(data)
        if self.span is not None:
            self.span[1].append(data)

    def handle_endtag(self, tag):
        if tag == 'strong' and self.strong is not None:
            heading = compact(''.join(self.strong))
            self.strong = None
            if heading.startswith('○'):
                self.section = bool(HEADING.fullmatch(heading))
                self.pending_role = None
        elif tag == 'span' and self.span is not None:
            kind, pieces = self.span
            self.span = None
            value = compact(''.join(pieces))
            if kind == 'role':
                self.pending_role = value if ROLE.fullmatch(value) else None
            else:
                if self.pending_role and NAME.fullmatch(value):
                    self.entries.append((self.pending_role, value))
                self.pending_role = None


def prepare(html, source, roles):
    validate_source(source)
    if not roles or any(not ROLE.fullmatch(compact(role)) for role in roles):
        raise ValueError('one or more valid --role values are required')
    parser = AttendanceParser()
    parser.feed(html)
    by_role = {}
    for role, name in parser.entries:
        by_role.setdefault(role, set()).add(name)
    result = []
    for role in dict.fromkeys(compact(role) for role in roles):
        names = by_role.get(role, set())
        if not names:
            raise ValueError(f'requested role not found: {role}')
        if len(names) != 1:
            raise ValueError(f'conflicting names for role: {role}')
        result.append({'name': next(iter(names)), 'role': role, 'source': source})
    return result


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--html', required=True, help='locally saved official meeting record HTML')
    parser.add_argument('--source', required=True, help='direct official recordView URL')
    parser.add_argument('--role', action='append', required=True, help='exact title; repeat for multiple roles')
    args = parser.parse_args(argv)
    try:
        content = Path(args.html).read_text(encoding='utf-8-sig')
        result = prepare(content, args.source, args.role)
    except (OSError, UnicodeError, ValueError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
