"""Read the current public schedule from the fixed deployed origin."""
import datetime as dt
import json
import urllib.request
from urllib.parse import urlparse

PUBLIC_ORIGIN = 'https://seongnam-council-desk.gnudas0923.chatgpt.site'
KST = dt.timezone(dt.timedelta(hours=9))


def fetch_schedule(endpoint=PUBLIC_ORIGIN, now=None):
    if endpoint.rstrip('/') != PUBLIC_ORIGIN:
        raise ValueError('unapproved schedule origin')
    request = urllib.request.Request(PUBLIC_ORIGIN + '/api/live/schedule', headers={
        'User-Agent': 'SeongnamCouncilSchedulePublisher/1.0', 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=15) as response:
        data = json.load(response)
    today = (now or dt.datetime.now(KST)).astimezone(KST).date().isoformat()
    if not isinstance(data, dict) or data.get('date') != today or not isinstance(data.get('meetings'), list):
        raise ValueError('schedule is not a valid current-day schedule')
    return data
