const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

test('replay preserves the captured bytes and separates proposed and approved changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-pipeline-'));
  const pipeline = path.join(__dirname, 'minutes_pipeline.cjs');
  const raw = {meetingId:'2853', status:'ended', updatedAt:'2026-11-25T06:05:00Z', gaps:[], cues:[
    {id:'a1',start:0,end:3,observedAt:'2026-11-25T06:00:00Z',text:'이른 차 소음 단속',rawText:'이른 차 소음 단속',flags:[]},
    {id:'a2',start:0,end:3,observedAt:'2026-11-25T06:00:00Z',text:'이른 차 소음 단속',rawText:'이른 차 소음 단속',flags:['segment_review']},
  ]};
  const input = path.join(dir, 'capture.json'), edits = path.join(dir, 'changes.json'), out = path.join(dir, 'result');
  fs.writeFileSync(input, JSON.stringify(raw) + '\n');
  fs.writeFileSync(edits, JSON.stringify({meetingId:'2853',cues:{
    a1:{text:'이륜차 소음 단속',speaker:'담당 과장'}, a2:{speaker:'담당자 확인'}}}));
  function run(...args) { return spawnSync(process.execPath, [pipeline, ...args], {encoding:'utf8'}); }
  try {
    const unreviewed = path.join(dir, 'unreviewed');
    const first = run(input, unreviewed);
    assert.equal(first.status, 0, first.stderr);
    const pending = JSON.parse(fs.readFileSync(path.join(unreviewed,'corrected.json')));
    assert.ok(pending[0].suggestions.some(candidate => candidate.official === '이륜차'));
    assert.equal(pending[0].minutesText, raw.cues[0].text);
    assert.equal(JSON.parse(fs.readFileSync(path.join(unreviewed,'aligned.json')))[1].duplicateForDraft, true);
    const reviewed = run(input, out, '--edits', edits, '--manifest', path.join(unreviewed,'meeting.json'));
    assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.deepEqual(fs.readFileSync(input), fs.readFileSync(path.join(out, 'raw.json')));
    assert.match(fs.readFileSync(path.join(out,'minutes.txt'),'utf8'), /담당 과장.*이륜차 소음 단속/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out,'run.json'))).confirmedSpeakers, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out,'aligned.json')))[1].duplicateForDraft, false);
    assert.notEqual(run(input, out).status, 0);
  } finally {
    for (const name of ['result','unreviewed']) {
      const folder = path.join(dir, name);
      if (!fs.existsSync(folder)) continue;
      for (const file of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, file));
      fs.rmdirSync(folder);
    }
    fs.unlinkSync(input);
    fs.unlinkSync(edits);
    fs.rmdirSync(dir);
  }
});
