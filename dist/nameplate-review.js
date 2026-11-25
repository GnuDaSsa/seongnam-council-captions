/* A sampled nameplate can corroborate a review, but cannot establish who spoke. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CouncilNameplateReview = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  // The tab player uses epoch milliseconds; published cues use ISO timestamps.
  function captureTime(value) {
    if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : NaN;
    return typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  }
  function observations(meeting, archive, payload) {
    if (String(meeting.id) !== String(payload?.meetingId) || !Array.isArray(payload?.observations)) throw Error('Invalid meeting observations');
    const members = new Set(meeting.members || []);
    const intervals = archive.cues.map(cue => {
      const start = captureTime(cue.observedAt), duration = (cue.end - cue.start) * 1000;
      return {id:String(cue.id), start, end:start + duration};
    }).filter(row => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start)
      .sort((a, b) => a.start - b.start);
    const gaps = (archive.gaps || []).map(gap => ({start:captureTime(gap.start), end:gap.end == null ? Infinity : captureTime(gap.end)}));
    const seen = new Set(), samples = [];
    for (const row of payload.observations) {
      const time = captureTime(row?.capturedAt);
      if (!Number.isFinite(time) || seen.has(time) || !Array.isArray(row.matchedMembers) || row.matchedMembers.some(name => !members.has(name))) continue;
      seen.add(time);
      samples.push({time, names:[...new Set(row.matchedMembers)], cueId:null, nearbyIds:[]});
    }
    samples.sort((a,b) => a.time - b.time);
    let cursor = 0, active = [];
    for (const sample of samples) {
      // The HLS feed has no program-date-time. Offer navigation around the capture
      // clock, without selecting one side of a turn change as the speaker.
      const radius = 15000;
      while (cursor < intervals.length && intervals[cursor].start <= sample.time + radius) active.push(intervals[cursor++]);
      active = active.filter(row => row.end > sample.time - radius);
      if (!sample.names.length || gaps.some(gap => gap.start <= sample.time && gap.end > sample.time)) continue;
      const nearby = active.filter(row => row.end - row.start <= 30000 &&
        !gaps.some(gap => gap.start < Math.max(row.end,sample.time) && gap.end > Math.min(row.start,sample.time)));
      sample.nearbyIds = nearby.map(row => row.id);
      const covering = active.filter(row => row.start <= sample.time && sample.time < row.end);
      if (nearby.length === 1 && covering.length === 1 && nearby[0] === covering[0]) sample.cueId = nearby[0].id;
    }
    return samples;
  }
  return {observations,captureTime};
});
