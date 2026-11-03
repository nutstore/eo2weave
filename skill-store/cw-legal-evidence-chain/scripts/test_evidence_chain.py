"""Self-tests for cw-legal-evidence-chain scripts (PR #115 Sourcery fixes).

Run: python3 scripts/test_evidence_chain.py
Each case asserts the CLI exit code / API behavior for a legal or illegal input.
Covers backward compatibility: a valid legacy-style chain must still pass.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
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


def expected_publish_mode() -> int:
    """The mode the published report must carry under the CURRENT umask.

    Measured by letting the kernel create a throwaway file, so the test never
    has to read the umask through os.umask() (which mutates the process-wide
    mask) and never assumes a permissive default. The group and other WRITE
    bits are withheld: the report stays readable for collaborators, but a peer
    must not be able to rewrite the published bytes. Returns 0 on platforms
    without POSIX permission bits, where the mode is not meaningful.
    """
    if os.name == "nt":
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        probe = Path(tmp) / "probe"
        fd = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o666)
        try:
            umask_mode = stat.S_IMODE(os.fstat(fd).st_mode)
        finally:
            os.close(fd)
        return umask_mode & ~0o022


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

def case_atomic_write_digest_permissions_and_cleanup() -> None:
    """OUTPUT_SHA256 must describe the staged bytes actually published; the
    published report must carry the mode a normal open() would have produced
    under the active umask; staging files must be cleaned up on failure."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "chain.json"
        src.write_text(json.dumps(valid_chain(), ensure_ascii=False), encoding="utf-8")
        out = tmp / ("报告" + "x" * 200 + ".md")  # long basename must not break the staging file
        result = subprocess.run([sys.executable, str(RENDER_PATH), "--strict", str(src), str(out)],
                                capture_output=True, text=True)
        assert result.returncode == 0, f"render with long output basename must succeed: {result.stdout} {result.stderr}"
        digest_line = next(line for line in result.stdout.splitlines() if line.startswith("OUTPUT_SHA256"))
        actual = hashlib.sha256(out.read_bytes()).hexdigest()
        assert digest_line.split()[1] == actual, "emitted checksum must match the published bytes"
        mode = stat.S_IMODE(out.stat().st_mode)
        expected = expected_publish_mode()
        if expected:
            # POSIX platforms: the published report must carry exactly the
            # mode a normal open() would have produced under the current
            # umask.
            assert mode == expected, \
                f"published report must carry the umask-adjusted mode {oct(expected)}, got {oct(mode)}"
            if expected & 0o400:
                assert mode & 0o400, f"published report must stay owner-readable, got {oct(mode)}"
        assert not list(tmp.glob("render-staging-*")), "no staging residue after success"
        # Stale staging files of THIS renderer are swept; a foreign file with
        # a similar name must survive.
        # A PID that cannot be running HERE is discovered at test time, not
        # hardcoded: a numeric PID like 999999 CAN be a live process on some
        # systems, and then the sweep would correctly PRESERVE the file and
        # the assertion below would fail on a healthy renderer. We probe the
        # live PID space instead of assuming any number is dead.
        dead_pid = None
        for candidate in range(700000, 999999, 7):
            try:
                os.kill(candidate, 0)
            except ProcessLookupError:
                dead_pid = candidate
                break
            except (PermissionError, OSError):
                continue  # occupied or unclassifiable — try another
        assert dead_pid is not None, "no free PID found to fake a dead renderer"
        stale = tmp / f"render-staging-{dead_pid}-abcdef0123456789.tmp-partial"
        stale.write_text("junk", encoding="utf-8")
        old = time.time() - 7 * 3600
        os.utime(stale, (old, old))
        foreign = tmp / "render-staging-user-notes.tmp-partial"
        foreign.write_text("user data", encoding="utf-8")
        os.utime(foreign, (old, old))
        live = tmp / f"render-staging-{os.getpid()}-feedfacefeedface.tmp-partial"
        live.write_text("junk", encoding="utf-8")
        os.utime(live, (old, old))
        assert run_cli(RENDER_PATH, "--strict", str(src), str(out)) == 0
        assert not stale.exists(), "stale staging file of a dead render must be swept"
        assert foreign.exists(), "a foreign file with a similar name must survive"
        assert live.exists(), "a live render's staging file must survive"
        foreign.unlink()
        live.unlink()


def case_atomic_write_failure_cleans_staging() -> None:
    """An injected os.replace failure must remove this run's staging file and
    leave the previously published report untouched."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "chain.json"
        src.write_text(json.dumps(valid_chain(), ensure_ascii=False), encoding="utf-8")
        out = tmp / "report.md"
        assert run_cli(RENDER_PATH, "--strict", str(src), str(out)) == 0
        before_bytes = out.read_bytes()
        script = f"""
import sys
from pathlib import Path
sys.path.insert(0, {str(SCRIPTS)!r})
import render_evidence_chain as ren

def failing_replace(src, dst):
    raise OSError("injected replace failure")
ren.os.replace = failing_replace
try:
    ren.atomic_write("partial content", Path({str(out)!r}))
except OSError:
    sys.exit(7)
sys.exit(0)
"""
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
        assert result.returncode == 7, f"injected failure must propagate: {result.stdout} {result.stderr}"
        assert out.read_bytes() == before_bytes, "failed publish must not touch the existing report"
        assert not list(tmp.glob("render-staging-*")), "staging must be cleaned on failure"


def case_render_never_mutates_process_umask() -> None:
    """The renderer must never change the process-wide umask, and the staged
    report must never be group/other-writable.

    os.umask() is the only way to change the process-wide mask, and every
    change is visible to every other thread in the process: while the mask is
    widened, a file another thread creates gets broader permissions than the
    user's mask allows, and an interruption between the read and the restore
    leaves the mask widened for the rest of the process.

    The staged report must never be writable by group or other. If the
    staging file were group/other-writable while the report bytes are
    staged, another user could open it, keep the descriptor and rewrite the
    staged bytes after the checksum pass; the emitted OUTPUT_SHA256 would
    then no longer describe the published bytes. The published report keeps
    the umask's READ bits, so collaborators can still read it.
    """
    if os.name == "nt" or not hasattr(os, "umask"):
        return  # no POSIX umask to protect on this platform
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "chain.json"
        src.write_text(json.dumps(valid_chain(), ensure_ascii=False), encoding="utf-8")
        out = tmp / "report.md"
        script = f"""
import os, stat, sys
from pathlib import Path
sys.path.insert(0, {str(SCRIPTS)!r})
import render_evidence_chain as ren

real_umask = os.umask
calls = []
def spy(mask):
    calls.append(mask)
    return real_umask(mask)
os.umask = spy  # any umask change from here on is recorded

real_replace = os.replace
staged_modes = []
def spy_replace(src, dst):
    # The staging file's mode at the moment it is moved into place.
    staged_modes.append(stat.S_IMODE(os.stat(src).st_mode))
    return real_replace(src, dst)
ren.os.replace = spy_replace

real_umask(0o022)  # permissive mask: the published report stays shared-readable
ren.atomic_write("report body", Path({str(out)!r}))
during = real_umask(0o077)  # read back the mask the renderer left behind
print("CALLS", calls)
print("DURING", oct(during))
print("STAGED", [oct(m) for m in staged_modes])
"""
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
        assert result.returncode == 0, \
            f"renderer must leave the process umask untouched: {result.stdout} {result.stderr}"
        assert "CALLS []" in result.stdout, \
            f"renderer must never change the process-wide umask: {result.stdout}"
        assert "DURING 0o22" in result.stdout, \
            f"renderer must leave the umask as it found it: {result.stdout}"
        # The mode is set on the staging inode BEFORE the publish, so the
        # file is never visible at the destination with the wrong mode.
        assert "STAGED ['0o644']" in result.stdout, \
            f"the staged report must carry the publish mode at the moment of the rename: {result.stdout}"
        mode = stat.S_IMODE(out.stat().st_mode)
        assert mode == 0o644, \
            f"under umask 022 the published report must stay shared-readable, got {oct(mode)}"
        assert not mode & 0o022, \
            f"the published report must not be group/other-writable, got {oct(mode)}"

        # A restrictive mask must publish an owner-only report, and the
        # renderer must still leave the process-wide mask untouched.
        out2 = tmp / "report-restricted.md"
        script2 = f"""
import os, stat, sys
from pathlib import Path
sys.path.insert(0, {str(SCRIPTS)!r})
import render_evidence_chain as ren

real_umask = os.umask
calls = []
def spy(mask):
    calls.append(mask)
    return real_umask(mask)
os.umask = spy

real_umask(0o077)
ren.atomic_write("report body", Path({str(out2)!r}))
during = real_umask(0o022)
print("CALLS", calls)
print("DURING", oct(during))
"""
        result2 = subprocess.run([sys.executable, "-c", script2], capture_output=True, text=True)
        assert result2.returncode == 0, \
            f"renderer must leave the process umask untouched: {result2.stdout} {result2.stderr}"
        assert "CALLS []" in result2.stdout, \
            f"renderer must never change the process-wide umask: {result2.stdout}"
        assert "DURING 0o77" in result2.stdout, \
            f"renderer must leave the umask as it found it: {result2.stdout}"
        mode2 = stat.S_IMODE(out2.stat().st_mode)
        assert mode2 == 0o600, \
            f"under umask 077 the published report must be owner-only, got {oct(mode2)}"


def case_render_survives_missing_fchmod() -> None:
    """The renderer must publish a report on platforms without os.fchmod.

    Windows has no os.fchmod and carries no POSIX permission bits; calling it
    unconditionally raised AttributeError before the publish, so no report was
    ever written. A missing fchmod must not stop the publish, and neither must
    a platform without POSIX permission bits at all.
    """
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "chain.json"
        src.write_text(json.dumps(valid_chain(), ensure_ascii=False), encoding="utf-8")
        out = tmp / "report.md"
        script = f"""
import os, sys
from pathlib import Path
sys.path.insert(0, {str(SCRIPTS)!r})
import render_evidence_chain as ren

if hasattr(os, "fchmod"):
    del os.fchmod  # emulate a platform without fchmod
digest, size = ren.atomic_write("report body", Path({str(out)!r}))
print("DIGEST", digest)
"""
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
        assert result.returncode == 0, \
            f"render must succeed without os.fchmod: {result.stdout} {result.stderr}"
        assert out.exists(), "a report must be published even without os.fchmod"
        assert out.read_text(encoding="utf-8") == "report body"
        assert hashlib.sha256(out.read_bytes()).hexdigest() in result.stdout, \
            "the emitted digest must describe the published bytes"

        # A platform without POSIX permission bits (Windows) must publish too.
        out2 = tmp / "report-no-posix-modes.md"
        script2 = f"""
import os, sys
from pathlib import Path
sys.path.insert(0, {str(SCRIPTS)!r})
import render_evidence_chain as ren

ren.supports_posix_modes = lambda: False  # emulate Windows
digest, size = ren.atomic_write("report body", Path({str(out2)!r}))
print("DIGEST", digest)
"""
        result2 = subprocess.run([sys.executable, "-c", script2], capture_output=True, text=True)
        assert result2.returncode == 0, \
            f"render must succeed without POSIX permission bits: {result2.stdout} {result2.stderr}"
        assert out2.exists(), "a report must be published without POSIX permission bits"
        assert out2.read_text(encoding="utf-8") == "report body"
        assert hashlib.sha256(out2.read_bytes()).hexdigest() in result2.stdout, \
            "the emitted digest must describe the published bytes"


def case_published_mode_and_digest_invariants() -> None:
    """The published report's mode and checksum must match the umask-derived
    contract, and the report must never be group/other-writable.

    Two invariants are pinned here, each under a DIFFERENT umask:

    1. Under umask 022 the published mode is exactly the mode the kernel gave
       the file at CREATION time (i.e. 0o666 & ~umask) with the group and
       other WRITE bits withheld: 0644 — still shared-readable, never
       shared-writable.
    2. Under a permissive umask (002) the same withheld bits must still
       produce 0644. This catches the regression the 022 run cannot see: if
       the renderer stops clearing the group/other WRITE bits, umask 022
       masks the defect (the kernel already removed them), but umask 002
       would leak a group-writable report.
    3. Under both masks the emitted OUTPUT_SHA256 must equal the SHA-256 of
       the PUBLISHED file's bytes, so the checksum the caller hands on
       always describes the delivered report.
    """
    if os.name == "nt":
        return  # POSIX permission bits are not meaningful on Windows
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "chain.json"
        src.write_text(json.dumps(valid_chain(), ensure_ascii=False), encoding="utf-8")
        out = tmp / "report.md"
        script = f"""
import os, stat, sys
from pathlib import Path
sys.path.insert(0, {str(SCRIPTS)!r})
import render_evidence_chain as ren

real_umask = os.umask
real_umask(0o022)
digest, size = ren.atomic_write("report body", Path({str(out)!r}))
print("DIGEST", digest)
print("SIZE", size)
"""
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
        assert result.returncode == 0, \
            f"render must succeed: {result.stdout} {result.stderr}"
        mode = stat.S_IMODE(out.stat().st_mode)
        # 0o666 & ~0o022 = 0o644: the umask's read bits plus owner read/write.
        assert mode == 0o644, \
            f"under umask 022 the published report must be 0644, got {oct(mode)}"
        assert not mode & 0o022, \
            f"the published report must never be group/other-writable, got {oct(mode)}"
        published = out.read_bytes()
        assert f"DIGEST {hashlib.sha256(published).hexdigest()}" in result.stdout, \
            "the emitted digest must equal the SHA-256 of the published bytes"

        # Umask 002 regression probe: umask 022 already removes the group
        # WRITE bit, so a renderer that stops clearing it would pass the
        # assertions above. Under 002 the kernel KEEPS that bit, so the
        # renderer's own clearing logic is what is being tested here.
        out2 = tmp / "report-umask-002.md"
        script2 = script.replace("real_umask(0o022)", "real_umask(0o002)").replace(str(out), str(out2))
        result2 = subprocess.run([sys.executable, "-c", script2], capture_output=True, text=True)
        assert result2.returncode == 0, \
            f"render under umask 002 must succeed: {result2.stdout} {result2.stderr}"
        mode2 = stat.S_IMODE(out2.stat().st_mode)
        assert mode2 == 0o644, \
            f"under umask 002 the published report must still be 0644, got {oct(mode2)}"
        assert not mode2 & 0o002, \
            f"under umask 002 the published report must not be group-writable, got {oct(mode2)}"
        published2 = out2.read_bytes()
        assert f"DIGEST {hashlib.sha256(published2).hexdigest()}" in result2.stdout, \
            "under umask 002 the emitted digest must equal the SHA-256 of the published bytes"


def case_staging_symlink_swap_aborts_publish() -> None:
    """A staging name swapped for a symlink must abort the publish.

    The identity check must not follow symlinks: a concurrent writer that
    replaced the staging name with a symlink to the opened inode would
    otherwise pass an os.stat-based check, and os.replace would move the
    symlink itself — publishing a replaceable symlink instead of the
    verified report.
    """
    if os.name == "nt":
        return  # symlink creation needs privileges on Windows
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        out = tmp / "report.md"
        script = f"""
import os, sys
from pathlib import Path
sys.path.insert(0, {str(SCRIPTS)!r})
import render_evidence_chain as ren

TMP = Path({str(tmp)!r})
real_lstat = os.lstat
state = {{'done': False}}
def spy_lstat(path, *args, **kwargs):
    # Swap the staging name for a symlink that points AT the opened inode,
    # exactly as a concurrent writer to the output directory would.
    text = str(path)
    if not state['done'] and os.path.basename(text).startswith(ren.STAGING_PREFIX):
        state['done'] = True
        alias = TMP / 'alias.bin'
        os.link(text, str(alias))   # a hard link to the very inode that is open
        os.unlink(text)             # the staging name now points nowhere
        os.symlink(str(alias), text)  # ... and is a symlink to that inode
    return real_lstat(path, *args, **kwargs)
os.lstat = spy_lstat

try:
    ren.atomic_write("report body", Path({str(out)!r}))
except RuntimeError as exc:
    print("ABORTED", exc)
    sys.exit(9)
sys.exit(0)
"""
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
        assert result.returncode == 9, \
            f"a swapped staging name must abort the publish: {result.stdout} {result.stderr}"
        assert "ABORTED" in result.stdout, \
            f"the abort must be reported as such: {result.stdout}"
        assert not out.exists(), "nothing may be published when the staging name was swapped"


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
    case_atomic_write_digest_permissions_and_cleanup,
    case_atomic_write_failure_cleans_staging,
    case_render_never_mutates_process_umask,
    case_render_survives_missing_fchmod,
    case_published_mode_and_digest_invariants,
    case_staging_symlink_swap_aborts_publish,
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
