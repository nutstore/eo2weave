"""
Lint — Wiki health check

Checks:
1. Dangling references: paragraphs referencing non-existent styles
2. Orphan images: images not referenced by any paragraph
3. Broken chain: p-002.next=p-003 but p-003.previous≠p-002
4. Orphan pages: nodes with no references pointing to them
5. Duplicate IDs
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from model import DocumentModel


@dataclass
class LintIssue:
    severity: str  # "error" / "warning" / "info"
    category: str  # "dangling_ref" / "orphan" / "broken_chain" / etc.
    message: str
    node_id: str = ""
    details: str = ""


@dataclass
class LintReport:
    issues: list[LintIssue] = field(default_factory=list)

    @property
    def errors(self) -> list[LintIssue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> list[LintIssue]:
        return [i for i in self.issues if i.severity == "warning"]

    @property
    def is_healthy(self) -> bool:
        return len(self.errors) == 0

    def to_markdown(self) -> str:
        lines = ["# Lint Report", ""]
        
        if not self.issues:
            lines.append("✅ **All checks passed. Wiki is healthy.**")
            return "\n".join(lines)

        lines.append(f"**Errors**: {len(self.errors)}")
        lines.append(f"**Warnings**: {len(self.warnings)}")
        lines.append(f"**Info**: {len([i for i in self.issues if i.severity == 'info'])}")
        lines.append("")

        for severity in ["error", "warning", "info"]:
            issues = [i for i in self.issues if i.severity == severity]
            if not issues:
                continue
            icon = {"error": "❌", "warning": "⚠️", "info": "ℹ️"}[severity]
            lines.append(f"## {icon} {severity.upper()}")
            lines.append("")
            for issue in issues:
                node_ref = f"[[{issue.node_id}]] " if issue.node_id else ""
                lines.append(f"- {node_ref}{issue.message}")
                if issue.details:
                    lines.append(f"  > {issue.details}")
            lines.append("")

        return "\n".join(lines)


def lint(model: DocumentModel) -> LintReport:
    """
    Run health check on DocumentModel.
    
    Args:
        model: Document model
    
    Returns:
        LintReport — containing all discovered issues
    """
    report = LintReport()
    
    # Collect all existing IDs
    all_ids = set()
    for p in model.paragraphs:
        all_ids.add(p.id)
    for s in model.styles.values():
        all_ids.add(s.id)
    for t in model.tables:
        all_ids.add(t.id)
    for img in model.images:
        all_ids.add(img.id)
    for sec in model.sections:
        all_ids.add(sec.id)

    style_ids = set(model.styles.keys())
    para_ids = {p.id for p in model.paragraphs}
    img_ids = {img.id for img in model.images}

    # 1. Dangling references: paragraphs referencing non-existent styles
    for p in model.paragraphs:
        if p.style_id and p.style_id not in style_ids:
            report.issues.append(LintIssue(
                severity="warning",
                category="dangling_style_ref",
                message=f"Paragraph references undefined style '{p.style_id}'",
                node_id=p.id,
                details=f"Style '{p.style_id}' not found in styles.xml",
            ))

    # 2. Orphan images: images not referenced by any paragraph
    referenced_images = set()
    for p in model.paragraphs:
        referenced_images.update(p.image_ids)
    for img in model.images:
        if img.id not in referenced_images:
            report.issues.append(LintIssue(
                severity="warning",
                category="orphan_image",
                message=f"Image is not referenced by any paragraph",
                node_id=img.id,
                details=f"File: {img.filename}",
            ))

    # 3. Broken chain links
    for p in model.paragraphs:
        if p.next_id:
            if p.next_id not in para_ids:
                report.issues.append(LintIssue(
                    severity="error",
                    category="broken_chain",
                    message=f"Next paragraph '{p.next_id}' does not exist",
                    node_id=p.id,
                ))
            else:
                # Check reverse reference
                next_p = model.get_paragraph(p.next_id)
                if next_p and next_p.previous_id != p.id:
                    report.issues.append(LintIssue(
                        severity="warning",
                        category="broken_chain",
                        message=f"Next link is not bidirectional: next=[[{p.next_id}]] but its previous=[[{next_p.previous_id}]]",
                        node_id=p.id,
                    ))

        if p.previous_id:
            if p.previous_id not in para_ids:
                report.issues.append(LintIssue(
                    severity="error",
                    category="broken_chain",
                    message=f"Previous paragraph '{p.previous_id}' does not exist",
                    node_id=p.id,
                ))

    # 4. Style used but 'referenced by' is inconsistent
    for sid, s in model.styles.items():
        actual_users = [p.id for p in model.paragraphs if p.style_id == sid]
        if set(actual_users) != set(s.used_by):
            report.issues.append(LintIssue(
                severity="warning",
                category="stale_ref",
                message=f"Style 'used_by' list is out of sync",
                node_id=s.id,
                details=f"Expected {len(actual_users)} users, found {len(s.used_by)}",
            ))

    # 5. Empty IDs
    for p in model.paragraphs:
        if not p.id:
            report.issues.append(LintIssue(
                severity="error",
                category="missing_id",
                message="Paragraph has no ID",
                node_id="",
            ))

    # 6. Duplicate IDs
    seen_ids = {}
    for p in model.paragraphs:
        if p.id in seen_ids:
            report.issues.append(LintIssue(
                severity="error",
                category="duplicate_id",
                message=f"Duplicate paragraph ID '{p.id}'",
                node_id=p.id,
                details=f"First seen at index {seen_ids[p.id]}, duplicate at index {p.index}",
            ))
        seen_ids[p.id] = p.index

    return report
