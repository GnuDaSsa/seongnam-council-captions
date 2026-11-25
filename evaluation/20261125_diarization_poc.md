# 익명 음성 구간 군집화 실험: 2026-11-25

이 실험은 화자의 실명 확인이나 음성 분리 결과가 아니다. 3초 음성 구간이 음향 특성상 비슷한지를 거칠게 묶어, 검토할 만한 경계가 보이는지만 살폈다. 각 구간에는 여러 사람이 함께 말하거나 비음성이 들어갈 수 있다. 구간을 한 사람의 발언으로 간주하지 않으며 OCR·명부·실명과 연결하지 않았다.

## 입력과 모델

- 음원: 2026-10-07 제313회 제1차 경제환경위원회 [공식 VOD 1800초](https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5483&position=1800)부터 90초, 16kHz 모노 PCM16. WAV SHA-256 `05e84b497f8daa4c7a48c14109f33fd5d49a8c1a9a8e8caaf6a805eb87fb34ef`.
- 관련 [공식 잠정 회의록](https://sncouncil.go.kr/record/recordView.do?key=a9515fd62076243f29966974b70a7a30027151656e67a04e5dce5ca09e6ec86b8caa687e3ebec190). 실제 발언자 전환 시각은 이 실험에서 원음으로 검증하지 않았다.
- [WeSpeaker 공식 VoxCeleb ResNet34-LM ONNX](https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM): 모델 카드 기준 CC BY 4.0, 영어 VoxCeleb 학습. 26,530,309바이트, SHA-256 `7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068`. 이 모델은 화자 임베딩 모델이지, 완성된 전환 검출 모델이 아니다.
- 특성 추출은 [kaldi-native-fbank](https://github.com/csukuangfj/kaldi-native-fbank) 1.23.3, 로컬 ONNX Runtime·NumPy·SciPy 사용. 새 패키지와 모델은 `%LOCALAPPDATA%\SeongnamCouncilDesk\diarization-poc`에만 두었다. ONNX Runtime intra/inter-op 각 1스레드, BLAS 등도 해당 실험 프로세스에서 1스레드로 제한했다. 기존 생중계 프로세스와 사용자·시스템 환경 설정은 변경하지 않았다.

## 방법과 결과

90초를 겹치지 않는 3초 창으로 나누고 RMS 0.004 미만인 창은 제외했다. 각 창에서 80차원 log-mel fbank를 시간 평균 정규화해 임베딩을 구한 뒤, 미리 정한 코사인 거리 0.65를 기준으로 average-linkage 군집화를 했다. 이 임계값은 이 장소·음원·한국어에 맞춰 검증되거나 보정된 값이 아니다. 연속 창의 군집 번호가 바뀌는 시점을 후보로 기록했고, 묵음으로 분리된 간격은 경계로 표시하지 않았다. 3초는 관측 단위일 뿐 정확한 화자 전환 시각이 아니다.

- 30개 3초 창 중 29개가 에너지 조건을 통과했고, 5개 **음향 군집**으로 묶였다.
- 연속 창의 군집이 바뀐 경계 후보는 **8개**: 발췌 시작 기준 6·9·12·24·75·78·81·84초(영상 위치 약 1806·1809·1812·1824·1875·1878·1881·1884초).
- 특징 추출·추론·군집화 3.57초. 모델 초기화와 WAV 읽기·파일 해시는 제외했고, 동시 작업이 있는 PC에서 한 번 실행한 값이다. 생중계 지연이나 처리 용량을 보장하지 않는다.
- 1832~1882.5초 인근의 공식 회의록에는 위원 발언과 집행부 발언 전환이 있으나, 청크의 영상 위치와 개별 음성을 정확하게 대조하지 않았으므로 위 8개 중 맞거나 틀린 개수는 알 수 없다. 5개 군집도 5명의 화자를 뜻하지 않는다.

중첩 발화, 발화 중 마이크 변경, 짧은 맞장구, 잔향, 배경음, 볼륨 변화와 3초 경계는 모두 가짜 전환이나 누락을 만들 수 있다. 또한 영어 화자 데이터로 학습한 모델의 성남시 한국어 회의 적합성은 검증하지 않았다. 따라서 이 실험만으로 운영에 적용하거나 음성 구간을 화자별로 자동 귀속할 근거는 없다.

## 재현

기존 로컬 Python 의존성 경로와 별도 helper 경로를 현재 PowerShell 프로세스에만 설정한다. 모델 및 공개 WAV는 저장소에 포함하지 않는다. 결과 JSON에는 익명 번호와 시간만 포함하며 로컬 캐시에 둔다.

```powershell
$root = Join-Path $env:LOCALAPPDATA 'SeongnamCouncilDesk'
$outputFile = 'diarization-poc\result-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json'
python evaluation\diarize_sample.py `
  (Join-Path $root 'econ5483_1800.wav') `
  (Join-Path $root 'diarization-poc\wespeaker.onnx') `
  (Join-Path $root $outputFile)
```

스크립트는 90초보다 긴 파일을 거절하고, 모델을 다운로드하지 않는다. `kaldi-native-fbank` 1.23.3은 사전에 별도 로컬 디렉터리에 설치해야 한다. WAV, 모델, 결과 JSON과 helper 패키지는 저장소 밖에 있다.
