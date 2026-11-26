# 운영자용 전사·회의록 초안

## 의회가 게시한 발언 원문 가져오기

영상의 '회의록 보기'에 발언 원문이 있는 경우 영상 번호로 가져올 수 있습니다. 아래 예시는 제311회 임시회 제3차 본회의입니다. Python 표준 라이브러리를 사용하며 API 비용이 들지 않습니다.

```powershell
python tools/import_council.py 5411 -o meeting-5411.json
```

사이트의 **회의 JSON 불러오기**에서 이 파일을 엽니다. 원본 플레이어가 여러 발언을 같은 장에 묶으면, 각 발언의 링크도 같은 장의 시작으로 이동합니다. 원문이 아직 게시되지 않은 회의는 다음 방식으로 처리합니다.

로컬 녹음 파일을 OpenAI 전사 API로 보내고 사이트용 회의 JSON과 근거 연결 회의록 초안 JSON을 각각 생성합니다. 실행 시 음성 및 전사 내용이 OpenAI에 전송되며 API 사용료가 발생할 수 있습니다. 공개 전 원음과 의회 회의록을 대조하세요. 입력 파일은 로컬 경로만 받으며 URL을 내려받지 않습니다.

## 준비 및 실행 (PowerShell)

Python 3.9 이상, FFmpeg와 ffprobe가 PATH에 필요합니다. `python -m pip install -U openai`로 공식 SDK를 설치합니다. 운영자가 별도로 현재 프로세스에 `OPENAI_API_KEY`를 설정한 뒤 실행합니다. 키를 인자나 파일에 넣지 마세요.

```powershell
python tools/council_minutes.py 'C:\recordings\meeting.mp4' --output 'C:\recordings\meeting.json' --draft-output 'C:\recordings\meeting-draft.json' --id 'meeting-1' --title '회의 제목' --date '2026-11-25' --body '위원회명' --source-url 'https://example.org/meeting' --agenda '안건명'
```

`--minutes-url`로 회의록 주소를, 반복 가능한 `--agenda`로 확인된 안건을 직접 넣을 수 있습니다. 기본 모델은 `gpt-transcribe`와 `gpt-6.1-terra`이며 각각 `--transcription-model`, `--summary-model`로 바꿀 수 있습니다. `--chunk-seconds`는 1~600초이며 기본 60초입니다. 출력 경로가 이미 있으면 덮어쓰지 않습니다. 녹음, 산출물, 키는 저장소에 넣지 마세요.

발췌 녹음의 원본 시작 시각이 2분이면 `--offset-seconds 120`을 추가합니다. 시간은 원본 기준으로 환산됩니다. 기본 범위 표시는 발췌이며 전체 녹음임을 확인한 경우에만 `--coverage full`을 지정하세요. 전체 녹음은 오프셋 0만 허용합니다.

전사 직후 회의 JSON을 먼저 저장합니다. 요약이 실패하면 이 파일을 보존하고 다음 명령으로 오디오 재전사 없이 새 출력 경로에 요약을 다시 생성할 수 있습니다. 기존 파일은 변경하지 않습니다.

```powershell
python tools/council_minutes.py --from-meeting 'C:\recordings\meeting.json' --output 'C:\recordings\meeting-with-draft.json' --draft-output 'C:\recordings\meeting-draft.json'
```

성공 시 회의 JSON의 `draft`와 별도 초안 JSON에 같은 요약이 들어갑니다. Responses 요청은 `store=False`로 보냅니다. 전사 도중 실패한 경우에는 아직 회의 JSON이 완성되지 않습니다.

각 전사 구간의 시작·끝은 FFmpeg로 자른 **원본 구간 경계**이며 개별 발화의 정확한 시각이 아닙니다. 화자 분리와 문장 경계 자동 보정은 제공하지 않습니다. 고정 시간 분할이 문장을 자를 수 있고 무음 구간의 결과가 누락될 수 있습니다. 시간과 전사 정확도, 누락, 화자, 회의록의 근거와 판단은 사람이 확인해야 합니다. 회의록은 별도 파일에 있으며 각 항목은 전사 구간 ID를 가리킵니다. ID 유효성 검사는 인용 내용의 사실성을 보장하지 않습니다. 오류나 응답 형식 불일치 시 수동 검토 후 새 경로로 다시 실행하세요.

공식 참고: [파일 전사 가이드](https://developers.openai.com/api/docs/guides/speech-to-text), [GPT-Transcribe 모델](https://developers.openai.com/api/docs/models/gpt-transcribe), [GPT-6.1 Terra 모델](https://developers.openai.com/api/docs/models/gpt-6.1-terra), [텍스트 생성](https://developers.openai.com/api/docs/guides/text). 파일 전사는 최대 25 MB이며 타임스탬프 세분화 옵션은 whisper-1 전용입니다. 이 도구는 32 kbps 단일 채널로 분할하고 각 파일이 24 MB 미만인지 확인합니다.

모의 테스트: `python -m unittest discover -s tools -p "test_*.py"` (API 호출 및 실제 음성 파일 불필요).
## 생중계 공유 자막 운영

운영 PC가 오늘의 공식 인터넷방송 편성을 조회해 회의장 HLS 채널의 공유 자막을 생성한다. 외청 유튜브 일정은 시청 링크를 제공한다. 방송 선택과 자막 열람에는 시청자의 API 키가 필요 없다.

Windows 운영 환경은 FFmpeg, Python 3.11, `faster-whisper` 1.2.1, NumPy, cryptography를 사용한다. 운영 PC의 `%LOCALAPPDATA%\SeongnamCouncilDesk\models\faster-whisper-small`에 변환된 다국어 small 모델이 있어야 한다. 서명용 Ed25519 개인키는 같은 운영 디렉터리의 `signing.pem`에 보관한다. 사이트에는 검증용 공개키만 `worker/publisher.pub`에 둔다.

```powershell
python -u tools/schedule_supervisor.py
```

운영 PC의 모델 폴더 또는 검증 패키지의 `source` 옆 `models`에 동봉된 CAM++ 파일이 있으면 수집기는 해시를 확인한 뒤 같은 회의의 자기소개와 후속 음성을 비교한다. 음성 특징은 수집기 메모리에만 둔다. 텍스트만 비교하려면 `--text-only-speakers`, 별도 위치의 Whisper 모델을 쓰려면 `--asr-model <폴더>`를 지정한다. 본회의의 연단 호명·후속 연설까지 음성으로 대조하려면 `--podium-floor`를 추가한다. 모델이 없거나 검증에 실패하면 텍스트로 수집을 계속한다.

오래된 음성을 현재 자막으로 내보내지 않도록 청크 시작부터 60초가 지나면 폐기한다. 입력 버퍼가 가득 차거나 이 제한을 넘으면 FFmpeg를 생방송의 최신 위치에서 최대 두 번 다시 연다. 이때 이전 자막과 ID는 보존하고, 새 음성에는 앞 화자의 이름과 전사 문맥을 넘기지 않는다. 수집기는 마지막으로 처리한 음성 끝과 재개 후 처음 처리한 음성 시작을 회의록의 중단 구간으로 기록한다. 재개 시각을 확인하지 못한 경우 끝은 열린 채로 남는다. `--lag-reconnects 0`은 재연결을 끈다. `--latency-policy standard`가 기본이며, `adaptive`는 대기 중인 음성의 나이가 30초 이상이면 첫 탐색 폭을 2에서 1로 낮춘다. 두 설정 모두 같은 60초 게시 기한을 적용한다.

웹과 운영 PC는 `/api/live/schedule`에서 서울 기준 당일 편성을 읽는다. Worker는 공식 일정, 회의 번호, 위원회명과 방송 시간을 대조하며 당일 응답을 2분간 캐시한다. 공식 원천이 응답하지 않으면 같은 날짜로 확인된 편성만 사용한다. 운영 PC에서 감독 프로그램을 실행하면 1분마다 시작할 HLS 회의를 확인한다. 로그인 예약 작업 `SeongnamCouncilSchedulePublisher`를 사용하는 PC에서는 예약 작업이 활성화돼 있어야 한다. 운영을 일시 중지할 때는 예약 작업을 끄고 `%LOCALAPPDATA%\SeongnamCouncilDesk\schedule-supervisor.pause`를 두면 수동으로 실행해도 송출을 시작하지 않는다. 편성 조회는 운영 PC가 꺼져 있어도 사용할 수 있다. 공유 자막은 운영 PC가 켜져 있고 실제 음성이 수신될 때 생성된다.

실시간 화면은 `/api/live/captions?meetingId=2853`에서 최근 100개 구간을 읽는다. **회의록 초안 열기**는 `/api/live/minutes?meetingId=2853`에서 해당 회의에 누적된 구간·수집 범위·확인된 중단을 읽는다. 화면의 시각은 운영 PC의 음성 수집 시각을 기준으로 한다. 위원 명단은 이름 표기의 참고 자료이며 출석 및 발언자는 원음과 공식 기록으로 확인한다.

전환 전에 저장한 실제 자막 스냅샷이 있을 때는 `restore_captions.py`로 회의 ID가 일치하는 자료를 이력에 복원할 수 있다. 복원할 때도 운영자 서명이 필요하며, 읽기 전용 회의록 조회와 실시간 송출 상태는 독립적으로 유지된다.

수집 종료나 중단 뒤 TXT와 HWPX를 로컬 보관함으로 저장하려면 `--archive-dir`을 지정한다. 저장에 실패한 회의는 `--archive-retry`로 다시 저장할 수 있다. [명령과 읽기 전용 미리보기 검증](../docs/local-archive.md)

### 회의록 작업 재현

아래 예시는 회의 중 한 시점의 공개 자막을 받아 새 폴더에 처리 결과를 저장한다. 사이트 편집 화면과 같은 용어 제안·발언자 후보·회의록 정리 함수를 쓴다.

```powershell
curl.exe -fSs "https://seongnam-council-desk.gnudas0923.chatgpt.site/api/live/minutes?meetingId=2853" -o meeting-2853.json
node tools/minutes_pipeline.cjs meeting-2853.json minutes-run-1
```

`raw.json`은 내려받은 파일과 바이트가 같다. `aligned.json`에는 구간과 중복 여부, `corrected.json`에는 원문·교정문·용어 후보, `speakers.json`에는 발언자 후보 및 확인 결과가 들어간다. `minutes.txt`는 사람이 읽을 초안이다. `run.json`은 모든 출력이 끝난 뒤 기록하며 파일별 SHA-256을 담는다. 재실행할 때는 새 출력 폴더를 사용한다.

확인한 내용은 `--edits reviews.json`으로 입력한다. 형식은 `{"meetingId":"2853","cues":{"발언ID":{"text":"확인한 발언","speaker":"확인한 이름 또는 직책"}}}`이며 수정한 항목만 기입한다. 이후 일정으로 바뀌면 원래 편성표를 `--manifest`로 지정한다. 프로그램은 확인된 편집과 후보를 따로 보관한다. [과거 음성 검증 결과](../evaluation/20261125_comparison.md)

