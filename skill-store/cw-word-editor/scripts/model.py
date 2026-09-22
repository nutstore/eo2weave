"""
Data models — core data structures for word-editor

Design principles:
- Node is the basic unit of Wiki, each node corresponds to a markdown page
- Each node has a unique ID, type, metadata, and reference list
- DocumentModel holds all nodes and reference graph, is the complete representation of Wiki
- EditOp is a structured edit instruction, produced by Agent, consumed by Writeback
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional


# ── Namespaces ──────────────────────────────────────────────

NAMESPACES = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
}


def ns(tag: str) -> str:
    """Convert 'w:p' to fully qualified namespace URI"""
    prefix, local = tag.split(":")
    return f"{{{NAMESPACES[prefix]}}}{local}"


# ── Node types ──────────────────────────────────────────────

class NodeType(str, Enum):
    PARAGRAPH = "paragraph"
    STYLE = "style"
    TABLE = "table"
    IMAGE = "image"
    SECTION = "section"
    COMMENT = "comment"


# ── Base nodes ──────────────────────────────────────────────

@dataclass
class WikiNode:
    """Wiki node base class"""
    id: str = ""
    node_type: NodeType = NodeType.PARAGRAPH  # overridden by subclass in __post_init__
    references: list[str] = field(default_factory=list)  # [[id]] reference list
    reverse_refs: list[str] = field(default_factory=list)  # reverse references (who references me)
    xpath: str = ""
    xml_path: str = ""

    def wiki_link(self) -> str:
        return f"[[{self.id}]]"

    def file_path(self) -> str:
        """Return relative file path in wiki"""
        type_dirs = {
            NodeType.PARAGRAPH: "paragraphs",
            NodeType.STYLE: "styles",
            NodeType.TABLE: "tables",
            NodeType.IMAGE: "images",
            NodeType.SECTION: "sections",
        }
        d = type_dirs.get(self.node_type, "other")
        return f"{d}/{self.id}.md"


@dataclass
class RunInfo:
    """Information about a single run in a paragraph"""
    text: str = ""
    bold: bool = False
    italic: bool = False
    underline: bool = False
    underline_val: str = ""  # underline type: "single", "double", "wave", "dotted", "dash", "thick", "none"
    font_name: str = ""
    font_size: str = ""  # half-points, e.g. "24" = 12pt
    color: str = ""      # w:color val, e.g. "FF0000"
    strike: bool = False  # strikethrough
    # ── Blank fill area detection ──
    is_blank: bool = False  # whether this is a blank fill area in template (text is all whitespace)
    has_underline: bool = False  # whether it has underline format (used to distinguish fill area from label area)
    # ── Track changes ──
    is_insertion: bool = False
    is_deletion: bool = False
    revision_id: str = ""
    revision_author: str = ""
    revision_date: str = ""
    # ── Hyperlink ──
    hyperlink_url: str = ""
    # ── Fields ──
    field_type: str = ""
    field_instruction: str = ""
    # ── Advanced run formatting ──
    char_scale: str = ""    # character scaling (percentage), e.g. "150" = 150%
    kern: str = ""          # kerning (half-points), e.g. "24" = 12pt
    position: str = ""      # baseline offset (half-points), positive=up, negative=down

    def to_markdown(self) -> str:
        """Convert run to markdown inline format"""
        text = self.text
        if self.bold and self.italic:
            text = f"***{text}***"
        elif self.bold:
            text = f"**{text}**"
        elif self.italic:
            text = f"*{text}*"
        if self.underline:
            text = f"<u>{text}</u>"
        return text


@dataclass
class ParagraphNode(WikiNode):
    """Paragraph node"""
    index: int = 0  # sequential index in document
    style_id: str = ""  # w:pStyle val (raw XML styleId, e.g. "876", "Heading1")
    _style_name: str = ""  # human-readable style name (filled by ingest from style_map, e.g. "Normal", "Title")
    text: str = ""
    runs: list[RunInfo] = field(default_factory=list)
    section_id: str = ""  # owning section
    previous_id: str = ""
    next_id: str = ""
    # Embedded resource references
    image_ids: list[str] = field(default_factory=list)
    table_id: str = ""  # if paragraph contains a table
    # Format properties
    alignment: str = ""
    indentation_left: str = ""
    indentation_first_line: str = ""
    spacing_before: str = ""
    spacing_after: str = ""
    line_spacing: str = ""
    sdt_alias: str = ""
    # ── List/numbering ──
    num_id: str = ""
    ilvl: int = -1
    # ── Bookmarks/comments/footnotes ──
    bookmarks: list = field(default_factory=list)
    comment_ids: list = field(default_factory=list)
    footnote_ids: list = field(default_factory=list)
    endnote_ids: list = field(default_factory=list)
    # ── Shading ──
    shading_fill: str = ""
    shading_val: str = ""
    # ── Paragraph borders ──
    borders: dict = field(default_factory=dict)  # {side: {val, sz, space, color}}
    # ── Tab stops ──
    tab_stops: list[dict] = field(default_factory=list)  # [{val, pos, leader?, fill?}, ...]
    # ── Outline level ──
    outline_level: int = -1  # -1=not set, 0=Level 1, ..., 8=Level 9

    def __post_init__(self):
        self.node_type = NodeType.PARAGRAPH

    @property
    def style(self) -> str:
        """Return human-readable style name (e.g. "Normal", "Heading1", "Title").

        Filled by ingest from style_map. Falls back to style_id if not filled or mapping not found.
        """
        return self._style_name or self.style_id or "Normal"

    def build_references(self):
        """Build reference list from fields"""
        refs = []
        if self.style_id:
            refs.append(f"style-{self.style_id}")
        if self.section_id:
            refs.append(self.section_id)
        if self.previous_id:
            refs.append(self.previous_id)
        if self.next_id:
            refs.append(self.next_id)
        for img_id in self.image_ids:
            refs.append(img_id)
        if self.table_id:
            refs.append(self.table_id)
        self.references = refs

    def to_markdown(self) -> str:
        """Generate complete wiki page markdown"""
        self.build_references()
        # Frontmatter
        fm = {
            "id": self.id,
            "type": "paragraph",
            "index": self.index,
            "style": f"[[style-{self.style_id}]]" if self.style_id else "",
            "section": f"[[{self.section_id}]]" if self.section_id else "",
            "previous": f"[[{self.previous_id}]]" if self.previous_id else "",
            "next": f"[[{self.next_id}]]" if self.next_id else "",
            "xpath": self.xpath,
            "xml_path": self.xml_path,
        }
        lines = ["---"]
        for k, v in fm.items():
            lines.append(f'{k}: "{v}"' if v else f"{k}: ")
        lines.append("---")
        lines.append("")
        lines.append(f"# {self.id}")
        lines.append("")

        # Text content
        if self.text.strip():
            # Infer heading level from style
            heading = ""
            if self.style_id and self.style_id.startswith("Heading"):
                try:
                    level = int(self.style_id.replace("Heading", "").replace("heading", "").strip())
                    heading = "#" * min(level + 1, 6) + " "
                except ValueError:
                    pass
            lines.append(f"## Text")
            lines.append("")
            lines.append(f"{heading}{self.text}")
            lines.append("")

        # Runs detail table
        if self.runs:
            lines.append("## Runs")
            lines.append("")
            # Check if there are blank fill areas
            has_blanks = any(r.is_blank for r in self.runs)
            if has_blanks:
                lines.append("| # | Text | Bold | Italic | Underline | Blank | Font | Size |")
                lines.append("|---|------|------|--------|-----------|-------|------|------|")
                for i, run in enumerate(self.runs):
                    text_escaped = run.text.replace("|", "\\|").replace("\n", "\\n")
                    ul = run.underline_val or ("yes" if run.underline else "no")
                    blank_marker = "⬜ **fill**" if run.is_blank else ""
                    lines.append(
                        f"| {i+1} | {text_escaped} | {'yes' if run.bold else 'no'} "
                        f"| {'yes' if run.italic else 'no'} | {ul} | {blank_marker} | {run.font_name} | {run.font_size} |"
                    )
            else:
                lines.append("| # | Text | Bold | Italic | Font | Size |")
                lines.append("|---|------|------|--------|------|------|")
                for i, run in enumerate(self.runs):
                    text_escaped = run.text.replace("|", "\\|").replace("\n", "\\n")
                    lines.append(
                        f"| {i+1} | {text_escaped} | {'yes' if run.bold else 'no'} "
                        f"| {'yes' if run.italic else 'no'} | {run.font_name} | {run.font_size} |"
                    )
            lines.append("")

        # Format properties
        fmt_props = []
        if self.alignment:
            fmt_props.append(f"- **Alignment**: {self.alignment}")
        if self.indentation_left:
            fmt_props.append(f"- **Indentation (left)**: {self.indentation_left}")
        if self.indentation_first_line:
            fmt_props.append(f"- **First line indent**: {self.indentation_first_line}")
        if self.spacing_before or self.spacing_after:
            fmt_props.append(f"- **Spacing**: before={self.spacing_before or 'inherit'}, after={self.spacing_after or 'inherit'}")
        if self.line_spacing:
            fmt_props.append(f"- **Line spacing**: {self.line_spacing}")
        if fmt_props:
            lines.append("## Format")
            lines.append("")
            lines.extend(fmt_props)
            lines.append("")

        # Reference context
        lines.append("## Context")
        lines.append("")
        if self.style_id:
            lines.append(f"- **Style**: [[style-{self.style_id}]]")
        if self.section_id:
            lines.append(f"- **Section**: [[{self.section_id}]]")
        if self.previous_id:
            lines.append(f"- **Previous**: [[{self.previous_id}]]")
        if self.next_id:
            lines.append(f"- **Next**: [[{self.next_id}]]")
        for img_id in self.image_ids:
            lines.append(f"- **Image**: [[{img_id}]]")
        if self.table_id:
            lines.append(f"- **Table**: [[{self.table_id}]]")
        lines.append("")

        return "\n".join(lines)


@dataclass
class StyleNode(WikiNode):
    """Style node"""
    style_id: str = ""
    style_type: str = ""  # paragraph / character / table / numbering
    name: str = ""
    based_on: str = ""  # which style this is based on
    is_default: bool = False
    # Font properties
    font_name: str = ""
    font_size: str = ""  # half-points
    bold: bool = False
    italic: bool = False
    underline: bool = False
    color: str = ""
    # Paragraph properties
    alignment: str = ""
    spacing_before: str = ""
    spacing_after: str = ""
    line_spacing: str = ""
    indentation_left: str = ""
    # Who uses this style (reverse references)
    used_by: list[str] = field(default_factory=list)

    def __post_init__(self):
        self.node_type = NodeType.STYLE
        if not self.id:
            self.id = f"style-{self.style_id}"

    def build_references(self):
        refs = []
        if self.based_on:
            refs.append(f"style-{self.based_on}")
        self.references = refs

    def to_markdown(self) -> str:
        self.build_references()
        fm = {
            "id": self.id,
            "type": "style",
            "style_id": self.style_id,
            "style_type": self.style_type,
            "name": self.name,
            "based_on": f"[[style-{self.based_on}]]" if self.based_on else "",
            "is_default": self.is_default,
        }
        lines = ["---"]
        for k, v in fm.items():
            if isinstance(v, bool):
                lines.append(f"{k}: {str(v).lower()}")
            elif isinstance(v, str) and v:
                lines.append(f'{k}: "{v}"')
            else:
                lines.append(f"{k}: ")
        lines.append("---")
        lines.append("")
        lines.append(f"# Style: {self.name or self.style_id}")
        lines.append("")

        # Properties
        props = []
        if self.font_name:
            props.append(f"- **Font**: {self.font_name}")
        if self.font_size:
            pt = int(self.font_size) / 2 if self.font_size.isdigit() else self.font_size
            props.append(f"- **Size**: {pt}pt ({self.font_size} half-points)")
        if self.bold:
            props.append(f"- **Bold**: yes")
        if self.italic:
            props.append(f"- **Italic**: yes")
        if self.underline:
            props.append(f"- **Underline**: yes")
        if self.color:
            props.append(f"- **Color**: {self.color}")
        if self.alignment:
            props.append(f"- **Alignment**: {self.alignment}")
        if self.spacing_before or self.spacing_after:
            props.append(f"- **Spacing**: before={self.spacing_before or 'inherit'}, after={self.spacing_after or 'inherit'}")
        if self.indentation_left:
            props.append(f"- **Indentation**: {self.indentation_left}")

        if props:
            lines.append("## Properties")
            lines.append("")
            lines.extend(props)
            lines.append("")

        # Used by
        if self.used_by:
            lines.append("## Used By")
            lines.append("")
            for uid in self.used_by:
                lines.append(f"- [[{uid}]]")
            lines.append("")

        return "\n".join(lines)


@dataclass
class TableCell:
    """Table cell"""
    text: str = ""
    row: int = 0
    col: int = 0
    merge_type: str = ""
    grid_span: int = 1
    v_merge: str = ""  # "" / "horizontal" / "vertical" / "first" / "continue"
    text_direction: str = ""  # "btLr"(vertical) / "lrTb"(horizontal) / "tbRl" / "tbLrV"


@dataclass
class TableNode(WikiNode):
    """Table node"""
    rows: int = 0
    cols: int = 0
    cells: list[TableCell] = field(default_factory=list)
    paragraph_ids: list[str] = field(default_factory=list)  # paragraphs within the table

    def __post_init__(self):
        self.node_type = NodeType.TABLE

    def build_references(self):
        self.references = list(self.paragraph_ids)

    @property
    def row_count(self) -> int:
        """Number of rows in the table (same as .rows, but more explicit name)."""
        return self.rows

    @property
    def col_count(self) -> int:
        """Number of columns in the table (same as .cols, but more explicit name)."""
        return self.cols

    def get_row(self, row_index: int) -> list[TableCell]:
        """Get all cells in a specific row, sorted by column index.

        Args:
            row_index: 0-based row index

        Returns:
            List of TableCell objects in the row, sorted by column.
            Empty list if row has no cells.

        Example:
            header = tbl.get_row(0)  # first row
            for cell in header:
                print(cell.text)
        """
        return sorted([c for c in self.cells if c.row == row_index], key=lambda c: c.col)

    def iter_rows(self) -> list[list[TableCell]]:
        """Iterate over all rows as lists of cells.

        Returns:
            List of rows, each row is a list of TableCell objects sorted by column.

        Example:
            for row in tbl.iter_rows():
                texts = [c.text for c in row]
                print(" | ".join(texts))
        """
        rows_dict: dict[int, list[TableCell]] = {}
        for c in self.cells:
            rows_dict.setdefault(c.row, []).append(c)
        return [sorted(rows_dict[r], key=lambda c: c.col) for r in sorted(rows_dict.keys())]

    def get_cell(self, row: int, col: int) -> Optional[TableCell]:
        """Get a specific cell by row and column index.

        Args:
            row: 0-based row index
            col: 0-based column index

        Returns:
            TableCell if found, None otherwise.
        """
        for c in self.cells:
            if c.row == row and c.col == col:
                return c
        return None

    def to_markdown(self) -> str:
        self.build_references()
        fm = {
            "id": self.id,
            "type": "table",
            "rows": self.rows,
            "cols": self.cols,
            "xpath": self.xpath,
            "xml_path": self.xml_path,
        }
        lines = ["---"]
        for k, v in fm.items():
            if isinstance(v, int):
                lines.append(f"{k}: {v}")
            elif isinstance(v, str) and v:
                lines.append(f'{k}: "{v}"')
            else:
                lines.append(f"{k}: ")
        lines.append("---")
        lines.append("")
        lines.append(f"# {self.id}")
        lines.append("")
        lines.append(f"**Dimensions**: {self.rows} × {self.cols}")
        lines.append("")

        # Render as markdown table
        if self.cells:
            lines.append("## Content")
            lines.append("")
            # Header row
            header_cells = [c for c in self.cells if c.row == 0]
            if header_cells:
                lines.append("| " + " | ".join(c.text.replace("|", "\\|") for c in header_cells) + " |")
                lines.append("|" + "|".join("---" for _ in header_cells) + "|")
            # Data rows
            for r in range(1, self.rows):
                row_cells = [c for c in self.cells if c.row == r]
                if row_cells:
                    lines.append("| " + " | ".join(c.text.replace("|", "\\|") for c in row_cells) + " |")
            lines.append("")

        # Paragraph references
        if self.paragraph_ids:
            lines.append("## Paragraphs")
            lines.append("")
            for pid in self.paragraph_ids:
                lines.append(f"- [[{pid}]]")
            lines.append("")

        return "\n".join(lines)


@dataclass
class ImageNode(WikiNode):
    """Image node"""
    filename: str = ""
    media_path: str = ""  # word/media/image1.png
    content_type: str = ""
    width: str = ""
    height: str = ""
    description: str = ""
    # Which paragraph references this image
    embedded_in: list[str] = field(default_factory=list)
    # ── Layout properties (floating images) ──
    layout: str = "inline"  # "inline" or "anchor"
    wrap: str = ""  # "square"/"tight"/"through"/"topAndBottom"/"none"/""(=inline no wrapping)
    behind_doc: bool = False
    allow_overlap: bool = True
    locked: bool = False
    layout_in_cell: bool = True
    # Positioning (anchor only)
    position_h_relative: str = ""  # "page"/"margin"/"column"/"paragraph"/"char"
    position_h_offset: str = ""  # EMU
    position_v_relative: str = ""  # "page"/"margin"/"paragraph"/"line"
    position_v_offset: str = ""  # EMU

    def __post_init__(self):
        self.node_type = NodeType.IMAGE

    def build_references(self):
        self.references = list(self.embedded_in)

    def to_markdown(self) -> str:
        self.build_references()
        fm = {
            "id": self.id,
            "type": "image",
            "filename": self.filename,
            "media_path": self.media_path,
            "content_type": self.content_type,
            "width": self.width,
            "height": self.height,
            "xpath": self.xpath,
            "xml_path": self.xml_path,
        }
        lines = ["---"]
        for k, v in fm.items():
            if isinstance(v, str) and v:
                lines.append(f'{k}: "{v}"')
            else:
                lines.append(f"{k}: ")
        lines.append("---")
        lines.append("")
        lines.append(f"# {self.id}")
        lines.append("")
        lines.append(f"**File**: `{self.media_path}`")
        if self.width or self.height:
            lines.append(f"**Dimensions**: {self.width}×{self.height}")
        if self.description:
            lines.append(f"**Description**: {self.description}")
        lines.append("")

        if self.embedded_in:
            lines.append("## Embedded In")
            lines.append("")
            for pid in self.embedded_in:
                lines.append(f"- [[{pid}]]")
            lines.append("")

        return "\n".join(lines)


@dataclass
class SectionNode(WikiNode):
    """Section node — corresponds to section break in document"""
    section_index: int = 0
    page_width: str = ""
    page_height: str = ""
    orientation: str = ""  # "portrait" or "landscape"
    margins: dict = field(default_factory=dict)
    columns: dict = field(default_factory=dict)  # {"num": "2", "space": "708", ...}
    # Contained paragraphs
    paragraph_ids: list[str] = field(default_factory=list)
    # Headers/footers
    header_ids: list[str] = field(default_factory=list)
    footer_ids: list[str] = field(default_factory=list)

    def __post_init__(self):
        self.node_type = NodeType.SECTION

    def build_references(self):
        self.references = list(self.paragraph_ids) + self.header_ids + self.footer_ids

    def to_markdown(self) -> str:
        self.build_references()
        fm = {
            "id": self.id,
            "type": "section",
            "section_index": self.section_index,
            "page_width": self.page_width,
            "page_height": self.page_height,
        }
        lines = ["---"]
        for k, v in fm.items():
            if isinstance(v, int):
                lines.append(f"{k}: {v}")
            elif isinstance(v, str) and v:
                lines.append(f'{k}: "{v}"')
            else:
                lines.append(f"{k}: ")
        if self.margins:
            lines.append("margins:")
            for mk, mv in self.margins.items():
                lines.append(f'  {mk}: "{mv}"')
        if self.columns:
            lines.append("columns:")
            for ck, cv in self.columns.items():
                lines.append(f'  {ck}: "{cv}"')
        lines.append("---")
        lines.append("")
        lines.append(f"# {self.id}")
        lines.append("")

        if self.page_width or self.page_height:
            lines.append("## Page Setup")
            lines.append("")
            lines.append(f"- **Size**: {self.page_width} × {self.page_height}")
            if self.margins:
                lines.append(f"- **Margins**: top={self.margins.get('top', 'default')}, "
                           f"bottom={self.margins.get('bottom', 'default')}, "
                           f"left={self.margins.get('left', 'default')}, "
                           f"right={self.margins.get('right', 'default')}")
            if self.columns:
                num = self.columns.get('num', '?')
                space = self.columns.get('space', 'default')
                lines.append(f"- **Columns**: {num} columns, space={space}")
            lines.append("")

        if self.paragraph_ids:
            lines.append("## Paragraphs")
            lines.append("")
            for pid in self.paragraph_ids:
                lines.append(f"- [[{pid}]]")
            lines.append("")

        return "\n".join(lines)


@dataclass
class CommentNode(WikiNode):
    """Comment node"""
    author: str = ""
    date: str = ""
    text: str = ""
    paragraph_ids: list[str] = field(default_factory=list)

    def __post_init__(self):
        self.node_type = NodeType.COMMENT

    def build_references(self):
        self.references = list(self.paragraph_ids)

    def to_markdown(self) -> str:
        self.build_references()
        lines = ["---"]
        lines.append(f'id: "{self.id}"')
        lines.append(f'type: comment')
        lines.append(f'author: "{self.author}"')
        if self.date:
            lines.append(f'date: "{self.date}"')
        lines.append("---")
        lines.append("")
        lines.append(f"# {self.id}")
        lines.append("")
        lines.append(self.text)
        if self.paragraph_ids:
            lines.append("")
            lines.append("## Targets")
            for pid in self.paragraph_ids:
                lines.append(f"- [[{pid}]]")
        return "\n".join(lines)


# ── Document model ──────────────────────────────────────────────

@dataclass
class DocumentModel:
    """
    Wiki model for the entire document

    Holds all nodes, maintains reference graph, responsible for generating index.md and log.md
    """
    source_file: str = ""
    paragraphs: list[ParagraphNode] = field(default_factory=list)
    styles: dict[str, StyleNode] = field(default_factory=dict)  # style_id -> StyleNode
    tables: list[TableNode] = field(default_factory=list)
    images: list[ImageNode] = field(default_factory=list)
    sections: list[SectionNode] = field(default_factory=list)
    headers_footers: list[dict] = field(default_factory=list)
    comments: list[CommentNode] = field(default_factory=list)
    footnotes: list[dict] = field(default_factory=list)
    endnotes: list[dict] = field(default_factory=list)
    core_properties: dict[str, str] = field(default_factory=dict)
    has_track_changes: bool = False
    sdt_controls: list[dict] = field(default_factory=list)
    charts: list[dict] = field(default_factory=list)
    equations: list[dict] = field(default_factory=list)
    smartart_nodes: list[dict] = field(default_factory=list)
    textbox_nodes: list[dict] = field(default_factory=list)
    shape_nodes: list[dict] = field(default_factory=list)

    # Index mapping
    _paragraph_by_id: dict[str, ParagraphNode] = field(default_factory=dict, repr=False)

    def index_paragraph(self):
        """Build paragraph ID index"""
        self._paragraph_by_id = {p.id: p for p in self.paragraphs}

    def get_paragraph(self, pid: str) -> Optional[ParagraphNode]:
        return self._paragraph_by_id.get(pid)

    def build_reverse_refs(self):
        """Build reverse references (who references me)"""
        # Clear
        for p in self.paragraphs:
            p.reverse_refs = []
        for s in self.styles.values():
            s.reverse_refs = []
            s.used_by = []
        for t in self.tables:
            t.reverse_refs = []
        for img in self.images:
            img.reverse_refs = []

        # Paragraph → Style
        for p in self.paragraphs:
            if p.style_id and p.style_id in self.styles:
                self.styles[p.style_id].used_by.append(p.id)
            # Paragraph → Image
            for img_id in p.image_ids:
                for img in self.images:
                    if img.id == img_id:
                        img.embedded_in.append(p.id)
            # Paragraph → Table
            if p.table_id:
                for tbl in self.tables:
                    if tbl.id == p.table_id:
                        tbl.reverse_refs.append(p.id)
            # Section → Paragraph
            if p.section_id:
                for sec in self.sections:
                    if sec.id == p.section_id:
                        if p.id not in sec.paragraph_ids:
                            sec.paragraph_ids.append(p.id)

    def generate_index(self) -> str:
        """Generate index.md"""
        lines = ["# Document Index", ""]
        lines.append(f"**Source**: `{self.source_file}`")
        lines.append(f"**Paragraphs**: {len(self.paragraphs)}")
        lines.append(f"**Styles**: {len(self.styles)}")
        lines.append(f"**Tables**: {len(self.tables)}")
        lines.append(f"**Images**: {len(self.images)}")
        lines.append(f"**Sections**: {len(self.sections)}")
        lines.append("")

        # Document outline (heading paragraphs)
        headings = [p for p in self.paragraphs if p.style_id and "heading" in p.style_id.lower()]
        if headings:
            lines.append("## Document Outline")
            lines.append("")
            for h in headings:
                indent = ""
                if h.style_id:
                    try:
                        level = int(h.style_id.replace("Heading", "").replace("heading", "").strip())
                        indent = "  " * (level - 1)
                    except ValueError:
                        pass
                text = h.text.strip() or "(empty heading)"
                lines.append(f"{indent}- [[{h.id}|{text}]]")
            lines.append("")

        # Paragraph directory
        lines.append("## Paragraphs")
        lines.append("")
        for p in self.paragraphs:
            preview = p.text.strip()[:60] or "(empty)"
            lines.append(f"- [[{p.id}]] — {preview}")
        lines.append("")

        # Style directory
        lines.append("## Styles")
        lines.append("")
        for sid, s in sorted(self.styles.items()):
            usage_count = len(s.used_by)
            lines.append(f"- [[style-{sid}|{s.name or sid}]] — used by {usage_count} paragraph(s)")
        lines.append("")

        # Table directory
        if self.tables:
            lines.append("## Tables")
            lines.append("")
            for t in self.tables:
                lines.append(f"- [[{t.id}]] — {t.rows}×{t.cols}")
            lines.append("")

        # Image directory
        if self.images:
            lines.append("## Images")
            lines.append("")
            for img in self.images:
                lines.append(f"- [[{img.id}]] — {img.filename}")
            lines.append("")

        # Section directory
        if self.sections:
            lines.append("## Sections")
            lines.append("")
            for sec in self.sections:
                lines.append(f"- [[{sec.id}]] — {len(sec.paragraph_ids)} paragraphs")
            lines.append("")

        return "\n".join(lines)

    def generate_log(self, action: str = "ingest", detail: str = "") -> str:
        """Generate log.md entry"""
        import datetime
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        lines = ["# Change Log", ""]
        lines.append(f"## [{now}] {action}")
        lines.append("")
        if detail:
            lines.append(detail)
            lines.append("")
        lines.append(f"- Source: `{self.source_file}`")
        lines.append(f"- Paragraphs: {len(self.paragraphs)}")
        lines.append(f"- Styles: {len(self.styles)}")
        lines.append(f"- Tables: {len(self.tables)}")
        lines.append(f"- Images: {len(self.images)}")
        lines.append("")
        return "\n".join(lines)


# ── Edit operations ──────────────────────────────────────────────

class EditAction(str, Enum):
    REPLACE_TEXT = "replace_text"
    INSERT_PARAGRAPH = "insert_paragraph"
    DELETE_PARAGRAPH = "delete_paragraph"
    CHANGE_STYLE = "change_style"
    FILL_BLANKS = "fill_blanks"           # fill blank fill-area runs in template
    EDIT_TABLE_CELL = "edit_table_cell"   # edit table cell

    # Phase 1.1-1.2: Formatting
    SET_PARAGRAPH_FORMAT = "set_paragraph_format"
    SET_RUN_FORMAT = "set_run_format"
    FIND_AND_REPLACE = "find_and_replace"
    FIND_AND_FORMAT = "find_and_format"
    ADD_BREAK = "add_break"

    # Phase 1.5: Table
    EDIT_TABLE_CELL_FORMAT = "edit_table_cell_format"
    SET_TABLE_PROPERTIES = "set_table_properties"
    SET_TABLE_BORDER = "set_table_border"
    ADD_TABLE = "add_table"
    REMOVE_TABLE = "remove_table"
    ADD_TABLE_ROW = "add_table_row"
    REMOVE_TABLE_ROW = "remove_table_row"
    ADD_TABLE_COLUMN = "add_table_column"
    REMOVE_TABLE_COLUMN = "remove_table_column"
    SET_TABLE_ROW_PROPERTIES = "set_table_row_properties"
    MERGE_CELLS = "merge_cells"
    SET_TABLE_CELL_PROPERTIES = "set_table_cell_properties"
    SET_TABLE_CELL_MARGIN = "set_table_cell_margin"
    SET_TABLE_CELL_TEXT_DIRECTION = "set_table_cell_text_direction"
    EDIT_TABLE_CELL_RICH_TEXT = "edit_table_cell_rich_text"
    SET_ROW_CELL_TEXT = "set_row_cell_text"
    SPLIT_CELLS = "split_cells"

    # Phase 1.6: Clone/Move
    COPY_PARAGRAPH = "copy_paragraph"
    COPY_TABLE = "copy_table"
    MOVE_PARAGRAPH = "move_paragraph"
    SWAP_PARAGRAPH = "swap_paragraph"

    # Phase 1.7: Style
    ADD_STYLE = "add_style"
    SET_STYLE_PROPERTIES = "set_style_properties"

    # Phase 1.8: Track changes
    ACCEPT_ALL_CHANGES = "accept_all_changes"
    REJECT_ALL_CHANGES = "reject_all_changes"

    # Phase 2.1: Image
    ADD_IMAGE = "add_image"
    REPLACE_IMAGE = "replace_image"
    SET_IMAGE_SIZE = "set_image_size"
    REMOVE_IMAGE = "remove_image"
    SET_IMAGE_ALT = "set_image_alt"
    SET_IMAGE_LAYOUT = "set_image_layout"

    # Phase 2.2: List
    SET_LIST_STYLE = "set_list_style"
    CREATE_NUMBERING_DEFINITION = "create_numbering_definition"
    SET_LIST_LEVEL = "set_list_level"

    # Phase 2.3: Hyperlink
    ADD_HYPERLINK = "add_hyperlink"
    REMOVE_HYPERLINK = "remove_hyperlink"
    SET_HYPERLINK = "set_hyperlink"

    # Phase 2.4: Properties
    SET_CORE_PROPERTIES = "set_core_properties"
    SET_PAGE_SETUP = "set_page_setup"

    # Phase 3.1: Header/Footer
    SET_HEADER = "set_header"
    SET_FOOTER = "set_footer"
    ADD_PAGE_NUMBER = "add_page_number"
    REMOVE_HEADER = "remove_header"
    REMOVE_FOOTER = "remove_footer"

    # Phase 3.2: Comments
    ADD_COMMENT = "add_comment"
    REMOVE_COMMENT = "remove_comment"

    # Phase 3.3: Footnotes
    ADD_FOOTNOTE = "add_footnote"
    REMOVE_FOOTNOTE = "remove_footnote"

    # Phase 3.3b: Endnotes
    ADD_ENDNOTE = "add_endnote"
    REMOVE_ENDNOTE = "remove_endnote"

    # Phase 3.4: Bookmarks
    ADD_BOOKMARK = "add_bookmark"
    REMOVE_BOOKMARK = "remove_bookmark"

    # Phase 3.5: TOC
    ADD_TOC = "add_toc"

    # Phase 3.6: Sections
    ADD_SECTION_BREAK = "add_section_break"
    REMOVE_SECTION_BREAK = "remove_section_break"
    SET_SECTION_PROPERTIES = "set_section_properties"
    SET_PAGE_NUMBER_FORMAT = "set_page_number_format"

    # Phase 3.7: Fields
    ADD_FIELD = "add_field"

    # Phase 1.2 supplement
    SET_RUN_TEXT_EFFECTS = "set_run_text_effects"
    SET_RUN_LANGUAGE = "set_run_language"
    SET_RUN_BORDER = "set_run_border"
    SET_PARAGRAPH_OUTLINE_LEVEL = "set_paragraph_outline_level"

    # Phase 1.1 supplement: Paragraph shading & border & tab stops
    SET_PARAGRAPH_SHADING = "set_paragraph_shading"
    SET_PARAGRAPH_BORDER = "set_paragraph_border"
    SET_TAB_STOPS = "set_tab_stops"
    SET_PARAGRAPH_NUMBERING_RESTART = "set_paragraph_numbering_restart"

    # Phase 0.3: Global settings
    SET_DOC_DEFAULTS = "set_doc_defaults"
    SET_DOCUMENT_PROTECTION = "set_document_protection"
    SET_EVEN_ODD_HEADERS = "set_even_odd_headers"
    SET_AUTO_HYPHENATION = "set_auto_hyphenation"

    # Phase 4.4: TOC/Fields update
    REFRESH_TOC = "refresh_toc"
    UPDATE_FIELDS = "update_fields"

    # Phase 7: Charts/Equations/SmartArt/Textboxes/Shapes/Clone
    EDIT_CHART = "edit_chart"
    EDIT_EQUATION = "edit_equation"
    EDIT_SMARTART = "edit_smartart"
    EDIT_TEXTBOX = "edit_textbox"
    EDIT_SHAPE = "edit_shape"
    CLONE_ELEMENT = "clone_element"


@dataclass
class EditOp:
    """
    Structured edit instruction

    Produced by Agent, consumed by writeback
    """
    action: EditAction
    target_id: str = ""  # target node ID for operation
    position: str = ""   # used for insert: "before:p-003" / "after:p-003"
    params: dict = field(default_factory=dict)

    @staticmethod
    def replace_text(target_id: str, old_text: str, new_text: str, target_text: str = "") -> EditOp:
        params = {"old_text": old_text, "new_text": new_text}
        if target_text:
            params["target_text"] = target_text
        return EditOp(
            action=EditAction.REPLACE_TEXT,
            target_id=target_id,
            params=params,
        )

    @staticmethod
    def insert_paragraph(text: str, position: str = "", style: str = "Normal") -> EditOp:
        return EditOp(
            action=EditAction.INSERT_PARAGRAPH,
            position=position,
            params={"text": text, "style": style},
        )

    @staticmethod
    def delete_paragraph(target_id: str) -> EditOp:
        return EditOp(
            action=EditAction.DELETE_PARAGRAPH,
            target_id=target_id,
        )

    @staticmethod
    def change_style(target_id: str, new_style: str, target_text: str = "") -> EditOp:
        params = {"new_style": new_style}
        if target_text:
            params["target_text"] = target_text
        return EditOp(
            action=EditAction.CHANGE_STYLE,
            target_id=target_id,
            params=params,
        )

    @staticmethod
    def fill_blanks(target_id: str, values: list[str], target_text: str = "") -> EditOp:
        """
        Fill blank fill-area runs in template.

        Args:
            target_id: paragraph ID, e.g. "p-003"
            values: list of values to fill into blank runs in order.
                    E.g. ["Zhang Wei"] fills the first blank run,
                    ["2026", "05", "01"] fills the first three blank runs.
            target_text: optional, locate paragraph by text content (lower priority than target_id)

        Fill rules:
            - Only modify runs where is_blank=True (blank fill areas in template)
            - Preserve run format (underline, font, etc.) unchanged
            - Fill values sequentially in document order
        """
        params = {"values": values}
        if target_text:
            params["target_text"] = target_text
        return EditOp(
            action=EditAction.FILL_BLANKS,
            target_id=target_id,
            params=params,
        )

    @staticmethod
    def edit_table_cell(table_id: str, row: int, col: int, text: str, target_text: str = "") -> EditOp:
        """
        Edit table cell content.

        Args:
            table_id: table ID, e.g. "tbl-000"
            row: row index (0-based)
            col: column index (0-based)
            text: new cell text

        Rules:
            - Locate the cell at row-th row, col-th column in the table
            - Replace the text of the first w:t element in the cell with text
            - If cell is empty, automatically create necessary paragraph and run structure
        """
        return EditOp(
            action=EditAction.EDIT_TABLE_CELL,
            target_id=table_id,
            params={"row": row, "col": col, "text": text, "target_text": target_text},
        )

    # Formatting
    @staticmethod
    def set_paragraph_format(target_id: str, format_props: dict, target_text: str = "") -> EditOp:
        p = dict(format_props)
        if target_text:
            p["target_text"] = target_text
        return EditOp(action=EditAction.SET_PARAGRAPH_FORMAT, target_id=target_id, params=p)

    @staticmethod
    def set_paragraph_shading(target_id: str = "", fill: str = "D9E2F3",
                               val: str = "clear", color: str = "auto",
                               target_text: str = "") -> EditOp:
        """Set paragraph shading. fill=background color (HEX without #), val=shading type (clear/solid etc.), color=foreground color"""
        params = {"fill": fill, "val": val, "color": color}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.SET_PARAGRAPH_SHADING, target_id=target_id, params=params)

    @staticmethod
    def set_paragraph_border(target_id: str = "",
                              borders: dict = None,
                              target_text: str = "") -> EditOp:
        """Set paragraph borders.

        borders: dict, key is border side (top/left/bottom/right/between/bar),
                 value is dict {val, sz, space, color}.
        Example: {"top": {"val": "single", "sz": "4", "space": "1", "color": "000000"}}
        val options: single/double/dotted/dashed/dashDot/dashDotDot/thick/thin etc.
        sz unit is 1/8 pt (e.g. 4 = 0.5pt)
        """
        if borders is None:
            borders = {}
        params = {"borders": borders}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.SET_PARAGRAPH_BORDER, target_id=target_id, params=params)

    @staticmethod
    def set_tab_stops(target_id: str = "",
                      tabs: list = None,
                      clear_existing: bool = True,
                      target_text: str = "") -> EditOp:
        """Set paragraph tab stops.

        tabs: list[dict], each tab stop definition:
            - val: alignment (required): left/center/right/decimal/bar/num
            - pos: position in twips (required): e.g. "1440" = 1 inch
            - leader: leader character (optional): none/dot/hyphen/underscore/heavy/middleDot
        Example: [{"val": "right", "pos": "9360", "leader": "dot"}]
        clear_existing: whether to clear existing tab stops (default True)
        """
        if tabs is None:
            tabs = []
        params = {"tabs": tabs, "clear_existing": clear_existing}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.SET_TAB_STOPS, target_id=target_id, params=params)

    @staticmethod
    def set_paragraph_numbering_restart(target_id: str = "", start: int = 1,
                                         num_id: str = None,
                                         target_text: str = "") -> EditOp:
        """Restart paragraph numbering.

        Make the target paragraph restart numbering from a specified value instead of continuing the previous list count.
        OOXML implements this via <w:lvlOverride><w:startOverride> in numbering.xml.

        Args:
            target_id: target paragraph ID (e.g. "p-005")
            start: restart numbering value (default 1)
            num_id: numbering definition ID (optional, auto-read from paragraph numPr if not provided)
            target_text: target text location
        """
        params = {"start": start}
        if num_id is not None:
            params["num_id"] = num_id
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.SET_PARAGRAPH_NUMBERING_RESTART,
                      target_id=target_id, params=params)

    @staticmethod
    def set_run_format(target_id: str, format_props: dict, run_index: int = None, target_text: str = "") -> EditOp:
        p = dict(format_props)
        if run_index is not None:
            p["_run_index"] = run_index
        if target_text:
            p["target_text"] = target_text
        return EditOp(action=EditAction.SET_RUN_FORMAT, target_id=target_id, params=p)

    @staticmethod
    def find_and_replace(old_text: str, new_text: str, scope: str = "all", target_id: str = "") -> EditOp:
        return EditOp(action=EditAction.FIND_AND_REPLACE, target_id=target_id, params={"old_text": old_text, "new_text": new_text, "scope": scope})

    @staticmethod
    def find_and_format(find_text: str, format_props: dict, scope: str = "all", target_id: str = "") -> EditOp:
        return EditOp(action=EditAction.FIND_AND_FORMAT, target_id=target_id, params={"find_text": find_text, "format_props": format_props, "scope": scope})

    @staticmethod
    def add_break(target_id: str, break_type: str = "page", target_text: str = "") -> EditOp:
        params = {"break_type": break_type}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.ADD_BREAK, target_id=target_id, params=params)

    # Table
    @staticmethod
    def edit_table_cell_format(table_id: str, row: int, col: int, target_text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.EDIT_TABLE_CELL_FORMAT, target_id=table_id, params={"row": row, "col": col, "target_text": target_text, **kwargs})

    @staticmethod
    def set_table_properties(table_id: str, target_text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_TABLE_PROPERTIES, target_id=table_id, params={"target_text": target_text, **kwargs})

    @staticmethod
    def set_table_border(table_id: str, target_text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_TABLE_BORDER, target_id=table_id, params={"target_text": target_text, **kwargs})

    @staticmethod
    def add_table(position: str = "", rows: int = 3, cols: int = 3,
                  header_row: list = None, data: list = None, **kwargs) -> EditOp:
        """Add table. header_row fills the first row, data fills subsequent rows."""
        params = {"rows": rows, "cols": cols}
        if header_row:
            params["header_row"] = header_row
        if data:
            params["data"] = data
        params.update(kwargs)
        return EditOp(action=EditAction.ADD_TABLE, position=position, params=params)

    @staticmethod
    def remove_table(table_id: str, target_text: str = "") -> EditOp:
        return EditOp(action=EditAction.REMOVE_TABLE, target_id=table_id, params={"target_text": target_text})

    @staticmethod
    def add_table_row(table_id: str, row_index: int = -1, target_text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.ADD_TABLE_ROW, target_id=table_id, params={"row_index": row_index, "target_text": target_text, **kwargs})

    @staticmethod
    def remove_table_row(table_id: str, row_index: int, target_text: str = "") -> EditOp:
        return EditOp(action=EditAction.REMOVE_TABLE_ROW, target_id=table_id, params={"row_index": row_index, "target_text": target_text})

    @staticmethod
    def add_table_column(table_id: str, col_index: int = -1, target_text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.ADD_TABLE_COLUMN, target_id=table_id, params={"col_index": col_index, "target_text": target_text, **kwargs})

    @staticmethod
    def remove_table_column(table_id: str, col_index: int, target_text: str = "") -> EditOp:
        return EditOp(action=EditAction.REMOVE_TABLE_COLUMN, target_id=table_id, params={"col_index": col_index, "target_text": target_text})

    @staticmethod
    def set_table_row_properties(table_id: str, row_index: int, target_text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_TABLE_ROW_PROPERTIES, target_id=table_id, params={"row_index": row_index, "target_text": target_text, **kwargs})

    @staticmethod
    def merge_cells(table_id: str, row_start: int, col_start: int, row_end: int, col_end: int, target_text: str = "") -> EditOp:
        return EditOp(action=EditAction.MERGE_CELLS, target_id=table_id, params={"row_start": row_start, "col_start": col_start, "row_end": row_end, "col_end": col_end, "target_text": target_text})

    @staticmethod
    def set_table_cell_properties(table_id: str, row: int, col: int, target_text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_TABLE_CELL_PROPERTIES, target_id=table_id, params={"row": row, "col": col, "target_text": target_text, **kwargs})

    @staticmethod
    def set_table_cell_margin(table_id: str, top: str = "", bottom: str = "",
                               left: str = "", right: str = "",
                               start: str = "", end: str = "",
                               target_text: str = "") -> EditOp:
        """Set table cell margins (table-level defaults, twips unit).

        Args:
            table_id: table ID
            top/bottom/left/right/start/end: margin for each direction (twips, 1 inch = 1440 twips)
                Common values: 0=no margin, 54≈1mm, 108≈2mm, 144≈2.5mm
        """
        params = {}
        if top: params["top"] = top
        if bottom: params["bottom"] = bottom
        if left: params["left"] = left
        if right: params["right"] = right
        if start: params["start"] = start
        if end: params["end"] = end
        if target_text: params["target_text"] = target_text
        return EditOp(action=EditAction.SET_TABLE_CELL_MARGIN,
                      target_id=table_id, params=params)

    @staticmethod
    def set_table_cell_text_direction(table_id: str, row: int, col: int,
                                       direction: str = "btLr",
                                       target_text: str = "") -> EditOp:
        """Set table cell text direction (vertical text).

        Args:
            table_id: table ID
            row: row index (0-based)
            col: column index (0-based)
            direction: text direction
                - "btLr": bottom to top, left to right (most common for Chinese vertical)
                - "lrTb": left to right, top to bottom (default horizontal)
                - "tbRl": top to bottom, right to left (traditional vertical)
                - "tbLrV": top to bottom, left to right
        """
        return EditOp(action=EditAction.SET_TABLE_CELL_TEXT_DIRECTION,
                      target_id=table_id,
                      params={"row": row, "col": col, "direction": direction, "target_text": target_text})

    @staticmethod
    def edit_table_cell_rich_text(table_id: str, row: int, col: int,
                                    runs: list = None,
                                    target_text: str = "") -> EditOp:
        """Edit rich text content of a table cell (multi-run with formatting).

        Args:
            table_id: table ID
            row: row index (0-based)
            col: column index (0-based)
            runs: run list, each run is a dict:
                {"text": "bold text", "bold": True, "color": "FF0000"}
                {"text": "normal text"}
                Supported format keys: bold, italic, underline, font_ascii, font_east_asia,
                             font_size, color, strike, highlight
                Omitted format keys mean not set (inherit default)
        """
        return EditOp(action=EditAction.EDIT_TABLE_CELL_RICH_TEXT,
                      target_id=table_id,
                      params={"row": row, "col": col, "runs": runs or [], "target_text": target_text})

    @staticmethod
    def set_row_cell_text(table_id: str, row_index: int, target_text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_ROW_CELL_TEXT, target_id=table_id, params={"row_index": row_index, "target_text": target_text, **kwargs})

    @staticmethod
    def split_cells(table_id: str, row: int, col: int,
                    horizontal: int = 1, vertical: int = 1,
                    target_text: str = "") -> EditOp:
        """Split merged table cells."""
        return EditOp(action=EditAction.SPLIT_CELLS, target_id=table_id,
                      params={"row": row, "col": col,
                              "horizontal": horizontal, "vertical": vertical,
                              "target_text": target_text})

    # Clone/Move
    @staticmethod
    def copy_paragraph(target_id: str, position: str) -> EditOp:
        return EditOp(action=EditAction.COPY_PARAGRAPH, target_id=target_id, position=position)

    @staticmethod
    def copy_table(table_id: str, position: str) -> EditOp:
        return EditOp(action=EditAction.COPY_TABLE, target_id=table_id, position=position)

    @staticmethod
    def move_paragraph(target_id: str, position: str) -> EditOp:
        return EditOp(action=EditAction.MOVE_PARAGRAPH, target_id=target_id, position=position)

    @staticmethod
    def swap_paragraph(target_id: str, target_id_2: str) -> EditOp:
        return EditOp(action=EditAction.SWAP_PARAGRAPH, target_id=target_id, params={"target_id_2": target_id_2})

    # Style
    @staticmethod
    def add_style(style_id: str, style_type: str = "paragraph", base_style: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.ADD_STYLE, target_id=style_id, params={"style_type": style_type, "base_style": base_style, **kwargs})

    @staticmethod
    def set_style_properties(style_id: str, **kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_STYLE_PROPERTIES, target_id=style_id, params=kwargs)

    # Track changes
    @staticmethod
    def accept_all_changes() -> EditOp:
        return EditOp(action=EditAction.ACCEPT_ALL_CHANGES)

    @staticmethod
    def reject_all_changes() -> EditOp:
        return EditOp(action=EditAction.REJECT_ALL_CHANGES)

    # Image
    @staticmethod
    def add_image(image_path: str, target_id: str = "", width: int = 400, height: int = 300, position: str = "",
                  layout: str = "", wrap: str = "", behind_doc: bool = False,
                  position_h: dict = None, position_v: dict = None) -> EditOp:
        """Add image. layout="anchor" creates floating image with text wrapping support.

        Args:
            layout: "inline"(default) or "anchor"(floating)
            wrap: wrapping mode — "square"/"tight"/"through"/"topAndBottom"/"none"(anchor only)
            behind_doc: True=image behind text
            position_h: {"relative_from": "column", "offset": "360045"} (anchor only, EMU)
            position_v: {"relative_from": "paragraph", "offset": "0"} (anchor only, EMU)
        """
        params = {"image_path": image_path, "width": width, "height": height}
        if layout:
            params["layout"] = layout
        if wrap:
            params["wrap"] = wrap
        if behind_doc:
            params["behind_doc"] = True
        if position_h:
            params["position_h"] = position_h
        if position_v:
            params["position_v"] = position_v
        return EditOp(action=EditAction.ADD_IMAGE, target_id=target_id, position=position, params=params)

    @staticmethod
    def replace_image(image_id: str, image_path: str) -> EditOp:
        return EditOp(action=EditAction.REPLACE_IMAGE, target_id=image_id, params={"image_path": image_path})

    @staticmethod
    def set_image_size(image_id: str, width: int, height: int) -> EditOp:
        return EditOp(action=EditAction.SET_IMAGE_SIZE, target_id=image_id, params={"width": width, "height": height})

    @staticmethod
    def remove_image(image_id: str) -> EditOp:
        return EditOp(action=EditAction.REMOVE_IMAGE, target_id=image_id)

    @staticmethod
    def set_image_alt(image_id: str, alt_text: str) -> EditOp:
        return EditOp(action=EditAction.SET_IMAGE_ALT, target_id=image_id, params={"alt_text": alt_text})

    @staticmethod
    def set_image_layout(image_id: str, layout: str = "", wrap: str = "", behind_doc: bool = None,
                         position_h: dict = None, position_v: dict = None,
                         allow_overlap: bool = None, locked: bool = None) -> EditOp:
        """Set image layout: inline↔anchor switching, text wrapping, positioning.

        Args:
            image_id: image ID (img-000)
            layout: "inline" or "anchor"
            wrap: "square"/"tight"/"through"/"topAndBottom"/"none"
            behind_doc: True=image behind text
            position_h: {"relative_from": "column", "offset": "360045"}
            position_v: {"relative_from": "paragraph", "offset": "0"}
            allow_overlap: whether to allow overlap
            locked: whether to lock position
        """
        params = {}
        if layout:
            params["layout"] = layout
        if wrap:
            params["wrap"] = wrap
        if behind_doc is not None:
            params["behind_doc"] = behind_doc
        if position_h:
            params["position_h"] = position_h
        if position_v:
            params["position_v"] = position_v
        if allow_overlap is not None:
            params["allow_overlap"] = allow_overlap
        if locked is not None:
            params["locked"] = locked
        return EditOp(action=EditAction.SET_IMAGE_LAYOUT, target_id=image_id, params=params)

    # List
    @staticmethod
    def set_list_style(target_id: str, list_type: str = "bullet",
                       num_id: str = "1", ilvl: int = 0,
                       target_text: str = "") -> EditOp:
        params = {"list_type": list_type, "num_id": num_id, "ilvl": ilvl}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.SET_LIST_STYLE, target_id=target_id,
                      params=params)

    @staticmethod
    def create_numbering_definition(list_type: str = "bullet", start: int = 1,
                                     levels: list = None, **kwargs) -> EditOp:
        """Create numbering definition (bullet or numbered list).

        Args:
            list_type: "bullet" or "numbered" (default "bullet")
            start: starting number (default 1, overridden by start in levels)
            levels: optional, per-level list configuration. Each level is a dict:
                - numFmt: "decimal"/"upperLetter"/"lowerLetter"/"upperRoman"/"lowerRoman"/"chineseCounting"/"bullet"
                - lvlText: format string, e.g. "%1.", "%%1.%%2." (multi-level)
                - start: start value for this level
                - indent_left: left indent in twips (e.g. "720")
                - indent_hanging: hanging indent in twips (e.g. "360")
                - font_ascii: Western font
                - font_east_asia: East Asian font
                Example: [
                    {"numFmt": "decimal", "lvlText": "%1.", "start": 1, "indent_left": "720", "indent_hanging": "360"},
                    {"numFmt": "lowerLetter", "lvlText": "%1.%2)", "start": 1, "indent_left": "1440", "indent_hanging": "360"},
                ]
            **kwargs: other parameters (passed directly to params)
        """
        params = {"list_type": list_type, "start": start, **kwargs}
        if levels is not None:
            params["levels"] = levels
        return EditOp(action=EditAction.CREATE_NUMBERING_DEFINITION, params=params)

    @staticmethod
    def set_list_level(target_id: str, num_id: str, ilvl: int,
                       target_text: str = "") -> EditOp:
        params = {"num_id": num_id, "ilvl": ilvl}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.SET_LIST_LEVEL, target_id=target_id, params=params)

    # Hyperlink
    @staticmethod
    def add_hyperlink(target_id: str, url: str, text: str = "", target_text: str = "") -> EditOp:
        params = {"url": url, "text": text}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.ADD_HYPERLINK, target_id=target_id, params=params)

    @staticmethod
    def remove_hyperlink(target_id: str, hyperlink_index: int = 0) -> EditOp:
        return EditOp(action=EditAction.REMOVE_HYPERLINK, target_id=target_id, params={"hyperlink_index": hyperlink_index})

    @staticmethod
    def set_hyperlink(target_id: str, url: str, text: str = "", hyperlink_index: int = 0) -> EditOp:
        return EditOp(action=EditAction.SET_HYPERLINK, target_id=target_id, params={"url": url, "text": text, "hyperlink_index": hyperlink_index})

    # Properties
    @staticmethod
    def set_core_properties(**kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_CORE_PROPERTIES, params=kwargs)

    @staticmethod
    def set_page_setup(**kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_PAGE_SETUP, params=kwargs)

    # Header/Footer
    @staticmethod
    def set_header(section_index: int = 0, text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_HEADER, params={"section_index": section_index, "text": text, **kwargs})

    @staticmethod
    def set_footer(section_index: int = 0, text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_FOOTER, params={"section_index": section_index, "text": text, **kwargs})

    @staticmethod
    def add_page_number(section_index: int = 0, alignment: str = "center") -> EditOp:
        return EditOp(action=EditAction.ADD_PAGE_NUMBER, params={"section_index": section_index, "alignment": alignment})

    @staticmethod
    def remove_header(section_index: int = 0, header_type: str = "default") -> EditOp:
        """Remove header.

        Args:
            section_index: section index (default 0)
            header_type: header type — default/first/even
        """
        return EditOp(action=EditAction.REMOVE_HEADER,
                      params={"section_index": section_index, "header_type": header_type})

    @staticmethod
    def remove_footer(section_index: int = 0, footer_type: str = "default") -> EditOp:
        """Remove footer.

        Args:
            section_index: section index (default 0)
            footer_type: footer type — default/first/even
        """
        return EditOp(action=EditAction.REMOVE_FOOTER,
                      params={"section_index": section_index, "footer_type": footer_type})

    # Comments
    @staticmethod
    def add_comment(target_id: str, text: str, author: str = "", target_text: str = "") -> EditOp:
        params = {"text": text, "author": author}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.ADD_COMMENT, target_id=target_id, params=params)

    @staticmethod
    def remove_comment(comment_id: str) -> EditOp:
        return EditOp(action=EditAction.REMOVE_COMMENT, target_id=comment_id)

    # Footnotes
    @staticmethod
    def add_footnote(target_id: str, text: str, target_text: str = "") -> EditOp:
        params = {"text": text}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.ADD_FOOTNOTE, target_id=target_id, params=params)

    @staticmethod
    def remove_footnote(footnote_id: str) -> EditOp:
        """Remove footnote (remove footnoteReference from paragraph + entry in footnotes.xml).

        Args:
            footnote_id: footnote ID, e.g. "fn-0", "fn-1"
        """
        return EditOp(action=EditAction.REMOVE_FOOTNOTE, target_id=footnote_id)

    # Endnotes
    @staticmethod
    def add_endnote(target_id: str, text: str, target_text: str = "") -> EditOp:
        params = {"text": text}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.ADD_ENDNOTE, target_id=target_id, params=params)

    @staticmethod
    def remove_endnote(endnote_id: str) -> EditOp:
        """Remove endnote (remove endnoteReference from paragraph + entry in endnotes.xml).

        Args:
            endnote_id: endnote ID, e.g. "en-0", "en-1"
        """
        return EditOp(action=EditAction.REMOVE_ENDNOTE, target_id=endnote_id)

    # Bookmarks
    @staticmethod
    def add_bookmark(target_id: str, bookmark_name: str, target_text: str = "") -> EditOp:
        params = {"bookmark_name": bookmark_name}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.ADD_BOOKMARK, target_id=target_id, params=params)

    @staticmethod
    def remove_bookmark(bookmark_name: str) -> EditOp:
        return EditOp(action=EditAction.REMOVE_BOOKMARK, params={"bookmark_name": bookmark_name})

    # TOC
    @staticmethod
    def add_toc(position: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.ADD_TOC, position=position, params=kwargs)

    # Sections
    @staticmethod
    def add_section_break(target_id: str = "", break_type: str = "nextPage") -> EditOp:
        return EditOp(action=EditAction.ADD_SECTION_BREAK, target_id=target_id, params={"break_type": break_type})

    @staticmethod
    def remove_section_break(target_id: str = "", section_index: int = None,
                              target_text: str = "") -> EditOp:
        """Remove section break (merge two sections into one).

        Cannot remove the last section in document (body-level sectPr).

        Args:
            target_id: paragraph ID containing the section break (recommended)
            section_index: section index (optional, 0=first section break)
            target_text: target text location
        """
        params = {}
        if section_index is not None:
            params["section_index"] = section_index
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.REMOVE_SECTION_BREAK,
                      target_id=target_id, params=params)

    @staticmethod
    def set_section_properties(section_index: int = 0, **kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_SECTION_PROPERTIES, params={"section_index": section_index, **kwargs})

    @staticmethod
    def set_page_number_format(section_index: int = 0, fmt: str = "decimal") -> EditOp:
        return EditOp(action=EditAction.SET_PAGE_NUMBER_FORMAT, params={"section_index": section_index, "fmt": fmt})

    # Fields
    @staticmethod
    def add_field(target_id: str, field_type: str, target_text: str = "", **kwargs) -> EditOp:
        params = {"field_type": field_type, **kwargs}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.ADD_FIELD, target_id=target_id, params=params)

    # Text effects
    @staticmethod
    def set_run_text_effects(target_id: str, outline: bool = None, shadow: bool = None, emboss: bool = None, imprint: bool = None, run_index: int = None, target_text: str = "") -> EditOp:
        p = {}
        if outline is not None: p["outline"] = outline
        if shadow is not None: p["shadow"] = shadow
        if emboss is not None: p["emboss"] = emboss
        if imprint is not None: p["imprint"] = imprint
        if run_index is not None: p["_run_index"] = run_index
        if target_text: p["target_text"] = target_text
        return EditOp(action=EditAction.SET_RUN_TEXT_EFFECTS, target_id=target_id, params=p)

    @staticmethod
    def set_run_language(target_id: str, val: str = "", east_asia: str = "",
                         bidi: str = "", run_index: int = None,
                         target_text: str = "") -> EditOp:
        """Set run proofing language tags.

        Args:
            val: primary language, e.g. "en-US", "zh-CN"
            east_asia: East Asian language, e.g. "zh-CN", "ja-JP"
            bidi: bidirectional text language, e.g. "ar-SA"
            run_index: specific run index (None=all runs)
        """
        p = {}
        if val: p["val"] = val
        if east_asia: p["eastAsia"] = east_asia
        if bidi: p["bidi"] = bidi
        if run_index is not None: p["_run_index"] = run_index
        if target_text: p["target_text"] = target_text
        return EditOp(action=EditAction.SET_RUN_LANGUAGE, target_id=target_id, params=p)

    @staticmethod
    def set_run_border(target_id: str, val: str = "single", sz: str = "4",
                       space: str = "1", color: str = "auto",
                       run_index: int = None, target_text: str = "") -> EditOp:
        """Set run character border.

        Args:
            val: border style — single/double/dotted/dashed/wave etc.
            sz: border width (1/8 pt, e.g. 4=0.5pt)
            space: spacing (pt)
            color: color (HEX, without #)
            run_index: specific run index (None=all runs)
        """
        p = {"val": val, "sz": sz, "space": space, "color": color}
        if run_index is not None: p["_run_index"] = run_index
        if target_text: p["target_text"] = target_text
        return EditOp(action=EditAction.SET_RUN_BORDER, target_id=target_id, params=p)

    @staticmethod
    def set_paragraph_outline_level(target_id: str, level: int = 0,
                                     target_text: str = "") -> EditOp:
        """Set paragraph outline level (independent of heading style).

        Args:
            level: outline level 0-8 (0=Level 1, 1=Level 2, ..., 8=Level 9)
                   Set -1 or omit to remove outlineLvl
        """
        params = {"level": level}
        if target_text:
            params["target_text"] = target_text
        return EditOp(action=EditAction.SET_PARAGRAPH_OUTLINE_LEVEL,
                      target_id=target_id, params=params)

    # Global settings
    @staticmethod
    def set_doc_defaults(**kwargs) -> EditOp:
        return EditOp(action=EditAction.SET_DOC_DEFAULTS, params=kwargs)

    @staticmethod
    def set_document_protection(protection_type: str, password: str = "") -> EditOp:
        p = {"protection_type": protection_type}
        if password: p["password"] = password
        return EditOp(action=EditAction.SET_DOCUMENT_PROTECTION, params=p)

    @staticmethod
    def set_even_odd_headers(enabled: bool = True) -> EditOp:
        return EditOp(action=EditAction.SET_EVEN_ODD_HEADERS, params={"enabled": enabled})

    @staticmethod
    def set_auto_hyphenation(enabled: bool = True) -> EditOp:
        return EditOp(action=EditAction.SET_AUTO_HYPHENATION, params={"enabled": enabled})

    # TOC/Fields update
    @staticmethod
    def refresh_toc(update_instr: str = None) -> EditOp:
        p = {}
        if update_instr: p["update_instr"] = update_instr
        return EditOp(action=EditAction.REFRESH_TOC, params=p)

    @staticmethod
    def update_fields() -> EditOp:
        return EditOp(action=EditAction.UPDATE_FIELDS)

    # Phase 7: Charts/Equations/SmartArt/Textboxes/Shapes/Clone
    @staticmethod
    def edit_chart(target_id: str, **kwargs) -> EditOp:
        return EditOp(action=EditAction.EDIT_CHART, target_id=target_id, params=kwargs)

    @staticmethod
    def edit_equation(target_id: str, equation_text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.EDIT_EQUATION, target_id=target_id, params={"equation_text": equation_text, **kwargs})

    @staticmethod
    def edit_smartart(target_id: str, **kwargs) -> EditOp:
        return EditOp(action=EditAction.EDIT_SMARTART, target_id=target_id, params=kwargs)

    @staticmethod
    def edit_textbox(target_id: str, text: str = "", **kwargs) -> EditOp:
        return EditOp(action=EditAction.EDIT_TEXTBOX, target_id=target_id, params={"text": text, **kwargs})

    @staticmethod
    def edit_shape(target_id: str, **kwargs) -> EditOp:
        return EditOp(action=EditAction.EDIT_SHAPE, target_id=target_id, params=kwargs)

    @staticmethod
    def clone_element(target_id: str, position: str = "", count: int = 1) -> EditOp:
        return EditOp(action=EditAction.CLONE_ELEMENT, target_id=target_id, position=position, params={"count": count})

    def to_dict(self) -> dict:
        return {
            "action": self.action.value,
            "target_id": self.target_id,
            "position": self.position,
            "params": self.params,
        }

    @staticmethod
    def from_dict(d: dict) -> EditOp:
        return EditOp(
            action=EditAction(d["action"]),
            target_id=d.get("target_id", ""),
            position=d.get("position", ""),
            params=d.get("params", {}),
        )

    def __str__(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False)
