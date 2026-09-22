---
name: cw-word-editor
description: "LLM Wiki-mode docx editor with 89 EditOps, zero third-party dependencies. Ingest compiles docx → DocumentModel, view provides outline/details/stats/issue detection, writeback applies precise edits."
version: "1.0.5"
category: documents
tags: [docx, word, document, editing, ooxml]
triggers:
  keywords: [docx, word, word文档, 文档编辑, 编辑docx, docx编辑]
---

# word-editor Skill

Compile docx documents into a DocumentModel, let the Agent **deeply understand** the content, then **precisely edit** via 89 EditOps — zero third-party dependencies.

## Architecture

```
.docx file → ingest() → DocumentModel → view() to understand the full picture
                                                ↓
                                        Agent generates EditOps
                                                ↓
                                  apply_edits() → new .docx
```

**Key insight**: Zero loss of original XML attributes. EditOps only make localized, precise modifications.

## Environment

- Python 3.8+ (Pyodide compatible)
- **Zero third-party dependencies** (zipfile + ElementTree only)
- **Store skill** — 从 Skill Store 安装后挂载到 `/mnt_skills/user/cw-word-editor/`。不要假设上述绝对路径：脚本与资源路径以 `read_skill` 返回内容或 skill loader 注入的运行时信息为准
- Script path: `/mnt_skills/user/cw-word-editor/scripts/`
- Includes a blank template: `/mnt_skills/user/cw-word-editor/blank.docx` (WPS-generated, with full styles/fonts/themes)

---

## Quick Start

### 1. Import (no sync needed — built-in skill is auto-mounted)

```python
import sys
sys.path.insert(0, '/mnt_skills/user/cw-word-editor/scripts')
from ingest import ingest
from model import EditOp, EditAction, DocumentModel, ParagraphNode
from writeback import apply_edits
from view import scan, focus, chunk, issues, stats
```

### 2. Ingest (when editing an existing docx)

```python
model = ingest('/mnt/{rootName}/template.docx', '/mnt/{rootName}/template_wiki')
print(f"Paragraphs: {len(model.paragraphs)}, Tables: {len(model.tables)}, Images: {len(model.images)}")
```

### 3. View (understand document structure)

```python
print(scan(model))          # Quick outline (~50 lines)
print(focus(model, "p-003"))  # Paragraph details (runs + formatting)
chunks = chunk(model)       # Chunked reading (large docs split into segments)
print(stats(model))         # Document statistics (word count/style/font distribution)
print(issues(model))        # Issue detection (empty paragraphs/missing alt/oversized paragraphs)
```

### 4. Edit + Writeback

```python
edits = [
    EditOp.replace_text("p-003", "old text", "new text"),
    EditOp.change_style("p-001", "Heading1"),
    EditOp.edit_table_cell("tbl-000", 1, 1, "new content"),
    EditOp.set_run_format("p-002", {"bold": True, "color": "FF0000"}, run_index=0),
]

ok = apply_edits(
    '/mnt/{rootName}/template.docx', edits, '/mnt/{rootName}/output.docx',
    model=model, wiki_dir='/mnt/{rootName}/template_wiki'
)
print(f"All successful: {ok}")

# ⚠️ IMPORTANT: Clean up ingest wiki artifacts
shutil.rmtree('/mnt/{rootName}/template_wiki', ignore_errors=True)
```

---

## Creating New docx from Scratch

Use the bundled `blank.docx` template (with full styles) and build with EditOps:

```python
import sys, shutil
sys.path.insert(0, '/mnt_skills/user/cw-word-editor/scripts')
from model import EditOp, EditAction, DocumentModel, ParagraphNode
from writeback import apply_edits
import base64

# 1. Copy blank template
output = '/mnt/{rootName}/output.docx'
shutil.copy2('/mnt_skills/user/cw-word-editor/blank.docx', output)

# 2. Build model manually (blank template has only 1 empty paragraph p-000)
model = DocumentModel()
model.paragraphs = [ParagraphNode(id="p-000", index=0, text="")]

# 3. Generate EditOps (omit position to append before sectPr in order)
edits = [
    EditOp.insert_paragraph("Document Title", style="Title"),
    EditOp.insert_paragraph("Body paragraph one"),
    EditOp.add_table(rows=3, cols=2,
        header_row=["Header1", "Header2"],
        data=[["r1c1", "r1c2"], ["r2c1", "r2c2"]]
    ),  # ✅ header_row + data filled directly, no need for edit_table_cell
    # Image: use from_dict to pass image_data (base64 encoded)
    EditOp.from_dict({"action": "add_image",
                      "params": {"width": 500, "height": 300,
                                 "image_path": "chart.png",
                                 "image_data": base64_chart_string}}),
    EditOp.add_footnote("", "Footnote text", target_text="Body paragraph one"),
    EditOp.add_comment("", "Comment text", target_text="Body paragraph one", author="Reviewer"),
    EditOp.add_bookmark("", "chapter1", target_text="Document Title"),
    EditOp.add_hyperlink("", url="https://example.com", text="Link text", target_text="Body paragraph one"),
    EditOp.set_header(text="Header text"),
    EditOp.set_footer(text="Footer text"),
    EditOp.add_page_number(alignment="center"),
    EditOp.set_core_properties(title="Document Title", creator="Author"),
]

ok = apply_edits(output, edits, output, model=model)

# ⚠️ IMPORTANT: Clean up ingest artifacts
import shutil
shutil.rmtree('/mnt/{rootName}/_wiki', ignore_errors=True)
```

### Key Notes

1. **position is optional**: `insert_paragraph`, `add_table`, `add_image`, `add_toc` all accept optional `position`; defaults to appending before sectPr (equivalent to end of document).
2. **Blank template paragraph auto-removed**: `apply_edits` automatically detects and removes the blank.docx template paragraph (footnote/comment references are migrated to the last content paragraph).
3. **image_data requires `from_dict`**: `EditOp.add_image()` factory method does not accept `image_data`; to embed image data use `EditOp.from_dict({"action": "add_image", "params": {"image_data": base64_string, ...}})`.
4. **Style name auto-mapping**: The engine builds a style name → styleId map automatically. WPS templates use numeric styleIds (e.g. `"718"` for Title, `"700"` for Heading 1), but you code with standard names like `"Title"`/`"Heading1"` and the engine resolves them.
5. **EditOps execute in order**: When position is omitted, all content is inserted before sectPr in EditOps list order, and the blank template paragraph is cleaned up at the end.
6. **Single-pass creation**: All EditOps complete in a single `apply_edits` call, including image embedding, footnote creation, style patching, and other post-processing steps.

### CJK (Chinese/Japanese/Korean) Font for Matplotlib Charts

Pyodide has no CJK fonts. When chart labels/titles contain CJK characters, fetch and load the bundled font **on demand**:

```python
import matplotlib
matplotlib.use('Agg')
import matplotlib.font_manager as fm
import matplotlib.pyplot as plt
import tempfile, os

async def load_cjk_font():
    """Fetch Noto Sans SC (SIL OFL) from app assets and load into matplotlib."""
    font_name = 'NotoSansSC-Regular.otf'
    tmp_path = os.path.join(tempfile.gettempdir(), font_name)
    if not os.path.exists(tmp_path):
        from pyodide.http import pyfetch
        resp = await pyfetch(f'/assets/fonts/{font_name}')
        data = await resp.bytes()
        with open(tmp_path, 'wb') as f:
            f.write(data)
    fm.fontManager.addfont(tmp_path)
    plt.rcParams['font.sans-serif'] = ['Noto Sans SC'] + plt.rcParams['font.sans-serif']
    plt.rcParams['axes.unicode_minus'] = False

# Call once before any plt.plot / plt.bar / etc.
await load_cjk_font()

# Now CJK text works in charts
fig, ax = plt.subplots()
ax.set_title('中文标题')  # renders correctly
ax.bar(['苹果', '香蕉', '橙子'], [3, 5, 2])
```

**Key points:**
- Font file is at `/assets/fonts/NotoSansSC-Regular.otf` (7.9MB, SIL OFL, bundled with the app)
- Only fetch when needed — no upfront download or OPFS storage
- `addfont()` requires a file path (not BytesIO), so write to a temp file first
- Subsequent calls in the same session skip the fetch (temp file already exists)
- **Emoji NOT supported**: matplotlib uses FreeType which cannot render color emoji (COLRv1/CBDT). All emoji glyphs appear as empty boxes. Use plain text labels instead of emoji in charts.

### Full Example: Generate a Report with Chart from Scratch

```python
import sys, shutil, base64, io
sys.path.insert(0, '/mnt_skills/user/cw-word-editor/scripts')
from model import EditOp, DocumentModel, ParagraphNode
from writeback import apply_edits
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

# ── 1. Generate chart ──
def fig_b64(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format='png', dpi=100, bbox_inches='tight')
    plt.close(fig); buf.seek(0)
    return base64.b64encode(buf.read()).decode()

fig, ax = plt.subplots(figsize=(6, 3.5))
ax.bar(['Q1','Q2','Q3','Q4'], [100, 150, 180, 220], color='#4472C4')
ax.set_title('Quarterly Revenue ($M)'); chart_b64 = fig_b64(fig)

# ── 2. Prepare template + model ──
output = '/mnt/{rootName}/report.docx'
shutil.copy2('/mnt_skills/user/cw-word-editor/blank.docx', output)
model = DocumentModel()
model.paragraphs = [ParagraphNode(id="p-000", index=0, text="")]

# ── 3. Build EditOps (omit position, insert in order) ──
edits = [
    EditOp.insert_paragraph("Annual Report 2026", style="Title"),
    EditOp.insert_paragraph("Financial Summary", style="Subtitle"),
    EditOp.insert_paragraph("Q4 revenue reached $220M, a 22% increase from Q3.", style="Heading1"),
    EditOp.insert_paragraph("The company saw consistent growth across all quarters."),
    EditOp.from_dict({"action": "add_table", "params": {
        "rows": 3, "cols": 2,
        "header_row": ["Quarter", "Revenue"],
        "data": [["Q1", "$100M"], ["Q4", "$220M"]]}}),
    EditOp.from_dict({"action": "add_image", "params": {
        "width": 500, "height": 290, "image_path": "chart.png", "image_data": chart_b64}}),
    EditOp.set_header(text="Annual Report 2026"),
    EditOp.set_footer(text="Confidential"),
    EditOp.add_page_number(alignment="center"),
    EditOp.set_core_properties(title="Annual Report", creator="Finance Team"),
]

# ── 4. Generate in one call ──
ok = apply_edits(output, edits, output, model=model)
print(f"✅ Generated: {ok}")
```

---

## target_text: Locating Paragraphs by Text Content

In addition to `target_id` (e.g. `"p-003"`), all EditOp factory methods that accept `target_id` also support `target_text` to locate the target paragraph by its text content.

```python
# Locate by target_id (traditional, requires knowing IDs after ingest)
EditOp.replace_text("p-034", "old text", "new text")

# Locate by target_text (no ID needed, use a text snippet from the paragraph)
EditOp.replace_text("", "old text", "new text", target_text="paragraph containing this text")
EditOp.change_style("", "Heading1", target_text="some heading text")
EditOp.add_footnote("", "Footnote content", target_text="paragraph to add footnote to")
EditOp.add_endnote("", "Endnote content", target_text="paragraph to add endnote to")
EditOp.add_comment("", "Comment content", target_text="paragraph to comment on", author="Reviewer")
EditOp.add_bookmark("", "bm1", target_text="paragraph to bookmark")
EditOp.add_hyperlink("", "https://example.com", text="Link", target_text="paragraph to add link to")
EditOp.add_break("", break_type="page", target_text="page break after this heading")
EditOp.add_field("", "DATE", target_text="some text")
EditOp.set_run_format("", {"bold": True}, target_text="paragraph to bold")
EditOp.set_paragraph_format("", {"spacing_before": "400"}, target_text="paragraph to adjust spacing")
EditOp.set_paragraph_shading("", fill="FFFF00", target_text="paragraph to shade")
EditOp.set_paragraph_border("", borders={"top": {"val": "single", "sz": "4", "space": "1", "color": "000000"}}, target_text="paragraph to border")
EditOp.set_tab_stops("", tabs=[{"val": "right", "pos": "9360", "leader": "dot"}], target_text="paragraph to add tab stops")
EditOp.set_run_text_effects("", outline=True, target_text="paragraph to outline")
EditOp.fill_blanks("", ["value1"], target_text="paragraph to fill blanks")
EditOp.set_list_style("", list_type="bullet", target_text="paragraph to make list")
EditOp.set_list_level("", num_id="1", ilvl=0, target_text="paragraph to adjust level")
EditOp.set_run_language("", val="en-US", east_asia="zh-CN", target_text="paragraph to set language")
EditOp.set_run_border("", val="single", color="FF0000", target_text="paragraph to add char border")
EditOp.set_paragraph_outline_level("", level=0, target_text="paragraph to set outline level")
```

**Resolution priority** (`_resolve_target_para`):
1. `target_id` + `id_to_elem` (Python object reference, unaffected by insertions/deletions)
2. `target_id` + `id_to_index` (positional index)
3. `target_text` (full-text substring search, **must match exactly 1 paragraph**)
4. `target_id` legacy numeric parsing (`p-037` → `paras[37]`)

**Rules**:
- `target_text` must match exactly 1 paragraph. 0 matches or 2+ matches will fail with a warning
- `target_text` is a substring match, not exact full paragraph text
- `target_id` and `target_text` can be provided together (`target_id` takes priority)
- When `target_id=""`, only `target_text` is used for locating

---

---

## EditOps Complete Reference

> **Required params** in code font, **optional params** in italics.

### Paragraph CRUD (6 ops)

```python
EditOp.replace_text("p-003", "old text", "new text")
EditOp.fill_blanks("p-003", ["value1", "value2"])       # Fill template blank runs
EditOp.insert_paragraph("text", position="after:p-005", style="Normal")  # position optional
EditOp.delete_paragraph("p-008")                   # target_id required (auto-cleans bookmarks/comments)
EditOp.change_style("p-003", "Heading1")           # new_style required
EditOp.add_break("p-005", break_type="page")       # break_type defaults to "page"
```

### Paragraph Formatting (6 ops)

```python
EditOp.set_paragraph_format("p-002", {
    "alignment": "center",           # left/center/right/justify
    "indent_left": "360",            # twips
    "indent_first_line": "420",
    "spacing_before": "120",         # twips
    "spacing_after": "60",
    "line_spacing": "360",           # twips (240=single)
    "keep_next": True,
    "keep_lines": True,
    "page_break_before": False,
    "contextual_spacing": True,
    "word_wrap": True,
})

EditOp.set_paragraph_shading("p-002", fill="D9E2F3", val="clear", color="auto")  # fill=bg color HEX, val=shading type, color=fg color

EditOp.set_paragraph_border("p-002", borders={
    "top":    {"val": "single", "sz": "4",  "space": "1", "color": "000000"},
    "bottom": {"val": "double", "sz": "6",  "space": "1", "color": "000000"},
    "left":   {"val": "single", "sz": "12", "space": "4", "color": "4472C4"},
    "right":  {"val": "single", "sz": "12", "space": "4", "color": "4472C4"},
})  # side: top/left/bottom/right/between/bar, val: single/double/dotted/dashed etc., sz: 1/8pt, space: pt

EditOp.set_tab_stops("p-002", tabs=[
    {"val": "left", "pos": "1440"},                    # Left-aligned tab at 1 inch
    {"val": "right", "pos": "9360", "leader": "dot"},  # Right-aligned tab with dot leader at 6.5 inches
    {"val": "center", "pos": "4680"},                  # Center-aligned tab at 3.25 inches
])  # val: left/center/right/decimal/bar/num, pos: twips, leader: none/dot/hyphen/underscore/heavy/middleDot

EditOp.set_paragraph_outline_level("p-002", level=0)  # level: 0=Level 1, ..., 8=Level 9; -1=remove
# TOC outline level independent of style. Required for docs using Normal style + outlineLvl (e.g. government docs).

EditOp.set_paragraph_numbering_restart("p-005", start=1)  # Restart numbering from 1 at p-005
# Use case: same numId list needs restart in the middle (e.g. 1,2,3 → restart 1,2,3)
# Creates new num reference (with lvlOverride/startOverride) without affecting prior numbering
```

### Run Formatting (4 ops)

```python
EditOp.set_run_format("p-002", {
    "bold": True, "italic": False,
    "font_ascii": "Arial", "font_east_asia": "SimSun",
    "font_size": "24",               # half-points (24=12pt)
    "color": "FF0000",
    "underline": "single",           # single/double/wave/none
    "strike": True,
    "highlight": "yellow",
    "vertical_align": "superscript", # superscript/subscript
    "caps": True, "small_caps": False,
    "char_spacing": "100",           # character spacing (twips)
    "char_scale": "150",             # character scaling % (150=150% width)
    "kern": "24",                    # kerning (half-points, 24=12pt minimum)
    "position": "4",                 # baseline offset (half-points, positive=up, negative=down)
}, run_index=0)                      # None=all runs, 0+=specific run

EditOp.set_run_text_effects("p-002", outline=True, shadow=True, run_index=0)

EditOp.set_run_language("p-002", val="en-US", east_asia="zh-CN", run_index=0)
# val: primary language (en-US, zh-CN, ja-JP, etc.)
# east_asia: East Asian language, bidi: bidirectional text language
# run_index: None=all runs, 0+=specific run

EditOp.set_run_border("p-002", val="single", sz="4", space="1", color="auto", run_index=0)
# val: single/double/dotted/dashed/wave etc., sz: 1/8pt, space: pt, color: HEX
```

### Find & Replace (2 ops)

```python
EditOp.find_and_replace("old text", "new text", scope="all")
EditOp.find_and_format("keyword", {"bold": True, "color": "FF0000"}, scope="all")
```

### Tables (18 ops)

```python
EditOp.edit_table_cell("tbl-000", row=1, col=2, text="content")
EditOp.edit_table_cell_format("tbl-000", row=1, col=2, bold=True, color="FF0000")
EditOp.add_table(position="after:p-005", rows=4, cols=3,
    header_row=["Name", "Dept", "Score"],
    data=[["Alice", "Eng", "95"], ["Bob", "Mkt", "88"], ["Carol", "Design", "92"]]
)  # position optional; header_row fills first row, data fills remaining rows
EditOp.remove_table("tbl-000")
EditOp.add_table_row("tbl-000", row_index=1)
EditOp.remove_table_row("tbl-000", row_index=2)
EditOp.add_table_column("tbl-000", col_index=1)
EditOp.remove_table_column("tbl-000", col_index=2)
EditOp.set_table_properties("tbl-000", alignment="center", width="5000", width_type="pct", layout="fixed")
# width_type: pct(percentage)/dxa(twips)/auto; layout: fixed/autofit
EditOp.set_table_border("tbl-000", border_type="top", style="single")  # border_type + style required
EditOp.set_table_row_properties("tbl-000", row_index=0, height="400", header=True)
EditOp.merge_cells("tbl-000", row_start=0, col_start=0, row_end=1, col_end=1)
EditOp.split_cells("tbl-000", row=0, col=0, horizontal=2)  # Split merged cell, horizontal/vertical=split count
EditOp.set_table_cell_properties("tbl-000", row=0, col=0, shading="FFFF00")
EditOp.set_table_cell_margin("tbl-000", top="108", bottom="108", left="54", right="54")
# Set table cell padding (table-level defaults), twips unit
# Common values: 0=no padding, 54≈1mm, 108≈2mm, 144≈2.5mm
EditOp.set_table_cell_text_direction("tbl-000", row=0, col=0, direction="btLr")
# Set cell text direction (vertical text)
# direction: btLr(bottom→top left→right, CJK vertical), lrTb(default horizontal), tbRl(top→bottom right→left), tbLrV(top→bottom left→right)
EditOp.edit_table_cell_rich_text("tbl-000", row=1, col=1, runs=[
    {"text": "Bold label", "bold": True, "color": "FF0000"},
    {"text": "Normal content"},
    {"text": "Italic note", "italic": True},
])
# Edit cell rich text (multiple runs + mixed formatting)
# Each dict in runs supports: text(required) + bold/italic/underline/font_ascii/font_east_asia/font_size/color/strike/highlight
EditOp.set_row_cell_text("tbl-000", row_index=1, col_0="A", col_1="B", col_2="C")
```

### Clone / Move (4 ops)

```python
EditOp.copy_paragraph("p-003", position="after:p-010")   # target_id + position required
EditOp.copy_table("tbl-000", position="after:p-015")
EditOp.move_paragraph("p-003", position="after:p-010")
EditOp.swap_paragraph("p-003", target_id_2="p-008")
```

### Styles (2 ops)

```python
EditOp.add_style(style_id="MyStyle", style_type="paragraph", base_style="Normal")
EditOp.set_style_properties("MyStyle", font_ascii="Arial", font_size="24", bold=True)
```

### Images (6 ops + image_data)

```python
# Method 1: Reference by file path (file must exist in ZIP)
EditOp.add_image(image_path="image.png", target_id="p-003", width=400, height=300, position="after:p-002")

# Method 2: Embed from base64 (recommended for matplotlib charts etc.)
EditOp.from_dict({"action": "add_image", "position": "before:p-000",
                  "params": {"width": 500, "height": 300,
                             "image_path": "chart.png",
                             "image_data": base64_b64encode(png_bytes).decode()}})

# Method 3: Floating image + text wrapping
EditOp.add_image("logo.png", width=200, height=100, layout="anchor", wrap="square",
                 position_h={"relative_from": "column", "offset": "360045"},
                 position_v={"relative_from": "paragraph", "offset": "0"})

EditOp.replace_image("img-000", image_path="/mnt/new.png")
EditOp.set_image_size("img-000", width=500, height=400)
EditOp.remove_image("img-000")
EditOp.set_image_alt("img-000", alt_text="Description")

# Layout conversion: inline ↔ anchor, modify wrapping/positioning
EditOp.set_image_layout("img-000", layout="anchor", wrap="tight",
                        position_h={"relative_from": "margin", "offset": "720000"},
                        position_v={"relative_from": "paragraph", "offset": "0"})
EditOp.set_image_layout("img-000", layout="inline")  # Convert back to inline
EditOp.set_image_layout("img-000", wrap="square")     # Change wrapping only
EditOp.set_image_layout("img-000", behind_doc=True)   # Place behind text
```

**Wrap modes**: `square`/`tight`/`through`/`topAndBottom`/`none`
**Position relative_from**: `page`/`margin`/`column`/`paragraph`/`char` (horizontal); `page`/`margin`/`paragraph`/`line` (vertical)

### Lists (3 ops)

```python
# Step 1: Create numbering definition (in numbering.xml)
EditOp.create_numbering_definition(list_type="bullet", start=1)    # list_type: bullet/numbered
EditOp.create_numbering_definition(list_type="numbered", start=1)

# Enhanced: custom multi-level numbering
EditOp.create_numbering_definition(
    list_type="numbered",
    levels=[
        {"numFmt": "decimal",      "lvlText": "%1.",    "start": 1, "indent_left": "720",  "indent_hanging": "360"},
        {"numFmt": "decimal",      "lvlText": "%1.%2.",  "start": 1, "indent_left": "1440", "indent_hanging": "360"},
        {"numFmt": "lowerLetter",  "lvlText": "%1.%2.%3)", "start": 1, "indent_left": "2160", "indent_hanging": "360"},
    ],
)
# numFmt: decimal/upperLetter/lowerLetter/upperRoman/lowerRoman/chineseCounting/bullet
# indent_left/indent_hanging: twips (720 twips = 0.5 inch)

# Step 2: Apply list style to paragraph
EditOp.set_list_style("p-003", list_type="bullet", num_id="1", ilvl=0)
# num_id: numbering definition ID (auto-assigned by create_numbering_definition)
# ilvl: level (0=top, 1=second, 2=third...)

# Adjust level
EditOp.set_list_level("p-003", num_id="1", ilvl=1)
```

### Hyperlinks (3 ops)

```python
EditOp.add_hyperlink("p-003", url="https://example.com", text="Link")
EditOp.remove_hyperlink("p-003", hyperlink_index=0)
EditOp.set_hyperlink("p-003", url="https://new.com", text="New link", hyperlink_index=0)
```

### Document Properties (2 ops)

```python
EditOp.set_core_properties(title="Title", creator="Author", subject="Subject", keywords="Keywords", category="Category", description="Description")
EditOp.set_page_setup(page_width="11906", page_height="16838", orientation="portrait")  # A4 portrait
```

> **Common paper sizes (twips, 1 inch = 1440 twips)**:
> | Paper | Portrait w × h | Landscape w × h |
> |-------|----------------|-----------------|
> | **A4** | 11906 × 16838 | 16838 × 11906 |
> | A3 | 16838 × 23811 | 23811 × 16838 |
> | Letter | 12240 × 15840 | 15840 × 12240 |
> | B5 | 10063 × 14173 | 14173 × 10063 |
>
> ⚠️ **Note**: `w` must be the shorter edge (portrait) or longer edge (landscape), consistent with `orientation`. WPS templates may write inconsistent values; writeback auto-corrects them.

### Headers & Footers (5 ops)

```python
EditOp.set_header(section_index=0, text="Header text")    # text required
EditOp.set_footer(section_index=0, text="Footer text")    # text required
EditOp.add_page_number(section_index=0, alignment="center")  # No required params
EditOp.remove_header(section_index=0, header_type="default")  # Remove header (header_type: default/first/even)
EditOp.remove_footer(section_index=0, footer_type="default")  # Remove footer (footer_type: default/first/even)
```

### Comments (2 ops)

```python
EditOp.add_comment("p-003", text="Comment text", author="Reviewer")  # text required
EditOp.remove_comment("cmt-000")
```

### Footnotes & Endnotes (4 ops)

```python
EditOp.add_footnote("p-003", text="Footnote content")  # target_id + text required
EditOp.add_endnote("p-003", text="Endnote content")  # target_id + text required
EditOp.remove_footnote("fn-0")               # footnote_id required (from ingest)
EditOp.remove_endnote("en-0")               # endnote_id required
```

### Bookmarks (2 ops)

```python
EditOp.add_bookmark("p-003", bookmark_name="chapter1")  # bookmark_name required
EditOp.remove_bookmark("chapter1")
```

### TOC + Sections + Fields (8 ops)

```python
EditOp.add_toc(position="before:p-001")  # position optional
EditOp.add_section_break("p-010", break_type="nextPage")  # target_id or position required
EditOp.remove_section_break("p-010")                     # Remove section break at p-010 (merges two sections)
EditOp.set_section_properties(section_index=0, page_orientation="landscape", columns="2")
EditOp.add_field("p-005", field_type="PAGE")
EditOp.set_page_number_format(section_index=0, fmt="lowerRoman")
EditOp.refresh_toc(update_instr=' TOC \\o "1-3" \\h \\z \\u ')
EditOp.update_fields()
```

### Global Settings (4 ops)

```python
EditOp.set_doc_defaults(font_ascii="Arial", font_east_asia="SimSun", font_size="22")
EditOp.set_document_protection(protection_type="readOnly", password="123")
EditOp.set_even_odd_headers(enabled=True)
EditOp.set_auto_hyphenation(enabled=True)
```

### Revision Tracking (2 ops)

```python
EditOp.accept_all_changes()
EditOp.reject_all_changes()
```

### Phase 7: Advanced Editing (6 ops)

```python
EditOp.edit_chart("chart-000", title="Sales Trend", series_name="Q1")
EditOp.edit_equation("eq-000", equation_text="E=mc^2")
EditOp.edit_smartart("smartart-000")
EditOp.edit_textbox("txbx-000", text="New textbox content")
EditOp.edit_shape("shape-000", alt_text="Description", width="500000", height="300000")
EditOp.clone_element("p-005", position="after:p-010", count=2)
```

---

## Reading Table Data

After `ingest()`, each table in `model.tables` is a `TableNode` with:

- **`tbl.rows`** / **`tbl.cols`** — dimensions (`int`, NOT lists)
- **`tbl.cells`** — flat list of `TableCell` objects, each with `.row`, `.col`, `.text`
- **`tbl.get_row(row_index)`** — get cells for one row, sorted by column
- **`tbl.iter_rows()`** — iterate all rows as lists of cells
- **`tbl.get_cell(row, col)`** — get a specific cell

```python
# ❌ WRONG — tbl.rows is an int (row count), NOT a list
for row in tbl.rows:  # TypeError: 'int' object is not iterable
    ...

# ✅ CORRECT — use iter_rows()
for row in tbl.iter_rows():
    texts = [c.text for c in row]
    print(" | ".join(texts))

# ✅ CORRECT — use get_row(n)
header = tbl.get_row(0)
for cell in header:
    print(f"col {cell.col}: {cell.text}")

# ✅ CORRECT — use get_cell(r, c)
cell = tbl.get_cell(1, 2)
if cell:
    print(cell.text)

# ✅ CORRECT — manual iteration via range + cells
for r in range(tbl.rows):
    row_cells = sorted([c for c in tbl.cells if c.row == r], key=lambda c: c.col)
    texts = [c.text for c in row_cells]
    print(f"Row {r}: {' | '.join(texts)}")
```

---

## View Functions

| Function | Signature | Purpose |
|----------|-----------|---------|
| `scan(model)` | `(DocumentModel, max_lines=50) → str` | Compact outline: heading levels + tables + images |
| `focus(model, node_id)` | `(DocumentModel, str) → str` | Node details: paragraph runs/formatting, table content |
| `chunk(model, ...)` | `(DocumentModel, strategy, ...) → list[dict]` | Chunked reading: large docs split into segments with full text |
| `stats(model)` | `(DocumentModel) → str` | Statistics: word count/style/font distribution |
| `issues(model)` | `(DocumentModel) → str` | Issue detection: empty paragraphs/missing alt/oversized paragraphs/unknown styles |

### chunk() Detailed Guide

Split document into chunks, each containing complete paragraph text (no truncation), suitable for subagents to read one chunk at a time.

**Strategies:**

| Strategy | Description | Best For |
|----------|-------------|----------|
| `"fixed"` | Fixed paragraph count per chunk (default 50) | General, uniform splitting |
| `"heading"` | Split by Heading1 titles | Reading/editing by chapter |
| `"range"` | By paragraph ID range | Precisely reading a specific area |
| `"section"` | By Word section | Multi-section documents |

**Return value:** `list[dict]`, each dict:

```python
{
    "index": 0,           # Chunk number
    "start_id": "p-000",  # Start paragraph ID
    "end_id": "p-049",    # End paragraph ID
    "paragraphs": 50,     # Paragraph count
    "chars": 2048,        # Total characters
    "content": "..."      # Full text (with hierarchy markers)
}
```

**Usage examples:**

```python
from view import chunk

# Fixed 50 paragraphs per chunk
chunks = chunk(model, strategy="fixed", size=50)

# Split by chapters
chunks = chunk(model, strategy="heading")

# Read a specific range
chunks = chunk(model, strategy="range", start_id="p-010", end_id="p-050")

# Print chunk summary (without full content)
for c in chunks:
    print(f"Chunk {c['index']}: {c['start_id']}→{c['end_id']} | {c['paragraphs']} paragraphs | {c['chars']} chars")
```

---

## Large Document Reading Best Practices

When a document exceeds ~200 paragraphs, outputting the full text may exceed the LLM context window. Use the **main agent dispatching multiple subagents for parallel reading** pattern.

> ⚠️ **Important limitation**: subagents cannot spawn subagents (platform limitation, `subagentRuntime` is `undefined` in child level).
> Therefore **subagent dispatching must be done by the main agent itself**, cannot be delegated to a subagent.

### Workflow

```
1. Main agent: scan(model) → understand document structure and outline
2. Main agent: chunk(model, strategy="heading") → get chunk list
3. Main agent: write each chunk['content'] to temp file (/mnt_assets/_chunks/chunk_N.txt)
4. Main agent: parallel spawn_subagent × N (each subagent reads one file)
   → subagent uses read tool to read vfs://assets/_chunks/chunk_N.txt
   → subagent returns summary of that segment
5. Main agent: collect all subagent summaries, synthesize full understanding
6. Main agent: delete temp chunk files
```

### Why Write Files?

Subagents are dispatched via `spawn_subagent` tool, with prompt content passed directly. For large chunks (>10K chars):
- Putting directly in the prompt wastes tokens
- Writing to a file and letting subagents read on-demand is more efficient
- Failed chunks can be retried individually without re-transmitting content

### Full Example (Python chunking + spawn_subagent parallel dispatch)

```python
import sys, os
sys.path.insert(0, '/mnt_skills/user/cw-word-editor/scripts')
from ingest import ingest
from view import scan, chunk

# ── Step 1: ingest + view outline ──
model = ingest('/mnt/{rootName}/large_doc.docx', '/mnt/{rootName}/_wiki')
print(scan(model, max_lines=30))

# ── Step 2: Chunk ──
chunks = chunk(model, strategy="heading")
print(f"Document split into {len(chunks)} chapters")

# ── Step 3: Write chunk files ──
os.makedirs('/mnt_assets/_chunks', exist_ok=True)
for c in chunks:
    path = f'/mnt_assets/_chunks/chunk_{c["index"]}.txt'
    with open(path, 'w') as f:
        f.write(c['content'])
    print(f"  Wrote chunk_{c['index']}.txt ({c['chars']:,} chars)")
```

Then in the **same conversation turn** (main agent uses tools directly), dispatch subagents in parallel:

```
// Prompt template for each subagent:
spawn_subagent(
  name: "reader-{index}",
  description: "Read document chapter {index}",
  mode: "plan",
  prompt: """
Read the following file and summarize the key points. Output only the summary.

File path: vfs://assets/_chunks/chunk_{index}.txt

Summary requirements:
1. List each policy/item name
2. For each, summarize the core content in one sentence
  """
)
```

> 💡 **Tip**: You can launch multiple subagents in a single `spawn_subagent` call block; the platform executes them in parallel.
> If a subagent fails, use `resume_subagent` or re-launch with `spawn_subagent` to retry individually.

Clean up after reading:

```python
import shutil
shutil.rmtree('/mnt_assets/_chunks', ignore_errors=True)
shutil.rmtree('/mnt/{rootName}/_wiki', ignore_errors=True)
```

### Chunk Strategy Selection Guide

| Document Type | Recommended Strategy | Reason |
|---------------|---------------------|--------|
| Policy/regulation docs | `"heading"` | Naturally organized by chapters |
| Contracts/agreements | `"fixed"` (size=30) | Uniform format, no obvious chapter divisions |
| Academic papers | `"heading"` | Organized by Introduction/Methods/Results/Discussion |
| Technical docs | `"section"` | Multi-section structure |
| Mixed/uncertain | `"fixed"` (size=50) | Most versatile default choice |

---

## ⚠️ Clean Up Artifacts

The wiki directory is an ingest compilation artifact. **After outputting the final .docx, actively clean up**:

```python
import shutil
shutil.rmtree(wiki_dir, ignore_errors=True)
```

---

## Template Filling Best Practices

| Template Pattern | Correct Approach | Wrong Approach |
|-----------------|------------------|----------------|
| Underline blanks `Name: _____` | `fill_blanks("p-3", ["John"])` | ~~`replace_text`~~ |
| Between-label blanks `From___Year___Month` | `fill_blanks("p-17", ["2026", "05"])` | ~~`replace_text`~~ |
| Table cells `│ Fee │ Bearer │` | `edit_table_cell("tbl-0", 1, 1, "Party B")` | — |

---

## Complete EditAction List (89 ops)

**Paragraph CRUD (6)**: replace_text, fill_blanks, insert_paragraph, delete_paragraph, change_style, add_break

**Paragraph Formatting (6)**: set_paragraph_format, set_paragraph_shading, set_paragraph_border, set_tab_stops, set_paragraph_outline_level, set_paragraph_numbering_restart

**Run Formatting (4)**: set_run_format, set_run_text_effects, set_run_language, set_run_border

**Find & Replace (2)**: find_and_replace, find_and_format

**Tables (18)**: edit_table_cell, edit_table_cell_format, set_table_properties, set_table_border, add_table, remove_table, add_table_row, remove_table_row, add_table_column, remove_table_column, set_table_row_properties, merge_cells, split_cells, set_table_cell_properties, set_table_cell_margin, set_table_cell_text_direction, edit_table_cell_rich_text, set_row_cell_text

**Clone/Move (4)**: copy_paragraph, copy_table, move_paragraph, swap_paragraph

**Styles (2)**: add_style, set_style_properties

**Revision Tracking (2)**: accept_all_changes, reject_all_changes

**Images (6)**: add_image, replace_image, set_image_size, remove_image, set_image_alt, set_image_layout

**Lists (3)**: set_list_style, create_numbering_definition, set_list_level

**Hyperlinks (3)**: add_hyperlink, remove_hyperlink, set_hyperlink

**Document Properties (2)**: set_core_properties, set_page_setup

**Headers & Footers (5)**: set_header, set_footer, add_page_number, remove_header, remove_footer

**Comments (2)**: add_comment, remove_comment

**Footnotes & Endnotes (4)**: add_footnote, remove_footnote, add_endnote, remove_endnote

**Bookmarks (2)**: add_bookmark, remove_bookmark

**TOC (1)**: add_toc

**Sections (4)**: add_section_break, remove_section_break, set_section_properties, set_page_number_format

**Fields (1)**: add_field

**Global Settings (4)**: set_doc_defaults, set_document_protection, set_even_odd_headers, set_auto_hyphenation

**TOC/Field Updates (2)**: refresh_toc, update_fields

**Phase 7 (6)**: edit_chart, edit_equation, edit_smartart, edit_textbox, edit_shape, clone_element

---
