"""
View Enhancement — View functions for agents to efficiently understand documents

Following OfficeCLI's three view modes, provides:
- scan() — concise outline (~30-50 lines)
- focus(node_id) — node details
- chunk() — chunked reading (segmented output for large documents)
- issues() — issue detection
- stats() — document statistics

These functions operate on DocumentModel (ingest output), not directly on docx.
"""

from __future__ import annotations

from typing import Optional
from model import (
    DocumentModel, ParagraphNode, TableNode, ImageNode,
    StyleNode, SectionNode, CommentNode,
    RunInfo, NodeType,
)


# ── scan() — concise outline ──────────────────────────────────────

def scan(model: DocumentModel, max_lines: int = 50) -> str:
    """
    Generate a concise outline with heading hierarchy, table summaries, image lists, and blank area markers.

    Output ~30-50 lines to let the agent quickly grasp the document overview.
    """
    lines: list[str] = []

    # Document title
    title = model.core_properties.get("title", "") or model.source_file
    creator = model.core_properties.get("creator", "")
    lines.append(f"# {title}")
    if creator:
        lines.append(f"Author: {creator}")
    lines.append("")

    # Statistics summary
    p_count = len(model.paragraphs)
    t_count = len(model.tables)
    i_count = len(model.images)
    s_count = len(model.sections)
    lines.append(f"> {p_count} paragraphs, {t_count} tables, {i_count} images, {s_count} sections")
    if model.headers_footers:
        lines.append(f"> {len(model.headers_footers)} headers/footers")
    if model.comments:
        lines.append(f"> {len(model.comments)} comments")
    if model.footnotes:
        lines.append(f"> {len(model.footnotes)} footnotes")
    lines.append("")

    # Iterate paragraphs, output only headings and key content
    line_budget = max_lines - len(lines) - 5  # reserve space for tail
    blank_streak = 0

    for para in model.paragraphs:
        if len(lines) >= max_lines:
            lines.append(f"... ({p_count - para.index} more paragraphs)")
            break

        text = para.text.strip()

        # Detect if this is a heading
        style = para.style or ""
        is_heading = False
        heading_level = 0

        if style.lower().startswith("heading"):
            try:
                heading_level = int(style[7:])
            except ValueError:
                heading_level = 1
            is_heading = True
        elif style.lower() == "title":
            heading_level = 1
            is_heading = True
        elif style.lower() == "subtitle":
            heading_level = 2
            is_heading = True

        if is_heading:
            blank_streak = 0
            prefix = "#" * (heading_level + 1)  # h1 → ##, h2 → ###, etc.
            lines.append(f"{prefix} {text or '(empty heading)'}")
        elif not text:
            blank_streak += 1
            if blank_streak <= 2:
                lines.append("")  # keep at most 2 blank lines
        else:
            blank_streak = 0
            # Non-heading paragraph: truncate for display
            display = text if len(text) <= 100 else text[:97] + "..."
            lines.append(display)

    # Table summary
    if model.tables:
        lines.append("")
        lines.append("## Tables")
        for i, tbl in enumerate(model.tables):
            rows = tbl.rows if hasattr(tbl, 'rows') else 0
            cols = tbl.cols if hasattr(tbl, 'cols') else 0
            # Extract first row text (cells with row=0)
            first_row_text = ""
            if hasattr(tbl, 'cells') and tbl.cells:
                row0_cells = [c for c in tbl.cells if c.row == 0]
                if row0_cells:
                    first_row_text = " | ".join(
                        c.text[:30] if c.text else ""
                        for c in sorted(row0_cells, key=lambda c: c.col)[:5]
                    )
            lines.append(f"  [{i}] {rows}×{cols or '?'} — {first_row_text or '(empty table)'}")

    # Image summary
    if model.images:
        lines.append("")
        lines.append("## Images")
        for i, img in enumerate(model.images[:10]):  # show at most 10
            name = img.id if hasattr(img, 'id') else f"image-{i}"
            width = img.width if hasattr(img, 'width') else 0
            height = img.height if hasattr(img, 'height') else 0
            desc = img.description if hasattr(img, 'description') else ""
            size_str = f"{width}×{height}" if width and height else ""
            desc_str = f" — {desc}" if desc else ""
            lines.append(f"  [{i}] {name} {size_str}{desc_str}")
        if len(model.images) > 10:
            lines.append(f"  ... and {len(model.images) - 10} more")

    return "\n".join(lines)


# ── focus() — node details ─────────────────────────────────────

def focus(model: DocumentModel, node_id: str) -> str:
    """
    View node details.

    Paragraph: full text + runs + format properties
    Table: full content + merge info
    Image: dimensions, alt text, embedding position
    """
    lines: list[str] = []

    # Try as paragraph
    para = model._paragraph_by_id.get(node_id)
    if para:
        return _focus_paragraph(para, model)

    # Try as table
    for i, tbl in enumerate(model.tables):
        if tbl.id == node_id:
            return _focus_table(tbl, i)

    # Try as image
    for i, img in enumerate(model.images):
        if img.id == node_id:
            return _focus_image(img, i)

    # Try as style
    if node_id.startswith("style-"):
        style_id = node_id[6:]  # remove "style-" prefix
        style = model.styles.get(style_id)
        if style:
            return _focus_style(style)
    else:
        # Also try looking up node_id directly as style_id
        style = model.styles.get(node_id)
        if style:
            return _focus_style(style)

    # Try as comment
    for i, cmt in enumerate(model.comments):
        if cmt.id == node_id:
            return _focus_comment(cmt, model)

    # Not found
    return f"Node not found: {node_id}\nUse scan() to see available node IDs."


def _focus_paragraph(para: ParagraphNode, model: DocumentModel) -> str:
    """Paragraph details"""
    lines: list[str] = []
    lines.append(f"## Paragraph: {para.id}")
    lines.append(f"Index: {para.index}")
    lines.append(f"Style: {para.style}")
    lines.append("")

    # Text
    lines.append(f"Text: \"{para.text}\"")
    lines.append("")

    # Format properties
    fmt_props = {}
    if para.alignment:
        fmt_props["alignment"] = para.alignment
    if para.indentation_left:
        fmt_props["indent_left"] = para.indentation_left
    if para.indentation_first_line:
        fmt_props["indent_first_line"] = para.indentation_first_line
    if para.spacing_before:
        fmt_props["spacing_before"] = para.spacing_before
    if para.spacing_after:
        fmt_props["spacing_after"] = para.spacing_after
    if para.line_spacing:
        fmt_props["line_spacing"] = para.line_spacing
    if para.num_id:
        fmt_props["num_id"] = para.num_id
    if para.ilvl:
        fmt_props["ilvl"] = para.ilvl
    if hasattr(para, "shading_fill") and para.shading_fill:
        fmt_props["shading_fill"] = para.shading_fill
    if hasattr(para, "shading_val") and para.shading_val:
        fmt_props["shading_val"] = para.shading_val
    if hasattr(para, "borders") and para.borders:
        fmt_props["borders"] = para.borders
    if hasattr(para, "tab_stops") and para.tab_stops:
        fmt_props["tab_stops"] = para.tab_stops
    if hasattr(para, "outline_level") and para.outline_level >= 0:
        fmt_props["outline_level"] = para.outline_level

    if fmt_props:
        lines.append("### Paragraph Format")
        for k, v in fmt_props.items():
            lines.append(f"  {k}: {v}")
        lines.append("")

    # Runs
    if para.runs:
        lines.append(f"### Runs ({len(para.runs)})")
        for i, run in enumerate(para.runs):
            run_text = run.text or ""
            props = []
            if run.bold:
                props.append("bold")
            if run.italic:
                props.append("italic")
            if run.has_underline or run.underline:
                props.append(f"underline:{run.underline_val or 'single'}")
            if run.strike:
                props.append("strike")
            if run.font_name:
                props.append(f"font:{run.font_name}")
            if run.font_size:
                props.append(f"size:{run.font_size}")
            if run.color:
                props.append(f"color:{run.color}")
            if run.hyperlink_url:
                props.append(f"link:{run.hyperlink_url}")
            if run.field_type:
                props.append(f"field:{run.field_type}")
            if run.field_instruction:
                props.append(f"instr:{run.field_instruction}")
            if hasattr(run, 'char_scale') and run.char_scale:
                props.append(f"scale:{run.char_scale}%")
            if hasattr(run, 'kern') and run.kern:
                props.append(f"kern:{run.kern}")
            if hasattr(run, 'position') and run.position:
                props.append(f"pos:{run.position}")

            prop_str = f" [{', '.join(props)}]" if props else ""
            display = run_text if len(run_text) <= 60 else run_text[:57] + "..."
            lines.append(f"  [{i}] \"{display}\"{prop_str}")
        lines.append("")

    # Associations
    if para.image_ids:
        lines.append(f"### Images: {', '.join(para.image_ids)}")
    if para.table_id:
        lines.append(f"### Table: {para.table_id}")
    if para.comment_ids:
        lines.append(f"### Comments: {', '.join(para.comment_ids)}")
    if para.footnote_ids:
        lines.append(f"### Footnotes: {', '.join(para.footnote_ids)}")
    if para.bookmarks:
        lines.append(f"### Bookmarks: {', '.join(para.bookmarks)}")

    # Context
    if para.previous_id:
        prev = model._paragraph_by_id.get(para.previous_id)
        if prev:
            prev_text = prev.text[:60] if prev.text else "(empty)"
            lines.append(f"### Context")
            lines.append(f"  Prev ({para.previous_id}): \"{prev_text}\"")
    if para.next_id:
        nxt = model._paragraph_by_id.get(para.next_id)
        if nxt:
            nxt_text = nxt.text[:60] if nxt.text else "(empty)"
            if "### Context" not in lines:
                lines.append("### Context")
            lines.append(f"  Next ({para.next_id}): \"{nxt_text}\"")

    return "\n".join(lines)


def _focus_table(tbl: TableNode, index: int) -> str:
    """Table details"""
    lines: list[str] = []
    lines.append(f"## Table: {tbl.id} (index {index})")
    lines.append(f"Size: {tbl.rows} rows × {tbl.cols} cols")
    lines.append("")

    if hasattr(tbl, 'cells') and tbl.cells:
        # Group cells by row
        rows_dict: dict[int, list] = {}
        for c in tbl.cells:
            rows_dict.setdefault(c.row, []).append(c)

        for r in sorted(rows_dict.keys()):
            row_cells = sorted(rows_dict[r], key=lambda c: c.col)
            cells_text = []
            for c in row_cells:
                t = c.text[:30] if c.text else ""
                extra = ""
                if hasattr(c, 'grid_span') and c.grid_span and c.grid_span > 1:
                    extra += f" [span:{c.grid_span}]"
                if hasattr(c, 'v_merge') and c.v_merge:
                    extra += f" [vmerge:{c.v_merge}]"
                if hasattr(c, 'text_direction') and c.text_direction:
                    extra += f" [dir:{c.text_direction}]"
                if c.merge_type == "first":
                    extra += " [merge_origin]"
                elif c.merge_type in ("horizontal", "vertical", "continue"):
                    extra += " [merged]"
                cells_text.append(f"{t}{extra}")
            lines.append(f"  Row {r}: {' | '.join(cells_text)}")
    else:
        lines.append("(no cell data available)")
        if hasattr(tbl, 'paragraph_ids') and tbl.paragraph_ids:
            lines.append(f"Paragraph IDs: {', '.join(tbl.paragraph_ids[:10])}")

    return "\n".join(lines)


def _focus_image(img: ImageNode, index: int) -> str:
    """Image details"""
    lines: list[str] = []
    lines.append(f"## Image: {img.id} (index {index})")

    if hasattr(img, 'width') and img.width:
        lines.append(f"Size: {img.width}×{img.height or '?'}")
    if hasattr(img, 'description') and img.description:
        lines.append(f"Alt text: {img.description}")

    # Layout info
    layout = getattr(img, 'layout', 'inline')
    lines.append(f"Layout: {layout}")
    if layout == "anchor":
        wrap = getattr(img, 'wrap', '')
        if wrap:
            lines.append(f"Wrap: {wrap}")
        behind = getattr(img, 'behind_doc', False)
        if behind:
            lines.append(f"Behind doc: True")
        pos_h_rel = getattr(img, 'position_h_relative', '')
        pos_h_off = getattr(img, 'position_h_offset', '')
        if pos_h_rel:
            lines.append(f"Position H: {pos_h_rel} + {pos_h_off} EMU")
        pos_v_rel = getattr(img, 'position_v_relative', '')
        pos_v_off = getattr(img, 'position_v_offset', '')
        if pos_v_rel:
            lines.append(f"Position V: {pos_v_rel} + {pos_v_off} EMU")

    if hasattr(img, 'embedded_in') and img.embedded_in:
        lines.append(f"Embedded in: {', '.join(img.embedded_in)}")

    return "\n".join(lines)


def _focus_style(style: StyleNode) -> str:
    """Style details"""
    lines: list[str] = []
    lines.append(f"## Style: {style.id}")
    lines.append(f"Name: {style.name}")
    lines.append(f"Type: {style.style_type}")
    if style.based_on:
        lines.append(f"Based on: {style.based_on}")

    # Run properties
    run_props = []
    if style.font_name:
        run_props.append(f"font: {style.font_name}")
    if style.font_size:
        pt = int(style.font_size) / 2 if style.font_size.isdigit() else style.font_size
        run_props.append(f"size: {pt}pt")
    if style.bold:
        run_props.append("bold")
    if style.italic:
        run_props.append("italic")
    if style.underline:
        run_props.append("underline")
    if style.color:
        run_props.append(f"color: {style.color}")
    if run_props:
        lines.append("### Run Properties")
        for prop in run_props:
            lines.append(f"  {prop}")

    # Paragraph properties
    para_props = []
    if style.alignment:
        para_props.append(f"alignment: {style.alignment}")
    if style.spacing_before:
        para_props.append(f"spacing_before: {style.spacing_before}")
    if style.spacing_after:
        para_props.append(f"spacing_after: {style.spacing_after}")
    if style.line_spacing:
        para_props.append(f"line_spacing: {style.line_spacing}")
    if style.indentation_left:
        para_props.append(f"indentation_left: {style.indentation_left}")
    if para_props:
        lines.append("### Paragraph Properties")
        for prop in para_props:
            lines.append(f"  {prop}")

    # Users
    if style.used_by:
        lines.append(f"### Used By ({len(style.used_by)})")
        for uid in style.used_by[:10]:
            lines.append(f"  {uid}")
        if len(style.used_by) > 10:
            lines.append(f"  ... and {len(style.used_by) - 10} more")

    return "\n".join(lines)


def _focus_comment(cmt: CommentNode, model: DocumentModel) -> str:
    """Comment details"""
    lines: list[str] = []
    lines.append(f"## Comment: {cmt.id}")
    lines.append(f"Author: {cmt.author}")
    if hasattr(cmt, 'date') and cmt.date:
        lines.append(f"Date: {cmt.date}")
    lines.append(f"Text: {cmt.text}")
    if hasattr(cmt, 'paragraph_ids') and cmt.paragraph_ids:
        lines.append(f"Targets: {', '.join(cmt.paragraph_ids)}")
        for pid in cmt.paragraph_ids:
            p = model._paragraph_by_id.get(pid)
            if p:
                lines.append(f"  → {pid}: \"{p.text[:60]}\"")

    return "\n".join(lines)


# ── chunk() — chunked reading (segmented output for large documents) ───────

def chunk(model: DocumentModel,
          strategy: str = "fixed",
          size: int = 50,
          start_id: str = "",
          end_id: str = "",
          section_index: int = -1) -> list[dict]:
    """
    Chunk the document for output, used for segmented reading of large documents.

    Each chunk contains full paragraph text (not truncated), suitable for subagents to read chunk by chunk.

    Strategies:
      - "fixed":    chunk by fixed paragraph count (default 50 paragraphs/chunk)
      - "heading":  chunk by Heading1 titles (one chunk per chapter)
      - "range":    chunk by paragraph ID range (start_id to end_id)
      - "section":  chunk by Word section (specified by section_index)

    Returns: list[dict], each dict contains:
      - index:    chunk sequence number (0-based)
      - start_id: starting paragraph ID
      - end_id:   ending paragraph ID
      - paragraphs: number of paragraphs
      - chars:    total character count
      - content:  full text content (paragraphs separated by newlines, with level markers)

    Usage examples:
      chunks = chunk(model, strategy="fixed", size=50)
      chunks = chunk(model, strategy="heading")
      chunks = chunk(model, strategy="range", start_id="p-010", end_id="p-050")
      chunks = chunk(model, strategy="section", section_index=0)
    """
    paragraphs = model.paragraphs
    if not paragraphs:
        return []

    if strategy == "range":
        return _chunk_by_range(model, start_id, end_id)
    elif strategy == "heading":
        return _chunk_by_heading(model)
    elif strategy == "section":
        return _chunk_by_section(model, section_index)
    else:  # "fixed"
        return _chunk_fixed(model, size)


def _format_para(para: ParagraphNode) -> str:
    """Format a paragraph as a text line with level markers"""
    text = para.text
    style = (para.style or "").lower()

    if style == "title":
        return f"# {text}"
    elif style == "subtitle":
        return f"## {text}"
    elif style.startswith("heading"):
        try:
            level = int(style[7:])
        except ValueError:
            level = 1
        prefix = "#" * (level + 1)
        return f"{prefix} {text}"
    else:
        return text


def _make_chunk(index: int, paras: list[ParagraphNode]) -> dict:
    """Build a chunk dict from a list of paragraphs"""
    lines = [_format_para(p) for p in paras]
    content = "\n".join(lines)
    return {
        "index": index,
        "start_id": paras[0].id if paras else "",
        "end_id": paras[-1].id if paras else "",
        "paragraphs": len(paras),
        "chars": len(content),
        "content": content,
    }


def _chunk_fixed(model: DocumentModel, size: int) -> list[dict]:
    """Chunk by fixed paragraph count"""
    paragraphs = model.paragraphs
    chunks = []
    for i in range(0, len(paragraphs), size):
        slice_paras = paragraphs[i:i + size]
        chunks.append(_make_chunk(len(chunks), slice_paras))
    return chunks


def _chunk_by_heading(model: DocumentModel) -> list[dict]:
    """Chunk by Heading1 titles (one chunk per chapter)"""
    paragraphs = model.paragraphs
    chunks: list[dict] = []
    current: list[ParagraphNode] = []

    for para in paragraphs:
        style = (para.style or "").lower()
        is_h1 = style == "heading 1" or style.startswith("heading") and style.endswith("1")

        if is_h1 and current:
            chunks.append(_make_chunk(len(chunks), current))
            current = []
        current.append(para)

    if current:
        chunks.append(_make_chunk(len(chunks), current))

    return chunks


def _chunk_by_range(model: DocumentModel, start_id: str, end_id: str) -> list[dict]:
    """Chunk by paragraph ID range"""
    paragraphs = model.paragraphs
    start_idx = 0
    end_idx = len(paragraphs) - 1

    if start_id:
        for i, p in enumerate(paragraphs):
            if p.id == start_id:
                start_idx = i
                break

    if end_id:
        for i, p in enumerate(paragraphs):
            if p.id == end_id:
                end_idx = i
                break

    if start_idx > end_idx:
        start_idx, end_idx = end_idx, start_idx

    slice_paras = paragraphs[start_idx:end_idx + 1]
    return [_make_chunk(0, slice_paras)] if slice_paras else []


def _chunk_by_section(model: DocumentModel, section_index: int) -> list[dict]:
    """Chunk by Word section"""
    if not model.sections:
        # No section info, fall back to fixed
        return _chunk_fixed(model, 50)

    if section_index < 0 or section_index >= len(model.sections):
        # Return all sections
        chunks = []
        for sec in model.sections:
            sec_paras = []
            for pid in sec.paragraph_ids:
                p = model._paragraph_by_id.get(pid)
                if p:
                    sec_paras.append(p)
            if sec_paras:
                # Sort by original order
                sec_paras.sort(key=lambda p: p.index)
                chunks.append(_make_chunk(len(chunks), sec_paras))
        return chunks
    else:
        sec = model.sections[section_index]
        sec_paras = []
        for pid in sec.paragraph_ids:
            p = model._paragraph_by_id.get(pid)
            if p:
                sec_paras.append(p)
        if sec_paras:
            sec_paras.sort(key=lambda p: p.index)
            return [_make_chunk(0, sec_paras)]
        return []


# ── issues() — issue detection ──────────────────────────────────────

def issues(model: DocumentModel) -> str:
    """
    Detect issues in the document:
    - Empty paragraphs
    - Images missing alt text
    - Style inconsistencies
    - Broken cross-references
    """
    lines: list[str] = []
    issue_count = 0

    # 1. Empty paragraphs (3+ consecutive)
    consecutive_blank = 0
    blank_start = 0
    for para in model.paragraphs:
        if not para.text.strip():
            if consecutive_blank == 0:
                blank_start = para.index
            consecutive_blank += 1
        else:
            if consecutive_blank >= 3:
                lines.append(f"⚠️  {consecutive_blank} consecutive blank paragraphs at indices {blank_start}-{blank_start + consecutive_blank - 1}")
                issue_count += 1
            consecutive_blank = 0
    if consecutive_blank >= 3:
        lines.append(f"⚠️  {consecutive_blank} consecutive blank paragraphs at indices {blank_start}-{blank_start + consecutive_blank - 1}")
        issue_count += 1

    # 2. Images missing alt text
    if model.images:
        for img in model.images:
            desc = img.description if hasattr(img, 'description') else ""
            if not desc:
                lines.append(f"⚠️  Image {img.id} missing alt text")
                issue_count += 1

    # 3. Very long paragraphs (potential layout issues)
    for para in model.paragraphs:
        if len(para.text) > 2000:
            display = para.text[:60] + "..."
            lines.append(f"⚠️  Very long paragraph {para.id} ({len(para.text)} chars): \"{display}\"")
            issue_count += 1

    # 4. References to non-existent styles
    style_ids = set(model.styles.keys())
    style_ids.add("Normal")  # default style
    for para in model.paragraphs:
        if para.style_id and para.style_id not in style_ids:
            lines.append(f"⚠️  Paragraph {para.id} references unknown style: {para.style_id}")
            issue_count += 1

    # 5. Too many empty cells in tables
    for i, tbl in enumerate(model.tables):
        if hasattr(tbl, 'cells') and tbl.cells:
            total_cells = len(tbl.cells)
            empty_cells = sum(1 for c in tbl.cells if not c.text.strip())
            if total_cells > 0 and empty_cells / total_cells > 0.5:
                lines.append(f"⚠️  Table {tbl.id} has {empty_cells}/{total_cells} empty cells ({empty_cells*100//total_cells}%)")
                issue_count += 1

    if issue_count == 0:
        lines.append("✅ No issues found.")
    else:
        lines.insert(0, f"Found {issue_count} issue(s):")
        lines.append("")
        lines.append(f"Total: {issue_count} issues")

    return "\n".join(lines)


# ── Paper size lookup ────────────────────────────────────────

# Standard paper sizes in twips (w_portrait, h_portrait)
_PAPER_SIZES = {
    "A4":     (11906, 16838),
    "A3":     (16838, 23811),
    "Letter": (12240, 15840),
    "Legal":  (12240, 20160),
    "B5":     (10063, 14173),
}


def _identify_paper_size(w: str, h: str) -> str:
    """Identify paper name from pgSz w/h. Supports portrait and landscape."""
    try:
        w_int, h_int = int(w), int(h)
    except (ValueError, TypeError):
        return ""
    for name, (pw, ph) in _PAPER_SIZES.items():
        if (w_int == pw and h_int == ph) or (w_int == ph and h_int == pw):
            return name
    return ""


# ── stats() — document statistics ──────────────────────────────────────

def stats(model: DocumentModel) -> str:
    """
    Document statistics:
    - Paragraph count, word count, style distribution, font distribution
    """
    lines: list[str] = []

    # Basic info
    title = model.core_properties.get("title", "") or model.source_file
    lines.append(f"# Document Statistics: {title}")
    lines.append("")

    # Paragraphs and word count
    p_count = len(model.paragraphs)
    total_chars = sum(len(p.text) for p in model.paragraphs)
    total_words = sum(len(p.text.split()) for p in model.paragraphs)
    non_empty = sum(1 for p in model.paragraphs if p.text.strip())

    lines.append(f"## Overview")
    lines.append(f"  Paragraphs: {p_count} ({non_empty} non-empty)")
    lines.append(f"  Characters: {total_chars:,}")
    lines.append(f"  Words (whitespace-split): {total_words:,}")
    lines.append(f"  Tables: {len(model.tables)}")
    lines.append(f"  Images: {len(model.images)}")
    lines.append(f"  Sections: {len(model.sections)}")

    # Page size info (show human-readable paper name)
    if model.sections:
        sec0 = model.sections[0]
        if sec0.page_width and sec0.page_height:
            paper_name = _identify_paper_size(sec0.page_width, sec0.page_height)
            w_mm = int(sec0.page_width) / 1440 * 25.4
            h_mm = int(sec0.page_height) / 1440 * 25.4
            orient = sec0.orientation or ("portrait" if int(sec0.page_width) <= int(sec0.page_height) else "landscape")
            if paper_name:
                lines.append(f"  Paper: {paper_name} {orient} ({w_mm:.0f}mm × {h_mm:.0f}mm)")
            else:
                lines.append(f"  Paper: {w_mm:.0f}mm × {h_mm:.0f}mm ({orient})")
    lines.append("")

    # Style distribution
    style_dist: dict[str, int] = {}
    for para in model.paragraphs:
        s = para.style
        style_dist[s] = style_dist.get(s, 0) + 1

    if style_dist:
        lines.append("## Style Distribution")
        for style, count in sorted(style_dist.items(), key=lambda x: -x[1]):
            lines.append(f"  {style}: {count}")
        lines.append("")

    # Font distribution
    font_dist: dict[str, int] = {}
    for para in model.paragraphs:
        for run in para.runs:
            if run.font_name:
                font_dist[run.font_name] = font_dist.get(run.font_name, 0) + 1

    if font_dist:
        lines.append("## Font Distribution")
        for font, count in sorted(font_dist.items(), key=lambda x: -x[1])[:15]:
            lines.append(f"  {font}: {count} runs")
        if len(font_dist) > 15:
            lines.append(f"  ... and {len(font_dist) - 15} more")
        lines.append("")

    # Run format statistics
    bold_count = sum(1 for p in model.paragraphs for r in p.runs if r.bold)
    italic_count = sum(1 for p in model.paragraphs for r in p.runs if r.italic)
    link_count = sum(1 for p in model.paragraphs for r in p.runs if r.hyperlink_url)
    total_runs = sum(len(p.runs) for p in model.paragraphs)

    if total_runs > 0:
        lines.append("## Formatting")
        lines.append(f"  Total runs: {total_runs}")
        lines.append(f"  Bold: {bold_count} ({bold_count*100//total_runs}%)")
        lines.append(f"  Italic: {italic_count} ({italic_count*100//total_runs}%)")
        lines.append(f"  Hyperlinks: {link_count}")
        lines.append("")

    # Special content
    comments_count = len(model.comments)
    footnotes_count = len(model.footnotes)
    hf_count = len(model.headers_footers)

    if comments_count or footnotes_count or hf_count:
        lines.append("## Special Content")
        if hf_count:
            lines.append(f"  Headers/Footers: {hf_count}")
        if comments_count:
            lines.append(f"  Comments: {comments_count}")
        if footnotes_count:
            lines.append(f"  Footnotes: {footnotes_count}")

    return "\n".join(lines)
