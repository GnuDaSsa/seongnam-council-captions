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
