import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

import council_minutes as cm


class PipelineTests(unittest.TestCase):
    def test_intervals_cover_short_final_chunk(self):
        self.assertEqual(cm.intervals(125.5, 60), [(0., 60.), (60., 120.), (120., 125.5)])
        with self.assertRaises(ValueError):
            cm.intervals(10, 0)

    def test_transcribe_uses_real_chunk_bounds_and_file(self):
        client = Mock()
        client.audio.transcriptions.create.return_value.text = "발언"
        def ffmpeg(args, **kwargs):
            Path(args[-1]).write_bytes(b"fake audio")
        with tempfile.TemporaryDirectory() as tmp, patch.object(cm.subprocess, "run", side_effect=ffmpeg):
            result = cm.transcribe(client, Path("local.mp4"), 61.5, 60, "gpt-transcribe", tmp)
        self.assertEqual([(s["start"], s["end"]) for s in result], [(0., 60.), (60., 61.5)])
        self.assertEqual(result[1]["id"], "cue-00002")
        self.assertEqual(client.audio.transcriptions.create.call_count, 2)

    def test_draft_references_must_exist(self):
        segments = [{"id": "cue-00001"}]
        item = {"kind": "요청", "text": "자료 요청", "cueIds": ["cue-00001"]}
        self.assertEqual(cm.validate_draft(json.dumps({"items": [item]}), segments)["items"], [item])
        item["cueIds"] = ["invented"]
        with self.assertRaises(ValueError):
            cm.validate_draft(json.dumps({"items": [item]}), segments)

    def test_summary_calls_responses_with_evidence(self):
        client = Mock()
        client.responses.create.return_value.output_text = '{"items": []}'
        result = cm.summarize(client, [{"id": "cue-00001", "text": "발언"}], "gpt-4.1-mini")
        self.assertEqual(result["items"], [])
        self.assertIn("cue-00001", client.responses.create.call_args.kwargs["input"])
        self.assertFalse(client.responses.create.call_args.kwargs["store"])

    def test_entrypoint_preserves_transcript_then_resumes(self):
        client = Mock()
        client.audio.transcriptions.create.return_value.text = "예시 발언"
        client.responses.create.side_effect = RuntimeError("summary failed")
        def ffmpeg(args, **kwargs):
            Path(args[-1]).write_bytes(b"fake audio")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            audio, output, draft = root / "input.mp4", root / "meeting.json", root / "draft.json"
            audio.write_bytes(b"fake input")
            argv = [str(audio), "--output", str(output), "--draft-output", str(draft),
                    "--id", "m", "--title", "t", "--date", "2026-11-25", "--body", "b",
                    "--offset-seconds", "120"]
            module = types.SimpleNamespace(OpenAI=lambda: client)
            with patch.dict("sys.modules", {"openai": module}), patch.dict("os.environ", {"OPENAI_API_KEY": "mock"}), \
                    patch.object(cm.shutil, "which", return_value="mock"), patch.object(cm, "probe", return_value=62), \
                    patch.object(cm.subprocess, "run", side_effect=ffmpeg):
                with self.assertRaisesRegex(RuntimeError, "summary failed"):
                    cm.main(argv)
                saved = json.loads(output.read_text(encoding="utf-8"))
                self.assertEqual(saved["segments"][0]["start"], 120)
                self.assertEqual(saved["segments"][1]["end"], 182)
                self.assertIn("발췌", saved["coverage"])
                self.assertFalse(draft.exists())
                client.responses.create.side_effect = None
                client.responses.create.return_value.output_text = '{"items": [{"kind":"논의","text":"예시","cueIds":["cue-00001"]}]}'
                resumed, resumed_draft = root / "resumed.json", root / "resumed-draft.json"
                cm.main(["--from-meeting", str(output), "--output", str(resumed), "--draft-output", str(resumed_draft)])
                self.assertEqual(json.loads(resumed.read_text(encoding="utf-8"))["draft"], json.loads(resumed_draft.read_text(encoding="utf-8")))
                self.assertEqual(client.audio.transcriptions.create.call_count, 2)

    def test_preflight_prevents_api_calls(self):
        client = Mock()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            audio = root / "input.mp4"
            audio.write_bytes(b"x")
            argv = [str(audio), "--output", str(root / "missing" / "out.json"), "--draft-output", str(root / "draft.json"),
                    "--id", "m", "--title", "t", "--date", "d", "--body", "b"]
            with patch.dict("sys.modules", {"openai": types.SimpleNamespace(OpenAI=lambda: client)}), \
                    patch.dict("os.environ", {"OPENAI_API_KEY": "mock"}):
                with self.assertRaises(SystemExit):
                    cm.main(argv)
            client.audio.transcriptions.create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
