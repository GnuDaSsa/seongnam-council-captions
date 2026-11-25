const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const cases = JSON.parse(read('evaluation/speaker_cases.json')).cases;
const vods = JSON.parse(read('dist/data/vod-catalog.json')).meetings;
let checkedVod = 0;
for (const item of cases.filter(x => x.origin === 'observed' && x.provenance.file === 'dist/data/vod-catalog.json')) {
  const meeting = vods.find(x => x.id === item.meeting.id);
  assert.ok(meeting, item.id);
  assert.equal(item.provenance.minutes_url, meeting.minutesUrl, item.id);
  const url = new URL(item.provenance.url);
  assert.equal(url.origin + url.pathname, new URL(meeting.officialPage).origin + new URL(meeting.officialPage).pathname, item.id);
  assert.equal(url.searchParams.get('pk_vod_no'), meeting.id, item.id);
  assert.equal(Number(url.searchParams.get('position')), Math.floor(item.cues[0].start), item.id);
  for (const cue of item.cues) {
    const original = meeting.cues.find(x => x.id === cue.id);
    assert.ok(original, cue.id);
    for (const key of ['id','text','start','end','flags']) assert.deepEqual(cue[key], original[key], `${cue.id} ${key}`);
    assert.equal(original.source, 'minutes_aligned', cue.id);
    assert.equal('speaker' in cue, false, `${cue.id}: source label must not enter the model`);
  }
  checkedVod++;
}
assert.ok(checkedVod >= 2, 'expected VOD cases to be checked');

// Compare public live archive examples with the literal test fixtures they were copied from.
// These tests are evidence of transcription provenance, not verification of speaker identity.
const liveSource = read('tools/test_speaker_review.cjs');
const directSource = read('tools/test_live_speaker.cjs');
const cue = (id, text, start, end, flags) => ({id, text, start, end, ...(flags === undefined ? {} : {flags})});
for (const item of cases.filter(x => x.origin === 'observed' && /^tools\/test_/.test(x.provenance.file))) {
  for (const row of item.cues) {
    let expression;
    const match = liveSource.match(new RegExp(`liveCue\\('${row.id}'[^\\n]*?\\)`));
    if (match) expression = match[0];
    else {
      const line = directSource.split(/\r?\n/).find(s => s.includes(`'${row.id}'`) && s.includes('=cue('));
      assert.ok(line, `missing source cue ${row.id}`);
      expression = line.slice(line.indexOf('cue('), line.lastIndexOf(')') + 1);
    }
    const original = JSON.parse(JSON.stringify(vm.runInNewContext(expression, {cue, liveCue:cue})));
    for (const key of ['id','text','start','end','flags']) assert.deepEqual(row[key], original[key], `${row.id} ${key}`);
  }
}
// Scratch snapshots are intentionally not tracked; validate them when present.
let snapshotChecks = 0;
for (const item of cases.filter(x => x.provenance.file?.startsWith('public snapshot '))) {
  const snapshotPath = path.resolve(root, item.provenance.file.slice('public snapshot '.length));
  if (!fs.existsSync(snapshotPath)) continue;
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).minutes;
  assert.equal(snapshot.meetingId, item.meeting.id, item.id);
  const url = new URL(item.provenance.url);
  assert.equal(url.searchParams.get('live'), item.meeting.id, item.id);
  for (const row of item.cues) {
    const original = snapshot.cues.find(x => x.id === row.id);
    assert.ok(original, row.id);
    assert.equal(url.searchParams.get('cue'), item.cues[0].id);
    for (const key of ['id','text','start','end','flags','observedAt']) assert.deepEqual(row[key], original[key], `${row.id} ${key}`);
    assert.equal('speaker' in row, false, `${row.id}: source label must not enter the model`);
    snapshotChecks++;
  }
}
console.log(`PASS observed speaker fixture provenance; ${snapshotChecks} optional scratch snapshot cues checked`);


