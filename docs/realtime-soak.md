# 로컬 1배속 수집·수신 장시간 검증

`evaluation/realtime_soak.py`는 지정한 16kHz 모노 PCM WAV의 SHA-256을 확인하고, 각 청크의 원본 종료 시각이 실제로 지난 다음에만 로컬 faster-whisper-small로 인식한다. 청크 처리 시간과 원본 시각 대비 지연을 기록하고, 임시 Ed25519 키로 서명해 같은 컴퓨터의 Worker 함수에 전달한다. Worker는 메모리 버킷만 사용하며 네트워크 게시를 하지 않는다. 원본은 45분이어야 한다.

```powershell
python evaluation/realtime_soak.py --wav <45분-PCM.wav> --sha256 <SHA256> --model <로컬-faster-whisper-small> --out <빈-결과-폴더> --threads 1
```

수집기와 달리 이 오프라인 재생기는 파일을 기다리며 끝까지 처리한다. 따라서 처리 지연이 60초를 넘으면 운영 수집기의 지연 제한을 충족하지 못한 것이며, 이 실험에서 누락이 없더라도 실제 실시간 캡처의 드롭이 없다고 해석하지 않는다. `chunks.jsonl`의 `lagSeconds`, `processingSeconds`, `invalidTime`과 최종 `summary.json`을 함께 확인한다. 수집기 중단 시각이 회의 종료를 뜻하지 않으므로 마지막 상태는 `interrupted`다.

`evaluation/precomputed_soak.py`는 별도 비교로, 동일 PCM에서 **이미 생성된** cue를 각 원본 청크가 끝난 뒤 실제 시간에 맞춰 서명 송신한다. 실시간 ASR의 처리 시간·정확도를 측정하지 않는다. WAV, cue, chunk 해시와 실험 방식은 결과에 기록한다. 기본 길이는 2700초이며, `--duration-seconds`는 짧은 도구 검증용이다. `COUNCIL_SOAK_TEST_JOINS`는 짧은 테스트에서만 수신자 참여 시각을 바꾸는 옵션이며 실제 실험에는 설정하지 않는다.

```powershell
python evaluation/precomputed_soak.py --wav <PCM.wav> --sha256 <SHA256> --cues <cues.jsonl> --chunks <chunks.jsonl> --out <빈-결과-폴더>
```

각 Worker는 실제 경과 10분과 30분에 두 수신자를 참여시키고, 수신자의 각 조회에서 tail 길이와 중복을 확인한다. 최종 전체 자막 ID와 게시 ID의 누락·중복, 수신자별 참여 후 누락, 14일 경계 직전·경계 시 서버 응답을 기록한다. 만료 테스트는 완료 뒤 Worker의 테스트 시계만 바꾼 결과이며 14일 실시간 경과 시험이 아니다. 프로세스가 종료되면 실험용 메모리 버킷과 임시 키는 사라진다.
