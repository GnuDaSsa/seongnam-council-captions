const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { parseArgs } = require('node:util');

const DEFAULT_FIXTURE = join(__dirname, 'speaker_cases.json');
const DEFAULT_ENGINE = join(__dirname, '../dist/live-speaker.js');
const ORIGINS = ['observed', 'constructed'];
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const id = value => text(value) && value.trim() === value && !RESERVED_IDS.has(value);
const date = value => text(value) && Number.isFinite(Date.parse(value));
const strings = value => Array.isArray(value) && value.every(text);
const has = (object, key) => Object.hasOwn(object, key);

function check(condition, location, message) {
  if (!condition) throw new TypeError(`${location}: ${message}`);
}

function validateFixture(fixture) {
  check(record(fixture) && fixture.schema_version === 1, 'fixture', 'schema_version must be 1');
  check(Array.isArray(fixture.cases) && fixture.cases.length > 0, 'fixture', 'cases must be nonempty');
  const caseIds = new Set();
  for (const [index, item] of fixture.cases.entries()) {
    const location = `cases[${index}]`;
    check(record(item) && id(item.id), location, 'case ID is required');
    const label = `case ${item.id}`;
    check(!caseIds.has(item.id), label, 'duplicate case ID');
    caseIds.add(item.id);
    check(ORIGINS.includes(item.origin), label, 'invalid origin');
    check(text(item.provenance) || (record(item.provenance) && Object.keys(item.provenance).length > 0),
      label, 'provenance is required');
    check(record(item.meeting) && id(item.meeting.id), label, 'meeting ID is required');
    if (has(item.meeting, 'members')) check(strings(item.meeting.members), label, 'invalid member roster');
    check(Array.isArray(item.cues) && item.cues.length > 0, label, 'cues must be nonempty');
    const cueIds = new Set();
    for (const cue of item.cues) {
      check(record(cue) && id(cue.id) && !cueIds.has(cue.id), label, 'invalid or duplicate cue ID');
      check(Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start,
        `${label}/${cue.id}`, 'invalid cue interval');
      check(text(cue.text), `${label}/${cue.id}`, 'cue text is required');
      if (has(cue, 'rawText')) check(text(cue.rawText), `${label}/${cue.id}`, 'invalid rawText');
      if (has(cue, 'flags')) check(strings(cue.flags), `${label}/${cue.id}`, 'invalid flags');
      if (has(cue, 'observedAt')) check(date(cue.observedAt), `${label}/${cue.id}`, 'invalid observedAt');
      if (has(cue, 'rejected')) check(typeof cue.rejected === 'boolean', `${label}/${cue.id}`, 'invalid rejected flag');
      cueIds.add(cue.id);
    }
    if (has(item, 'observations')) {
      check(Array.isArray(item.observations) && item.observations.every(row =>
        record(row) && date(row.capturedAt) && strings(row.matchedMembers)),
      label, 'invalid nameplate observations');
    }
    if (has(item, 'gaps')) {
      check(Array.isArray(item.gaps) && item.gaps.every(row => record(row) && date(row.start) &&
        (row.end === null || (date(row.end) && Date.parse(row.end) > Date.parse(row.start)))),
      label, 'invalid gaps');
    }
    check(Array.isArray(item.expected) && item.expected.length > 0, label, 'expected results must be nonempty');
    const scored = new Set();
    for (const entry of item.expected) {
      check(record(entry) && cueIds.has(entry.cue_id) && !scored.has(entry.cue_id), label,
        'expected cue ID must reference a unique cue');
      const target = `${label}/${entry.cue_id}`;
      check(entry.expected_name === null || text(entry.expected_name), target, 'expected_name must be a name or null');
      check(text(entry.rationale), target, 'rationale is required');
      if (has(entry, 'forbidden_names')) {
        check(strings(entry.forbidden_names) && !entry.forbidden_names.includes(entry.expected_name), target,
          'forbidden_names must be strings and exclude the expected name');
      }
      if (has(entry, 'expected_role')) check(text(entry.expected_role), target, 'invalid expected_role');
      scored.add(entry.cue_id);
    }
  }
  return fixture;
}

function summarize(rows) {
  const referenceNames = rows.filter(row => row.expected_name !== null).length;
  const predictedNames = rows.filter(row => row.actual_name !== null).length;
  const correctNames = rows.filter(row => row.expected_name !== null && row.actual_name === row.expected_name).length;
  const correctAbstentions = rows.filter(row => row.expected_name === null && row.actual_name === null).length;
  return {
    scored_cues: rows.length,
    named_precision: { numerator: correctNames, denominator: predictedNames },
    reference_name_recall: { numerator: correctNames, denominator: referenceNames },
    false_named: { numerator: predictedNames - correctNames, denominator: predictedNames },
    false_named_on_abstention_targets: {
      numerator: rows.length - referenceNames - correctAbstentions,
      denominator: rows.length - referenceNames,
    },
    abstentions: { numerator: rows.length - predictedNames, denominator: rows.length },
    correct_abstentions: { numerator: correctAbstentions, denominator: rows.length - referenceNames },
    named_target_abstentions: { numerator: rows.filter(row => row.expected_name !== null && row.actual_name === null).length,
      denominator: referenceNames },
  };
}

function evaluate(fixture, engine) {
  validateFixture(fixture);
  check(typeof engine?.attribute === 'function', 'engine', 'attribute(meeting, cues, observations, gaps) is required');
  const rows = [];
  const failures = [];
  for (const item of fixture.cases) {
    const { meeting, cues, observations = [], gaps = [] } = structuredClone(item);
    const cueIds = new Set(cues.map(cue => cue.id));
    const predictions = engine.attribute(meeting, cues, observations, gaps);
    check(record(predictions), `case ${item.id}`, 'engine result must be a cue ID map');
    for (const [cueId, prediction] of Object.entries(predictions)) {
      if (!cueIds.has(cueId)) {
        failures.push(`${item.id}/${cueId}: engine returned an unknown cue`);
      } else if (!record(prediction) || typeof prediction.name !== 'string' || !text(prediction.role) ||
          !text(prediction.method) || !Array.isArray(prediction.evidence) ||
          !prediction.evidence.includes(cueId) || !prediction.evidence.every(key => cueIds.has(key))) {
        failures.push(`${item.id}/${cueId}: invalid attribution or missing cue evidence`);
      }
    }
    for (const expected of item.expected) {
      const prediction = has(predictions, expected.cue_id) ? predictions[expected.cue_id] : null;
      const actualName = text(prediction?.name) ? prediction.name.trim() : null;
      const actualRole = text(prediction?.role) ? prediction.role.trim() : null;
      const row = {
        case_id: item.id,
        origin: item.origin,
        provenance: item.provenance,
        cue_id: expected.cue_id,
        expected_name: expected.expected_name,
        actual_name: actualName,
        expected_role: expected.expected_role ?? null,
        actual_role: actualRole,
        confidence: prediction?.confidence ?? null,
        method: prediction?.method ?? null,
        evidence: prediction?.evidence ?? [],
        rationale: expected.rationale,
      };
      rows.push(row);
      const location = `${item.id}/${expected.cue_id}`;
      if (actualName !== expected.expected_name) {
        failures.push(`${location}: expected name ${JSON.stringify(expected.expected_name)}, got ${JSON.stringify(actualName)}`);
      }
      if (expected.forbidden_names?.includes(actualName)) {
        failures.push(`${location}: assigned forbidden name ${JSON.stringify(actualName)}`);
      }
      if (has(expected, 'expected_role') && actualRole !== expected.expected_role) {
        failures.push(`${location}: expected role ${JSON.stringify(expected.expected_role)}, got ${JSON.stringify(actualRole)}`);
      }
    }
  }
  const origins = Object.fromEntries(ORIGINS.map(origin => [
    origin, summarize(rows.filter(row => row.origin === origin)),
  ]));
  return { policy_version: engine.policyVersion || null, origins, failures, rows };
}

function printResult(label, result) {
  console.log(`${label}${result.policy_version ? ' ' + result.policy_version : ''} (${result.failures.length} failed checks)`);
  for (const [origin, metrics] of Object.entries(result.origins)) {
    const { scored_cues, ...ratios } = metrics;
    console.log(`  ${origin} (${scored_cues} scored cues)`);
    for (const [kind, { numerator, denominator }] of Object.entries(ratios)) {
      const rate = denominator ? (numerator / denominator * 100).toFixed(1) + '%' : 'n/a';
      console.log(`    ${kind}: ${numerator}/${denominator} (${rate})`);
    }
  }
  for (const failure of result.failures) console.log(`  ${failure}`);
}

function main() {
  const { values } = parseArgs({ options: {
    fixture: { type: 'string' },
    engine: { type: 'string' },
    baseline: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node evaluation/speaker_harness.cjs [--fixture PATH] [--engine PATH] [--baseline PATH] [--json]');
    return;
  }
  const fixture = JSON.parse(readFileSync(values.fixture ? resolve(values.fixture) : DEFAULT_FIXTURE, 'utf8'));
  const candidate = evaluate(fixture, require(values.engine ? resolve(values.engine) : DEFAULT_ENGINE));
  const baseline = values.baseline ? evaluate(fixture, require(resolve(values.baseline))) : null;
  if (values.json) {
    console.log(JSON.stringify({ candidate, baseline }, null, 2));
  } else {
    if (baseline) printResult('Baseline', baseline);
    printResult('Candidate', candidate);
  }
  if (candidate.failures.length) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { DEFAULT_FIXTURE, evaluate };
