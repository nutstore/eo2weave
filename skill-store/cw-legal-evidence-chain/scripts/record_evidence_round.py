#!/usr/bin/env python3
"""Record one case round without changing the tested evidence-chain engine.

python record_evidence_round.py --before A-before.json --after evidence-chain.json \
    --round round-input.json --output-dir rounds/round_0001
Subsequent rounds also pass --previous-record rounds/round_0001/round-record.json.
"""
from __future__ import annotations

import argparse
import os
import shutil
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
from typing import Any

import validate_evidence_chain as core
from render_evidence_chain import cell, table

SECTIONS = core.LINKABLE_SECTIONS
ACTIONS = {"use", "pending", "exclude_duplicate", "exclude_irrelevant", "no_material", "correction", "reassessment"}
STATUSES = {"open", "answered", "blocked", "withdrawn"}
SPECIAL = {"$case_metadata", "$limits_and_assumptions", "$demand"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def text_field(item: dict, key: str, label: str) -> str:
    value = item.get(key)
    require(isinstance(value, str) and bool(value.strip()), f"{label}.{key}: non-empty string required")
    return value


def rows(item: dict, key: str, label: str) -> list[dict]:
    value = item.get(key)
    require(isinstance(value, list) and all(isinstance(x, dict) for x in value), f"{label}.{key}: object list required")
    seen = set()
    for row in value:
        row_id = text_field(row, "id", f"{label}.{key}")
        require(row_id not in seen, f"{label}.{key}: duplicate id {row_id}")
        seen.add(row_id)
    return value


def refs(item: dict, key: str, allowed: set[str], label: str) -> list[str]:
    value = item.get(key)
    require(isinstance(value, list) and all(isinstance(x, str) for x in value), f"{label}.{key}: string list required")
    require(len(value) == len(set(value)), f"{label}.{key}: duplicate references")
    require(set(value) <= allowed, f"{label}.{key}: unknown ids {sorted(set(value) - allowed)}")
    return value


def index(data: dict, section: str) -> dict[str, dict]:
    return {x["id"]: x for x in data[section]}


def differences(before: dict, after: dict) -> tuple[list[dict], dict]:
    changes, unchanged = [], {}
    for section in SECTIONS:
        old, new = index(before, section), index(after, section)
        unchanged[section] = []
        for obj_id in sorted(old.keys() | new.keys()):
            a, b = old.get(obj_id), new.get(obj_id)
            if a == b:
                unchanged[section].append(obj_id)
            else:
                changes.append({"section": section, "id": obj_id,
                                "kind": "added" if a is None else "retired" if b is None else "changed",
                                "before": a, "after": b})
    for section in ("case_metadata", "limits_and_assumptions"):
        if before[section] != after[section]:
            changes.append({"section": section, "id": "$" + section, "kind": "changed",
                            "before": before[section], "after": after[section]})
    return changes, unchanged


def validate_record(record: Any, before: dict, after: dict, changes: list[dict], previous: dict | None) -> None:
    require(isinstance(record, dict), "round input must be an object")
    require(record.get("schema_version") == "1.0", "round schema_version must be '1.0'")
    for key in ("case_id", "round_id", "created_at", "next_step_reason"):
        text_field(record, key, "round")
    require(bool(re.fullmatch(r"[a-zA-Z0-9_-]+", record["round_id"])), "round_id must be a safe identifier")
    stamp = datetime.fromisoformat(record["created_at"].replace("Z", "+00:00"))
    require(stamp.tzinfo is not None and stamp.utcoffset() is not None, "created_at requires timezone")
    require("previous_round_id" in record, "previous_round_id is required (null for first round)")
    if previous is None:
        require(record["previous_round_id"] is None, "previous_round_id requires --previous-record")
    else:
        require(previous.get("schema_version") == "1.0" and "review_queue" in previous, "previous file must be a generated round-record")
        require(previous["case_id"] == record["case_id"], "previous record belongs to another case")
        require(previous["round_id"] == record["previous_round_id"], "previous round ID mismatch")
        require(previous["round_id"] != record["round_id"], "round ID must advance")
    context = record.get("run_context")
    require(isinstance(context, dict), "run_context must be an object")
    for key in ("model", "run_ref"):
        text_field(context, key, "run_context")
    demand = record.get("demand")
    require(isinstance(demand, dict), "demand must be an object")
    for key in ("before", "after"):
        text_field(demand, key, "demand")
    require("change_reason" in demand, "demand.change_reason is required")
    if previous:
        require(demand["before"] == previous["demand"]["after"], "demand.before must match prior demand.after")
    demand_changed = demand["before"] != demand["after"]
    if demand_changed:
        text_field(demand, "change_reason", "demand")
    inputs = rows(record, "inputs", "round")
    decisions = rows(record, "decisions", "round")
    requests = rows(record, "requests", "round")
    feedback = rows(record, "feedback", "round")
    if demand_changed:
        reassessment_decisions = [row for row in decisions if row.get("action") == "reassessment"]
        require(
            any("$demand" in (row.get("object_ids") or []) for row in reassessment_decisions),
            "demand change requires a reassessment decision covering $demand",
        )
        for row in reassessment_decisions:
            if "$demand" in (row.get("object_ids") or []):
                require(
                    "source" in row.get("reason", "").lower() or "来源" in row.get("reason", ""),
                    f"{row['id']}: reassessment reason must identify the source of the changed demand",
                )
        changes.append({"section": "demand", "id": "$demand", "kind": "changed",
                        "before": demand["before"], "after": demand["after"]})
    require(bool(inputs or feedback) or demand["before"] != demand["after"] or any(x.get("action") == "reassessment" for x in decisions) or previous is None,
            "no new input, feedback, demand change or explicit reassessment; wait rather than loop unchanged")
    input_ids = {x["id"] for x in inputs}
    decision_ids = {x["id"] for x in decisions}
    request_ids = {x["id"] for x in requests}
    object_ids = set().union(*(set(index(before, s)) | set(index(after, s)) for s in SECTIONS))
    ev_ids = set(index(before, "evidence_items")) | set(index(after, "evidence_items"))
    require(len(input_ids | decision_ids | request_ids | {x["id"] for x in feedback}) == len(inputs) + len(decisions) + len(requests) + len(feedback), "round IDs must be unique across sections")
    require(not ((input_ids | decision_ids | request_ids | {x["id"] for x in feedback}) & object_ids), "round IDs must not collide with core IDs")
    if previous:
        for section in ("inputs", "decisions", "feedback"):
            require(not ({x["id"] for x in record[section]} & {x["id"] for x in previous[section]}), f"{section}: new event IDs must not reuse prior round IDs")
    for row in inputs:
        label = row["id"]
        require(row.get("kind") in {"text", "file", "unavailable"}, f"{label}: invalid input kind")
        for key in ("source_ref", "locator", "provider", "summary"):
            text_field(row, key, label)
        refs(row, "response_to_request_ids", request_ids, label)
    covered_inputs, covered_objects = set(), set()
    for row in decisions:
        label = row["id"]
        require(row.get("action") in ACTIONS, f"{label}: invalid action")
        related_inputs = refs(row, "input_ids", input_ids, label)
        require(bool(related_inputs) or row["action"] == "reassessment", f"{label}: input_ids required for intake decision")
        covered_inputs.update(related_inputs)
        covered_objects.update(refs(row, "object_ids", object_ids | SPECIAL, label))
        refs(row, "evidence_ids", ev_ids, label)
        for key in ("reason", "limits"):
            text_field(row, key, label)
        require(isinstance(row.get("important"), bool), f"{label}: important must be boolean")
        require("duplicate_of" in row, f"{label}: duplicate_of required (may be null)")
        if row["action"] == "exclude_duplicate":
            text_field(row, "duplicate_of", label)
        supersedes = row.get("supersedes")
        require(isinstance(supersedes, list) and all(isinstance(x, str) and re.fullmatch(r"[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+", x) for x in supersedes), f"{label}: supersedes requires round_id:decision_id references")
        if row["action"] == "correction":
            require(bool(supersedes), f"{label}: correction requires supersedes")
    require(covered_inputs == input_ids, f"inputs without disposition: {sorted(input_ids - covered_inputs)}")
    require({x["id"] for x in changes} <= covered_objects, f"changes without decision basis: {sorted({x['id'] for x in changes} - covered_objects)}")
    if previous:
        pending_requests = {x["id"] for x in previous["requests"] if x["status"] in {"open", "blocked"}}
        require(pending_requests <= request_ids, f"unresolved requests omitted: {sorted(pending_requests - request_ids)}")
    for row in requests:
        label = row["id"]
        for key in ("question", "requested_material", "proof_purpose"):
            text_field(row, key, label)
        require(row.get("priority") in {"high", "medium", "low"}, f"{label}: invalid priority")
        require(row.get("status") in STATUSES, f"{label}: invalid request status")
        responding_inputs = {
            input_id
            for input_row in inputs
            for input_id in input_row.get("response_to_request_ids") or []
            if input_id == label
        }
        require(
            row.get("status") != "answered" or bool(responding_inputs),
            f"{label}: request marked answered requires a recorded input in response_to_request_ids",
        )
        targets = set()
        for key, section in (("gap_ids", "evidence_gaps"), ("proof_object_ids", "proof_objects"), ("supplement_ids", "supplement_plan")):
            targets.update(refs(row, key, set(index(before, section)) | set(index(after, section)), label))
        require(bool(targets), f"{label}: a proof/gap/supplement target required")
        criteria = row.get("criterion_targets")
        require(isinstance(criteria, list) and all(isinstance(x, dict) for x in criteria), f"{label}: criterion_targets must be object list")
        gap_map = {**index(before, "evidence_gaps"), **index(after, "evidence_gaps")}
        for criterion in criteria:
            gap_id = criterion.get("gap_id")
            require(gap_id in row["gap_ids"], f"{label}: criterion gap must be a request gap")
            texts = {x.get("criterion") for x in gap_map[gap_id]["closure_criteria"]}
            require(criterion.get("criterion") in texts, f"{label}: unknown closure criterion")
        require(set(row["gap_ids"]) <= {x["gap_id"] for x in criteria}, f"{label}: each gap requires a criterion target")
        if row["status"] == "blocked":
            text_field(row, "blocked_reason", label)
        if row["status"] == "open":
            live_targets = {x for x in row["gap_ids"] if gap_map[x]["closure_status"] != "closed"}
            require(not row["gap_ids"] or bool(live_targets) or row["proof_object_ids"] or row["supplement_ids"], f"{label}: open request only targets closed gaps")
            current_targets = set().union(*(set(index(after, s)) for s in ("evidence_gaps", "proof_objects", "supplement_plan")))
            require(bool(targets & current_targets), f"{label}: open request only targets retired objects")
            for gap_id in live_targets:
                gap_criteria = gap_map[gap_id]["closure_criteria"]
                selected = {x["criterion"] for x in criteria if x["gap_id"] == gap_id}
                require(any(x.get("criterion") in selected and x["status"] != "met" for x in gap_criteria), f"{label}: open request requires an unresolved criterion for {gap_id}")
                for criterion in criteria:
                    if criterion["gap_id"] != gap_id:
                        continue
                    criterion_row = next((x for x in gap_criteria if x.get("criterion") == criterion.get("criterion")), None)
                    require(criterion_row is None or criterion_row.get("status") != "met", f"{label}: criterion target '{criterion.get('criterion')}' for {gap_id} is already met")
    previous_targets = ({x["target_id"] for x in previous["review_queue"]} | {x["id"] for x in previous["decisions"]}) if previous else set()
    reviewed = set()
    for row in feedback:
        label = row["id"]
        target = text_field(row, "target_id", label)
        require(target in object_ids | SPECIAL | decision_ids | previous_targets, f"{label}: unknown feedback target")
        require(target not in reviewed, f"{label}: conflicting duplicate feedback target")
        reviewed.add(target)
        require(row.get("verdict") in {"confirmed", "corrected", "disputed"}, f"{label}: invalid verdict")
        for key in ("reviewer", "source_ref", "reason"):
            text_field(row, key, label)


def review_queue(record: dict, changes: list[dict], previous: dict | None, before: dict, after: dict) -> list[dict]:
    queue = {}
    changed_ids = {x["id"] for x in changes}
    def add(target: str, reason: str) -> None:
        item = queue.setdefault(target, {"target_id": target, "reasons": [], "status": "pending"})
        if reason not in item["reasons"]:
            item["reasons"].append(reason)
    if previous:
        reassessed_decisions = {ref.split(":")[1] for d in record["decisions"] for ref in d["supersedes"] if ref.split(":")[0] == previous["round_id"]}
        reassessed_objects = {obj for d in record["decisions"] if d["action"] in {"correction", "reassessment"} for obj in d["object_ids"]}
        for item in previous["review_queue"]:
            if item["status"] != "confirmed":
                queue[item["target_id"]] = {**item, "reasons": list(item["reasons"])}
                if item["status"] in {"corrected", "disputed"} and item["target_id"] in changed_ids | reassessed_decisions | reassessed_objects:
                    queue[item["target_id"]]["status"] = "pending"
                    add(item["target_id"], "更正后已重新评估，等待律师复核本轮判断")
    for change in changes:
        old, new, section = change["before"] or {}, change["after"] or {}, change["section"]
        if change["kind"] == "retired":
            add(change["id"], "移除旧对象，请核对是否遗漏或需要保留")
        elif section in {"facts", "proof_objects"} and new.get("support_state") == "supported" and old.get("support_state") != "supported":
            add(change["id"], "本轮评估变为 supported")
        elif section in {"facts", "proof_objects"} and old.get("support_state") == "supported" and new.get("support_state") != "supported":
            add(change["id"], "原先 supported 判断被撤回")
        elif section == "evidence_gaps" and new.get("closure_status") == "closed" and old.get("closure_status") != "closed":
            add(change["id"], "本轮评估关闭缺口")
        elif section == "evidence_gaps" and old.get("closure_status") == "closed" and new.get("closure_status") != "closed":
            add(change["id"], "原先 closed 缺口被重新打开")
        elif section == "contradictions" and new.get("severity") == "high":
            add(change["id"], "新增或改变高严重度矛盾")
        elif section == "demand":
            add(change["id"], "当前诉讼需求改变")
    significant = {x["id"] for data in (before, after) for s in ("facts", "proof_objects", "evidence_gaps") for x in data[s]
                   if x.get("fact_type") == "key_fact" or x.get("importance") == "high" or x.get("severity") == "high"}
    for decision in record["decisions"]:
        if decision["important"]:
            add(decision["id"], "C标明重要决定：" + decision["action"])
        elif decision["action"] in {"exclude_irrelevant", "exclude_duplicate"} and significant & set(decision["object_ids"]):
            add(decision["id"], "排除信息涉及关键事实或高重要性对象")
    for feedback in record["feedback"]:
        target = feedback["target_id"]
        add(target, "收到实际律师反馈")
        queue[target]["status"] = feedback["verdict"]
        queue[target]["feedback_id"] = feedback["id"]
    return list(queue.values())


def state(value: Any) -> Any:
    if isinstance(value, dict):
        return value.get("support_state", value.get("closure_status", value.get("status", value.get("review_status", "—"))))
    return "—"


def field_changes(change: dict) -> dict:
    a, b = change["before"], change["after"]
    if isinstance(a, dict) and isinstance(b, dict):
        return {key: {"前": json.dumps(a[key], ensure_ascii=False) if key in a else "[字段不存在]",
                      "后": json.dumps(b[key], ensure_ascii=False) if key in b else "[字段不存在]"}
                for key in sorted(a.keys() | b.keys()) if key not in a or key not in b or a[key] != b[key]}
    return {"前": json.dumps(a, ensure_ascii=False), "后": json.dumps(b, ensure_ascii=False)}


def render(record: dict, after: dict) -> str:
    lines = [f"# 本轮更新摘要：{record['round_id']}", "", f"- 案件：{cell(record['case_id'])}",
             f"- 记录时间：{cell(record['created_at'])}；前轮：{cell(record['previous_round_id'])}",
             f"- 下一步状态：{record['workflow_status']}", f"- 原因：{cell(record['next_step_reason'])}",
             "- 本摘要呈现 C 的当前评估；律师确认情况见复核表。", "", "## 当前需求", "",
             f"- 更新前：{cell(record['demand']['before'])}", f"- 更新后：{cell(record['demand']['after'])}",
             f"- 变更依据：{cell(record['demand']['change_reason'])}", "", "## B 的输入与 C 的处理", ""]
    input_map = {x["id"]: x for x in record["inputs"]}
    lines += table(["决定", "原始输入/定位", "去向", "涉及对象/证据", "理由", "核验局限/旧决定"], [
        [x["id"], [{"输入": i, "来源": input_map[i]["source_ref"], "定位": input_map[i]["locator"], "摘要": input_map[i]["summary"]} for i in x["input_ids"]],
         x["action"], list(dict.fromkeys(x["object_ids"] + x["evidence_ids"])), x["reason"], {"局限": x["limits"], "重复来源": x["duplicate_of"], "更正旧决定": x["supersedes"]}]
        for x in record["decisions"]])
    lines += ["", "## A 的实际变化", ""]
    lines += table(["对象", "变化", "前状态", "后状态", "字段差异", "决策依据"], [
        [x["id"], x["kind"], state(x["before"]), state(x["after"]), field_changes(x),
         [{"决定": d["id"], "理由": d["reason"], "证据": d["evidence_ids"]} for d in record["decisions"] if x["id"] in d["object_ids"]]]
        for x in record["changes"]])
    lines += ["", f"- 未变 ID：{cell(record['unchanged_ids'])}", "", "## 涉及缺口的条件与剩余要素", ""]
    affected = {i for d in record["decisions"] for i in d["object_ids"]} | {x["id"] for x in record["changes"]}
    lines += table(["缺口", "当前状态", "逐项关闭条件", "关闭证据", "剩余要素", "说明"], [
        [x["id"], x["closure_status"], x["closure_criteria"], x.get("closure_evidence_ids", []), x.get("remaining_elements", []), x.get("closure_reason")]
        for x in after["evidence_gaps"] if x["id"] in affected or x["id"] in {i for q in record["requests"] for i in q["gap_ids"]}])
    lines += ["", "## 律师复核与实际反馈", ""]
    lines += table(["对象/决定", "复核原因", "状态", "反馈记录"], [[x["target_id"], x["reasons"], x["status"], x.get("feedback_id")] for x in record["review_queue"]])
    lines += [""]
    lines += table(["反馈", "目标", "结论", "律师", "原始意见定位", "理由"], [[x["id"], x["target_id"], x["verdict"], x["reviewer"], x["source_ref"], x["reason"]] for x in record["feedback"]])
    lines += ["", "## 下一轮问题与取得障碍", ""]
    lines += table(["请求", "状态/优先级", "向 B 提问", "需要材料", "证明目的/条件", "关联对象", "障碍"], [
        [x["id"], [x["status"], x["priority"]], x["question"], x["requested_material"], {"目的": x["proof_purpose"], "条件": x["criterion_targets"]}, x["gap_ids"] + x["proof_object_ids"] + x["supplement_ids"], x.get("blocked_reason")]
        for x in record["requests"]])
    lines += ["", "## 实际校验与可追溯信息", ""]
    for label, result in record["validation"].items():
        lines += [f"- {label}：passed；错误 {len(result['errors'])}；警告 {len(result['warnings'])}"]
        if result["warnings"]:
            lines.append(f"  - 警告：{cell(result['warnings'])}")
    lines += [f"- 快照 SHA-256：{cell(record['snapshot_hashes'])}", "- 原有 strict validator 与轮次结构检查均已实际执行；通过不代表真实性核验或律师采信。",
              "- no_actionable_request 仅表示当前没有可执行的新请求，不代表缺口全部关闭。"]
    return "\n".join(lines) + "\n"


def read(path: Path) -> tuple[bytes, Any]:
    raw = path.read_bytes()
    return raw, json.loads(raw.decode("utf-8-sig"))


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def record_round(before_path: Path, after_path: Path, input_path: Path, output_dir: Path, previous_path: Path | None = None) -> dict:
    require(not output_dir.exists(), "output directory already exists; historical rounds cannot be overwritten")
    sibling_rounds = output_dir.parent.glob("*/round-record.json") if output_dir.parent.exists() else []
    existing_round_ids = set()
    for marker in sibling_rounds:
        try:
            existing_round_ids.add(json.loads(marker.read_text(encoding="utf-8-sig")).get("round_id"))
        except (OSError, ValueError):
            continue
    old_raw, before = read(before_path)
    new_raw, after = read(after_path)
    _, record = read(input_path)
    round_id = record.get("round_id")
    require(isinstance(round_id, str) and round_id not in existing_round_ids,
            f"round_id {round_id!r} already exists in another round directory under {output_dir.parent}; competing rounds rejected")
    previous = read(previous_path)[1] if previous_path else None
    validation = {}
    for label, data, baseline in (("core_before_strict", before, None), ("core_after_strict", after, before)):
        errors, warnings, infos = core.validate(data, strict=True, baseline=baseline)
        require(not errors, label + " failed: " + "; ".join(errors))
        validation[label] = {"errors": errors, "warnings": warnings, "infos": infos}
    if previous:
        require(previous.get("snapshot_hashes", {}).get("after") == digest(old_raw), "A-before does not match previous A-after snapshot")
    changes, unchanged = differences(before, after)
    validate_record(record, before, after, changes, previous)
    queue = review_queue(record, changes, previous, before, after)
    if any(x["status"] in {"corrected", "disputed"} for x in queue):
        status = "needs_reassessment"
    elif any(x["status"] == "pending" for x in queue):
        status = "awaiting_lawyer"
    elif any(x["status"] == "open" for x in record["requests"]):
        status = "awaiting_client"
    elif any(x["status"] == "blocked" for x in record["requests"]):
        status = "blocked_collection"
    else:
        status = "no_actionable_request"
    root = Path(__file__).resolve().parent.parent
    validation["round_record_checks"] = {"errors": [], "warnings": [], "infos": []}
    result = {**record, "snapshot_hashes": {"before": digest(old_raw), "after": digest(new_raw)},
              "skill_hashes": {str(p.relative_to(root)).replace("\\", "/"): digest(p.read_bytes()) for p in sorted(root.rglob("*")) if p.is_file() and p.suffix in {".md", ".py"}},
              "validation": validation, "changes": changes, "unchanged_ids": unchanged,
              "review_queue": queue, "workflow_status": status}
    if previous_path:
        result["previous_record"] = {"source_ref": str(previous_path.resolve()), "sha256": digest(previous_path.read_bytes())}
    report = render(result, after)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = output_dir.with_name(output_dir.name + ".tmp-partial")
    if staging.exists():
        stale_entries = list(staging.iterdir())
        # Only staging files written by this script are safe to discard on retry;
        # anything else means someone else is using that path, so refuse to touch it.
        staging_owned = all(
            p.name in {"A-before.json", "A-after.json", "round-record.json", "round-update.md"}
            for p in stale_entries
        )
        require(staging_owned, f"staging directory {staging} contains unrecognized files; remove it before retrying")
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        (staging / "A-before.json").write_bytes(old_raw)
        (staging / "A-after.json").write_bytes(new_raw)
        (staging / "round-record.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (staging / "round-update.md").write_text(report, encoding="utf-8")
        os.replace(staging, output_dir)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--round", dest="round_input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--previous-record", type=Path)
    args = parser.parse_args()
    try:
        result = record_round(args.before, args.after, args.round_input, args.output_dir, args.previous_record)
    except Exception as exc:
        print(f"ERROR: round recording blocked: {exc}")
        return 1
    print(f"Recorded {result['round_id']}: {len(result['changes'])} changes, next={result['workflow_status']}")
    print(f"Summary: {args.output_dir / 'round-update.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
