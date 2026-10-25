"""Prepare a reviewable pcbridge release and rollback snapshot; never deploy.

No credentials/configuration are copied, and no processes or scheduled tasks
are changed. The final coordinated deployment must check before hashes again.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil


def digest(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def prepare(runtime_directory: Path, output: Path, *, source_directory: Path | None = None) -> dict:
    source = (source_directory or Path(__file__).resolve().parent).resolve(strict=True)
    runtime = runtime_directory.resolve(strict=True)
    target = runtime / "mcp_dsh_server.py"
    candidate = source / target.name
    if not target.is_file() or target.is_symlink() or not candidate.is_file() or candidate.is_symlink():
        raise ValueError("REGULAR_SOURCE_AND_RUNTIME_REQUIRED")
    output = output.resolve()
    # The prepared package must never overwrite the source or live runtime.
    if output == source or source in output.parents or output == runtime or runtime in output.parents:
        raise ValueError("SEPARATE_RELEASE_DIRECTORY_REQUIRED")
    output.mkdir(parents=True, exist_ok=False)
    staged = output / "candidate"
    backup = output / "rollback"
    staged.mkdir(); backup.mkdir()
    before = digest(target)
    after = digest(candidate)
    shutil.copyfile(candidate, staged / target.name)
    shutil.copyfile(target, backup / target.name)
    if digest(target) != before or digest(staged / target.name) != after or digest(backup / target.name) != before:
        raise ValueError("CONCURRENT_SOURCE_CHANGE")
    manifest = {
        "format": 1, "preparedAt": datetime.now(timezone.utc).isoformat(),
        "state": "prepared_not_deployed", "targetDirectory": str(runtime),
        "files": [{"name": target.name, "beforeSha256": before, "candidateSha256": after}],
        "untouched": ["config.json", "state/", "shared/", "logs", "watchdog", "Harness", "WeChat", "scheduled tasks"],
        "deploymentGate": [
            "coordinate the pcbridge-only maintenance window; check active jobs and the real Python PID/path",
            "verify the live source still has beforeSha256; keep its credentials and user data unchanged",
            "replace only the named server after coordinated supervision/process handling",
            "verify health version/pid/sourceSha256 and actual MCP initialize, schemas, bounded read and missing-file error",
            "verify Harness registration and scoped tool execution; do not equate catalog presence with availability",
            "record runtime manifest and rollback evidence; no automatic replay of old jobs or unconfirmed deliveries",
        ],
        "rollbackGate": "coordinate first; restore only the named rollback file after checking for newer changes; never replace config/state or reset Harness",
    }
    (output / "release.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = prepare(args.runtime_directory, args.output)
    print(json.dumps({"state": manifest["state"], "files": manifest["files"]}))


if __name__ == "__main__":
    main()
