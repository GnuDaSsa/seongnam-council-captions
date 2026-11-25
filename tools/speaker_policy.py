"""Read the versioned JSON policy blocks embedded in the browser's synchronous policy file."""
from functools import cache
import json
from pathlib import Path
import re

_SOURCE = Path(__file__).resolve().parents[1] / 'dist' / 'speaker-policy.js'


@cache
def policy_block(name):
    marker = re.escape(name + '-json')
    match = re.search(r'/\* ' + marker + r' \*/\s*(\{.*?\})\s*/\* end-' + marker + r' \*/',
                      _SOURCE.read_text(encoding='utf-8'), re.DOTALL)
    if match is None:
        raise ValueError(f'Shared speaker policy block is missing: {name}')
    return json.loads(match[1])

