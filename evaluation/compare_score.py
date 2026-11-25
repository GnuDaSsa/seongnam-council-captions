"""Score decoded chunks whose start times fall within the selected range."""
import argparse
import json
import unicodedata
from pathlib import Path


def normalize(text):
    return "".join(char for char in unicodedata.normalize("NFKC", text).lower() if char.isalnum())


def edit_distance(reference, output):
    previous = list(range(len(output) + 1))
    for index, expected in enumerate(reference, 1):
        current = [index]
        for column, recognized in enumerate(output, 1):
            current.append(min(current[-1] + 1, previous[column] + 1, previous[column - 1] + (expected != recognized)))
        previous = current
    return previous[-1]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("interval", help="END or START:END in clip-relative seconds")
    parser.add_argument("results", nargs="+", type=Path)
    args = parser.parse_args()
    start, _, end = args.interval.rpartition(":")
    lower, upper = float(start or 0), float(end)
    reference = normalize(args.reference.read_text(encoding="utf8"))
    if not reference or upper <= lower:
        parser.error("Expected a nonempty reference and an increasing time interval")
    for path in args.results:
        data = json.loads(path.read_text(encoding="utf8"))
        text = "".join(chunk["text"] for chunk in data["chunks"] if lower <= chunk["start"] < upper)
        output = normalize(text)
        edits = edit_distance(reference, output)
        print(path, "edits", edits, "reference", len(reference), "CER", round(edits / len(reference) * 100, 2),
              "output_chars", len(output), "whole_run_seconds", round(data["seconds"], 1))
