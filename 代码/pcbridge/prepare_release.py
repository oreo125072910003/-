"""Prepare a reviewable pcbridge release and rollback snapshot; never deploy.

No credentials/configuration are copied, and no processes or scheduled tasks
are changed. The final coordinated deployment must check before hashes again.
"""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil


def digest(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def candidate_contract(candidate: Path) -> dict:
    """Read declared constants without importing or running server/config code."""
    tree = ast.parse(candidate.read_text(encoding="utf-8"))
    values = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            continue
        name = node.targets[0].id
        if name not in {"SERVER_VERSION", "BUSINESS_QUERY_TOOLS", "DISABLED_CONTROL_TOOLS", "DISABLED_AUXILIARY_TOOLS"}:
            continue
        expression = node.value
        if isinstance(expression, ast.Call) and isinstance(expression.func, ast.Name) and expression.func.id == "frozenset":
            expression = expression.args[0]
        values[name] = ast.literal_eval(expression)
    return {
        "version": values["SERVER_VERSION"], "toolCount": len(values["BUSINESS_QUERY_TOOLS"]),
        "businessTools": sorted(values["BUSINESS_QUERY_TOOLS"]),
        "disabledTools": sorted(values["DISABLED_CONTROL_TOOLS"] | values["DISABLED_AUXILIARY_TOOLS"]),
        "deliveryPolicy": "legacy-control-disabled-v1",
        "controlPolicy": "no-trusted-session-control-transport-v1",
    }


def prepare(runtime_directory: Path, output: Path, *, source_directory: Path | None = None) -> dict:
    source = (source_directory or Path(__file__).resolve().parent).resolve(strict=True)
    runtime = runtime_directory.resolve(strict=True)
    target = runtime / "mcp_dsh_server.py"
    candidate = source / target.name
    if not target.is_file() or target.is_symlink() or not candidate.is_file() or candidate.is_symlink():
        raise ValueError("REGULAR_SOURCE_AND_RUNTIME_REQUIRED")
    contract = candidate_contract(candidate)
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
        "candidateContract": contract,
        "files": [{"name": target.name, "beforeSha256": before, "candidateSha256": after}],
        "untouched": ["config.json", "state/", "shared/", "logs", "watchdog", "Harness", "WeChat", "scheduled tasks"],
        "deploymentGate": [
            "coordinate the pcbridge-only maintenance window; check active jobs and the real Python PID/path",
            "verify the live source still has beforeSha256; keep its credentials and user data unchanged",
            "replace only the named server after coordinated supervision/process handling",
            "verify health version/pid/sourceSha256 and actual MCP initialize, seven business schemas and control-disabled policies",
            "verify raw MCP controls remain isError with permissive configuration and forged scope/account/executionPolicy; do not run real control probes",
            "verify business query results and confined artifacts; arbitrary file read/write, shell, agent, export/image sending and generic CLI remain denied",
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
