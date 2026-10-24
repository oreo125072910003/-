"""Validate native argument handling and storage isolation, without GUI startup."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", type=Path, required=True)
    args = parser.parse_args()
    exe = args.exe.resolve(strict=True)
    flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
    with tempfile.TemporaryDirectory(prefix="assistant-contract-args-") as temporary:
        folder = Path(temporary)
        explicit = folder / "product-contract-data"
        qa = folder / "qa-output"
        valid = subprocess.run([str(exe), "--data-dir", str(explicit), "--self-test", str(qa)], capture_output=True, creationflags=flags, timeout=15)
        assert valid.returncode == 0, valid.stderr.decode("utf-8", "replace")
        report = json.loads((qa / "desktop-test-results.json").read_text(encoding="utf-8-sig"))
        assert report["passed"] and Path(report["storageRoot"]) == explicit
        assert (explicit / "Library").is_dir() and not (qa / "data").exists()
        cases = [
            ["--data-dir"],
            ["--data-dir", "relative-data"],
            ["--data-dir", "C:drive-relative"],
            ["--data-dir", "\\root-relative"],
            ["--unknown"],
            ["--self-test"],
            ["--data-dir", str(explicit), "--data-dir", str(folder / "other")],
            ["--data-dir", str(explicit), "--self-test", str(qa), "--unknown"],
        ]
        for invalid in cases:
            result = subprocess.run([str(exe), *invalid], capture_output=True, creationflags=flags, timeout=5)
            assert result.returncode == 2, {"args": invalid, "code": result.returncode}
        assert not (folder / "other").exists()
    print(json.dumps({"passed": True, "mode": "native-exe-offline-no-gui", "checks": len(cases) + 1, "explicitDataDirectoryHonored": True, "unknownMissingRelativeArgumentsRejected": True, "guiStarted": False}))


if __name__ == "__main__":
    main()
