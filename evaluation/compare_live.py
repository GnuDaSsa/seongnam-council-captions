"""Measure the production recognizer on the same chunks as the candidates."""
import argparse

from compare_candidate import run_comparison


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav")
    parser.add_argument("output")
    args = parser.parse_args()
    run_comparison(args.wav, args.output, "live")
