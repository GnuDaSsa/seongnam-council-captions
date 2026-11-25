// Shared by the live Worker, browser and offline evaluator. Media time is in seconds.
(function (root) {
  const policy = Object.freeze({
    version: '2026-11-25.1',
    handoffSeconds: 5,
    minHandoffLetters: 12,
    calledIntroSeconds: 3,
    splitIntroSeconds: 1.5,
    continuationSeconds: 1.5,
    responseSeconds: 3,
    dialogueBreakSeconds: 20,
    floorLifetimeMs: 8 * 60 * 1000,
    plateNearIntroMs: 15_000,
    plateSearchMs: 125_000,
    independentPlateMs: 10_000,
    plateBeforeQuestionMs: 150_000
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = policy;
  else root.CouncilSpeakerPolicy = policy;
})(typeof window === 'undefined' ? globalThis : window);
