"""
validate_xml — Post-writeback XML well-formedness and structural validation.

Runs after apply_edits() serializes all XML parts but before the ZIP is written.
Catches common XML corruption issues: stray characters, unclosed tags, broken
bookmarks/comments, invalid namespace references, etc.

Usage:
    from validate_xml import validate_files, XmlValidationReport

    report = validate_files(files)
    if report.errors:
        print(report.to_markdown())
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Optional


# ── OOXML namespace shortcuts ──────────────────────────────────────

NAMESPACES = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    "wpg": "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
    "wpi": "http://schemas.microsoft.com/office/word/2010/wordprocessingInk",
    "wne": "http://schemas.microsoft.com/office/word/2006/wordml",
    "wp14": "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "v": "urn:schemas-microsoft-com:vml",
    "o": "urn:schemas-microsoft-com:office:office",
    "rels": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
}


def _ns(prefix: str, local: str) -> str:
    """Build Clark notation {uri}local."""
    return f"{{{NAMESPACES[prefix]}}}{local}"


# ── Data model ─────────────────────────────────────────────────────

@dataclass
class XmlIssue:
    severity: str  # "error" / "warning"
    category: str  # e.g. "well_formedness", "bookmark_integrity", "stray_chars"
    file: str      # e.g. "word/document.xml"
    message: str
    details: str = ""


@dataclass
class XmlValidationReport:
    issues: list[XmlIssue] = field(default_factory=list)

    @property
    def errors(self) -> list[XmlIssue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> list[XmlIssue]:
        return [i for i in self.issues if i.severity == "warning"]

    @property
    def is_ok(self) -> bool:
        return len(self.errors) == 0

    def to_markdown(self) -> str:
        lines = ["# XML Validation Report", ""]

        if not self.issues:
            lines.append("✅ **All XML files are valid.**")
            return "\n".join(lines)

        err_count = len(self.errors)
        warn_count = len(self.warnings)
        lines.append(f"**Errors**: {err_count} | **Warnings**: {warn_count}")
        lines.append("")

        # Group by file
        by_file: dict[str, list[XmlIssue]] = {}
        for issue in self.issues:
            by_file.setdefault(issue.file, []).append(issue)

        for f, file_issues in sorted(by_file.items()):
            for issue in file_issues:
                icon = "❌" if issue.severity == "error" else "⚠️"
                lines.append(f"- {icon} **{f}** [{issue.category}] {issue.message}")
                if issue.details:
                    lines.append(f"  > {issue.details}")

        return "\n".join(lines)


# ── Individual validators ──────────────────────────────────────────

def _check_well_formedness(file_name: str, xml_bytes: bytes, report: XmlValidationReport):
    """Check if XML can be parsed by ET.fromstring (round-trip test)."""
    if not xml_bytes:
        return

    # 1. Quick text-level checks for common corruption patterns
    text = xml_bytes.decode("utf-8", errors="replace")

    # 1a. Check for UTF-8 BOM (\ufeff) — should be stripped before ZIP packaging
    if text and text[0] == '\ufeff':
        report.issues.append(XmlIssue(
            severity="warning",
            category="bom",
            file=file_name,
            message="File starts with UTF-8 BOM (U+FEFF) — should be stripped",
            details="BOM prevents XML declaration detection and causes duplicate declarations in _ensure_xml_declarations",
        ))
        # Strip BOM for subsequent checks so they don't produce false positives
        text = text[1:]

    # 1b. Check for duplicate XML declarations
    xml_decl_pattern = re.compile(r'<\?xml[^?]*\?>')
    decl_matches = list(xml_decl_pattern.finditer(text))
    if len(decl_matches) > 1:
        report.issues.append(XmlIssue(
            severity="error",
            category="duplicate_xml_declaration",
            file=file_name,
            message=f"Multiple XML declarations found ({len(decl_matches)})",
            details="An XML document can only have one declaration as the very first thing. "
                    "This is typically caused by _ensure_xml_declarations prepending a new "
                    "declaration to a file that already has one hidden behind a BOM.",
        ))

    # 1c. Stray '<' that isn't part of a tag
    # Match '<' not followed by letter, '/', '!', or '?'
    stray_pattern = re.compile(r'<(?![a-zA-Z/!?])')
    stray_matches = []
    for m in stray_pattern.finditer(text):
        pos = m.start()
        # Get context around the stray character
        ctx_start = max(0, pos - 30)
        ctx_end = min(len(text), pos + 30)
        context = text[ctx_start:ctx_end].replace('\n', '\\n')
        stray_matches.append((pos, context))

    if stray_matches:
        # Only report the first few
        for pos, ctx in stray_matches[:5]:
            report.issues.append(XmlIssue(
                severity="error",
                category="stray_chars",
                file=file_name,
                message=f"Stray '<' character at byte offset {pos} — likely XML corruption",
                details=f"...{ctx}...",
            ))

    # 2. Try parsing (use BOM-stripped text)
    try:
        root = ET.fromstring(text.encode("utf-8"))
    except ET.ParseError as e:
        report.issues.append(XmlIssue(
            severity="error",
            category="well_formedness",
            file=file_name,
            message=f"XML parse error: {e}",
            details=str(e),
        ))
        return  # Can't do further structural checks

    # 3. Check for encoding issues (replacement character U+FFFD)
    if '\ufffd' in text:
        report.issues.append(XmlIssue(
            severity="warning",
            category="encoding",
            file=file_name,
            message="UTF-8 decode used replacement character (U+FFFD) — possible encoding corruption",
        ))

    # 4. Structural checks for document.xml
    if file_name == "word/document.xml":
        _check_document_structure(root, report)


def _check_document_structure(root: ET.Element, report: XmlValidationReport):
    """Structural integrity checks for document.xml."""

    body = root.find(_ns("w", "body"))
    if body is None:
        report.issues.append(XmlIssue(
            severity="error",
            category="structure",
            file="word/document.xml",
            message="Missing w:body element",
        ))
        return

    # ── Bookmark integrity ──
    bookmark_starts = {}  # name → list of elements
    bookmark_ends = {}    # name → list of elements
    for elem in body.iter():
        tag = elem.tag
        if tag == _ns("w", "bookmarkStart"):
            name = elem.get(_ns("w", "name"), "")
            if name:
                bookmark_starts.setdefault(name, []).append(elem)
        elif tag == _ns("w", "bookmarkEnd"):
            bid = elem.get(_ns("w", "id"), "")
            if bid:
                bookmark_ends.setdefault(bid, []).append(elem)

    # Check: each bookmarkStart should have a matching bookmarkEnd (by id)
    start_ids = set()
    for elem in body.iter(_ns("w", "bookmarkStart")):
        bid = elem.get(_ns("w", "id"), "")
        if bid:
            start_ids.add(bid)

    end_ids = set()
    for elem in body.iter(_ns("w", "bookmarkEnd")):
        bid = elem.get(_ns("w", "id"), "")
        if bid:
            end_ids.add(bid)

    unmatched_starts = start_ids - end_ids
    if unmatched_starts:
        report.issues.append(XmlIssue(
            severity="warning",
            category="bookmark_integrity",
            file="word/document.xml",
            message=f"{len(unmatched_starts)} bookmarkStart without matching bookmarkEnd",
            details=f"Unmatched bookmark IDs: {sorted(unmatched_starts)[:10]}",
        ))

    unmatched_ends = end_ids - start_ids
    if unmatched_ends:
        report.issues.append(XmlIssue(
            severity="warning",
            category="bookmark_integrity",
            file="word/document.xml",
            message=f"{len(unmatched_ends)} bookmarkEnd without matching bookmarkStart",
            details=f"Unmatched bookmark IDs: {sorted(unmatched_ends)[:10]}",
        ))

    # ── Comment range integrity ──
    comment_starts = set()
    for elem in body.iter(_ns("w", "commentRangeStart")):
        cid = elem.get(_ns("w", "id"), "")
        if cid:
            comment_starts.add(cid)

    comment_ends = set()
    for elem in body.iter(_ns("w", "commentRangeEnd")):
        cid = elem.get(_ns("w", "id"), "")
        if cid:
            comment_ends.add(cid)

    # commentReference runs
    comment_refs = set()
    for elem in body.iter(_ns("w", "commentReference")):
        cid = elem.get(_ns("w", "id"), "")
        if cid:
            comment_refs.add(cid)

    unmatched_comment_starts = comment_starts - comment_ends
    if unmatched_comment_starts:
        report.issues.append(XmlIssue(
            severity="warning",
            category="comment_integrity",
            file="word/document.xml",
            message=f"{len(unmatched_comment_starts)} commentRangeStart without matching commentRangeEnd",
            details=f"Unmatched comment IDs: {sorted(unmatched_comment_starts)[:10]}",
        ))


    # ── Drawing integrity ──
    drawings = list(body.iter(_ns("w", "drawing")))
    doc_pr_ids = set()
    duplicate_doc_ids = set()
    for drawing in drawings:
        for doc_pr in drawing.iter(_ns("wp", "docPr")):
            did = doc_pr.get("id", "")
            if did:
                if did in doc_pr_ids:
                    duplicate_doc_ids.add(did)
                doc_pr_ids.add(did)

    if duplicate_doc_ids:
        report.issues.append(XmlIssue(
            severity="warning",
            category="drawing_integrity",
            file="word/document.xml",
            message=f"Duplicate docPr id values: {sorted(duplicate_doc_ids)}",
            details="docPr id must be unique across all drawings in the document",
        ))

    # ── Hyperlink integrity ──
    hyperlinks = list(body.iter(_ns("w", "hyperlink")))
    for hl in hyperlinks:
        rid = hl.get(_ns("r", "id"), "")
        if not rid:
            report.issues.append(XmlIssue(
                severity="warning",
                category="hyperlink_integrity",
                file="word/document.xml",
                message="Hyperlink element missing r:id attribute",
            ))


def _check_rels_consistency(files: dict, report: XmlValidationReport):
    """Check that document.xml.rels references match actual files in the ZIP."""
    rels_xml = files.get("word/_rels/document.xml.rels", b"")
    if not rels_xml:
        return

    try:
        rels_root = ET.fromstring(rels_xml)
    except ET.ParseError:
        return  # Already caught by well-formedness check

    rels_ns = NAMESPACES["rels"]
    for rel in rels_root.findall(f"{{{rels_ns}}}Relationship"):
        rid = rel.get("Id", "")
        target = rel.get("Target", "")
        rel_type = rel.get("Type", "")

        # Check that the target file exists in the ZIP
        # Target paths in rels are relative to word/
        target_path = f"word/{target}" if not target.startswith("word/") else target

        if target_path not in files:
            # Only warn for non-external relationships
            if rel_type and "relationships/external" not in rel_type.lower():
                report.issues.append(XmlIssue(
                    severity="warning",
                    category="rels_consistency",
                    file="word/_rels/document.xml.rels",
                    message=f"Relationship {rid} targets '{target}' but file not found in ZIP",
                    details=f"Expected: {target_path}",
                ))


def _check_content_types(files: dict, report: XmlValidationReport):
    """Check that [Content_Types].xml has entries for all files in the ZIP."""
    ct_xml = files.get("[Content_Types].xml", b"")
    if not ct_xml:
        report.issues.append(XmlIssue(
            severity="error",
            category="content_types",
            file="[Content_Types].xml",
            message="Missing [Content_Types].xml",
        ))
        return

    try:
        ct_root = ET.fromstring(ct_xml)
    except ET.ParseError:
        return  # Already caught by well-formedness check

    ct_ns = NAMESPACES["ct"]

    # Collect all registered extensions and part names
    registered_extensions = set()
    registered_parts = set()
    for elem in ct_root:
        if elem.tag == f"{{{ct_ns}}}Default":
            ext = elem.get("Extension", "")
            if ext:
                registered_extensions.add(ext.lower())
        elif elem.tag == f"{{{ct_ns}}}Override":
            part = elem.get("PartName", "")
            if part:
                registered_parts.add(part.lstrip("/").lower())

    # Check critical defaults
    for ext in ("xml", "rels", "png"):
        if ext not in registered_extensions:
            report.issues.append(XmlIssue(
                severity="warning",
                category="content_types",
                file="[Content_Types].xml",
                message=f"Missing Default entry for '{ext}' extension",
                details="docx-preview requires xml and rels defaults to identify file types",
            ))

    # Check that key parts are registered
    key_parts = ["word/document.xml", "word/styles.xml", "word/settings.xml"]
    for part in key_parts:
        if part in files and part.lower() not in registered_parts:
            report.issues.append(XmlIssue(
                severity="warning",
                category="content_types",
                file="[Content_Types].xml",
                message=f"Missing Override entry for '{part}'",
            ))


def _check_notes_consistency(files: dict, report: XmlValidationReport):
    """Check that footnote/endnote references in document.xml have matching definitions."""
    doc_xml = files.get("word/document.xml", b"")
    if not doc_xml:
        return

    try:
        doc_root = ET.fromstring(doc_xml)
    except ET.ParseError:
        return

    body = doc_root.find(_ns("w", "body"))
    if body is None:
        return

    # Collect footnote/endnote reference IDs from document body
    fn_ref_ids = set()
    for elem in body.iter(_ns("w", "footnoteReference")):
        fid = elem.get(_ns("w", "id"), "")
        if fid:
            fn_ref_ids.add(fid)

    en_ref_ids = set()
    for elem in body.iter(_ns("w", "endnoteReference")):
        eid = elem.get(_ns("w", "id"), "")
        if eid:
            en_ref_ids.add(eid)

    # Check footnotes.xml has definitions for all referenced IDs
    if fn_ref_ids:
        fn_xml = files.get("word/footnotes.xml", b"")
        if not fn_xml:
            report.issues.append(XmlIssue(
                severity="warning",
                category="footnote_integrity",
                file="word/footnotes.xml",
                message="Footnote references exist but footnotes.xml is missing",
            ))
        else:
            try:
                fn_root = ET.fromstring(fn_xml)
                defined_fn_ids = set()
                for elem in fn_root.iter(_ns("w", "footnote")):
                    fid = elem.get(_ns("w", "id"), "")
                    if fid:
                        defined_fn_ids.add(fid)
                orphan_refs = fn_ref_ids - defined_fn_ids
                if orphan_refs:
                    report.issues.append(XmlIssue(
                        severity="warning",
                        category="footnote_integrity",
                        file="word/document.xml",
                        message=f"{len(orphan_refs)} footnoteReference IDs have no matching footnote definition",
                        details=f"Orphan IDs: {sorted(orphan_refs)[:10]}",
                    ))
            except ET.ParseError:
                pass

    # Check endnotes.xml has definitions for all referenced IDs
    if en_ref_ids:
        en_xml = files.get("word/endnotes.xml", b"")
        if not en_xml:
            report.issues.append(XmlIssue(
                severity="warning",
                category="endnote_integrity",
                file="word/endnotes.xml",
                message="Endnote references exist but endnotes.xml is missing",
            ))
        else:
            try:
                en_root = ET.fromstring(en_xml)
                defined_en_ids = set()
                for elem in en_root.iter(_ns("w", "endnote")):
                    eid = elem.get(_ns("w", "id"), "")
                    if eid:
                        defined_en_ids.add(eid)
                orphan_refs = en_ref_ids - defined_en_ids
                if orphan_refs:
                    report.issues.append(XmlIssue(
                        severity="warning",
                        category="endnote_integrity",
                        file="word/document.xml",
                        message=f"{len(orphan_refs)} endnoteReference IDs have no matching endnote definition",
                        details=f"Orphan IDs: {sorted(orphan_refs)[:10]}",
                    ))
            except ET.ParseError:
                pass


# ── Main entry point ───────────────────────────────────────────────

def validate_files(files: dict) -> XmlValidationReport:
    """
    Validate all XML files in the docx ZIP before writing.

    Args:
        files: Dict of {filename: bytes} representing the docx ZIP contents.

    Returns:
        XmlValidationReport with errors and warnings.
    """
    report = XmlValidationReport()

    # XML files to validate (skip non-XML like images, fonts, etc.)
    xml_extensions = {".xml", ".rels"}

    for name, data in sorted(files.items()):
        ext = ""
        if "." in name:
            ext = "." + name.rsplit(".", 1)[-1]

        if ext not in xml_extensions:
            continue

        if not isinstance(data, (bytes, bytearray)):
            continue

        # Well-formedness + structural checks
        _check_well_formedness(name, data, report)

    # Cross-file consistency checks
    _check_rels_consistency(files, report)
    _check_content_types(files, report)
    _check_notes_consistency(files, report)

    return report


def validate_and_report(files: dict, verbose: bool = True) -> bool:
    """
    Validate all XML files, print report, and return True if no errors.

    Convenience wrapper for use in apply_edits().
    """
    report = validate_files(files)

    if report.issues and verbose:
        print(report.to_markdown())

    return report.is_ok
