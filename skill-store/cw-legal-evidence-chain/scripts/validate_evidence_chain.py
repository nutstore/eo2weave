#!/usr/bin/env python3
"""Validate CreatorWeave legal evidence-chain JSON.

The checks are proposition- and relationship-based. They do not contain rules
for named case types, parties, expenses, payments, refunds, or other benchmark
scenarios.

Usage:
  python validate_evidence_chain.py evidence-chain.json
  python validate_evidence_chain.py --strict evidence-chain.json
  python validate_evidence_chain.py --strict --baseline old.json new.json

Non-strict mode accepts legacy schema omissions but still rejects structural
errors and unsafe semantic combinations. Strict mode enforces schema 1.1 gates.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable


REQUIRED_TOP_LEVEL = [
    "case_metadata",
    "material_scope",
    "issues",
    "proof_objects",
    "facts",
    "evidence_items",
    "relations",
    "contradictions",
    "evidence_gaps",
    "supplement_plan",
    "timeline",
    "limits_and_assumptions",
]

VALID_SUPPORT_STATES = {
    "supported",
    "partially_supported",
    "unsupported",
    "contradicted",
    "unclear",
}
VALID_CLOSURE_STATES = {"remains_open", "partially_closed", "closed"}
VALID_CRITERION_STATES = {"met", "partially_met", "unmet", "unclear"}
VALID_INFERENCE_LEVELS = {"direct", "reasonable_inference", "speculative"}
VALID_STRENGTHS = {"strong", "medium", "weak", "unclear"}
VALID_SUPPLEMENT_STATES = {"open", "in_progress", "completed", "not_applicable"}
VALID_PROOF_SCOPES = {
    "statement_occurrence",
    "content_truth",
    "underlying_event",
    "authenticity",
    "identity",
    "amount",
    "time",
    "continuing_state",
    "other",
}
VALID_RELATION_TYPES = {
    "temporal_before",
    "temporal_after",
    "causal",
    "logical_support",
    "condition",
    "purpose_motive",
    "performance_breach",
    "funds_flow",
    "goods_flow",
    "information_flow",
    "authority_agency",
    "corroborates",
    "contradicts",
    "weakens",
    "gap",
}
SECTION_TYPE_NAMES = {
    "facts": "fact",
    "proof_objects": "proof_object",
    "evidence_items": "evidence_item",
    "issues": "issue",
    "contradictions": "contradiction",
    "supplement_plan": "supplement",
}
NEGATIVE_CONTINUING_MARKERS = (
    "从未",
    "一直",
    "至今",
    "未曾",
    "始终",
    "不再",
    "均未",
    "再未",
    "never",
    "always",
    "continuing",
    "continues to",
    "remains",
    "to this day",
    "up to now",
)
LINKABLE_SECTIONS = (
    "material_scope",
    "issues",
    "proof_objects",
    "facts",
    "evidence_items",
    "relations",
    "contradictions",
    "evidence_gaps",
    "supplement_plan",
    "timeline",
)


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as stream:
        return json.load(stream)


def require_list(data: dict[str, Any], key: str, errors: list[str]) -> list[Any]:
    value = data.get(key)
    if not isinstance(value, list):
        errors.append(f"{key}: expected list")
        return []
    return value


def collect_ids(items: list[Any], section: str, errors: list[str]) -> set[str]:
    ids: set[str] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            errors.append(f"{section}[{index}]: expected object")
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            errors.append(f"{section}[{index}]: missing non-empty id")
            continue
        if item_id in ids:
            errors.append(f"{section}: duplicate id {item_id}")
        ids.add(item_id)
    return ids


def check_refs(
    item: dict[str, Any],
    field: str,
    valid_ids: set[str],
    label: str,
    errors: list[str],
) -> list[str]:
    refs = item.get(field, [])
    if refs is None:
        return []
    if not isinstance(refs, list):
        errors.append(f"{label}.{field}: expected list")
        return []
    clean_refs: list[str] = []
    for ref in refs:
        if not isinstance(ref, str):
            errors.append(f"{label}.{field}: expected string id, got {ref!r}")
        elif ref not in valid_ids:
            errors.append(f"{label}.{field}: unknown id {ref!r}")
        else:
            clean_refs.append(ref)
    return clean_refs


def strict_issue(
    message: str,
    strict: bool,
    errors: list[str],
    warnings: list[str],
) -> None:
    (errors if strict else warnings).append(message)


def by_id(items: Iterable[Any]) -> dict[str, dict[str, Any]]:
    return {
        item["id"]: item
        for item in items
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }


def nonempty_list(value: Any) -> bool:
    return isinstance(value, list) and bool(value)


def validate(
    data: Any,
    *,
    strict: bool = False,
    baseline: Any | None = None,
) -> tuple[list[str], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    infos: list[str] = []

    if not isinstance(data, dict):
        return ["top-level JSON must be an object"], warnings, infos

    for key in REQUIRED_TOP_LEVEL:
        if key not in data:
            errors.append(f"missing top-level key: {key}")

    sections = {key: require_list(data, key, errors) for key in REQUIRED_TOP_LEVEL if key != "case_metadata"}
    metadata = data.get("case_metadata")
    if not isinstance(metadata, dict):
        errors.append("case_metadata: expected object")
        metadata = {}
    if strict and metadata.get("schema_version") != "1.1":
        errors.append("case_metadata.schema_version: strict output must be '1.1'")

    section_ids = {
        key: collect_ids(sections.get(key, []), key, errors)
        for key in LINKABLE_SECTIONS
    }
    all_ids: set[str] = set()
    for section, ids in section_ids.items():
        duplicate_across = all_ids & ids
        for item_id in sorted(duplicate_across):
            errors.append(f"id {item_id!r} is reused across sections (including {section})")
        all_ids.update(ids)

    facts = sections.get("facts", [])
    evidence_items = sections.get("evidence_items", [])
    proof_objects = sections.get("proof_objects", [])
    issues = sections.get("issues", [])
    relations = sections.get("relations", [])
    contradictions = sections.get("contradictions", [])
    gaps = sections.get("evidence_gaps", [])
    supplements = sections.get("supplement_plan", [])
    timeline = sections.get("timeline", [])
    materials = sections.get("material_scope", [])

    if not facts:
        warnings.append("facts is empty")
    if not evidence_items:
        warnings.append("evidence_items is empty")
    if not proof_objects:
        warnings.append("proof_objects is empty")
    if not relations:
        warnings.append("relations is empty; evidence-chain output may be only an event list")

    id_section = {item_id: section for section, ids in section_ids.items() for item_id in ids}
    fact_ids = section_ids["facts"]
    ev_ids = section_ids["evidence_items"]
    po_ids = section_ids["proof_objects"]
    issue_ids = section_ids["issues"]
    gap_ids = section_ids["evidence_gaps"]
    supp_ids = section_ids["supplement_plan"]

    unreadable_severity = {"unreadable": 2, "unavailable": 1}
    material_derived_from: dict[str, set[str]] = {}
    material_status_by_path: dict[str, Any] = {}
    for item in materials:
        if not isinstance(item, dict) or not isinstance(item.get("source_path"), str):
            continue
        path = item["source_path"]
        status = item.get("review_status")
        current = material_status_by_path.get(path)
        if current is None or unreadable_severity.get(status, 0) > unreadable_severity.get(current, 0):
            material_status_by_path[path] = status
    evidence_map = by_id(evidence_items)

    for item in materials:
        if not isinstance(item, dict):
            continue
        label = item.get("id", "mat<?>")
        material_derived_from[str(label)] = set(
            check_refs(
                item,
                "derived_from_material_ids",
                section_ids["material_scope"],
                label,
                errors,
            )
        )

    for item in facts:
        if not isinstance(item, dict):
            continue
        label = item.get("id", "fact<?>")
        state = item.get("support_state")
        if state not in VALID_SUPPORT_STATES:
            errors.append(f"{label}.support_state: invalid or missing value {state!r}")
        supporting = check_refs(item, "supporting_evidence_ids", ev_ids, label, errors)
        check_refs(item, "opposing_evidence_ids", ev_ids, label, errors)
        check_refs(item, "related_proof_object_ids", po_ids, label, errors)

        if state == "supported" and not supporting:
            errors.append(f"{label}: supported fact requires supporting_evidence_ids")
        if state == "supported" and item.get("unsupported_elements"):
            errors.append(f"{label}: supported fact cannot retain unsupported_elements")

        if state == "supported" and supporting and item.get("fact_type") != "statement":
            scopes = [
                set(evidence_map.get(evidence_id, {}).get("proof_scope") or [])
                for evidence_id in supporting
            ]
            if scopes and all(scope and scope <= {"statement_occurrence"} for scope in scopes):
                errors.append(
                    f"{label}: fact cannot be supported only by evidence scoped to statement_occurrence"
                )

        fact_type = item.get("fact_type")
        statement_text = item.get("statement")
        negative_continuing = fact_type == "negative_state" or (
            isinstance(statement_text, str)
            and any(marker in statement_text.lower() for marker in NEGATIVE_CONTINUING_MARKERS)
        )
        if negative_continuing:
            if fact_type != "negative_state":
                strict_issue(
                    f"{label}: negative/continuing proposition must use fact_type 'negative_state'",
                    strict,
                    errors,
                    warnings,
                )
            time_scope = item.get("time_scope")
            has_cutoff = isinstance(time_scope, dict) and bool(
                time_scope.get("as_of") or time_scope.get("end")
            )
            if not has_cutoff:
                strict_issue(
                    f"{label}: negative_state requires time_scope.as_of or time_scope.end",
                    strict,
                    errors,
                    warnings,
                )
            if not isinstance(item.get("support_scope"), str) or not item.get("support_scope", "").strip():
                strict_issue(
                    f"{label}: negative_state requires non-empty support_scope",
                    strict,
                    errors,
                    warnings,
                )

        unavailable_sources = [
            evidence_id
            for evidence_id in supporting
            if material_status_by_path.get(evidence_map.get(evidence_id, {}).get("source_path"))
            in {"unreadable", "unavailable"}
        ]
        if unavailable_sources:
            message = (
                f"{label}: cites evidence from unreadable/unavailable material {unavailable_sources}; "
                "verify that only material existence, not content, is being proved"
            )
            if state == "supported" and len(unavailable_sources) == len(supporting):
                strict_issue(
                    message + "; a supported fact cannot rest solely on unreadable/unavailable sources",
                    strict,
                    errors,
                    warnings,
                )
            else:
                warnings.append(message)

    missing_proof_scope: list[str] = []
    evidence_derived_materials: dict[str, set[str]] = {}
    for item in evidence_items:
        if not isinstance(item, dict):
            continue
        label = item.get("id", "ev<?>")
        check_refs(item, "related_fact_ids", fact_ids, label, errors)
        check_refs(item, "related_proof_object_ids", po_ids, label, errors)
        proof_scope = item.get("proof_scope")
        if strict and (not isinstance(proof_scope, list) or not proof_scope):
            missing_proof_scope.append(str(label))
        if isinstance(proof_scope, list):
            invalid_scopes = sorted(
                {str(scope) for scope in proof_scope if not isinstance(scope, str) or scope not in VALID_PROOF_SCOPES}
            )
            if invalid_scopes:
                strict_issue(
                    f"{label}.proof_scope: invalid value(s) {invalid_scopes}; allowed: {sorted(VALID_PROOF_SCOPES)}",
                    strict,
                    errors,
                    warnings,
                )
        if strict:
            for provenance_field in ("source_path", "locator"):
                provenance_value = item.get(provenance_field)
                if not isinstance(provenance_value, str) or not provenance_value.strip():
                    errors.append(
                        f"{label}.{provenance_field}: strict output requires a non-empty value "
                        "(use 'unknown' plus a limitation note when genuinely unavailable)"
                    )
        derived_material_refs = check_refs(
            item,
            "derived_from_material_ids",
            section_ids["material_scope"],
            label,
            errors,
        )
        evidence_derived_materials[label] = set(derived_material_refs)
    if missing_proof_scope:
        errors.append(
            "evidence_items.proof_scope: strict output requires non-empty proof scope for "
            + ", ".join(missing_proof_scope)
        )

    facts_by_po: dict[str, list[dict[str, Any]]] = {po_id: [] for po_id in po_ids}
    for fact in facts:
        if not isinstance(fact, dict):
            continue
        for po_id in fact.get("related_proof_object_ids") or []:
            if po_id in facts_by_po:
                facts_by_po[po_id].append(fact)

    for item in proof_objects:
        if not isinstance(item, dict):
            continue
        label = item.get("id", "po<?>")
        state = item.get("support_state")
        if state not in VALID_SUPPORT_STATES:
            errors.append(f"{label}.support_state: invalid or missing value {state!r}")
        check_refs(item, "related_issue_ids", issue_ids, label, errors)
        related_facts = facts_by_po.get(label, [])
        if state == "supported":
            if not related_facts:
                strict_issue(
                    f"{label}: supported proof object has no related facts",
                    strict,
                    errors,
                    warnings,
                )
            else:
                weak_fact_ids = [
                    str(fact.get("id", "fact<?>"))
                    for fact in related_facts
                    if fact.get("support_state")
                    in {"partially_supported", "unsupported", "contradicted", "unclear"}
                ]
                facts_with_open_elements = [
                    str(fact.get("id", "fact<?>"))
                    for fact in related_facts
                    if nonempty_list(fact.get("unsupported_elements"))
                ]
                if weak_fact_ids:
                    strict_issue(
                        f"{label}: supported proof object has related facts that are not fully supported: "
                        + ", ".join(weak_fact_ids),
                        strict,
                        errors,
                        warnings,
                    )
                if facts_with_open_elements:
                    strict_issue(
                        f"{label}: supported proof object has related facts with unsupported_elements: "
                        + ", ".join(facts_with_open_elements),
                        strict,
                        errors,
                        warnings,
                    )

    for item in issues:
        if not isinstance(item, dict):
            continue
        label = item.get("id", "issue<?>")
        check_refs(item, "related_proof_object_ids", po_ids, label, errors)

    relation_ids = section_ids["relations"]
    valid_relation_endpoints = all_ids - relation_ids - section_ids["material_scope"] - section_ids["timeline"]
    for item in relations:
        if not isinstance(item, dict):
            continue
        label = item.get("id", "rel<?>")
        for field in ("from_id", "to_id"):
            ref = item.get(field)
            if ref not in valid_relation_endpoints:
                errors.append(f"{label}.{field}: unknown or invalid endpoint id {ref!r}")
        check_refs(item, "supporting_evidence_ids", ev_ids, label, errors)

        relation_type = item.get("relation_type")
        if relation_type not in VALID_RELATION_TYPES:
            strict_issue(
                f"{label}.relation_type: unknown value {relation_type!r}; allowed: {sorted(VALID_RELATION_TYPES)}",
                strict,
                errors,
                warnings,
            )
        for type_field, ref_field in (("from_type", "from_id"), ("to_type", "to_id")):
            declared_type = item.get(type_field)
            endpoint_section = id_section.get(item.get(ref_field))
            expected_type = SECTION_TYPE_NAMES.get(endpoint_section)
            if expected_type is None:
                continue
            if declared_type not in {expected_type, endpoint_section}:
                strict_issue(
                    f"{label}.{type_field}: endpoint {item.get(ref_field)!r} is a {endpoint_section} entry; "
                    f"expected {expected_type!r}, got {declared_type!r}",
                    strict,
                    errors,
                    warnings,
                )

        inference = item.get("inference_level")
        strength = item.get("strength")
        if inference not in VALID_INFERENCE_LEVELS:
            errors.append(f"{label}.inference_level: invalid or missing value {inference!r}")
        if strength not in VALID_STRENGTHS:
            errors.append(f"{label}.strength: invalid or missing value {strength!r}")
        if inference == "speculative" and strength == "strong":
            errors.append(f"{label}: speculative relation cannot be strong")
        if inference == "reasonable_inference" and strength == "strong":
            alternatives = item.get("alternative_explanations")
            if not isinstance(alternatives, list) or not alternatives:
                strict_issue(
                    f"{label}: strong reasonable inference requires addressed alternative_explanations",
                    strict,
                    errors,
                    warnings,
                )
        if item.get("relation_type") == "causal":
            alternatives = item.get("alternative_explanations")
            if not isinstance(alternatives, list):
                warnings.append(f"{label}: causal relation should record alternative_explanations")

        if relation_type == "corroborates":
            path_to_material = {
                m.get("source_path"): m.get("id") for m in materials if isinstance(m, dict)
            }
            endpoint_evidence = [
                str(item.get(field))
                for field in ("from_id", "to_id")
                if id_section.get(item.get(field)) == "evidence_items"
            ]
            if len(endpoint_evidence) == 2:
                derived_a = evidence_derived_materials.get(endpoint_evidence[0], set())
                derived_b = evidence_derived_materials.get(endpoint_evidence[1], set())
                source_material_a = path_to_material.get(by_id(evidence_items).get(endpoint_evidence[0], {}).get("source_path"))
                source_material_b = path_to_material.get(by_id(evidence_items).get(endpoint_evidence[1], {}).get("source_path"))
                roots_a = set(derived_a) | ({source_material_a} if source_material_a else set())
                roots_b = set(derived_b) | ({source_material_b} if source_material_b else set())
                dependent = bool(roots_a & roots_b)
                for mat_id in derived_a:
                    chain_origin = mat_id
                    seen: set[str] = set()
                    while chain_origin and chain_origin not in seen:
                        seen.add(chain_origin)
                        if chain_origin in roots_b:
                            dependent = True
                            break
                        chain_origin = next(iter(material_derived_from.get(chain_origin, set())), None)
                if dependent:
                    strict_issue(
                        f"{label}: corroboration endpoints {endpoint_evidence} derive from the same source "
                        "material chain; derived copies are not independent corroboration",
                        strict,
                        errors,
                        warnings,
                    )

    for item in contradictions:
        if not isinstance(item, dict):
            continue
        label = item.get("id", "con<?>")
        fact_refs = check_refs(item, "conflicting_fact_ids", fact_ids, label, errors)
        evidence_refs = check_refs(item, "conflicting_evidence_ids", ev_ids, label, errors)
        if len(set(fact_refs + evidence_refs)) < 2:
            strict_issue(
                f"{label}: contradiction requires at least two identified conflicting sources/propositions",
                strict,
                errors,
                warnings,
            )

    gap_map = by_id(gaps)
    for item in gaps:
        if not isinstance(item, dict):
            continue
        label = item.get("id", "gap<?>")
        check_refs(item, "affected_fact_ids", fact_ids, label, errors)
        check_refs(item, "affected_proof_object_ids", po_ids, label, errors)
        check_refs(item, "recommended_action_ids", supp_ids, label, errors)
        check_refs(item, "closure_evidence_ids", ev_ids, label, errors)

        closure_state = item.get("closure_status")
        criteria = item.get("closure_criteria")
        remaining = item.get("remaining_elements")
        closure_evidence = item.get("closure_evidence_ids")
        if closure_state not in VALID_CLOSURE_STATES:
            strict_issue(
                f"{label}.closure_status: missing or invalid value {closure_state!r}",
                strict,
                errors,
                warnings,
            )
            continue
        if not isinstance(criteria, list) or not criteria:
            strict_issue(
                f"{label}.closure_criteria: must be a non-empty list",
                strict,
                errors,
                warnings,
            )
            criteria = []

        criterion_states: list[str] = []
        criterion_evidence: list[list[str]] = []
        for index, criterion in enumerate(criteria):
            criterion_label = f"{label}.closure_criteria[{index}]"
            if not isinstance(criterion, dict):
                errors.append(f"{criterion_label}: expected object")
                continue
            criterion_state = criterion.get("status")
            if criterion_state not in VALID_CRITERION_STATES:
                errors.append(f"{criterion_label}.status: invalid or missing value {criterion_state!r}")
            else:
                criterion_states.append(criterion_state)
            criterion_evidence.append(check_refs(criterion, "evidence_ids", ev_ids, criterion_label, errors))

        if closure_state == "closed":
            if criteria and any(state != "met" for state in criterion_states):
                errors.append(f"{label}: closed gap has a non-met closure criterion")
            if not isinstance(closure_evidence, list) or not closure_evidence:
                errors.append(f"{label}: closed gap requires closure_evidence_ids")
            if isinstance(remaining, list) and remaining:
                errors.append(f"{label}: closed gap cannot retain remaining_elements")
            unevidenced = [
                f"closure_criteria[{index}]"
                for index, evidence_refs in enumerate(criterion_evidence)
                if not evidence_refs
            ]
            if unevidenced:
                strict_issue(
                    f"{label}: closed gap has closure criteria without evidence_ids: " + ", ".join(unevidenced),
                    strict,
                    errors,
                    warnings,
                )
            criteria_evidence_union: set[str] = set()
            for evidence_refs in criterion_evidence:
                criteria_evidence_union.update(evidence_refs)
            if (
                isinstance(closure_evidence, list)
                and closure_evidence
                and criteria_evidence_union
                and not set(closure_evidence) & criteria_evidence_union
            ):
                errors.append(
                    f"{label}: closure_evidence_ids do not support any closure criterion evidence"
                )
        elif closure_state == "partially_closed":
            if criteria and all(state == "met" for state in criterion_states):
                errors.append(f"{label}: partially_closed gap must retain a non-met criterion")
            if not isinstance(remaining, list) or not remaining:
                errors.append(f"{label}: partially_closed gap requires remaining_elements")

    for item in supplements:
        if not isinstance(item, dict):
            continue
        label = item.get("id", "supp<?>")
        target_gap = item.get("target_gap_id")
        if target_gap is not None and target_gap not in gap_ids:
            errors.append(f"{label}.target_gap_id: unknown id {target_gap!r}")
        status = item.get("status")
        if status not in VALID_SUPPLEMENT_STATES:
            strict_issue(
                f"{label}.status: missing or invalid value {status!r}",
                strict,
                errors,
                warnings,
            )
        required = item.get("required_for_closure")
        if strict and not isinstance(required, bool):
            errors.append(f"{label}.required_for_closure: strict output requires boolean")
        if (
            target_gap in gap_map
            and gap_map[target_gap].get("closure_status") == "closed"
            and required is True
            and status not in {"completed", "not_applicable"}
        ):
            errors.append(f"{label}: required action remains {status!r} although target gap is closed")

    for item in timeline:
        if not isinstance(item, dict):
            continue
        label = item.get("id", "time<?>")
        check_refs(item, "fact_ids", fact_ids, label, errors)
        check_refs(item, "evidence_ids", ev_ids, label, errors)

    if baseline is not None:
        validate_incremental(data, baseline, errors, warnings, infos)

    return errors, warnings, infos


def validate_incremental(
    current: dict[str, Any],
    baseline: Any,
    errors: list[str],
    warnings: list[str],
    infos: list[str],
) -> None:
    if not isinstance(baseline, dict):
        errors.append("baseline top-level JSON must be an object")
        return

    current_ev_ids = set(by_id(current.get("evidence_items", [])).keys())
    baseline_ev_ids = set(by_id(baseline.get("evidence_items", [])).keys())
    new_ev_ids = current_ev_ids - baseline_ev_ids

    for section in LINKABLE_SECTIONS:
        current_map = by_id(current.get(section, []))
        baseline_map = by_id(baseline.get(section, []))
        added = set(current_map) - set(baseline_map)
        removed = set(baseline_map) - set(current_map)
        changed = {
            item_id
            for item_id in set(current_map) & set(baseline_map)
            if current_map[item_id] != baseline_map[item_id]
        }
        if added or changed or removed:
            infos.append(
                f"incremental {section}: added={sorted(added)}, changed={sorted(changed)}, removed={sorted(removed)}"
            )
        if removed:
            warnings.append(
                f"incremental {section}: baseline IDs removed {sorted(removed)}; retain or explicitly explain retirement"
            )

    current_gaps = by_id(current.get("evidence_gaps", []))
    baseline_gaps = by_id(baseline.get("evidence_gaps", []))
    for gap_id in set(current_gaps) & set(baseline_gaps):
        old_state = baseline_gaps[gap_id].get("closure_status")
        new_state = current_gaps[gap_id].get("closure_status")
        if old_state == new_state:
            continue
        if new_state == "closed":
            closure_evidence = set(current_gaps[gap_id].get("closure_evidence_ids") or [])
            if not closure_evidence:
                errors.append(f"{gap_id}: gap closed without closure_evidence_ids")
            elif not (closure_evidence & new_ev_ids):
                warnings.append(
                    f"{gap_id}: gap closed without newly added evidence; confirm this is an explicit reassessment"
                )
        elif old_state == "closed":
            reopened = current_gaps[gap_id]
            reopened_remaining = reopened.get("remaining_elements")
            reopened_criteria = reopened.get("closure_criteria") or []
            non_met_states = [
                criterion.get("status")
                for criterion in reopened_criteria
                if isinstance(criterion, dict)
                and criterion.get("status") in VALID_CRITERION_STATES
                and criterion.get("status") != "met"
            ]
            if not (isinstance(reopened_remaining, list) and reopened_remaining) and not non_met_states:
                errors.append(
                    f"{gap_id}: gap reopened from closed without remaining_elements or a non-met closure criterion"
                )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("json_file", type=Path, help="evidence-chain JSON to validate")
    parser.add_argument("--strict", action="store_true", help="enforce schema 1.1 semantic gates")
    parser.add_argument("--baseline", type=Path, help="baseline JSON for incremental checks")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        data = load_json(args.json_file)
        baseline = load_json(args.baseline) if args.baseline else None
    except Exception as exc:  # noqa: BLE001 - user-facing CLI
        print(f"ERROR: failed to read JSON: {exc}")
        return 1

    errors, warnings, infos = validate(data, strict=args.strict, baseline=baseline)
    for info in infos:
        print(f"INFO: {info}")
    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}")

    if errors:
        print(
            f"Validation failed: {len(errors)} error(s), "
            f"{len(warnings)} warning(s), {len(infos)} info message(s)"
        )
        return 1
    print(
        f"Validation passed: 0 error(s), {len(warnings)} warning(s), "
        f"{len(infos)} info message(s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
