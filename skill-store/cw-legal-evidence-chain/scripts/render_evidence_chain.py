#!/usr/bin/env python3
"""Render a lawyer-facing Markdown report from validated evidence-chain JSON.

The renderer deliberately copies IDs and status fields from JSON instead of
re-deciding legal or evidentiary questions. Narrative refinement may be added
after rendering, but core states must remain identical to JSON.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from collections import Counter
from pathlib import Path
from typing import Any


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as stream:
        data = json.load(stream)
    if not isinstance(data, dict):
        raise ValueError("top-level JSON must be an object")
    return data


def load_validator(script_dir: Path) -> Any:
    path = script_dir / "validate_evidence_chain.py"
    spec = importlib.util.spec_from_file_location("evidence_chain_validator", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load validator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cell(value: Any) -> str:
    if value is None or value == "":
        return "—"
    if isinstance(value, list):
        value = "、".join(cell(item) for item in value) if value else "—"
    elif isinstance(value, dict):
        value = "；".join(f"{key}: {cell(item)}" for key, item in value.items() if item not in (None, "", []))
    text = str(value).replace("\r", " ").replace("\n", "<br>").replace("|", "\\|")
    return text or "—"


def ids(value: Any) -> str:
    return cell(value if isinstance(value, list) else [])


def table(headers: list[str], rows: list[list[Any]]) -> list[str]:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    if rows:
        lines.extend("| " + " | ".join(cell(value) for value in row) + " |" for row in rows)
    else:
        lines.append("| " + " | ".join("—" for _ in headers) + " |")
    return lines


def time_scope(fact: dict[str, Any]) -> str:
    scope = fact.get("time_scope")
    if not isinstance(scope, dict) or not any(scope.values()):
        return cell(fact.get("time"))
    return cell({key: scope.get(key) for key in ("start", "end", "as_of") if scope.get(key)})


def criteria_summary(gap: dict[str, Any], target_state: str) -> str:
    criteria = gap.get("closure_criteria") or []
    selected = []
    for criterion in criteria:
        if not isinstance(criterion, dict) or criterion.get("status") != target_state:
            continue
        selected.append(f"{criterion.get('criterion', '未命名条件')} [{ids(criterion.get('evidence_ids'))}]")
    return cell(selected)


def render(data: dict[str, Any], errors: list[str], warnings: list[str], strict: bool = False) -> str:
    materials = data.get("material_scope") or []
    issues = data.get("issues") or []
    proof_objects = data.get("proof_objects") or []
    facts = data.get("facts") or []
    evidence = data.get("evidence_items") or []
    relations = data.get("relations") or []
    contradictions = data.get("contradictions") or []
    gaps = data.get("evidence_gaps") or []
    supplements = data.get("supplement_plan") or []
    timeline = data.get("timeline") or []

    fact_map = {item.get("id"): item for item in facts if isinstance(item, dict)}
    ev_map = {item.get("id"): item for item in evidence if isinstance(item, dict)}
    support_counts = Counter(item.get("support_state", "unknown") for item in facts if isinstance(item, dict))
    gap_counts = Counter(item.get("closure_status", "legacy_unknown") for item in gaps if isinstance(item, dict))

    lines: list[str] = ["# 证据链分析报告", "", "## 一、材料审阅范围", ""]
    lines += table(
        ["序号", "材料", "类型", "审阅状态", "备注/派生来源"],
        [
            [item.get("id"), item.get("source_path"), item.get("material_type"), item.get("review_status"), item.get("notes") or ids(item.get("derived_from_material_ids"))]
            for item in materials if isinstance(item, dict)
        ],
    )

    lines += ["", "## 二、初步结论摘要", "", f"- 事实支持状态统计：{cell(dict(support_counts))}", f"- 缺口关闭状态统计：{cell(dict(gap_counts))}", "- 本报告由结构化 JSON 渲染；具体结论须结合下表证据范围、未支持要素与风险阅读。"]
    if not strict:
        lines.append("- ⚠️ 本报告未经严格校验（未执行 --strict 严格校验模式），仅通过兼容性检查；JSON 校验摘要不可标注为“通过/_passed_”。")

    lines += ["", "## 三、争议焦点与证明对象", ""]
    issue_titles = {item.get("id"): item.get("title") for item in issues if isinstance(item, dict)}
    lines += table(
        ["编号", "争议焦点/证明对象", "重要性", "当前支持状态", "关联争点", "关联事实"],
        [
            [item.get("id"), item.get("name"), item.get("importance"), item.get("support_state"), [issue_titles.get(ref, ref) for ref in item.get("related_issue_ids") or []], [fact.get("id") for fact in facts if isinstance(fact, dict) and item.get("id") in (fact.get("related_proof_object_ids") or [])]]
            for item in proof_objects if isinstance(item, dict)
        ],
    )

    lines += ["", "## 四、关键事实梳理", ""]
    lines += table(
        ["事实编号", "事实陈述", "时间/截止点", "主体", "来源基础", "支持状态", "支持证据", "支持范围/未支持要素", "风险提示"],
        [
            [item.get("id"), item.get("statement"), time_scope(item), item.get("actors"), item.get("source_basis"), item.get("support_state"), item.get("supporting_evidence_ids"), {"支持范围": item.get("support_scope"), "未支持": item.get("unsupported_elements")}, item.get("notes")]
            for item in facts if isinstance(item, dict)
        ],
    )

    lines += ["", "## 五、证据目录", ""]
    lines += table(
        ["证据编号", "证据名称", "来源/定位", "类型", "形成时间", "真实性状态", "证明目的/范围", "证明力", "风险"],
        [
            [item.get("id"), item.get("title"), f"{cell(item.get('source_path'))} / {cell(item.get('locator'))}", item.get("evidence_type"), item.get("formation_time"), item.get("authenticity_status"), {"目的": item.get("proof_purpose"), "范围": item.get("proof_scope")}, item.get("probative_strength"), {"真实性状态": item.get("authenticity_status"), "风险提示": item.get("risk_notes")}]
            for item in evidence if isinstance(item, dict)
        ],
    )

    lines += ["", "## 六、证据链总览", ""]
    chain_rows = []
    for po in proof_objects:
        if not isinstance(po, dict):
            continue
        related_facts = [fact for fact in facts if isinstance(fact, dict) and po.get("id") in (fact.get("related_proof_object_ids") or [])]
        chain_rows.append([
            po.get("id"),
            [fact.get("id") for fact in related_facts],
            sorted({ev_id for fact in related_facts for ev_id in (fact.get("supporting_evidence_ids") or [])}),
            [rel.get("id") for rel in relations if isinstance(rel, dict) and (rel.get("from_id") in {fact.get("id") for fact in related_facts} or rel.get("to_id") in {fact.get("id") for fact in related_facts})],
            po.get("support_state"),
            [gap.get("id") for gap in gaps if isinstance(gap, dict) and po.get("id") in (gap.get("affected_proof_object_ids") or [])],
        ])
    lines += table(["证明对象", "关键事实", "支持证据", "关联关系", "链条状态", "主要缺口"], chain_rows)

    lines += ["", "## 七、事实关系与链条说明", ""]
    relation_rows = [
        [item.get("id"), f"{cell(item.get('from_id'))} → {cell(item.get('to_id'))}", item.get("relation_type"), item.get("description"), item.get("strength"), item.get("inference_level"), item.get("risk") or item.get("alternative_explanations")]
        for item in relations if isinstance(item, dict)
    ]
    lines += table(["编号", "方向", "类型", "说明", "强度", "推断层级", "风险/替代解释"], relation_rows)

    lines += ["", "## 八、证据缺口、矛盾及薄弱环节", ""]
    gap_rows = [
        [item.get("id"), item.get("gap_type"), (item.get("affected_fact_ids") or []) + (item.get("affected_proof_object_ids") or []), item.get("description"), item.get("severity"), item.get("closure_status"), criteria_summary(item, "met"), item.get("remaining_elements"), item.get("closure_reason")]
        for item in gaps if isinstance(item, dict)
    ]
    lines += table(["编号", "类型", "涉及事实/证明对象", "问题描述", "风险等级", "关闭状态", "已满足条件", "剩余要素", "处理/关闭说明"], gap_rows)
    if contradictions:
        lines += ["", "### 矛盾记录", ""]
        lines += table(
            ["编号", "不相容命题/证据", "说明", "等级", "影响", "处理建议"],
            [[item.get("id"), (item.get("conflicting_fact_ids") or []) + (item.get("conflicting_evidence_ids") or []), item.get("description"), item.get("severity"), item.get("impact"), item.get("resolution_suggestion")] for item in contradictions if isinstance(item, dict)],
        )

    lines += ["", "## 九、待补充证据清单", ""]
    lines += table(
        ["编号", "优先级", "待补证据", "证明目的", "可能来源", "获取/固定方式", "对应缺口", "状态"],
        [[item.get("id"), item.get("priority"), item.get("evidence_to_collect"), item.get("proof_purpose"), item.get("possible_source"), item.get("collection_method"), item.get("target_gap_id"), item.get("status")] for item in supplements if isinstance(item, dict)],
    )

    lines += ["", "## 十、时间线", ""]
    lines += table(
        ["编号", "时间", "事件", "事实", "证据", "说明"],
        [[item.get("id"), item.get("time"), item.get("event"), item.get("fact_ids"), item.get("evidence_ids"), item.get("relation_notes")] for item in timeline if isinstance(item, dict)],
    )

    verdict = "failed" if errors else ("passed（严格校验）" if strict else "passed（仅兼容性检查，未经严格校验）")
    mode_label = "strict（严格校验）" if strict else "compatibility only（仅兼容性检查，未经严格校验）"
    lines += ["", "## 十一、结构化校验摘要", "", f"- JSON 校验：{verdict}", f"- 校验模式：{mode_label}", f"- 错误数：{len(errors)}", f"- 警告数：{len(warnings)}"]
    if errors:
        lines.append(f"- 未解决错误：{cell(errors)}")
    if warnings:
        lines.append(f"- 校验警告：{cell(warnings)}")

    lines += ["", "## 十二、限制与假设", ""]
    limits = data.get("limits_and_assumptions") or []
    lines.extend(f"- {cell(item)}" for item in limits)
    lines.append("- 本报告聚焦证据链整理与补证辅助，不替代承办律师的最终法律判断。")
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("json_file", type=Path)
    parser.add_argument("output_file", type=Path)
    parser.add_argument("--strict", action="store_true", help="require strict validation before rendering")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        data = load_json(args.json_file)
        validator = load_validator(Path(__file__).resolve().parent)
        errors, warnings, _ = validator.validate(data, strict=args.strict)
    except Exception as exc:  # noqa: BLE001 - user-facing CLI
        print(f"ERROR: {exc}")
        return 1

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        print("Rendering blocked because JSON validation failed")
        return 1

    report = render(data, errors, warnings, strict=args.strict)
    args.output_file.parent.mkdir(parents=True, exist_ok=True)
    temp_output = args.output_file.with_name(args.output_file.name + ".tmp-partial")
    try:
        temp_output.write_text(report, encoding="utf-8")
        temp_output.replace(args.output_file)
    except BaseException:
        temp_output.unlink(missing_ok=True)
        raise
    print(f"Rendered {args.output_file} with {len(warnings)} warning(s) ({'strict' if args.strict else 'compatibility-only'} validation)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
