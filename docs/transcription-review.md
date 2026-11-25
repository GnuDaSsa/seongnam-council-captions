# 성남시의회 전사 품질 검토

## 영상과 회의록을 짝짓는 방법

공식 인터넷방송의 회의 ID·위원회·날짜·안건으로 원본을 특정하고 같은 회의의 영상회의록을 찾는다. 발언별 시각이 없으면 회의록의 장 시작과 원음의 첫 문장·끝 문장을 대조해 구간을 정한다. 회의 진행 지문, 발언자 표제와 음소거 구간을 구분한다. 편집된 공식 문장과 다른 어미는 별도로 살피고, 금액·단위·부정 표현·의결 결과가 바뀐 오류를 먼저 검토한다.

개의사나 보고서 낭독, 위원과 집행부가 주고받는 질의응답은 각각 따로 측정한다. 성능을 조정하는 회의와 마지막 검증에 쓰는 회의를 구분한다. 운영 당시에 알 수 있는 의사일정, 소관 부서, 이전 회의에서 확인한 용어만 전사에 제공한다. 위원 명단은 발음을 돕는 자료로 사용하며, 발언자 확정은 별도 검토한다.

## 비교할 항목

동일한 음원과 동일한 정답 구간에 대해 현재 운영 설정과 후보 설정을 실행한다. 띄어쓰기·문장부호를 제외한 문자 편집 횟수와 정답 글자 수, 이름·사업명·수치의 출현 및 일치 횟수를 기록한다. 단위나 부정이 달라져 의미가 바뀐 구절은 시각과 함께 남긴다. 반복이나 음성 재확인으로 표시한 구간은 원문과 화면 결과를 함께 평가한다. 빠진 문장 후보는 사람이 소리를 대조한 경우에만 누락으로 확정한다.

실시간 자막은 연결이 끊긴 구간과 처리 지연까지 확인한다. 과거 녹음의 정확도가 높아도 생중계 감당 여부는 별도다. 회의록은 누적 전사 원문을 보관하고, 교정·자료요구·의결에 출처 발언과 수집 시각을 연결한다. 같은 소리로 판별할 수 없는 중요한 단어나 숫자는 검토 표시를 유지한다.

## 남은 질의응답 오류

11월 25일에 확인한 잔여 오류는 반복 없이 그럴듯하게 틀린 부서명과 사람 이름이다. 정상으로 판정된 질의응답은 두 번째 전사를 거치지 않아 같은 오류가 남을 수 있다. 다음 비교에서는 다른 날짜의 위원회 질의응답에서 부서명·법령명·금액·단위를 먼저 표시해 두고, 공식 안건 대조와 더 큰 음성 모델의 사후 전사를 같은 음원에 적용한다. 생방송의 초안과 사후 교정본은 별도로 보존한다. 담당자가 원음과 대조한 표현만 사전에 추가한다.

## Claude와 Codex의 GitHub 검토

1. Claude와 Codex가 각자 재현 가능한 문제를 찾아 공개 이슈로 등록한다. 이슈에는 회의·원본 시각, 관찰한 현상, 기대 결과, 재현 방법을 적는다. 예측한 원인과 확인된 사실을 구분한다.
2. Codex가 같은 입력에서 실패하는 사례를 확인하고 수정한다. 해당 위원회뿐 아니라 다른 위원회의 발언, 숫자, 정상 반복을 함께 확인한다.
3. Claude가 패치와 남은 위험을 재검토한다. Codex는 회귀 테스트, GitHub 커밋, 운영 사이트 확인 결과를 원래 이슈에 남긴다. 개선을 입증하지 못한 설정은 실험 결과에 남긴다.

## 발언자 이름을 확인하는 방법

경기도의회 설치 문서 6절은 `councilors`에 이름과 위원회를 등록하도록 안내한다. 전사 프롬프트와 이름 교정이 이 명부를 함께 쓴다. 집행부용 `staff_roster`는 임시회의록의 출석공무원·출석전문위원 부분에서 직책과 성명을 읽는다. 생방송 텍스트 교정기는 위원회별 두 명부와 직전 화자, 현재 질의 위원·답변 직책 단서를 함께 보고 이름을 검증한다. 단서가 부족하면 직전 화자를 유지하므로 표시된 실명만으로 화자 전환의 정확도를 측정할 수 없다. [설치 문서 6절](https://github.com/gyeonggi-council/ai-live-transcribe/blob/15ce669d6e17de56418b7fdc3e73b816dca379e1/docs/SETUP.md#6-의원-명부-넣기-선택이지만-권장) · [집행부 명부 수집](https://github.com/gyeonggi-council/ai-live-transcribe/blob/15ce669d6e17de56418b7fdc3e73b816dca379e1/backend/app/services/staff_roster_service.py#L1-L19) · [생방송 화자 검증](https://github.com/gyeonggi-council/ai-live-transcribe/blob/15ce669d6e17de56418b7fdc3e73b816dca379e1/backend/app/services/live_corrector.py#L263-L308)

2026년 11월 25일 경기도의회 공개 소스와 광진구 공개 서비스 안내를 확인했다. 경기도 생방송의 기본 교정 경로는 직전 발언자와 위원회 문맥을 읽어 화자를 추정한다. 공개 배포 파일에 켜져 있는 음성 대조 옵션은 다시보기용이다. [생방송 교정 코드](https://github.com/gyeonggi-council/ai-live-transcribe/blob/15ce669d6e17de56418b7fdc3e73b816dca379e1/backend/app/services/live_corrector.py) · [공개 배포 설정](https://github.com/gyeonggi-council/ai-live-transcribe/blob/15ce669d6e17de56418b7fdc3e73b816dca379e1/k8s/ggc-live-transcribe.yaml#L184)

**경기도의회.** 생방송용 코드에는 위원장의 다음 질의자 호명, 위원의 자기소개, 집행부의 답변 직책을 추적하고 해당 위원회 명부에서 이름을 찾는 기능이 있다. 선택형 음성 분리는 등록된 의원 음성 표본을 한 번에 최대 4명까지 사용할 수 있다. 이 음성 분리 옵션의 공개 소스 기본값은 꺼져 있으며 실제 채널별 운영 설정은 공개 코드만으로 확정할 수 없다. [생방송 단서 추적](https://github.com/gyeonggi-council/ai-live-transcribe/blob/15ce669d6e17de56418b7fdc3e73b816dca379e1/backend/app/services/speaker_cue_tracker.py#L1-L16) · [음성 분리 기본 설정](https://github.com/gyeonggi-council/ai-live-transcribe/blob/15ce669d6e17de56418b7fdc3e73b816dca379e1/backend/app/core/config.py#L238-L244) · [음성 표본 수 설정](https://github.com/gyeonggi-council/ai-live-transcribe/blob/15ce669d6e17de56418b7fdc3e73b816dca379e1/backend/app/core/config.py#L297-L301)

다시보기에서는 전사문과 명부를 함께 읽어 의원에게는 이름을, 집행부에는 직책을 붙인다. 호명 직후의 발언이나 자기소개처럼 근거가 뚜렷한 구간에서 같은 회의의 목소리 기준을 만들어, 다른 구간의 잘못된 배정을 교정한다. 목소리 보정이 실패하면 텍스트로 얻은 결과를 유지한다. [텍스트에서 이름을 붙이는 코드](https://github.com/gyeonggi-council/ai-live-transcribe/blob/15ce669d6e17de56418b7fdc3e73b816dca379e1/backend/app/services/text_speaker_service.py#L2-L16) · [같은 회의의 음성 대조](https://github.com/gyeonggi-council/ai-live-transcribe/blob/15ce669d6e17de56418b7fdc3e73b816dca379e1/backend/app/services/speaker_voice_fusion.py#L1-L22) · [다시보기 설정](https://github.com/gyeonggi-council/ai-live-transcribe/blob/15ce669d6e17de56418b7fdc3e73b816dca379e1/backend/app/core/config.py#L268-L279)

**광진구.** 서비스 안내에 따르면 의원 이름은 의원 명단과 대조하고, 구청장 이름은 의회 영상회의록에 수록된 공식 회의록으로 바로잡는다. 행사에서는 직원이 입력한 출연자 명단을 쓴다. 방송 후에는 영상회의록과 다시보기를 맞추고, 직원이 영상으로 확인한 자막에는 검수 표시를 붙인다. 공개 안내만으로 생방송에서 처음 화자가 바뀐 순간을 감지하는 알고리즘이나 음성 지문 등록 여부는 알 수 없다. [광진 AI 자막 ON 서비스 안내](https://gj-ai-on.pubax.org/?about=1) · [안내문 원본](https://gj-ai-on.pubax.org/static/js/about.js)

**성남시 적용안.** 11월 25일 경제환경위 생방송 화면에는 감사 대상 부서가 나온다. 10월 7일 해당 위원회 다시보기 화면의 기본 발언자란은 비어 있었고, 같은 회의의 잠정 회의록에는 발언 순서와 의원·공무원의 직위 및 실명이 적혀 있었다. 생방송에서 위원장이 누군가를 호명한 문장은 위원장의 발언으로 보존하고 다음 발언을 해당 위원의 후보로만 표시한다. 짧은 맞장구, 겹말, 중간 개입은 미확인으로 남긴다. 회의 후에는 회의록 문장 순서와 해당 영상의 원음을 대조하고 확인한 이름만 초안에 반영한다. 성남 생방송 초안에는 담당자가 근거를 보고 승인하거나 직접 입력한 이름만 기록한다. 11월 25일 경제환경위 호명 세 사례 중 정연화 의원의 호명 직후 응답과 정봉규 의원 호명 뒤 다른 위원의 직전 발언을 인용한 구간은 낮은 신뢰도의 후보로 표시한다. 이름까지 불명확한 나머지 한 사례는 보류한다. 개회·산회나 가결 선포 등 정형 진행 발언에서 이름을 확인할 수 없으면 직무 후보만 표시한다. 당일 공식 기록과의 대조가 남아 있어 실제 화자 정확도는 산정하지 않았다. [경제환경위 생방송 안건](https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=2853) · [과거 질의 영상](https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5483&position=1832) · [공식 잠정 회의록](https://sncouncil.go.kr/record/recordView.do?key=a9515fd62076243f29966974b70a7a30027151656e67a04e5dce5ca09e6ec86b8caa687e3ebec190&memberName=%EC%A0%95%EC%97%B0%ED%99%94)

평가할 때는 같은 회의의 위원·집행부 교대, 위원장 개입, 보충 질의를 따로 표시한다. 글자 오류율과 별개로 이름을 붙인 발언 중 잘못 귀속한 비율, 확인 가능한 발언 중 이름을 맞힌 비율, 미확인으로 남긴 수를 기록한다. 이미 텍스트 교정에 사용한 회의와 다른 날짜의 표본으로 확인한다.

### 성남 회의별 명부 준비와 적용 결과

11월 25일 네 위원회의 의원 31명에 더해, 감사 대상 기관의 직책·성명 23건과 각각의 공식 회의록 주소를 `dist/data/live-meetings.json`에 기록했다. 이전 회의에서 확인한 직책은 당일 발언자를 좁히는 후보 자료다. 예를 들어 10월 12일 도시건설위원회에서는 공동주택과장과 대리 참석 팀장을 따로 기록했다. [도시건설위 원문](https://www.sncouncil.go.kr/record/recordView.do?key=19e7659ee24153e3859a041f28a78b7653ca6c0a98796487bd529d78440e60e9ca0e7044ba047285) · [문화재단 출석 명부](https://www.sncouncil.go.kr/record/recordView.do?key=3fa563a257a5d7157643fe7bbdd05d79f718f2beed0dd1d9c6f8f9f751b93fd4bbe12eddc953242d)

다음 회의를 준비할 때는 공식 회의록을 HTML로 저장한 뒤, 아래처럼 당일 안건에 해당하는 직책을 골라 후보 목록을 만든다. 최근 인사발령과 대리 참석 여부를 대조한 뒤 해당 회의의 `staffRoster`에 반영한다. 도구는 선택한 직책이 누락됐거나 여러 이름에 대응하면 해당 직책을 출력 오류에 표시한다.

```sh
python tools/prepare_staff_roster.py --html minutes.html --source "https://www.sncouncil.go.kr/record/recordView.do?key=a46813304d41743bfdeff02347f8bf0fcca4dd972e54fe3035d5d261986dbb422f0b6975fb238591" --role 공원과장 --role 생태하천과장
```

경제환경위의 17시 41분 답변은 직전 소장 호칭과 발화자가 밝힌 발령일이 공식 인사보고에 기록된 직책·발령일과 일치해 이종빈 푸른도시사업소장으로 추정한다. 간부가 다른 직원을 소개한 17시 34분 발언은 그 직원에게 귀속하지 않는다. 행정교육위의 14시 44분에는 위원장의 호명과 이어진 자기소개에서 순선영이라는 이름이 모두 명부와 일치했다. [인사발령 공식 회의록](https://www.sncouncil.go.kr/record/recordView.do?key=483791be148a634445c8aa53fadd5e6ef18d2f8fee9b7163fcc2a988441a058562a87a7edbd766e4) · [경제환경위 답변](https://seongnam-council-desk.gnudas0923.chatgpt.site/?live=2853&cue=1795587268650154433) · [행정교육위 자기소개](https://seongnam-council-desk.gnudas0923.chatgpt.site/?live=2852&cue=1795584783028762085)

11월 25일 18시 25분에 확보한 같은 자막·명패 자료로 이전 버전과 대조했다. 실명 후보는 경제환경위 1,878구간에서 25건에서 30건으로, 행정교육위 959구간에서 4건에서 6건으로 늘었다. 도시건설위는 1,035구간 중 두 버전 모두 2건이었다. 문화복지체육위는 대조할 공유 자막 자료가 없었다. 당일 공식 회의록을 대조한 정답률은 아직 측정하지 않았다.

공식 생중계와 과거 영상에서 공개된 AAC 오디오 스트림은 각각 스테레오 하나였다. 좌석별 마이크 식별자는 확인되지 않았다. 생중계 화면의 의원 명패 한 건은 한국어 OCR로 읽혔지만 그 화면에 답변석도 함께 나왔다. 별도 90초 음향 실험에서는 구간 경계 후보 8곳이 나왔으며, 실제 발언자 전환 시각은 확인되지 않았다. 운영 초안에는 텍스트 근거와 담당자 확인을 사용한다. [명패 및 스트림 점검](../evaluation/20261125_speaker_video.md) · [익명 음향 구간 실험](../evaluation/20261125_diarization_poc.md)

[성남시의회 영상회의록](https://cast.sncouncil.go.kr/search/search_list.jsp) · [위원회 발언 네 구간의 개선 전후 측정](../evaluation/20261125_comparison.md) · [본회의 10분 측정 방법과 결과](../evaluation/README.md) · [공개 이슈](https://github.com/GnuDaSsa/seongnam-council-captions/issues)
