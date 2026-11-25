# 10-minute public recording evaluation

Source: [official VOD and posted chapter transcripts](https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5467&position=591), 2026-09-07 plenary session, original 591–1191 seconds. The selected 600 seconds are saved outside this repository as 16 kHz mono PCM. Its first 388 seconds are chapter 3 and the remainder is chapter 4. Downloading the player HTML and HLS and extracting its audio requires access to the official public server. Do not submit audio or text to a remote transcription service.

WAV SHA-256: `643ee7c02753fd16b592da87bf57ced52a138bed0bf905d2369cc2604424c0cb`.

`extract_reference.py PLAYER_HTML OUTPUT_DIR` extracts official chapters 3 and 4. `browser_eval.py WAV OUTPUT_JSON [REVISION]` serves `dist/asr/worker.js` from git revision `b96f6c7` by default and invokes Chrome on independent 8-second slices, using the Xenova/whisper-tiny model and worker settings. This reproduces the measured pre-repetition-filter baseline; the currently edited worker may differ. It downloads the model via that worker if needed. `baseline.py WAV MODEL OUTPUT_JSON` is a different engine (faster-whisper tiny int8); it is a proxy and must not be called the browser measurement. `shared_eval.py WAV OUTPUT_JSON` uses the production `shared_stt` functions, bounded quiet-based chunks, a public chapter-title hint list, and previous model output, with a locally provisioned model. It evaluates uninterrupted recorded audio, not live network capture or presentation latency. Install dependencies separately and retain the existing model path; do not download another copy.

`score.py REFERENCE_DIR OUTPUT_JSON` computes character edit distance divided by the number of reference characters after Unicode NFKC, lowercasing, and removing non-alphanumerics. It removes parenthesized editorial stage directions and speaker labels, and cuts chapter 4 at the sentence ending around 1191 seconds. It does not convert spoken numbers to digits. The posted minutes are edited text, not a human verbatim audio transcript, and the final sentence boundary is approximate; CER includes these mismatches. `omissions.py` flags candidate sentences of at least 15 normalized characters with less than 20% coverage in a global SequenceMatcher alignment. Candidates are not confirmed omissions without audio review; alignment can miss omissions and can flag paraphrases. A complete count requires review against the original recording.

One Chrome run on this PC: model initialization 85.57 s, inference 176.55 s; **1,397 / 2,650 = 52.72% CER**. The updated shared model's displayed text scored **227 / 2,650 = 8.57%**, and its raw text **435 / 2,650 = 16.42%**. The updated model loaded in 1.70 s and processed the excerpt in 138.91 s; this overlapped live CPU activity and unnecessarily decoded seven near-silent chunks. Those seven produced no text, so applying the producer's RMS gate does not alter the text or subsequent context. These timings are not controlled benchmarks or live-latency guarantees. The browser produced `25년 12월` → `20분 연 12월`; the shared model produced `B/C값` → `비식값` even when its displayed `0.38` was correct. One raw segment repeated `2부에서` dozens of times and was displayed as `[음성 재확인]`, explaining much of the raw/display difference. These are single-sample measurements, not population estimates.

Algorithmic whole-sentence omission candidates: browser 5, shared displayed 2. These are not confirmed counts: the official record repeats an interrupted phrase, which can create alignment artefacts, and actual speech has not been independently reviewed by a listener. Do not interpret the candidates as proven complete-utterance drops.

| Exact normalized target | Reference occurrences | Browser output | Shared displayed output |
|---|---:|---:|---:|
| 추선미 | 2 | 0 | 1 |
| 윤혜선 | 2 | 0 | 2 |
| 도촌야탑역 | 1 | 0 | 1 |
| 0.38 | 2 | 0 | 2 |
| 27년 2월 | 1 | 1 | 1 |

These are exact string counts rather than aligned mention recall; the numeric test does not treat spoken forms as equivalent. The shared model received the public chapter labels `추선미 의원, 윤혜선 의원, 도촌야탑역 신설` as hints, whereas the browser did not. Those hints identify topics and invited speakers, not proof of actual attendance or statements.
