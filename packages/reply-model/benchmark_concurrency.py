#!/usr/bin/env python3
"""Compare one and two independent local MLX reply workers.

Uses synthetic conversations only. Run while the packaged daemon is stopped for
an uncontended benchmark, or leave it running to measure realistic contention.
"""
import argparse
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parent


def run(command, stdin=None):
    started = time.perf_counter()
    result = subprocess.run(command, input=stdin, text=True, capture_output=True, check=True)
    return time.perf_counter() - started, result.stdout


def summarize_generation(path):
    rows = json.loads(path.read_text())["results"]
    durations = sorted(row["seconds"] for row in rows)
    return {
        "jobs": len(rows),
        "mean_seconds": statistics.mean(durations),
        "p50_seconds": statistics.median(durations),
        "p95_seconds": durations[int(0.95 * (len(durations) - 1))],
        "peak_mlx_gb": max(row["peak_memory_gb"] for row in rows),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.model.is_absolute() or not (args.model / "config.json").is_file():
        raise ValueError("local_model_required")

    with tempfile.TemporaryDirectory(prefix="inboxd-concurrency-") as directory:
        directory = Path(directory)
        base = [sys.executable, str(ROOT / "benchmark_reply.py"), "--model", str(args.model)]
        sequential = directory / "sequential.json"
        sequential_wall, _ = run(base + ["--output", str(sequential), "--repeat", "2"])

        parallel_paths = [directory / "parallel-a.json", directory / "parallel-b.json"]
        commands = [base + ["--output", str(path), "--repeat", "1"] for path in parallel_paths]
        started = time.perf_counter()
        processes = [subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                      text=True) for command in commands]
        errors = [process.communicate()[1] for process in processes]
        if any(process.returncode for process in processes):
            raise RuntimeError("parallel_worker_failed: " + "\n".join(errors))
        parallel_wall = time.perf_counter() - started

        one = summarize_generation(sequential)
        two_parts = [summarize_generation(path) for path in parallel_paths]
        result = {
            "model": str(args.model),
            "kind": "generation_only",
            "one_worker": {**one, "wall_seconds": sequential_wall,
                           "throughput_jobs_per_second": one["jobs"] / sequential_wall},
            "two_workers": {
                "jobs": sum(part["jobs"] for part in two_parts),
                "wall_seconds": parallel_wall,
                "throughput_jobs_per_second": sum(part["jobs"] for part in two_parts) / parallel_wall,
                "per_worker": two_parts,
            },
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
