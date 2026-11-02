"""Self-tests for cw-legal-evidence-chain scripts (PR #115 Sourcery fixes).

Run: python3 scripts/test_evidence_chain.py
Each case asserts the CLI exit code / API behavior for a legal or illegal input.
Covers backward compatibility: a valid legacy-style chain must still pass.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
VALIDATOR_PATH = SCRIPTS / "validate_evidence_chain.py"
RENDER_PATH = SCRIPTS / "render_evidence_chain.py"
RECORD_PATH = SCRIPTS / "record_evidence_round.py"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = _load("validate_evidence_chain", VALIDATOR_PATH)


def run_cli(script: Path, *args: str) -> int:
    return subprocess.run(
        [sys.executable, str(script), *args], capture_output=True, text=True
    ).returncode


def valid_chain() -> dict:
    """A minimal but fully legal schema-1.1 chain (backward-compat fixture)."""
    return {
        "case_metadata": {"schema_version": "1.1", "case_name": "t", "case_type": "t",
                          "parties": [], "review_date": "2026-10-29", "reviewer_role": "lawyer-assistant"},
        "material_scope": [
            {"id": "mat_001", "source_path": "m/contract.pdf", "material_type": "contract",
             "review_status": "reviewed", "notes": "", "derived_from_material_ids": []},
            {"id": "mat_002", "source_path": "m/receipt.pdf", "material_type": "invoice",
             "review_status": "reviewed", "notes": "", "derived_from_material_ids": []},
        ],
        "issues": [{"id": "issue_001", "title": "t", "description": "t", "side": "claimant",
                    "related_proof_object_ids": ["po_001"], "status": "disputed"}],
        "proof_objects": [{"id": "po_001", "name": "po", "description": "d", "importance": "high",
                           "related_issue_ids": ["issue_001"], "support_state": "supported"}],
        "facts": [{"id": "fact_001", "statement": "甲方于2024年3月1日向乙方发送合同扫描件。",
                   "fact_type": "key_fact", "time": "2024-03-01",
                   "time_scope": {"start": None, "end": None, "as_of": "2024-03-01"},
                   "actors": ["甲方"], "amount": None, "location": None, "source_basis": "direct_evidence",
                   "support_state": "supported", "supporting_evidence_ids": ["ev_001"],
                   "opposing_evidence_ids": [], "support_scope": "甲方、发送行为",
                   "unsupported_elements": [], "related_proof_object_ids": ["po_001"],
                   "confidence": "high", "notes": ""}],
        "evidence_items": [
            {"id": "ev_001", "title": "合同扫描件", "source_path": "m/contract.pdf", "locator": "第1页",
             "evidence_type": "document", "formation_time": "2024-03-01", "provider_or_source": "甲方",
             "content_summary": "s", "proof_purpose": "p",
             "proof_scope": ["content_truth", "underlying_event"], "authenticity_status": "copy",
             "relevance": "high", "probative_strength": "medium", "risk_notes": "复印件",
             "related_fact_ids": ["fact_001"], "related_proof_object_ids": ["po_001"]},
            {"id": "ev_002", "title": "接收回执", "source_path": "m/receipt.pdf", "locator": "第1页",
             "evidence_type": "transaction_record", "formation_time": "2024-03-02",
             "provider_or_source": "乙方", "content_summary": "s", "proof_purpose": "p",
             "proof_scope": ["content_truth"], "authenticity_status": "original",
             "relevance": "high", "probative_strength": "strong", "risk_notes": "",
             "related_fact_ids": [], "related_proof_object_ids": []},
        ],
        "relations": [{"id": "rel_001", "from_id": "fact_001", "to_id": "po_001",
                       "from_type": "fact", "to_type": "proof_object", "relation_type": "logical_support",
                       "description": "d", "supporting_evidence_ids": ["ev_001"], "strength": "medium",
                       "risk": "r", "inference_level": "reasonable_inference",
                       "alternative_explanations": ["alt1"]}],
        "contradictions": [],
        "evidence_gaps": [{"id": "gap_001", "gap_type": "missing_evidence", "description": "d",
                           "affected_fact_ids": ["fact_001"], "affected_proof_object_ids": ["po_001"],
                           "severity": "medium", "litigation_risk": "r", "closure_status": "closed",
                           "closure_criteria": [{"criterion": "有接收记录", "status": "met",
                                                 "evidence_ids": ["ev_002"]}],
                           "closure_evidence_ids": ["ev_002"], "remaining_elements": [],
                           "closure_reason": "已取得接收回执", "recommended_action_ids": []}],
        "supplement_plan": [],
        "timeline": [],
        "limits_and_assumptions": ["limit"],
    }


def base_valid_strict_passes() -> None:
    errors, _, _ = validator.validate(valid_chain(), strict=True)
    assert not errors, f"legal fixture must pass strict: {errors}"


def legacy_chain_non_strict_passes() -> None:
    """Legacy omission style must remain accepted by compatibility mode."""
    data = valid_chain()
    for item in data["evidence_items"]:
        item.pop("proof_scope", None)
        item.pop("authenticity_status", None)
    data["case_metadata"]["schema_version"] = "1.0"
    data["relations"][0]["relation_type"] = "not_in_taxonomy"
    data["relations"][0]["from_type"] = "wrong"
    errors, _, _ = validator.validate(data, strict=False)
    assert not errors, f"legacy chain must pass non-strict: {errors}"


def _mutate(**kwargs):
    data = valid_chain()
    for path, value in kwargs.items():
        section, field = path.split(".", 1)
        target = data[section]
        if isinstance(target, list):
            target = target[0]
        if value is _DELETE:
            target.pop(field, None)
        else:
            target[field] = value
    return data


_DELETE = object()


def case_statement_only_support() -> None:
    data = valid_chain()
    data["evidence_items"][0]["proof_scope"] = ["statement_occurrence"]
    errors, _, _ = validator.validate(data, strict=True)
    assert any("statement_occurrence" in e for e in errors), "statement-only support must fail strict"


def case_unreadable_evidence() -> None:
    data = valid_chain()
    data["material_scope"][0]["review_status"] = "unreadable"
    errors, _, _ = validator.validate(data, strict=True)
    assert any("unreadable" in e for e in errors), "supported fact on unreadable source must fail strict"
    # evidence that only proves existence stays allowed -> fact downgraded, no unreadable error
    data["facts"][0]["support_state"] = "unclear"
    data["proof_objects"][0]["support_state"] = "unclear"
    errors, warnings, _ = validator.validate(data, strict=True)
    assert not errors, f"non-content reliance stays a warning, got errors: {errors}"
    assert any("unreadable" in w for w in warnings), "unreadable warning must remain"


def case_duplicate_material_paths_preserve_unreadable() -> None:
    data = valid_chain()
    data["material_scope"].append(
        {"id": "mat_003", "source_path": "m/contract.pdf", "material_type": "contract",
         "review_status": "reviewed", "notes": "re-listed", "derived_from_material_ids": []}
    )
    data["material_scope"][0]["review_status"] = "unreadable"
    errors, _, _ = validator.validate(data, strict=True)
    assert any("unreadable" in e for e in errors), "duplicate path must not overwrite unreadable status"


def case_invalid_proof_scope() -> None:
    data = valid_chain()
    data["evidence_items"][0]["proof_scope"] = ["made_up_scope"]
    errors, _, _ = validator.validate(data, strict=True)
    assert any("proof_scope" in e for e in errors), "invalid proof_scope value must fail strict"


def case_missing_source_locator() -> None:
    data = valid_chain()
    data["evidence_items"][0].pop("locator")
    data["evidence_items"][0].pop("source_path")
    errors, _, _ = validator.validate(data, strict=True)
    assert any("source_path" in e for e in errors) and any("locator" in e for e in errors), \
        "missing provenance must fail strict"


def case_unknown_relation_type() -> None:
    data = valid_chain()
    data["relations"][0]["relation_type"] = "quantum_entanglement"
    errors, _, _ = validator.validate(data, strict=True)
    assert any("relation_type" in e for e in errors), "unknown relation_type must fail strict"


def case_endpoint_type_mismatch() -> None:
    data = valid_chain()
    data["relations"][0]["to_type"] = "fact"  # po_001 is a proof object
    errors, _, _ = validator.validate(data, strict=True)
    assert any("to_type" in e for e in errors), "endpoint type mismatch must fail strict"


def case_supported_po_without_facts() -> None:
    data = valid_chain()
    data["facts"][0]["related_proof_object_ids"] = []
    errors, warnings, _ = validator.validate(data, strict=True)
    assert any("no related facts" in e for e in errors), "supported PO without facts must fail strict"
    errors_n, _, _ = validator.validate(data, strict=False)
    assert not errors_n, "non-strict keeps warning-only behavior"


def case_negative_claim_wrong_type() -> None:
    data = valid_chain()
    data["facts"].append({
        "id": "fact_002", "statement": "乙方从未支付任何款项。", "fact_type": "key_fact",
        "time": None, "time_scope": {"start": None, "end": None, "as_of": None},
        "actors": ["乙方"], "amount": None, "location": None, "source_basis": "party_statement",
        "support_state": "unsupported", "supporting_evidence_ids": [], "opposing_evidence_ids": [],
        "support_scope": None, "unsupported_elements": [], "related_proof_object_ids": [],
        "confidence": "low", "notes": ""})
    errors, _, _ = validator.validate(data, strict=True)
    assert any("fact_002" in e and "negative_state" in e for e in errors), \
        "negative proposition mis-typed as key_fact must fail strict"


def case_derived_corroboration() -> None:
    data = valid_chain()
    data["material_scope"][1]["derived_from_material_ids"] = ["mat_001"]  # receipt derived from contract scan
    data["evidence_items"][1]["derived_from_material_ids"] = ["mat_001"]
    data["evidence_items"][1]["related_fact_ids"] = ["fact_001"]
    data["relations"].append({
        "id": "rel_002", "from_id": "ev_001", "to_id": "ev_002", "from_type": "evidence_item",
        "to_type": "evidence_item", "relation_type": "corroborates", "description": "derived copy",
        "supporting_evidence_ids": [], "strength": "strong", "risk": "",
        "inference_level": "direct", "alternative_explanations": []})
    errors, _, _ = validator.validate(data, strict=True)
    assert any("rel_002" in e and "not independent corroboration" in e for e in errors), \
        "derived evidence corroborating its own source must fail strict"


def case_closed_gap_without_criterion_evidence() -> None:
    data = valid_chain()
    data["evidence_gaps"][0]["closure_criteria"][0]["evidence_ids"] = []
    errors, _, _ = validator.validate(data, strict=True)
    assert any("closure criteria without evidence_ids" in e for e in errors), \
        "met criterion without evidence must fail strict"
    errors, _, _ = validator.validate(data, strict=False)
    assert not errors, "non-strict keeps warning-only behavior for criterion evidence"


def case_closed_gap_unrelated_closure_evidence() -> None:
    data = valid_chain()
    data["evidence_gaps"][0]["closure_evidence_ids"] = ["ev_001"]  # unrelated to criterion ev_002
    errors, _, _ = validator.validate(data, strict=True)
    assert any("closure_evidence_ids do not support" in e for e in errors), \
        "closure evidence unrelated to criteria must fail strict"


def case_reopened_gap_validates() -> None:
    """Reopen must NOT demand closure evidence (regression for finding #12)."""
    base = valid_chain()
    current = json.loads(json.dumps(base))
    current["evidence_gaps"][0]["closure_status"] = "remains_open"
    current["evidence_gaps"][0]["remaining_elements"] = ["接收记录原件待核"]
    current["evidence_gaps"][0]["closure_evidence_ids"] = []
    errors, _, _ = validator.validate(current, strict=True, baseline=base)
    assert not errors, f"correctly reopened gap must pass strict incremental: {errors}"


def case_incremental_close_without_evidence_fails() -> None:
    base = valid_chain()
    current = json.loads(json.dumps(base))
    current["evidence_gaps"].append({
        "id": "gap_002", "gap_type": "missing_evidence", "description": "d",
        "affected_fact_ids": [], "affected_proof_object_ids": [], "severity": "low",
        "litigation_risk": "r", "closure_status": "closed",
        "closure_criteria": [{"criterion": "c", "status": "met", "evidence_ids": ["ev_002"]}],
        "closure_evidence_ids": ["ev_002"], "remaining_elements": [], "closure_reason": "r",
        "recommended_action_ids": []})
    base["evidence_gaps"].append({
        "id": "gap_002", "gap_type": "missing_evidence", "description": "d",
        "affected_fact_ids": [], "affected_proof_object_ids": [], "severity": "low",
        "litigation_risk": "r", "closure_status": "remains_open",
        "closure_criteria": [{"criterion": "c", "status": "unmet", "evidence_ids": []}],
        "closure_evidence_ids": [], "remaining_elements": ["x"], "closure_reason": "r",
        "recommended_action_ids": []})
    errors, _, _ = validator.validate(current, strict=True, baseline=base)
    assert not [e for e in errors if "gap_002" in e], "closing with evidence must stay legal"


# ---------------- renderer ----------------

def case_renderer_labels() -> None:
    data = valid_chain()
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "chain.json"
        src.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        out = Path(tmp) / "report.md"
        assert run_cli(RENDER_PATH, str(src), str(out)) == 0, "renderer must succeed without --strict"
        text = out.read_text(encoding="utf-8")
        assert "未经严格校验" in text and "compatibility only" in text, \
            "non-strict report must carry the not-strictly-validated banner"
        assert "真实性状态" in text and "copy" in text, \
            "authenticity_status must appear in the evidence directory"
        assert run_cli(RENDER_PATH, "--strict", str(src), str(out)) == 0
        strict_text = out.read_text(encoding="utf-8")
        assert "passed（严格校验）" in strict_text and "未经严格校验" not in strict_text.split("## 十一")[0], \
            "strict report keeps the plain banner out of the summary section"


# ---------------- round recorder ----------------

def round_fixtures(tmp: Path) -> dict[str, Path]:
    chain = valid_chain()
    before = tmp / "A-before.json"
    after = tmp / "A-after.json"
    before.write_text(json.dumps(chain, ensure_ascii=False), encoding="utf-8")
    after.write_text(json.dumps(chain, ensure_ascii=False), encoding="utf-8")
    return {"before": before, "after": after}


def round_input(request_status: str = "open", criterion_status: str = "unmet") -> dict:
    return {
        "schema_version": "1.0", "case_id": "case_001", "round_id": "round_0001",
        "previous_round_id": None, "created_at": "2026-10-29T12:00:00+08:00",
        "run_context": {"model": "unknown", "run_ref": "test"},
        "demand": {"before": "确认合同是否成立并追究违约责任", "after": "确认合同是否成立并追究违约责任",
                   "change_reason": None},
        "inputs": [{"id": "input_001", "kind": "text", "source_ref": "会话:1", "locator": "第1段",
                    "provider": "当事人B", "summary": "s",
                    "response_to_request_ids": []}],
        "decisions": [{"id": "dec_001", "input_ids": ["input_001"], "action": "no_material",
                       "object_ids": ["gap_001"], "evidence_ids": [], "reason": "未提供新材料",
                       "limits": "l", "important": False, "duplicate_of": None, "supersedes": []}],
        "requests": [{"id": "req_001", "question": "q?", "requested_material": "m",
                      "proof_purpose": "p", "gap_ids": ["gap_001"], "proof_object_ids": [],
                      "supplement_ids": [],
                      "criterion_targets": [{"gap_id": "gap_001", "criterion": "有接收记录"}],
                      "priority": "high", "status": request_status}],
        "feedback": [],
        "next_step_reason": "等待补充",
    }


def write_round_files(tmp: Path, chain: dict, request_status: str, criterion_status: str,
                      gap_status: str = "remains_open") -> tuple[Path, Path, Path]:
    fx = round_fixtures(tmp)
    chain = json.loads(json.dumps(chain))
    chain["evidence_gaps"][0]["closure_status"] = gap_status
    chain["evidence_gaps"][0]["closure_criteria"][0]["status"] = criterion_status
    if gap_status == "closed":
        chain["evidence_gaps"][0]["remaining_elements"] = []
    else:
        chain["evidence_gaps"][0]["remaining_elements"] = ["接收记录原件待核"]
    fx["after"].write_text(json.dumps(chain, ensure_ascii=False), encoding="utf-8")
    rinput = tmp / "round-input.json"
    rinput.write_text(json.dumps(round_input(request_status, criterion_status), ensure_ascii=False), encoding="utf-8")
    return fx["before"], fx["after"], rinput


def case_record_happy_path() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        before, after, rinput = write_round_files(Path(tmp), valid_chain(), "open", "unmet")
        out = Path(tmp) / "rounds" / "round_0001"
        assert run_cli(RECORD_PATH, "--before", str(before), "--after", str(after),
                       "--round", str(rinput), "--output-dir", str(out)) == 0, "legal round must record"
        assert (out / "round-record.json").exists() and (out / "round-update.md").exists()
        assert not list(Path(tmp).glob("**/*.tmp-partial*")), "no staging residue"


def case_answered_request_needs_response() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        before, after, rinput = write_round_files(Path(tmp), valid_chain(), "answered", "unmet")
        out = Path(tmp) / "rounds" / "round_0001"
        result = subprocess.run([sys.executable, str(RECORD_PATH), "--before", str(before),
                                 "--after", str(after), "--round", str(rinput),
                                 "--output-dir", str(out)], capture_output=True, text=True)
        assert result.returncode == 1 and "answered requires a recorded input" in result.stdout, \
            "answered request without responding input must be rejected"


def case_open_request_targeting_met_criterion() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        # gap already closed in `after`; open request still aims at its met criterion
        before, after, rinput = write_round_files(Path(tmp), valid_chain(), "open", "met", gap_status="closed")
        out = Path(tmp) / "rounds" / "round_0001"
        result = subprocess.run([sys.executable, str(RECORD_PATH), "--before", str(before),
                                 "--after", str(after), "--round", str(rinput),
                                 "--output-dir", str(out)], capture_output=True, text=True)
        # Either rejected as met-criterion target or as closed-gap-only target: both are correct rejects
        assert result.returncode == 1, "open request against met criterion / closed gap must be rejected"


def case_competing_round_id_rejected() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        before, after, rinput = write_round_files(tmp, valid_chain(), "open", "unmet")
        first = tmp / "rounds" / "round_0001"
        assert run_cli(RECORD_PATH, "--before", str(before), "--after", str(after),
                       "--round", str(rinput), "--output-dir", str(first)) == 0
        # second job, different directory, same round_id => must be rejected
        second = tmp / "rounds" / "round_0001_copy"
        result = subprocess.run([sys.executable, str(RECORD_PATH), "--before", str(before),
                                 "--after", str(after), "--round", str(rinput),
                                 "--output-dir", str(second)], capture_output=True, text=True)
        assert result.returncode == 1 and "round_id" in result.stdout, \
            "competing round with duplicate round_id must be rejected"
        assert not second.exists() and not list((tmp / "rounds").glob("*.tmp-partial*")), \
            "failed run must not leave partial output"


def case_atomic_write_no_partial_dir() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        before, after, rinput = write_round_files(tmp, valid_chain(), "open", "unmet")
        # force a failure before publish: reuse of an existing output dir is still atomic-checked
        out = tmp / "rounds" / "round_0001"
        assert run_cli(RECORD_PATH, "--before", str(before), "--after", str(after),
                       "--round", str(rinput), "--output-dir", str(out)) == 0
        stale = tmp / "rounds" / "round_0001_retries"
        stale.mkdir()
        (stale / "A-before.json").write_bytes(b"{")  # pre-existing dir -> hard reject, no overwrite
        result = subprocess.run([sys.executable, str(RECORD_PATH), "--before", str(before),
                                 "--after", str(after), "--round", str(rinput),
                                 "--output-dir", str(stale)], capture_output=True, text=True)
        assert result.returncode == 1 and "already exists" in result.stdout
        assert (stale / "A-before.json").read_bytes() == b"{", "existing dir must not be touched"
        assert not list((tmp / "rounds").glob("*.tmp-partial")), "staging cleaned up"


def case_mid_write_failure_cleans_staging() -> None:
    """Inject a failure after staging starts: partial artifacts must be removed
    and the final output directory must remain unpublished."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        before, after, rinput = write_round_files(tmp, valid_chain(), "open", "unmet")
        out = tmp / "rounds" / "round_0001"
        script = f"""
import sys, json
from pathlib import Path
sys.path.insert(0, {str(SCRIPTS)!r})
import record_evidence_round as rec

original_replace = rec.os.replace
def failing_replace(src, dst):
    raise OSError("injected mid-write failure")
rec.os.replace = failing_replace
try:
    rec.record_round(Path({str(before)!r}), Path({str(after)!r}), Path({str(rinput)!r}), Path({str(out)!r}))
except OSError as exc:
    print("EXPECTED_FAILURE:", exc)
    sys.exit(7)
sys.exit(0)
"""
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
        assert result.returncode == 7 and "EXPECTED_FAILURE" in result.stdout, \
            f"injected failure must trigger cleanup path: {result.stdout} {result.stderr}"
        assert not out.exists(), "final directory must not be published on failure"
        assert not out.with_name(out.name + ".tmp-partial").exists(), "staging must be cleaned on failure"
        assert not list((tmp / "rounds").glob("*.tmp-partial*")), "no partial residue"
        # retry after the failure must succeed without manual intervention
        assert run_cli(RECORD_PATH, "--before", str(before), "--after", str(after),
                       "--round", str(rinput), "--output-dir", str(out)) == 0, \
            "retry after mid-write failure must succeed"


def case_stale_staging_autorecovered() -> None:
    """A stale staging directory holding only this script's artifacts is discarded on retry."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        before, after, rinput = write_round_files(tmp, valid_chain(), "open", "unmet")
        out = tmp / "rounds" / "round_0001"
        staging = out.with_name(out.name + ".tmp-partial")
        staging.mkdir(parents=True)
        (staging / "round-record.json").write_text('{"half": true}', encoding="utf-8")
        assert run_cli(RECORD_PATH, "--before", str(before), "--after", str(after),
                       "--round", str(rinput), "--output-dir", str(out)) == 0, \
            "retry must auto-recover a stale staging directory"
        assert out.exists() and not staging.exists()
        # foreign content must still be refused (use a fresh round_id so the
        # duplicate-ID guard doesn't fire before the staging check)
        staging2 = out.with_name(out.name + "2.tmp-partial")
        staging2.mkdir(parents=True)
        (staging2 / "unrelated.txt").write_text("user data", encoding="utf-8")
        round_input_foreign = json.loads(rinput.read_text(encoding="utf-8"))
        round_input_foreign["round_id"] = "round_0002"
        rinput_foreign = tmp / "round-input-foreign.json"
        rinput_foreign.write_text(json.dumps(round_input_foreign, ensure_ascii=False), encoding="utf-8")
        result = subprocess.run([sys.executable, str(RECORD_PATH), "--before", str(before),
                                 "--after", str(after), "--round", str(rinput_foreign),
                                 "--output-dir", str(out.with_name(out.name + "2"))],
                                capture_output=True, text=True)
        assert result.returncode == 1 and "unrecognized files" in result.stdout, \
            "staging with foreign content must not be silently discarded"
        assert (staging2 / "unrelated.txt").exists(), "foreign staging files must be preserved"


def case_demand_change_requires_reassessment() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        before, after, rinput = write_round_files(tmp, valid_chain(), "open", "unmet")
        data = json.loads(rinput.read_text(encoding="utf-8"))
        data["demand"]["after"] = "改为追讨逾期利息"
        data["demand"]["change_reason"] = "律师调整诉讼请求"
        data["decisions"][0]["action"] = "no_material"  # no reassessment decision
        data["decisions"][0]["object_ids"] = ["$demand", "gap_001"]
        rinput.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        out = tmp / "rounds" / "round_0001"
        result = subprocess.run([sys.executable, str(RECORD_PATH), "--before", str(before),
                                 "--after", str(after), "--round", str(rinput),
                                 "--output-dir", str(out)], capture_output=True, text=True)
        assert result.returncode == 1 and "reassessment" in result.stdout, \
            "demand change without reassessment decision must be rejected"


def case_demand_change_with_reassessment_passes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        before, after, rinput = write_round_files(tmp, valid_chain(), "open", "unmet")
        data = json.loads(rinput.read_text(encoding="utf-8"))
        data["demand"]["after"] = "改为追讨逾期利息"
        data["demand"]["change_reason"] = "律师调整诉讼请求"
        data["decisions"].append({
            "id": "dec_002", "input_ids": [], "action": "reassessment",
            "object_ids": ["$demand"], "evidence_ids": [],
            "reason": "需求来源：律师2026-10-29书面确认改为主张逾期利息", "limits": "l",
            "important": True, "duplicate_of": None, "supersedes": []})
        rinput.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        out = tmp / "rounds" / "round_0001"
        result = subprocess.run([sys.executable, str(RECORD_PATH), "--before", str(before),
                                 "--after", str(after), "--round", str(rinput),
                                 "--output-dir", str(out)], capture_output=True, text=True)
        assert result.returncode == 0, f"legal reassessment round must record: {result.stdout}"


CASES = [
    base_valid_strict_passes,
    legacy_chain_non_strict_passes,
    case_statement_only_support,
    case_unreadable_evidence,
    case_duplicate_material_paths_preserve_unreadable,
    case_invalid_proof_scope,
    case_missing_source_locator,
    case_unknown_relation_type,
    case_endpoint_type_mismatch,
    case_supported_po_without_facts,
    case_negative_claim_wrong_type,
    case_derived_corroboration,
    case_closed_gap_without_criterion_evidence,
    case_closed_gap_unrelated_closure_evidence,
    case_reopened_gap_validates,
    case_incremental_close_without_evidence_fails,
    case_renderer_labels,
    case_record_happy_path,
    case_answered_request_needs_response,
    case_open_request_targeting_met_criterion,
    case_competing_round_id_rejected,
    case_atomic_write_no_partial_dir,
    case_mid_write_failure_cleans_staging,
    case_stale_staging_autorecovered,
    case_demand_change_requires_reassessment,
    case_demand_change_with_reassessment_passes,
]


def main() -> int:
    failures = 0
    for case in CASES:
        try:
            case()
            print(f"PASS  {case.__name__}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL  {case.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"ERROR {case.__name__}: {exc!r}")
    print(f"\n{len(CASES) - failures}/{len(CASES)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
