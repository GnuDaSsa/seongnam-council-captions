/* Source-backed review suggestions. Never edits recognized text. */
(function (root) {
  'use strict';
  const entries = [
    { heard: '맨사 환경 생태학 수본', official: '맹산환경생태학습원', department: '환경정책과', context: /생태|학습|환경/, source: 'https://www.seongnam.go.kr/pm04041101?deptCode=37803130000&orgSelect=orgSelect01' },
    { heard: '탄전습지생태원', official: '탄천습지생태원', department: '생태하천과', context: /탄전습지생태원/, source: 'https://www.sujeong-gu.go.kr/mobile/sub/content.asp?cIdx=224' },
    { heard: '1윤 차', official: '이륜차', department: '기후에너지과', context: /소음|단속|과태료|오토바이|배기|주행/, source: 'https://snvision.seongnam.go.kr/21799' },
    { heard: '이른 차', official: '이륜차', department: '기후에너지과', context: /소음|단속|과태료|오토바이|배기|주행/, source: 'https://snvision.seongnam.go.kr/21799' },
    { heard: '아프리카 대지 열병', official: '아프리카돼지열병', department: '환경정책과', context: /멧돼지|야생|포획|매몰|방역/, source: 'https://sncouncil.go.kr/record/recordView.do?key=beedbee2563c9755856c28f25d1bcf791037330e1e1e1abe32b2c4e646af14445d52610902fe66e2' }
  ];
  function suggestions(meeting, text) {
    if (!meeting || String(meeting.id) !== '2853' || !Array.isArray(meeting.agenda) || typeof text !== 'string') return [];
    return entries.filter(e => meeting.agenda.includes(e.department) && text.includes(e.heard) && e.context.test(text))
      .map(({ heard, official, source }) => ({ heard, official, source }));
  }
  const api = Object.freeze({ suggestions });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CouncilCommitteeTerms = api;
})(typeof window !== 'undefined' ? window : globalThis);
