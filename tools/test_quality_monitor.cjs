const assert = require('node:assert/strict');
const test = require('node:test');
const {observations} = require('../evaluation/monitor_live.cjs');

test('observations are stable across unchanged runs and preserve absent earlier cue IDs', () => {
  const meeting = {id:'2853', members:[]};
  const cue = (id, text, flags = []) => ({id, start:Number(id), end:Number(id)+1, text, rawText:text, flags});
  const archive = {meetingId:'2853', cues:[
    cue('1','서면으로 가름하겠습니다.'), cue('2','성패를 가름하는 요인입니다.'),
    cue('3','유인물로 가름하겠습니다.', ['severe_uncertainty']), cue('4','의석을 정돈해 주십시오.'),
  ]};
  const result = observations(meeting, archive);
  assert.deepEqual(result.map(r => r.spelling), ['corrected_in_context','unchanged','audio_review']);
  assert.deepEqual(observations(meeting, archive, result), result);
  assert.deepEqual(observations(meeting, {...archive, cues:archive.cues.slice(2)}, result), result);
  assert.throws(() => observations({...meeting,id:'2855'}, archive));
});
