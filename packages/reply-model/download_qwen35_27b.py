#!/usr/bin/env python3
"""Explicit, revision-pinned local download for an offline 27B evaluation.

Preparation alone does nothing. Run with --execute only after the disk-space
decision; this script never deletes existing models or changes the active one.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


REPO = "mlx-community/Qwen3.5-27B-4bit"
REVISION = "45797d2985a12c55e6473686e9ea91b95e959553"
TARGET = Path.home() / ".inboxd/reply-model/models/Qwen3.5-27B-4bit"
MIN_FREE_AFTER_DOWNLOAD = 5 * 1024**3


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024**2), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="download after preflight")
    args = parser.parse_args()
    if not args.execute:
        print("Prepared only. Pass --execute after the disk-space decision.")
        return 0

    # The repository is public. Ignore any saved Hugging Face credential and
    # keep transfer metadata within the target instead of a second global cache.
    os.environ["HF_XET_CACHE"] = str(TARGET / ".cache" / "xet")
    from huggingface_hub import HfApi, snapshot_download

    info = HfApi().model_info(REPO, revision=REVISION,
                              files_metadata=True, token=False)
    if info.sha != REVISION:
        raise RuntimeError("model_revision_mismatch")
    files = [file for file in info.siblings if file.size is not None]
    names = {file.rfilename for file in files}
    required = {"config.json", "tokenizer.json", "tokenizer_config.json",
                "model.safetensors.index.json",
                *(f"model-{i:05d}-of-00003.safetensors" for i in range(1, 4))}
    if not required.issubset(names):
        raise RuntimeError("model_manifest_incomplete")
    pending = 0
    for file in files:
        if Path(file.rfilename).is_absolute() or ".." in Path(file.rfilename).parts:
            raise RuntimeError("invalid_model_filename")
        path = TARGET / file.rfilename
        if path.is_file() and path.stat().st_size == file.size:
            lfs = getattr(file, "lfs", None)
            if lfs is None or sha256(path) == lfs.sha256:
                continue
        pending += file.size
    free = shutil.disk_usage(TARGET.parent).free
    print(f"Pinned revision: {REVISION}")
    print(f"Remaining download: {pending:,} bytes; free: {free:,} bytes")
    if free < pending + MIN_FREE_AFTER_DOWNLOAD:
        raise RuntimeError("insufficient_disk_space_for_model_and_margin")

    TARGET.mkdir(parents=True, exist_ok=True)
    snapshot_download(repo_id=REPO, revision=REVISION, local_dir=TARGET,
                      token=False, max_workers=1)
    for file in files:
        path = TARGET / file.rfilename
        if not path.is_file() or path.stat().st_size != file.size:
            raise RuntimeError("download_file_size_mismatch")
        lfs = getattr(file, "lfs", None)
        if lfs is not None and sha256(path) != lfs.sha256:
            raise RuntimeError("download_weight_hash_mismatch")
    config = json.loads((TARGET / "config.json").read_text())
    json.loads((TARGET / "tokenizer.json").read_text())
    index = json.loads((TARGET / "model.safetensors.index.json").read_text())
    if config.get("model_type") != "qwen3_5" or not index.get("weight_map"):
        raise RuntimeError("model_structure_invalid")
    if not set(index["weight_map"].values()).issubset(names):
        raise RuntimeError("model_index_missing_weight")
    print(f"Verified local model: {TARGET}")
    print(f"Free after download: {shutil.disk_usage(TARGET).free:,} bytes")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        # Leave partial files for an intentional resume. Do not emit request
        # headers, environment variables, or authentication values.
        print(f"Download stopped: {type(exc).__name__}", file=sys.stderr)
        sys.exit(1)
