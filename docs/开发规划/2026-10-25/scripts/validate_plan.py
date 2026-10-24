"""Check task dependencies, estimate totals, audit coverage and local document links."""
from __future__ import annotations

import json
from pathlib import Path
import re
from urllib.parse import unquote

PLAN = Path(__file__).resolve().parents[1]


def main() -> None:
    registry = json.loads((PLAN / "tasks.json").read_text(encoding="utf-8-sig"))
    tasks = registry["tasks"]
    by_id = {task["id"]: task for task in tasks}
    assert len(by_id) == len(tasks) == 40
    visiting, visited = set(), set()

    def visit(task_id):
        assert task_id not in visiting, f"Cyclic dependency: {task_id}"
        if task_id in visited:
            return
        visiting.add(task_id)
        task = by_id[task_id]
        for dependency in task["depends_on"]:
            assert dependency in by_id, f"Unknown dependency: {dependency}"
            assert by_id[dependency]["phase"] <= task["phase"], f"Later-phase dependency: {task_id}"
            visit(dependency)
        visiting.remove(task_id)
        visited.add(task_id)

    for task in tasks:
        visit(task["id"])
        assert task["implementation"] and task["deliverables"] and task["acceptance"]
        assert task["status"] == "planned"
        estimate = task["estimate_person_days"]
        assert 0 < estimate["min"] <= estimate["max"]

    core = [task for task in tasks if task["phase"] != "M7"]
    for edge in ("min", "max"):
        assert sum(task["estimate_person_days"][edge] for task in core) == registry["core_estimate_person_days"][edge]
    coverage = {ref for task in tasks for ref in task["review_refs"]}
    assert coverage == {f"CR{number:02d}" for number in range(1, 11)}
    book = (PLAN / "04_开发任务书.md").read_text(encoding="utf-8-sig")
    for task in tasks:
        assert f"### {task['id']} {task['title']}" in book
        for text in task["implementation"] + task["acceptance"]:
            assert text in book, f"Taskbook differs: {task['id']}"
        assert "；".join(task["deliverables"]) in book
    links = 0
    for file in PLAN.glob("*.md"):
        body = file.read_text(encoding="utf-8-sig")
        assert "\ufffd" not in body
        assert body.count("```") % 2 == 0, f"Unclosed code block: {file.name}"
        for match in re.finditer(r"\[[^\]]+\]\(([^)]+)\)", body):
            target = match.group(1)
            if target.startswith(("https://", "http://", "#")):
                continue
            filename = unquote(target.split("#", 1)[0])
            assert (file.parent / filename).is_file(), f"Missing link {file.name}: {filename}"
            links += 1
    evidence = json.loads((PLAN / "evidence/baseline.json").read_text(encoding="utf-8-sig"))
    assert evidence["commit"] == registry["baseline_commit"]
    assert all(item["reproduced"] for item in evidence["reproductions"].values())
    review = (PLAN / "03_现有代码审查报告.md").read_text(encoding="utf-8-sig")
    for kind in ("js_syntax", "python_ast"):
        assert str(evidence[kind]["passed"]) in review
    result = {"ok": True, "task_count": len(tasks), "core_task_count": len(core),
              "optional_task_count": len(tasks) - len(core), "dependency_graph": "acyclic",
              "review_findings_covered": len(coverage), "local_links_checked": links,
              "core_estimate_person_days": registry["core_estimate_person_days"]}
    (PLAN / "evidence/plan-validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
