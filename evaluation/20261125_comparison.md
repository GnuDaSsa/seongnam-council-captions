# 2026-11-25 공식 회의 음성 비교

CPU `faster-whisper-small` int8, `cpu_threads=2`, 기존 quiet 기반 청크와 무음 게이트, 이전 정상 출력 300자, 고정 기본 프롬프트를 사용했다. 회의록은 점수 계산에만 썼고 인식 모델에 제공하지 않았다. 각 측정은 단일 실행이며 동시에 운영 프로세스와 CPU를 공유했으므로 처리시간은 실시간 지연이나 3채널 처리 보장이 아니다. 공식 잠정 회의록은 편집문이고 경계는 발화·청크를 대조해 근사했으며, 사람이 음성 전체를 축어 채록하거나 화자를 독립 검증한 것은 아니다. CER은 NFKC, 소문자, 비문자·비숫자 제거 뒤 Levenshtein 거리 / 참조 글자 수다. `[음성 재확인]`도 출력된 문자열로 점수에 포함한다. 숫자의 발음과 아라비아 숫자를 동일하게 정규화하지 않는다.

| 평가 구분 | 기준 beam 2 | beam 5 | 운영 transcribe_live | 오디오 전체 길이 및 운영 측정 시간 |
|---|---:|---:|---:|---|
| 경제환경위 개회, 개발 | 164/367 = 44.69% | 45/367 = 12.26% | 41/367 = 11.17% | 120초, 41.4초, 추가 beam5 1회 |
| 행정교육위 개회, 독립 위원회 | 26/599 = 4.34% | 22/599 = 3.67% | 26/599 = 4.34% | 120초, 40.5초, 추가 0회 |
| 경제환경위 폐기물 조례 제안·집행부 발언, 같은 회의 후반 | 36/446 = 8.07% | 32/446 = 7.17% | 36/446 = 8.07% | 120초, 51.1초, 추가 0회 |
| 경제환경위 질의·응답, 같은 회의 후반 | 26/240 = 10.83% | 미측정 | 26/240 = 10.83% | 90초, 26.4초, 추가 0회 |

기준 및 beam5 전체 오디오 처리시간은 순서대로 경제 개회 35.7·38.7초, 행정 개회 28.1·45.3초, 폐기물 발언 37.1·43.8초였다. 시간은 각각 별도 실행이고 CPU 부하가 달랐다. 운영 transcribe_live는 청크별 beam2에 repetition 또는 severe_uncertainty가 있으면 같은 오디오·동일 문맥으로 beam5를 한 번 수행하며, 재시도 결과에도 해당 플래그가 있거나 기존 정상 발화 구간이 사라지면 원본을 유지한다. 이 실험은 일반 고유명사 오류나 모든 누락을 탐지하지 못한다.

개발 발췌에서 공식 회의록의 최민수는 beam2·beam5 모두 정확 문자열 0/1회였다. 2027·8건·2026·2025는 각각 1회 등장하고 beam2 정확 문자열 총 0/4, beam5 4/4였다. 독립 행정교육 발췌에서 구본혁은 둘 다 0/1, 3건·2026·2025는 둘 다 3/3이다. 폐기물 제안 발췌에서 장미라 2회는 양쪽 모두 2회, 김정아 1회도 양쪽 1회였지만 자원순환과는 양쪽 모두 정확 문자열 0회이며 자원수란과 등으로 오인했다. 제9조 정확 문자열도 0회다. 단순 정확 문자열 수이고 의미 정렬이나 인명 식별 정확도를 뜻하지 않는다. 특히 beam2는 백진규를 2회 출력하지만 참조에는 1회로, 정확 문자열 존재가 오인 추가를 배제하지 않는다.

고정 용어 프롬프트 후보 `일부개정조례안, 제안설명, 심사보고, 자료 제출, 경기도신용보증재단`은 개발 44/367, 독립 행정 28/599로 독립 사례가 악화됐다. 기관명이 해당 회의 안건과도 겹치므로 독립 과거 자료로 분리된 사전의 검증이 아니며 채택하지 않는다. 인명·숫자·기관명 자동 교정은 하지 않았다.

## 구간 및 출처

- 경제 개발: [2026-10-07 제313회 제1차 경제환경위 영상 0초](https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5483&position=0), [공식 잠정 회의록](https://www.sncouncil.go.kr/record/recordView.do?key=f029c2f06f8a836d3121716a4cb595e6f99b963a31140fc177deaf26e61e66d8ebf3cfcf39b7662b&memberName=%EC%A0%95%EC%97%B0%ED%99%94). 전체 0~120초 중 0~89.5초의 청크, 회의록 첫말 `의석을 정돈해`, 끝말 `수고하셨습니다`. WAV SHA-256 `abb03bdc4ecee62a4712507e9378aafc7e0f4d4cc879450819d598529b194eee`.
- 독립 행정교육위: [같은 날 제1차 행정교육위 영상 0초](https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5481&position=0), [공식 잠정 회의록](https://www.sncouncil.go.kr/record/recordView.do?key=6c5f481f1c88e2bf008f0d6977e20b567d1f7a309e40ae7e8debea59517c0497ce904713ae521c34&memberName=%EC%88%9C%EC%84%A0%EC%98%81). 0~120초 중 0~110초 청크, 첫말 `좌석을 정돈하여`, 끝말 `이상 보고를 마치겠습니다`. WAV SHA-256 `56b3320449322b2a2dbb76eebc2f4e4dfc49b9228e67ecb207d7fce8ae07bc83`.
- 추가 조례 발언: [경제환경위 영상 1200초](https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5483&position=1200), [공식 잠정 회의록](https://sncouncil.go.kr/record/recordView.do?key=a9515fd62076243f29966974b70a7a30027151656e67a04e5dce5ca09e6ec86b8caa687e3ebec190&memberName=%EC%A0%95%EC%97%B0%ED%99%94). 1200~1320초 중 1200~1299.5초 청크, 첫말 `주민들이 악취와 환경 문제로`, 끝말 `이상으로 팀장 소개를 마치고`. 제안자, 위원장 및 집행부 발언이며 질의응답으로 분류하지 않는다. WAV SHA-256 `bff00f6ecfdbea7d777f8dc1b9614c2d69fa49ce881ee09f9590142f49fc01ec`.
- 질의·응답: [경제환경위 영상 1800초](https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5483&position=1800), 앞의 동일 회의록. 1800~1890초 중 1832~1882.5초 청크, 첫말 `다 버리는 거예요`, 끝말 `예, 알겠습니다`. 정연화 위원의 야탑동 쓰레기 민원 질의와 자원순환과장의 발언 전환에 걸친 구간이며, 두 번째 발언이 짧아 충분한 실질 답변 사례라고 일반화할 수 없다. WAV SHA-256 `05e84b497f8daa4c7a48c14109f33fd5d49a8c1a9a8e8caaf6a805eb87fb34ef`.

후반 두 표본은 개발 사례와 같은 회의이므로 독립 회의 검증이 아니다. 후보를 선정한 뒤 추가로 채취했고, 타임라인·공식 검색 발췌와 ASR 청크 시작점으로 참조 경계를 수동 지정했다. 기존 원본 사이트의 회의록을 직접 내려받는 시도가 빈 문서로 돌아와 공식 검색에서 노출된 회의록 발췌를 수작업 발췌했다. 그러므로 제공 참조 파일은 정답셋 전문이 아니라 출처가 명시된 비교용 부분 발췌이며 축어 전사로 취급하지 않는다.

## 재현

측정용 PC의 오디오와 결과, 비교용 회의록 발췌는 저장소 밖 `%LOCALAPPDATA%\SeongnamCouncilDesk` 및 그 하위 `evaluation-20261125`에 있다. 다른 PC에서는 위 공식 영상의 같은 구간을 16 kHz 모노 16비트 PCM WAV로 준비하고 같은 경계의 회의록 발췌를 지정한다. 운영 전사 의존성과 모델을 준비한 Python 환경에서 다음 명령을 실행한다.

```powershell
$sample=Join-Path $env:LOCALAPPDATA 'SeongnamCouncilDesk\econ5483.wav'
$out=Join-Path $env:LOCALAPPDATA 'SeongnamCouncilDesk\evaluation-20261125\repro-live.json'
python evaluation\compare_live.py $sample $out
$ref=Join-Path $env:LOCALAPPDATA 'SeongnamCouncilDesk\evaluation-20261125\econ_reference.txt'
python evaluation\compare_score.py $ref 89.5 $out
```

`compare_candidate.py WAV OUTPUT baseline|beam5|vocabulary`는 기존 beam2와 beam5, 실험용 프롬프트를 각각 실행한다. `compare_live.py`는 실제 운영 `transcribe_live`를 호출하고 모델 호출 횟수만 계측한다. 참조와 비교할 때 0초가 아닌 청크 범위는 `compare_score.py REFERENCE 32:82.5 RESULT`처럼 상대 초로 지정한다. 실행 시간이 재현값과 다를 수 있다.
