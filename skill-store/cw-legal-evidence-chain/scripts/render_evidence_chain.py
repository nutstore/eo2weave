#!/usr/bin/env python3
"""Render a lawyer-facing Markdown report from validated evidence-chain JSON.

The renderer deliberately copies IDs and status fields from JSON instead of
re-deciding legal or evidentiary questions. Narrative refinement may be added
after rendering, but core states must remain identical to JSON.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import secrets
import stat
import time
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


STAGING_PREFIX = "render-staging-"
STAGING_SUFFIX = ".tmp-partial"
STAGING_STALE_SECONDS = 6 * 3600

# A published report must keep the mode a normal open(path, "w") would have
# produced under the active umask. The kernel applies the umask when a file is
# CREATED, so the staging file is created with 0o666 and the resulting mode is
# read back from the descriptor: no umask probe file and no os.umask() call.
REPORT_CREATE_MODE = 0o666

# The group and other WRITE bits are withheld from the published report.
# 0o666 & ~umask grants them under a permissive umask, and a peer that can
# write the staged inode can rewrite the report bytes between the checksum
# pass and the publish, so the emitted checksum would stop describing the
# published bytes. Their READ bits are kept: that is what makes the report
# readable for collaborators.
PUBLISH_MODE_DENIED = 0o022

# The staging file is narrowed to owner-only before a single report byte is
# written, so no other user can read a half-written report from it and no
# peer can retain a descriptor and rewrite the staged bytes after they have
# been hashed. The publish mode was read from the creation, so narrowing the
# file costs nothing.
STAGING_OWNER_MODE = 0o600

# Windows must read and write the staging descriptor in binary mode: in text
# mode the runtime translates "\n" into "\r\n" and stops reading at a Ctrl-Z
# byte, so the checksum would describe bytes that are not the published bytes.
BINARY_FLAG = getattr(os, "O_BINARY", 0)

# The PID carried in a staging file name. Linux PIDs fit in 10 digits; the
# limit keeps a name with a huge numeric part from being treated as a PID.
MAX_PID_DIGITS = 10


def supports_posix_modes() -> bool:
    """True on platforms that carry POSIX permission bits (not Windows)."""
    return os.name != "nt"


def desired_publish_mode(created_mode: int) -> int | None:
    """Return the mode the published report must carry.

    The staging file was created with 0o666, so the kernel already applied
    the active umask: the mode read back after the CREATION is exactly the
    mode a normal open(path, "w") would have produced under that umask. The
    group and other WRITE bits are then withheld — their READ bits are kept,
    so the report stays readable for collaborators, but a peer can no longer
    rewrite the staged bytes after they have been hashed.

    Returns None on platforms without POSIX permission bits (Windows),
    where the mode is not meaningful.
    """
    if not supports_posix_modes():
        return None
    return created_mode & ~PUBLISH_MODE_DENIED


def apply_publish_mode(fd: int, mode: int | None) -> bool:
    """Apply `mode` to the inode behind `fd`; True when it was applied.

    The mode is applied through the already-open descriptor, so it lands on
    the very inode that was hashed and published — never on a file another
    render may have put at the destination path in the meantime. The mode
    is NEVER applied through the path: a path can be swapped between the
    check and the call, and chmod'ing a swapped path would change the
    permissions of a different file.

    Windows carries no POSIX permission bits, so this is a no-op there (the
    mode is None). A platform without descriptor-based chmod leaves the
    mode the kernel gave the file, which is owner-only and therefore safe.
    A failed mode update must never turn a published render into an error:
    the report is published either way and its digest is still returned.
    """
    if mode is None or not supports_posix_modes():
        return True
    fchmod = getattr(os, "fchmod", None)
    if fchmod is not None:
        try:
            fchmod(fd, mode)
            return True
        except (OSError, NotImplementedError):
            return False
    try:
        os.chmod(fd, mode)
        return True
    except (OSError, TypeError, NotImplementedError):
        return False


def create_staging_file(directory: Path) -> tuple[int, Path, int | None]:
    """Create a unique staging file in `directory`.

    Returns (fd, path, publish_mode): an open read-write descriptor, the
    staging path, and the mode the published report must carry (None on
    platforms without POSIX permission bits).

    The file is created with O_EXCL, so a name collision can never reuse an
    existing file, and with 0o666 so that the kernel applies the active
    umask: the mode the file is born with is exactly the mode a normal
    open(path, "w") would have produced.

    The file is then IMMEDIATELY narrowed to owner-only, before a single
    report byte is written. That gives two properties at once:

    - no other user can open the staging file, so no peer can retain a
      descriptor and rewrite the staged bytes after they were hashed;
    - no other user can read a half-written report from the staging file.

    The publish mode was already read from the creation, so narrowing the
    file costs nothing. The name carries this render's PID and a random
    token, so only this renderer's own files can be recognised as its
    staging files.
    """
    for _ in range(16):
        candidate = directory / f"{STAGING_PREFIX}{os.getpid()}-{secrets.token_hex(8)}{STAGING_SUFFIX}"
        try:
            fd = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_RDWR | BINARY_FLAG, REPORT_CREATE_MODE)
        except FileExistsError:
            continue
        try:
            publish_mode = desired_publish_mode(stat.S_IMODE(os.fstat(fd).st_mode))
            if publish_mode is not None:
                # Narrow to owner-only before anything is written.
                apply_publish_mode(fd, STAGING_OWNER_MODE)
        except BaseException:
            # Setup failed before atomic_write's own cleanup exists: leave
            # neither a leaked descriptor nor a stray staging file behind.
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                candidate.unlink()
            except OSError:
                pass
            raise
        return fd, candidate, publish_mode
    raise RuntimeError(f"cannot create a unique staging file in {directory}")


def write_all(fd: int, payload: bytes) -> None:
    """Write every byte of `payload` through `fd`."""
    view = memoryview(payload)
    while view:
        written = os.write(fd, view)
        view = view[written:]


# The report is encoded and written in chunks of this many characters, so a
# large report never needs a second full-size buffer alongside the live
# report string.
WRITE_CHUNK_CHARS = 65536


def write_text(fd: int, text: str) -> int:
    """Encode `text` as UTF-8 and write it through `fd`; return the byte count.

    The text is encoded chunk by chunk: encoding the whole report at once
    would allocate a second report-sized buffer while the report string is
    still live, which can exhaust memory on very large reports.
    """
    total = 0
    for start in range(0, len(text), WRITE_CHUNK_CHARS):
        chunk = text[start:start + WRITE_CHUNK_CHARS].encode("utf-8")
        write_all(fd, chunk)
        total += len(chunk)
    return total


def hash_fd(fd: int) -> tuple[str, int]:
    """Return (sha256 hexdigest, size) of the file behind `fd`.

    The descriptor is rewound first, so this always hashes the file's current
    content. The bytes are read through the descriptor, never through the
    path, so the digest describes the very inode that will be published even
    if the path is replaced in the meantime.
    """
    hasher = hashlib.sha256()
    size = 0
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        hasher.update(chunk)
        size += len(chunk)
    return hasher.hexdigest(), size


def path_names_inode(path: Path, fd: int) -> bool:
    """True when `path` still refers to the file behind `fd`.

    The check uses os.lstat, NOT os.stat: os.stat follows symlinks, so a
    replacement symlink pointing at the opened inode would pass the check
    while os.replace would move the symlink itself and publish a
    replaceable symlink instead of the verified report. lstat reports the
    symlink's own inode, which differs from the opened inode, so the
    publish is aborted.
    """
    try:
        named = os.lstat(path)
        opened = os.fstat(fd)
    except OSError:
        return False
    return (named.st_dev, named.st_ino) == (opened.st_dev, opened.st_ino)


def cleanup_stale_staging(output_dir: Path, *, now: float | None = None) -> None:
    """Best-effort sweep of abandoned staging files in `output_dir`.

    Only this renderer's OWN staging files are candidates: their names
    carry the renderer's PID and a random token
    ("render-staging-<pid>-<token>.tmp-partial"). A file that merely looks
    similar — a user's own file, or a concurrent render's staging file from
    another process — does not match this renderer's pattern and is never
    touched.

    A candidate is only removed when it is clearly abandoned: its PID is
    not a live process AND its mtime is older than STAGING_STALE_SECONDS.
    A staging file whose owning process is still running is never removed,
    so a long-running render never loses its staging file. When the owning
    process cannot be classified, the safe default is to keep the file:
    leaking one stale file is far less harmful than deleting a live
    render's staging file or a user's file.
    """
    current = time.time() if now is None else now
    try:
        entries = list(output_dir.iterdir())
    except OSError:
        return
    for entry in entries:
        if not is_own_staging_name(entry.name):
            continue
        try:
            if current - entry.stat().st_mtime < STAGING_STALE_SECONDS:
                continue
        except OSError:
            continue
        if owner_process_is_alive(entry.name):
            continue
        try:
            entry_stat = entry.stat()
            if not stat.S_ISREG(entry_stat.st_mode):
                continue
        except OSError:
            continue
        # Re-verify identity immediately before unlinking: a writer that
        # swaps the entry between the checks and this unlink must not get
        # their file deleted by this sweep.
        try:
            dir_fd = os.open(output_dir, os.O_RDONLY)
        except OSError:
            continue
        try:
            try:
                named = os.stat(entry.name, dir_fd=dir_fd, follow_symlinks=False)
                if (named.st_dev, named.st_ino) != (entry_stat.st_dev, entry_stat.st_ino):
                    continue  # the entry changed — leave it alone
                os.unlink(entry.name, dir_fd=dir_fd)
            except FileNotFoundError:
                continue
            except OSError:
                continue
        finally:
            os.close(dir_fd)


def is_own_staging_name(name: str) -> bool:
    """True when `name` is a staging file created by THIS render.

    The renderer creates "render-staging-<pid>-<token>.tmp-partial". A name
    that does not carry a numeric PID and a token is not one of ours — it
    is either a user's file or a file from an older renderer version, and
    both must survive the cleanup sweep.
    """
    if not (name.startswith(STAGING_PREFIX) and name.endswith(STAGING_SUFFIX)):
        return False
    middle = name[len(STAGING_PREFIX):-len(STAGING_SUFFIX)]
    pid_text, _, token = middle.partition("-")
    if not token or not re.fullmatch(r"[0-9a-f]+", token):
        return False
    return bool(pid_text.isdigit()) and len(pid_text) <= MAX_PID_DIGITS


def owner_process_is_alive(name: str) -> bool:
    """True when the process that created `name` may still be running.

    Returns True when the owner cannot be classified (unknown PID), so an
    uncertain case never deletes a file.
    """
    middle = name[len(STAGING_PREFIX):-len(STAGING_SUFFIX)]
    pid_text = middle.partition("-")[0]
    try:
        pid = int(pid_text)
    except ValueError:
        return True
    if pid <= 0:
        # PID 0 addresses the whole process group; never signal it.
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False  # no such process on this host
    except OverflowError:
        # The number in the name is outside the platform's representable PID
        # range, so liveness cannot be classified — the safe default is to
        # KEEP the file rather than delete something we could not check.
        return True
    except PermissionError:
        return True  # the process exists but belongs to another user
    except OSError:
        return True
    return True


def atomic_write(text: str, output_file: Path) -> tuple[str, int]:
    """Publish text atomically; return (sha256, size) of THIS invocation's bytes.

    Safety properties:
    - The staging file is unique per invocation (the render's PID and a
      random token are in its name), so concurrent renders never share one
      staging path and valid output basenames cannot overflow the
      filesystem name limit.
    - os.replace() is atomic on POSIX: the final path only ever holds a
      complete report.
    - The process-wide umask is never read or written. The kernel applies
      the umask when a file is CREATED, so creating the staging file with
      0o666 yields exactly the mode a normal open(path, "w") would have
      produced — no os.umask() probe and no throwaway probe file.
    - The group and other WRITE bits are withheld from the published mode
      (their READ bits are kept), so a peer cannot rewrite the staged bytes
      between the checksum pass and the publish.
    - The mode is set on the staging inode BEFORE the file becomes visible
      at the destination, so a reader never sees an owner-only report and
      no post-publish chmod can fail after the report is published.
    - Everything happens on ONE open descriptor: the report is written,
      hashed, re-hashed, mode-set and published through the same inode. The
      digest therefore always describes the bytes that were published, even
      if another process rewrites the staging path in the meantime.
    - The staged bytes are hashed twice — once to compute the checksum and
      once again immediately before the publish — so a staging file that
      changed underneath us aborts the publish instead of publishing bytes the
      emitted checksum does not describe.
    """
    output_file.parent.mkdir(parents=True, exist_ok=True)
    cleanup_stale_staging(output_file.parent)
    fd, staging, publish_mode = create_staging_file(output_file.parent)
    published = False
    # True once the descriptor has been closed on Windows ahead of the
    # rename; after that point identity checks through `fd` are impossible,
    # so failure cleanup falls back to comparing against the identity that
    # was captured before the close.
    fd_closed = False
    staging_identity: tuple[int, int] | None = None
    try:
        # The report bytes are written through the descriptor in BINARY
        # mode: a text wrapper would translate newlines on Windows, so the
        # checksum would describe bytes that are not the published bytes.
        # The text is encoded and written INCREMENTALLY, so a large report
        # never needs a second full-size buffer.
        size = write_text(fd, text)
        os.fsync(fd)
        digest, size = hash_fd(fd)
        # Re-hash immediately before publishing. A same-user process (or a
        # root process) can still rewrite the staging file; re-verifying
        # guarantees the checksum we publish describes the bytes that are
        # actually moved into place.
        verified, verified_size = hash_fd(fd)
        if verified != digest or verified_size != size:
            raise RuntimeError(
                "staged report changed while it was being verified; nothing was published"
            )
        # The final publish mode is applied to the verified staging inode
        # THROUGH THE DESCRIPTOR immediately before the file becomes visible
        # at the destination: the report is never published with broader
        # permissions than the contract, and no post-publish chmod can fail
        # after the report has already been published. The staging file is
        # owner-only while the bytes are being written, so nothing is ever
        # exposed at this step either.
        if not apply_publish_mode(fd, publish_mode):
            print("WARNING: the published report's permissions could not be set to the "
                  "umask-adjusted mode; it keeps the mode the kernel gave it")
        # The identity check must not follow symlinks: a concurrent writer
        # that replaced the staging name with a symlink to the opened inode
        # would otherwise pass the check, and os.replace would move the
        # symlink itself.
        if not path_names_inode(staging, fd):
            raise RuntimeError(
                "the staging file was replaced before it could be published; nothing was published"
            )
        if os.name == "nt":
            # Windows can refuse to rename a file that still has an open
            # descriptor, so the descriptor MUST be closed before the
            # rename. The mode was already set on the inode, so the report
            # is published with its final permissions either way. The
            # inode's identity is captured BEFORE the close, so failure
            # cleanup after a failed rename can still verify that the
            # staging name still names this render's file.
            staging_identity = (
                os.fstat(fd).st_dev,
                os.fstat(fd).st_ino,
            )
            os.close(fd)
            fd = -1
            fd_closed = True
        os.replace(staging, output_file)
        published = True
        if fd >= 0:
            # On POSIX the descriptor stays open across the rename, so the
            # inode that was hashed can still be compared with the inode the
            # destination now holds. A concurrent writer that swapped the
            # staging name between the identity check and the rename is
            # detected here instead of silently publishing someone else's
            # bytes.
            try:
                if not path_names_inode(output_file, fd):
                    print("WARNING: the published path does not hold the report this run "
                          "hashed; another writer swapped the staging name — do not deliver "
                          "without re-verifying")
            except OSError:
                pass
    except BaseException:
        if not published:
            # Only unlink the staging path if it STILL names the inode this
            # render wrote. With the descriptor open (POSIX, and Windows up
            # to the pre-rename close), identity is checked through `fd` so
            # a swapped-in foreign file is never deleted. If os.replace
            # failed AFTER the Windows pre-rename close, there is no
            # descriptor to check through, but the inode's (dev, ino) was
            # captured before the close: the name is unlinked only when it
            # still names THAT inode, so a swap-in replacement survives.
            # Leaving one stale file behind in that (already hostile) case
            # is the harmless direction to fail in.
            try:
                if fd_closed and staging_identity is not None:
                    named = os.lstat(staging)
                    ours = (named.st_dev, named.st_ino) == staging_identity
                else:
                    ours = path_names_inode(staging, fd)
                if ours:
                    staging.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
    return digest, size


def published_digest(path: Path) -> str | None:
    """SHA-256 of the file at `path`, read in bounded chunks; None on failure.

    The file is read in fixed-size chunks, so verifying a large report never
    allocates a second report-sized buffer, and only after confirming the
    path holds a REGULAR file: a peer who could swap the published path for
    a FIFO (open blocks forever) or a symlink to an unbounded stream such as
    /dev/zero (memory exhaustion) is otherwise able to hang or OOM the
    verification step.
    """
    try:
        if not stat.S_ISREG(os.stat(path).st_mode):
            return None
        hasher = hashlib.sha256()
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(65536)
                if not chunk:
                    break
                hasher.update(chunk)
        return hasher.hexdigest()
    except OSError:
        return None


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
    digest, size = atomic_write(report, args.output_file)
    print(f"Rendered {args.output_file} with {len(warnings)} warning(s) ({'strict' if args.strict else 'compatibility-only'} validation)")
    # The report is now published; the verification below is a post-condition
    # check on the delivered artifact. `published_digest` returns None when
    # the path is missing, unreadable, or not a regular file — in that state
    # the delivery cannot be verified, and an UNVERIFIED report must never be
    # presented as a verified success.
    published = published_digest(args.output_file)
    if published is None:
        print("ERROR: the published report could not be verified after publication "
              "(missing, unreadable, or not a regular file); the checksum below "
              "describes what this run wrote, but the delivered file was NOT verified")
        print(f"OUTPUT_SHA256 {digest}")
        print(f"OUTPUT_PATH {args.output_file.resolve()}")
        return 1
    if published != digest:
        print("WARNING: the published report's checksum differs from this run's staged "
              "report; another render likely replaced it after publish — do not deliver "
              "without re-verifying")
    print(f"OUTPUT_SHA256 {digest}")
    print(f"OUTPUT_PATH {args.output_file.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
