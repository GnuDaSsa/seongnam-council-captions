const fs = require('node:fs');
const {suggestions} = require('../dist/committee-terms.js');
const {meetings} = require('../dist/data/live-meetings.json');

if (!process.argv[2]) throw Error('Usage: node evaluation/count_live_terms.cjs DOWNLOADED_PUBLIC_ARCHIVE.json');
const archive = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const meeting = meetings.find(item => item.id === '2853');
if (archive.meetingId !== meeting.id || !Array.isArray(archive.cues)) throw Error('Snapshot is for a different meeting');
const counts = {};
let proposedCues = 0;
let suggestionsCount = 0;
for (const cue of archive.cues) {
  const list = suggestions(meeting, cue.rawText || cue.text || '');
  if (list.length) proposedCues++;
  for (const item of list) {
    const key = item.heard + ' → ' + item.official;
    suggestionsCount++;
    counts[key] = (counts[key] || 0) + 1;
  }
}
console.log(JSON.stringify({meetingId:archive.meetingId, updatedAt:archive.updatedAt, cues:archive.cues.length,
  proposedCues, suggestions:suggestionsCount, counts}, null, 2));
