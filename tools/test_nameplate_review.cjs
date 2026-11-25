const assert = require('node:assert/strict');
const {observations} = require('../dist/nameplate-review.js');
const start = Date.UTC(2026, 10, 25, 5);
const time = s => new Date(start + s * 1000).toISOString();
const cue = (id, at, duration) => ({id, start:1, end:1 + duration, observedAt:time(at)});
const meeting = {id:'2853', members:['김옥수','정연화']};
const archive = {
  cues:[cue('b',8,8),cue('a',0,8),cue('overlap',12,6),cue('long',30,35)],
  gaps:[{start:time(2), end:time(3)}, {start:time(17), end:null}],
};
const observation = (s, names=['김옥수']) => ({capturedAt:time(s),matchedMembers:names});
const rows = [observation(8,['김옥수','정연화']),observation(1),observation(2),observation(12),
  observation(17),observation(20),observation(3,[]),observation(1),observation(9,['명단밖'])];
const result = observations(meeting, archive, {meetingId:'2853', observations:rows});
assert.deepEqual(result.map(x => [x.time,x.cueId]), [[1,null],[2,null],[3,null],[8,'b'],[12,null],[17,null],[20,null]].map(([s,id]) => [start+s*1000,id]));
const duringTurnChange = observations(meeting, {cues:[cue('first',0,8),cue('second',8,8)]},
  {meetingId:'2853',observations:[observation(13)]})[0];
assert.equal(duringTurnChange.cueId,null);
assert.deepEqual(duringTurnChange.nearbyIds,['first','second']);
assert.deepEqual(result[3].names, ['김옥수','정연화']);
assert.equal(observations(meeting, {...archive,gaps:[]}, {meetingId:'2853',observations:[observation(35)]})[0].cueId,null);
assert.throws(() => observations(meeting, archive, {meetingId:'2852',observations:rows}));
console.log('PASS: nameplate time alignment, roster, gaps, overlapping cues and ambiguous frames');
