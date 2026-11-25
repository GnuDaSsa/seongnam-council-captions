/* Replay a captured live meeting with the same review and formatting rules as the browser. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const format = require('../dist/minutes-format.js');
const speakers = require('../dist/speaker-review.js');
const terms = require('../dist/committee-terms.js');
const departments = require('../dist/department-review.js');
const defaultManifest = path.join(__dirname, '../dist/data/live-meetings.json');

function jsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function run() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { manifest: { type: 'string', default: defaultManifest }, edits: { type: 'string' } },
  });
  if (positionals.length !== 2) throw Error('Usage: node tools/minutes_pipeline.cjs SNAPSHOT.json NEW_OUTPUT_DIR [--manifest FILE] [--edits FILE]');
  const [snapshot, directory] = positionals;
  const original = fs.readFileSync(snapshot);
  const archive = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
  const meeting = jsonFile(values.manifest).meetings.find(row => row.id === archive.meetingId);
  if (!meeting || !Array.isArray(archive.cues)) throw Error('Snapshot must match a meeting in the schedule');
  const byId = new Set();
  for (const cue of archive.cues) {
    if (typeof cue.id !== 'string' || !cue.id || byId.has(cue.id) || !Number.isFinite(cue.start) ||
        !Number.isFinite(cue.end) || cue.end <= cue.start) throw Error('Missing, duplicate or invalid cue in snapshot');
    byId.add(cue.id);
  }
  const changes = values.edits ? jsonFile(values.edits) : {meetingId: meeting.id, cues: {}};
  if (changes.meetingId !== meeting.id || !changes.cues || Array.isArray(changes.cues) ||
      typeof changes.cues !== 'object') throw Error('Edits must belong to the same meeting');
  for (const [id, change] of Object.entries(changes.cues)) {
    if (!byId.has(id) || !change || typeof change !== 'object' || Array.isArray(change)) throw Error('Unknown cue in edits: ' + id);
    for (const field of ['text', 'speaker', 'kind']) {
      if (field in change && typeof change[field] !== 'string') throw Error('Invalid ' + field + ' for ' + id);
    }
    if ('confirmed' in change && typeof change.confirmed !== 'boolean') throw Error('Invalid review state for ' + id);
  }
  const changeFor = cue => changes.cues[cue.id] || {};
  const read = cue => changeFor(cue).text ?? format.initial(cue);
  const cues = [...archive.cues].sort((a,b) => a.start - b.start);
  const aligned = cues.map(cue => ({id:cue.id, start:cue.start, end:cue.end, observedAt:cue.observedAt,
    timingUncertain:(cue.flags || []).includes('segment_review'),
    duplicateForDraft:format.isDuplicate(cue, cues, format.manuallyChanged(read(cue), format.initial(cue), changeFor(cue)), format.bad)}));
  const corrected = cues.map(cue => {
    const text = read(cue);
    const glossary = terms.suggestions(meeting, text);
    const department = departments.suggestions(text, meeting.agenda || []);
    return {id:cue.id, sourceText:format.initial(cue), reviewedText:text, minutesText:format.tidy(text),
      edited:Object.hasOwn(changeFor(cue), 'text'), suggestions:[...glossary, ...department]};
  });
  const candidates = speakers.guesses(meeting, cues);
  const attribution = cues.map(cue => ({id:cue.id, candidate:candidates[cue.id] || null,
    confirmedSpeaker:changeFor(cue).speaker || null}));
  const coverage = `${archive.coverageStart || '미확인'} ~ ${archive.updatedAt || '미확인'} · 수집 상태 ${archive.status || '미확인'}`;
  const lines = format.lines({meeting, archive:{...archive, cues}, read, meta:changeFor, coverage,
    bad:format.bad, initial:format.initial});
  fs.mkdirSync(directory);
  const hashes = {};
  function save(name, bytes) {
    fs.writeFileSync(path.join(directory, name), bytes, {flag:'wx'});
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
  }
  const json = data => JSON.stringify(data, null, 2) + '\n';
  save('raw.json', original);
  save('meeting.json', json({meetings:[meeting]}));
  save('reviews.json', json(changes));
  save('aligned.json', json(aligned));
  save('corrected.json', json(corrected));
  save('speakers.json', json(attribution));
  save('minutes.txt', lines.join('\n') + '\n');
  const report = {meetingId:meeting.id, cues:cues.length, guesses:Object.keys(candidates).length,
    confirmedSpeakers:attribution.filter(row => row.confirmedSpeaker).length, hashes};
  fs.writeFileSync(path.join(directory, 'run.json'), json(report), {flag:'wx'});
  console.log(`${meeting.title} · ${report.cues}개 구간 · 발언자 후보 ${report.guesses} · ${directory}`);
}

try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
