import datetime as dt
import io
import json
import unittest
from unittest.mock import patch
import live_schedule as api
import schedule_supervisor as sup

class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2026,11,26,10,tzinfo=api.KST)
        self.row = {'id':'2856','provider':'hls','scheduledAt':'2026-11-26T09:30:00+09:00','endsAt':'2026-11-26T17:00:00+09:00'}
    def test_late_start_and_end(self):
        self.assertTrue(sup.eligible(self.row, self.now))
        self.assertFalse(sup.eligible(self.row, self.now.replace(hour=9)))
        self.assertFalse(sup.eligible(self.row, self.now.replace(hour=17)))
        self.assertFalse(sup.eligible(dict(self.row, provider='youtube'), self.now))
        self.assertFalse(sup.eligible(dict(self.row, scheduledAt='2026-11-26T09:30:00'), self.now))
    def test_api_current_day_and_origin(self):
        data={'date':'2026-11-26','schedule':'x','meetings':[self.row]}
        with patch.object(api.urllib.request,'urlopen',return_value=io.BytesIO(json.dumps(data).encode())):
            self.assertEqual(api.fetch_schedule(now=self.now),data)
            with self.assertRaises(ValueError): api.fetch_schedule(now=self.now+dt.timedelta(days=1))
        with self.assertRaises(ValueError): api.fetch_schedule('https://invalid.example')
    def test_commands_use_live_snapshot_and_bounded_end(self):
        for cmd in sup.commands(self.row):
            self.assertIn('--live-schedule',cmd)
            self.assertEqual(cmd[cmd.index('--end-at')+1], self.row['endsAt'])

if __name__ == '__main__': unittest.main()
