"""Keep the local shared producers aligned with the current official schedule.

Run once at logon; it checks the deployed schedule each minute, including after midnight.
Failed jobs are retried at most twice after a five-minute delay while the meeting is active.
Existing producer locks prevent duplicate publishing after an unexpected supervisor restart.
"""
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from live_schedule import fetch_schedule, PUBLIC_ORIGIN, KST

ROOT = Path(__file__).resolve().parents[1]
HOME = Path(os.environ['LOCALAPPDATA']) / 'SeongnamCouncilDesk'


def eligible(meeting, now):
    try:
        mid = str(meeting['id'])
        start = dt.datetime.fromisoformat(meeting['scheduledAt'].replace('Z', '+00:00'))
        end = dt.datetime.fromisoformat(meeting['endsAt'].replace('Z', '+00:00'))
        if not re.fullmatch(r'[0-9]+', mid) or start.tzinfo is None or end.tzinfo is None:
            return False
        return meeting.get('provider') == 'hls' and start <= now < end and start.astimezone(KST).date() == now.astimezone(KST).date()
    except (KeyError, TypeError, ValueError):
        return False


def commands(meeting):
    mid, end = str(meeting['id']), meeting['endsAt']
    return [
        [sys.executable, '-u', str(ROOT / 'tools' / 'shared_stt.py'), '--endpoint', PUBLIC_ORIGIN, '--live-schedule', '--meeting-id', mid, '--end-at', end],
        [sys.executable, '-u', str(ROOT / 'tools' / 'nameplate_publisher.py'), '--live-schedule', '--meeting-id', mid, '--end-at', end],
    ]


def main():
    if (HOME / 'schedule-supervisor.pause').exists():
        print('Schedule publishing is paused on this PC.', flush=True)
        return
    import msvcrt
    HOME.mkdir(parents=True, exist_ok=True)
    with (HOME / 'schedule-supervisor.lock').open('a+b') as lock:
        lock.seek(0)
        if not lock.read(1):
            lock.write(b'0'); lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            print('schedule supervisor already running', flush=True)
            return
        jobs = {}
        while True:
            now = dt.datetime.now(KST)
            try:
                schedule = fetch_schedule(now=now)
                ids = [str(m.get('id')) for m in schedule['meetings'] if isinstance(m, dict)]
                eligible_rows = []
                for meeting in schedule['meetings']:
                    if not isinstance(meeting, dict) or ids.count(str(meeting.get('id'))) != 1 or not eligible(meeting, now):
                        continue
                    eligible_rows.append(meeting)
                # Reap exited children before considering bounded retries.
                for key, job in list(jobs.items()):
                    if job['process'] is None or job['process'].poll() is None:
                        continue
                    code = job['process'].returncode
                    with job['log'].open('rb') as stream:
                        stream.seek(job['offset'])
                        tail = stream.read()[-30000:].decode('utf-8', 'replace')
                    auth_error = any(marker in tail for marker in ('HTTP Error 401', 'HTTP Error 403', 'unauthorized', 'forbidden'))
                    job['process'] = None
                    job['done'] = code == 0 or auth_error or job['attempts'] >= 3
                    job['next'] = time.monotonic() + 300
                    print('{} meeting={} producer={} exit={} retry={}'.format(
                        now.isoformat(), key[1], key[2], code, not job['done']), flush=True)
                for meeting in eligible_rows:
                    for kind, command in enumerate(commands(meeting)):
                        key = (schedule['date'], str(meeting['id']), kind)
                        old = jobs.get(key)
                        if old and (old['done'] or old['process'] is not None or time.monotonic() < old['next']):
                            continue
                        peers = [meeting]
                        if kind == 0:
                            peers = [row for row in eligible_rows if row['endsAt'] == meeting['endsAt'] and
                                     ((peer := jobs.get((schedule['date'], str(row['id']), 0))) is None or
                                      (not peer['done'] and peer['process'] is None and time.monotonic() >= peer['next']))]
                            # The command's first ID must stay first.
                            peers = [meeting] + [row for row in peers if row is not meeting]
                            for peer in peers[1:]:
                                command.extend(['--meeting-id', str(peer['id'])])
                        log = HOME / ('scheduled-{}-{}-{}.log'.format(schedule['date'], meeting['id'], kind))
                        with log.open('ab') as output:
                            offset = output.tell()
                            process = subprocess.Popen(command, cwd=str(ROOT), stdout=output, stderr=subprocess.STDOUT,
                                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                        for peer in peers:
                            peer_key = (schedule['date'], str(peer['id']), kind)
                            prior = jobs.get(peer_key)
                            jobs[peer_key] = {'process': process, 'log': log, 'offset': offset,
                                              'attempts': (prior['attempts'] if prior else 0) + 1,
                                              'done': False, 'next': 0}
                        print('{} started meeting={} producer={} attempt={}'.format(
                            now.isoformat(), meeting['id'], kind, jobs[key]['attempts']), flush=True)
                jobs = {key: value for key, value in jobs.items() if key[0] == schedule['date'] or
                        value['process'] is not None}
            except Exception as error:
                print('{} schedule unavailable: {}'.format(now.isoformat(), type(error).__name__), flush=True)
            time.sleep(60)


if __name__ == '__main__':
    main()
