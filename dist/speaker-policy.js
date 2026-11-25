// Shared by the live Worker, browser and offline evaluator. Media time is in seconds.
(function (root) {
  // The Python producer reads this JSON block as well. Locality names only qualify a self-introduction.
  // Source: https://www.seongnam.go.kr/cn040104 (administrative districts, 26 November 2026).
  const districtIntroData = /* district-intro-json */ {"districts":["수정구","중원구","분당구"],"dongs":["단대동","산성동","양지동","복정동","위례동","신촌동","고등동","시흥동","성남동","중앙동","하대원동","도촌동","분당동","정자동","금곡동","구미동","판교동","삼평동","백현동","운중동"],"numberedDongs":{"신흥":"123","태평":"1234","수진":"12","금광":"12","은행":"12","상대원":"123","수내":"123","정자":"123","서현":"12","이매":"12","야탑":"123","구미":"1"},"parties":["무소속","국민의힘","더불어민주당","민주당","조국혁신당","개혁신당","진보당","기본소득당","사회민주당","정의당","국민의당","노동당","녹색당","새로운미래","새미래민주당"]} /* end-district-intro-json */;
  for (const value of Object.values(districtIntroData)) Object.freeze(value);
  const podium = /* podium-json */ {
    "profile": "plenary-floor-1",
    "callMaxSeconds": 65,
    "confirmationMaxSeconds": 12,
    "maxCueGapSeconds": 12,
    "maxFloorSeconds": 360,
    "minCallSeconds": 3.5,
    "minSeedSeconds": 2.5,
    "minMatchSeconds": 3.5,
    "maxCueSeconds": 15,
    "maxOverlapSeconds": 0.04,
    "maxUnreadCallAudioSeconds": 3,
    "minChairSeparation": 0.17,
    "minChairMargin": 0.12
  } /* end-podium-json */;
  const priorStaff = /* prior-staff-json */ {
    "bases": ["official-assigned-committee-support-team", "official-recorded-committee-contact"],
    "offices": ["주무관", "전문위원"],
    "minCueSeconds": 1,
    "maxCueSeconds": 12
  } /* end-prior-staff-json */;
  Object.freeze(priorStaff.bases);
  Object.freeze(priorStaff.offices);
  const policy = Object.freeze({
    priorStaff: Object.freeze(priorStaff),
    districtIntro: Object.freeze(districtIntroData),
    chairElection: Object.freeze({
      term:10, half:'전반기', registeredOn:'2026-07-07', through:'2028-06-30',
      vodId:'5403', sourceUrl:'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5403',
      registryUrl:'https://cast.sncouncil.go.kr/vod/simple_vod_list.jsp',
      // Original election programme chapters with the successful candidate and office in the heading.
      offices:Object.freeze({
        '의회운영위원회':Object.freeze({name:'정봉규',position:7089}),
        '행정교육위원회':Object.freeze({name:'김보석',position:7166}),
        '경제환경위원회':Object.freeze({name:'안광환',position:7229}),
        '문화복지체육위원회':Object.freeze({name:'윤혜선',position:7309}),
        '도시건설위원회':Object.freeze({name:'박기범',position:7382}),
        '예산결산특별위원회':Object.freeze({name:'서은경',position:7512}),
        '윤리특별위원회':Object.freeze({name:'민영미',position:7594}),
      })
    }),
    spokenStaffOffices: Object.freeze(['의회사무과장','의회사무국장','정책지원관','전문위원','주무관']),
    recordedExecutiveOffices: Object.freeze([
      Object.freeze({role:'교통기획과장', body:'도시건설위원회', registeredOn:'2026-04-17',
        source:'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5389&position=3290'}),
    ]),
    oath: Object.freeze({podiumWaitSeconds:10,maxPauseSeconds:2,maxSeconds:60}),
    petition: Object.freeze({podiumWaitSeconds:8,maxPauseSeconds:3,splitSeconds:1,maxSeconds:60,minTopicLength:9,
      commonWords:Object.freeze(['성남시','성남시민','시민의','주민참여','지역주민','공공시설','개선방안','정비사업','일부개정','선정과정','도시건설위원회'])}),
    completedSpeech: Object.freeze({maxSeconds:480,maxSilenceSeconds:15}),
    plenaryTopicActivity: Object.freeze({
      maxDays:90,
      sources:Object.freeze([
        Object.freeze({name:'민영미',office:'윤리특별위원회',term:10,publishedOn:'2026-07-30',
          url:'https://www.sncouncil.go.kr/member/09021/bbsPress.do?key=18e0943d57062cf89d6f31b246efd2c3506cb09727f71325d785209d66ac5226703adfb998841e55&reform=view'}),
        Object.freeze({name:'민영미',office:'윤리특별위원회',term:10,publishedOn:'2026-08-05',
          url:'https://www.sncouncil.go.kr/kr/news/bbsLaw.do?flag=&key=ba8979de01935510fd52841190bc27229448bccfa429b22275a4e9a5c4d0c4a2ec48baaeae9a9d24&keyword=&pageNum=2&reform=view'}),
      ]),
    }),
    version: '2026-11-26.13',
    podium: Object.freeze(podium),
    acousticProfiles: Object.freeze({
      'same-session-1': Object.freeze({minSeconds:3.5}),
      'same-session-2': Object.freeze({minSeconds:2.5,shortBelowSeconds:3.5,shortMinLetters:11,shortMinWords:4}),
      'same-session-cam-1': Object.freeze({minSeconds:2.5,shortBelowSeconds:3.5,shortMinLetters:11,shortMinWords:4})
    }),
    acousticMaxGapSeconds: 0.35,
    acousticMaxOverlapSeconds: 0.04,
    acousticMaxClockDriftSeconds: 0.5,
    acousticMaxAgeSeconds: 120,
    acousticMinKoreanLetters: 12,
    handoffSeconds: 5,
    minHandoffLetters: 12,
    calledIntroSeconds: 3,
    splitIntroSeconds: 1.5,
    continuationSeconds: 1.5,
    introducedQuestionMinLetters: 14,
    introducedQuestionMaxSpanSeconds: 18,
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
