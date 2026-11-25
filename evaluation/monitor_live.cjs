'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {correct} = require('../dist/korean-corrections.js');
const {attribute} = require('../dist/live-speaker.js');
const {bad} = require('../dist/minutes-format.js');
const committeeTerms = require('../dist/committee-terms.js');

const origin = 'https://seongnam-council-desk.gnudas0923.chatgpt.site';

function observations(meeting, archive, previous = []) {
  if (archive?.meetingId !== meeting.id || !Array.isArray(archive.cues)) throw Error('Invalid meeting archive');
  const byId = new Map(previous.map(row => [row.id, row]));
  const speakers = attribute(meeting, archive.cues, [], archive.gaps || []);
  for (const cue of archive.cues) {
    if (typeof cue.id !== 'string' || !Number.isFinite(cue.start)) throw Error('Invalid cue');
    const source = cue.rawText || cue.text || '';
    const row = {id:cue.id, start:cue.start};
    if (/가름|중\s*공|관원\s+질의|관원\s*질(?:이|을)/u.test(source)) {
      if (bad(cue)) row.spelling = 'audio_review';
      else row.spelling = correct(source).changed ? 'corrected_in_context' : 'unchanged';
    }
    const vocabulary = committeeTerms.suggestions(meeting, source);
    if (!bad(cue) && vocabulary.length) row.terms = vocabulary.map(term => term.official);
    const candidate = cue.speaker || speakers[cue.id];
    if (candidate) {
      row.speaker = {status:'candidate', method:candidate.method, evidence:candidate.evidence};
    } else if (/(?:의원|위원)(?:장)?님/.test(source) && /질의|지리하시|발언해/.test(source) &&
               (meeting.members || []).some(name => source.includes(name))) {
      // A named address is an opportunity to review the following turn, not a verified speaker.
      row.speaker = {status:'address_in_text'};
    }
    if (row.spelling || row.speaker || row.terms) {
      row.sourceSha256 = createHash('sha256').update(source).digest('hex');
      byId.set(cue.id, row);
    } else {
      byId.delete(cue.id);
    }
  }
  return [...byId.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

async function getJson(route, beforeFirstCue = false) {
  const response = await fetch(origin + route, {
    headers:{'User-Agent':'SeongnamCouncilCaptionQuality/1.0', Accept:'application/json'},
    signal:AbortSignal.timeout(30000),
  });
  if (beforeFirstCue && response.status === 404) return null;
  if (!response.ok) throw Error(`HTTP ${response.status} for ${route}`);
  return response.json();
}

async function collect(directory) {
  const manifest = await getJson('/data/live-meetings.json');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.date) || !Array.isArray(manifest.meetings)) throw Error('Invalid schedule');
  const updates = [];
  for (const meeting of manifest.meetings.filter(m => m.provider === 'hls')) {
    if (!/^\d+$/.test(meeting.id)) throw Error('Invalid schedule meeting ID');
    const route = '/api/live/minutes?meetingId=' + meeting.id;
    const filename = path.join(directory, manifest.date + '-' + meeting.id + '.json');
    const existing = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : null;
    const archive = await getJson(route, true);
    if (!archive) {
      if (existing) throw Error('Previously observed archive unavailable: ' + meeting.id);
      continue;
    }
    const rows = observations(meeting, archive, existing ? JSON.parse(existing).observations : []);
    if (!rows.length && !existing) continue;
    const report = {meetingId:meeting.id, date:manifest.date, title:meeting.title, source:origin + route, observations:rows};
    const content = JSON.stringify(report, null, 2) + '\n';
    if (content !== existing) updates.push({filename, content});
    console.log(`${meeting.id}: ${rows.length} observations in ${archive.cues.length} captured cues`);
  }
  fs.mkdirSync(directory, {recursive:true});
  for (const update of updates) fs.writeFileSync(update.filename, update.content);
}

if (require.main === module) {
  if (!process.argv[2]) throw Error('Usage: node evaluation/monitor_live.cjs DIRECTORY');
  collect(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = {observations};
