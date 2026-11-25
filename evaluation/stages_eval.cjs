// Score the saved transcriptions without accessing the network or decoding audio again.
const fs = require('node:fs');
const path = require('node:path');
const format = require('../dist/minutes-format.js');
const terms = require('../dist/committee-terms.js');
const speakers = require('../dist/speaker-review.js');
const meeting = require('../dist/data/live-meetings.json').meetings.find(row => row.id === '2853');
const directory = process.argv[2];
if (!directory) throw Error('Usage: node evaluation/stages_eval.cjs ARCHIVED_EVAL_DIR');

const samples = [
  ['economic', 'econ', 0, 89.5, {0:'안광환', 12.5:'안광환', 18:'안광환', 38:'최민수', 58:'최민수', 78:'최민수', 84.5:'안광환'}],
  ['admin', 'admin', 0, 110, {}],
  ['proposal', 'proposal', 0, 99.5, {}],
  ['question', 'qa2', 32, 82.5, {32:'정연화', 52:'정연화'}],
];

// The 74.5s proposal self-introduction below was selected after observing this
// rule's candidate and checked against the official transcript. It remains outside
// the annotated score so this follow-up is not presented as independent validation.

function normalized(text) {
  return Array.from(text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
}

function editDistance(reference, recognized) {
  let previous = Array.from({length:recognized.length + 1}, (_, index) => index);
  for (const [row, expected] of reference.entries()) {
    const current = [row + 1];
    for (const [column, actual] of recognized.entries()) {
      current.push(Math.min(current[column] + 1, previous[column + 1] + 1, previous[column] + Number(expected !== actual)));
    }
    previous = current;
  }
  return previous.at(-1);
}

for (const [label, prefix, start, end, annotations] of samples) {
  const getFile = suffix => fs.readFileSync(path.join(directory, prefix + suffix), 'utf8');
  const {chunks} = JSON.parse(getFile('_live.json'));
  const selected = chunks.filter(chunk => start <= chunk.start && chunk.start < end);
  const reference = normalized(getFile('_reference.txt'));
  const before = normalized(selected.map(chunk => chunk.text).join(''));
  const after = normalized(selected.map(chunk => format.tidy(chunk.text)).join(''));
  const cues = chunks.map((chunk, index) => ({
    id:String(index), start:chunk.start, end:chunks[index + 1]?.start ?? chunk.start + 5,
    text:chunk.text, rawText:chunk.text,
  }));
  const guesses = speakers.guesses(meeting, cues);
  const selectedIds = new Set(cues.filter(cue => start <= cue.start && cue.start < end).map(cue => cue.id));
  const selectedGuesses = [...selectedIds].map(id => guesses[id]).filter(Boolean);
  const score = {
    candidateChunks:selectedGuesses.length,
    namedCandidateChunks:selectedGuesses.filter(candidate => candidate.name).length,
    roleOnlyCandidateChunks:selectedGuesses.filter(candidate => !candidate.name).length,
    annotated:0, offered:0, correct:0,
  };
  for (const cue of cues) {
    const name = annotations[cue.start];
    if (!name) continue;
    score.annotated++;
    if (!guesses[cue.id]?.name) continue;
    score.offered++;
    if (guesses[cue.id].name === name) score.correct++;
  }
  // The current agenda is deliberately used on old text to probe false suggestions.
  const otherMeetingContextProposals = selected.reduce((n, chunk) => n + terms.suggestions(meeting, chunk.text).length, 0);
  console.log(JSON.stringify({label, refChars:reference.length, rawEdits:editDistance(reference, before),
    tidyEdits:editDistance(reference, after), changedChunks:selected.filter(c => c.text !== format.tidy(c.text)).length,
    chunks:selected.length, otherMeetingContextProposals, speaker:score}));
}
