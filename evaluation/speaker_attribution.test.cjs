const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const liveSpeaker = require('../dist/live-speaker.js');
const { DEFAULT_FIXTURE, evaluate } = require('./speaker_harness.cjs');

test('production attribution matches the reviewed speaker cases', () => {
  const fixture = JSON.parse(readFileSync(DEFAULT_FIXTURE, 'utf8'));
  const { failures, origins } = evaluate(fixture, liveSpeaker);
  assert.ok(origins.observed.scored_cues > 0, 'observed cases must be scored');
  assert.ok(origins.constructed.scored_cues > 0, 'constructed cases must be scored');
  assert.equal(failures.length, 0, failures.join('\n'));
});

function sample() {
  const cues = ['correct', 'wrong', 'unverified', 'missed', 'abstained'].map((id, index) => ({
    id, text: '회의 발언', start: index, end: index + 1,
  }));
  const expected = ['김의원', '김의원', null, '김의원', null].map((expectedName, index) => ({
    cue_id: cues[index].id, expected_name: expectedName, rationale: 'Metrics regression example',
  }));
  expected[2].forbidden_names = ['박의원'];
  return { schema_version: 1, cases: [{
    id: 'metrics', origin: 'constructed', provenance: 'Deliberate metric outcomes',
    meeting: { id: 'sample' }, cues, expected,
  }] };
}

test('speaker metrics distinguish wrong names, missing names, and correct abstentions', () => {
  const prediction = (name, cue) => ({ name, role: '의원', method: 'example', evidence: [cue] });
  const { origins, failures } = evaluate(sample(), { attribute: () => ({
    correct: prediction('김의원', 'correct'),
    wrong: prediction('박의원', 'wrong'),
    unverified: prediction('박의원', 'unverified'),
  }) });
  const metrics = origins.constructed;
  assert.equal(metrics.scored_cues, 5);
  assert.equal(origins.observed.scored_cues, 0);
  assert.deepEqual(metrics.named_precision, { numerator: 1, denominator: 3 });
  assert.deepEqual(metrics.reference_name_recall, { numerator: 1, denominator: 3 });
  assert.deepEqual(metrics.false_named, { numerator: 2, denominator: 3 });
  assert.deepEqual(metrics.false_named_on_abstention_targets, { numerator: 1, denominator: 2 });
  assert.deepEqual(metrics.abstentions, { numerator: 2, denominator: 5 });
  assert.deepEqual(metrics.correct_abstentions, { numerator: 1, denominator: 2 });
  assert.deepEqual(metrics.named_target_abstentions, { numerator: 1, denominator: 3 });
  assert.ok(failures.some(failure => failure.includes('assigned forbidden name')));
});

test('speaker evaluation requires scored cues and rejects unknown evidence', () => {
  const blank = { attribute: () => ({}) };
  assert.throws(() => evaluate({ schema_version: 1, cases: [] }, blank), /cases must be nonempty/);
  const fixture = sample();
  fixture.cases[0].expected = [];
  assert.throws(() => evaluate(fixture, blank), /expected results must be nonempty/);

  const result = evaluate(sample(), { attribute: () => ({
    correct: { name: '김의원', role: '의원', method: 'example', evidence: ['correct', 'unknown'] },
  }) });
  assert.ok(result.failures.some(failure => failure.includes('missing cue evidence')));
});
