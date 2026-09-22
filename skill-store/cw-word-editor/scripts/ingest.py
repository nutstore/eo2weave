"""
Ingest Pipeline — docx → Wiki compilation pipeline

Flow:
1. Unzip docx
2. Parse document.xml → extract paragraphs, tables, images
3. Parse styles.xml → extract style definitions
4. Parse .rels → extract reference relationships
5. Build DocumentModel
6. Generate wiki markdown files
"""

from __future__ import annotations

import os
import re
import zipfile
import xml.etree.ElementTree as ET
from typing import Optional

from model import (
    NAMESPACES, ns,
    DocumentModel, ParagraphNode, StyleNode, TableNode, TableCell,
    ImageNode, SectionNode, CommentNode, RunInfo,
)


def register_namespaces():
    """Register namespaces to avoid generating ns0/ns1 prefixes on output"""
    for prefix, uri in NAMESPACES.items():
        ET.register_namespace(prefix, uri)


# ── Helper functions ──────────────────────────────────────────────

def _get_text(elem: Optional[ET.Element], tag: str) -> str:
    """Get child element text"""
    if elem is None:
        return ""
    child = elem.find(ns(tag))
    if child is not None and child.text:
        return child.text
    return ""


def _get_attr(elem: Optional[ET.Element], tag: str, attr: str) -> str:
    """Get child element attribute"""
    if elem is None:
        return ""
    child = elem.find(ns(tag))
    if child is not None:
        return child.get(attr, "")
    return ""


def _get_elem_attr(elem: Optional[ET.Element], attr: str) -> str:
    """Get element attribute"""
    if elem is None:
        return ""
    return elem.get(attr, "")


def _build_parent_map(root: ET.Element) -> dict:
    """Build parent mapping for entire document at once, avoiding repeated traversal"""
    return {c: p for p in root.iter() for c in p}


def _build_xpath(elem: ET.Element, root: ET.Element, parent_map: dict = None) -> str:
    """Build element XPath (using cached parent_map)"""
    if elem is root:
        return f"/{elem.tag}"
    if parent_map is None:
        parent_map = _build_parent_map(root)

    parent = parent_map.get(elem)
    if parent is None:
        return f"/{elem.tag}"
    siblings = [c for c in parent if c.tag == elem.tag]
    if len(siblings) > 1:
        idx = siblings.index(elem) + 1
        return f"{_build_xpath(parent, root, parent_map)}/{elem.tag}[{idx}]"
    return f"{_build_xpath(parent, root, parent_map)}/{elem.tag}"


# ── Parse Styles ──────────────────────────────────────────

def parse_styles(tree: ET.ElementTree) -> dict[str, StyleNode]:
    """Parse styles.xml"""
    root = tree.getroot()
    styles = {}

    for style_elem in root.findall(f".//{ns('w:style')}"):
        style_id = style_elem.get(f"{{{NAMESPACES['w']}}}styleId", "")
        style_type = style_elem.get(f"{{{NAMESPACES['w']}}}type", "")

        name_elem = style_elem.find(ns("w:name"))
        name = name_elem.get(f"{{{NAMESPACES['w']}}}val", "") if name_elem is not None else ""

        based_on_elem = style_elem.find(ns("w:basedOn"))
        based_on = based_on_elem.get(f"{{{NAMESPACES['w']}}}val", "") if based_on_elem is not None else ""

        is_default = style_elem.get(f"{{{NAMESPACES['w']}}}default", "0") == "1"

        # sanitize: style_id may contain spaces/asterisks and other illegal filename characters (e.g. Word-generated "font-yahei *")
        safe_id = re.sub(r'[^\w\-.]', '_', style_id) if style_id else ""

        node = StyleNode(
            id=f"style-{safe_id}",
            style_id=style_id,
            style_type=style_type,
            name=name,
            based_on=based_on,
            is_default=is_default,
        )

        # Parse run properties (rPr)
        rpr = style_elem.find(ns("w:rPr"))
        if rpr is not None:
            # Font
            rFonts = rpr.find(ns("w:rFonts"))
            if rFonts is not None:
                node.font_name = rFonts.get(f"{{{NAMESPACES['w']}}}ascii", "") or rFonts.get(f"{{{NAMESPACES['w']}}}eastAsia", "")
            
            # Font size
            sz = rpr.find(ns("w:sz"))
            if sz is not None:
                node.font_size = sz.get(f"{{{NAMESPACES['w']}}}val", "")
            
            # Bold
            node.bold = rpr.find(ns("w:b")) is not None
            # Italic
            node.italic = rpr.find(ns("w:i")) is not None
            # Underline
            node.underline = rpr.find(ns("w:u")) is not None
            # Color
            color = rpr.find(ns("w:color"))
            if color is not None:
                node.color = color.get(f"{{{NAMESPACES['w']}}}val", "")

        # Parse paragraph properties (pPr)
        ppr = style_elem.find(ns("w:pPr"))
        if ppr is not None:
            jc = ppr.find(ns("w:jc"))
            if jc is not None:
                node.alignment = jc.get(f"{{{NAMESPACES['w']}}}val", "")
            
            spacing = ppr.find(ns("w:spacing"))
            if spacing is not None:
                node.spacing_before = spacing.get(f"{{{NAMESPACES['w']}}}before", "")
                node.spacing_after = spacing.get(f"{{{NAMESPACES['w']}}}after", "")
                node.line_spacing = spacing.get(f"{{{NAMESPACES['w']}}}line", "")
            
            ind = ppr.find(ns("w:ind"))
            if ind is not None:
                node.indentation_left = ind.get(f"{{{NAMESPACES['w']}}}left", "")

        node.xml_path = "word/styles.xml"
        styles[style_id] = node

    return styles


# ── Parse Relationships ───────────────────────────────────

def parse_relationships(zip_file: zipfile.ZipFile) -> dict[str, dict]:
    """
    Parse relationship files (.rels)
    Returns { rId: { type, target } }
    """
    rels = {}
    # Try multiple possible relationship file paths
    for rels_path in ["word/_rels/document.xml.rels", "_rels/.rels"]:
        try:
            rels_content = zip_file.read(rels_path)
            root = ET.fromstring(rels_content)
            for rel in root:
                rid = rel.get("Id", "")
                target = rel.get("Target", "")
                rel_type = rel.get("Type", "")
                if rid:
                    rels[rid] = {"type": rel_type, "target": target}
        except KeyError:
            continue
    return rels


# ── Phase 7: Advanced content parsing ────────────────────────────────

def parse_charts(body: ET.Element, ns_map: dict) -> list:
    """Parse chart references. Charts in document.xml are referenced via w:drawing > a:graphic."""
    charts = []
    a_ns = "http://schemas.openxmlformats.org/drawingml/2006/main"
    r_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    for i, drawing in enumerate(body.iter(ns("w:drawing"))):
        for graphic in drawing.iter(f"{{{a_ns}}}graphic"):
            gd = graphic.find(f"{{{a_ns}}}graphicData")
            if gd is not None:
                for child in gd:
                    tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                    if tag == 'chart':
                        rId = child.get(f"{{{r_ns}}}id", "")
                        charts.append({
                            "id": f"chart-{i:03d}",
                            "relationship_id": rId,
                            "type": "chart",
                        })
    return charts


def parse_equations(body: ET.Element, ns_map: dict) -> list:
    """Parse equations (OMML). Find m:oMath and m:oMathPara elements."""
    equations = []
    m_ns = "http://schemas.openxmlformats.org/officeDocument/2006/math"
    for i, omath in enumerate(body.iter(f"{{{m_ns}}}oMath")):
        # Extract equation text
        text_parts = []
        for t in omath.iter(f"{{{m_ns}}}t"):
            if t.text:
                text_parts.append(t.text)
        eq_text = "".join(text_parts)
        equations.append({
            "id": f"eq-{i:03d}",
            "text": eq_text,
            "type": "equation",
        })
    return equations


def parse_smartart(body: ET.Element, ns_map: dict) -> list:
    """Parse SmartArt references."""
    smartart = []
    a_ns = "http://schemas.openxmlformats.org/drawingml/2006/main"
    r_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    for i, drawing in enumerate(body.iter(ns("w:drawing"))):
        for graphic in drawing.iter(f"{{{a_ns}}}graphic"):
            gd = graphic.find(f"{{{a_ns}}}graphicData")
            if gd is not None:
                for child in gd:
                    tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                    if tag == 'dgm':  # diagram (SmartArt)
                        rId = child.get(f"{{{r_ns}}}id", "")
                        smartart.append({
                            "id": f"smartart-{i:03d}",
                            "relationship_id": rId,
                            "type": "smartart",
                        })
    return smartart


def parse_textboxes(body: ET.Element, ns_map: dict) -> list:
    """Parse text boxes. Find w:txbxContent."""
    textboxes = []
    for i, txbx in enumerate(body.iter(ns("w:txbxContent"))):
        # Extract text
        text_parts = []
        for t in txbx.iter(ns("w:t")):
            if t.text:
                text_parts.append(t.text)
        text = "".join(text_parts)
        textboxes.append({
            "id": f"txbx-{i:03d}",
            "text": text,
            "type": "textbox",
        })
    return textboxes


def parse_shapes(body: ET.Element, ns_map: dict) -> list:
    """Parse shapes. Find wp:anchor/wp:inline within w:drawing."""
    shapes = []
    wp_ns = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
    for i, drawing in enumerate(body.iter(ns("w:drawing"))):
        for child in list(drawing):
            tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if tag in ('anchor', 'inline'):
                # Get dimensions
                extent = child.find(f"{{{wp_ns}}}extent")
                cx = extent.get("cx", "") if extent is not None else ""
                cy = extent.get("cy", "") if extent is not None else ""
                # Get alt text
                docPr = child.find(f"{{{wp_ns}}}docPr")
                name = docPr.get("name", "") if docPr is not None else ""
                descr = docPr.get("descr", "") if docPr is not None else ""
                shapes.append({
                    "id": f"shape-{i:03d}",
                    "name": name,
                    "alt_text": descr,
                    "width": cx,
                    "height": cy,
                    "type": "shape",
                })
    return shapes


# ── Document-level parsing ───────────────────────────────────────

def parse_headers_footers(files: dict) -> list:
    """Parse word/headerN.xml and word/footerN.xml"""
    results = []
    for name, data in files.items():
        if name.startswith('word/') and ('header' in name or 'footer' in name) and name.endswith('.xml'):
            try:
                root = ET.fromstring(data)
                texts = []
                for t in root.iter(ns("w:t")):
                    if t.text:
                        texts.append(t.text)
                results.append({
                    "id": name.replace("/", "-").replace(".xml", ""),
                    "type": "header" if "header" in name else "footer",
                    "text": "".join(texts),
                    "path": name,
                })
            except ET.ParseError:
                pass
    return results


def parse_comments_xml(files: dict) -> list:
    """Parse word/comments.xml → list of CommentNode"""
    data = files.get("word/comments.xml")
    if not data:
        return []
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []
    comments = []
    for comment in root.findall(ns("w:comment")):
        cmt_id = comment.get(f"{{{NAMESPACES['w']}}}id", "")
        author = comment.get(f"{{{NAMESPACES['w']}}}author", "")
        date = comment.get(f"{{{NAMESPACES['w']}}}date", "")
        texts = []
        for t in comment.iter(ns("w:t")):
            if t.text:
                texts.append(t.text)
        cmt = CommentNode(
            id=f"cmt-{cmt_id}",
            author=author,
            date=date,
            text="".join(texts),
        )
        comments.append(cmt)
    return comments


def parse_footnotes_xml(files: dict) -> list:
    """Parse word/footnotes.xml"""
    data = files.get("word/footnotes.xml")
    if not data:
        return []
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []
    footnotes = []
    for fn in root.findall(ns("w:footnote")):
        fn_id = fn.get(f"{{{NAMESPACES['w']}}}id", "")
        fn_type = fn.get(f"{{{NAMESPACES['w']}}}type", "")
        if fn_type in ("separator", "continuationSeparator"):
            continue
        texts = []
        for t in fn.iter(ns("w:t")):
            if t.text:
                texts.append(t.text)
        footnotes.append({
            "id": f"fn-{fn_id}",
            "text": "".join(texts),
        })
    return footnotes


def parse_endnotes_xml(files: dict) -> list:
    """Parse word/endnotes.xml"""
    data = files.get("word/endnotes.xml")
    if not data:
        return []
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []
    endnotes = []
    for en in root.findall(ns("w:endnote")):
        en_id = en.get(f"{{{NAMESPACES['w']}}}id", "")
        en_type = en.get(f"{{{NAMESPACES['w']}}}type", "")
        if en_type in ("separator", "continuationSeparator"):
            continue
        texts = []
        for t in en.iter(ns("w:t")):
            if t.text:
                texts.append(t.text)
        endnotes.append({
            "id": f"en-{en_id}",
            "text": "".join(texts),
        })
    return endnotes


def parse_core_properties(files: dict) -> dict:
    """Parse docProps/core.xml"""
    data = files.get("docProps/core.xml")
    if not data:
        return {}
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return {}
    props = {}
    cp_ns = "http://purl.org/dc/elements/1.1/"
    dcterms_ns = "http://purl.org/dc/terms/"
    for tag, key in [
        (f"{{{cp_ns}}}title", "title"),
        (f"{{{cp_ns}}}creator", "creator"),
        (f"{{{cp_ns}}}subject", "subject"),
        (f"{{{cp_ns}}}description", "description"),
        (f"{{{cp_ns}}}language", "language"),
        (f"{{{dcterms_ns}}}created", "created"),
        (f"{{{dcterms_ns}}}modified", "modified"),
    ]:
        elem = root.find(tag)
        if elem is not None and elem.text:
            props[key] = elem.text
    # Keywords
    cp_ns2 = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
    kw = root.find(f"{{{cp_ns2}}}keywords")
    if kw is not None and kw.text:
        props["keywords"] = kw.text
    return props


def detect_track_changes(body: ET.Element) -> bool:
    """Detect whether the document has track changes"""
    for tag in [ns("w:ins"), ns("w:del")]:
        if body.find(f".//{tag}") is not None:
            return True
    return False


def parse_sdt_controls(body: ET.Element) -> list:
    """Parse content controls (SDT)"""
    controls = []
    for i, sdt in enumerate(body.iter(ns("w:sdt"))):
        sdtPr = sdt.find(ns("w:sdtPr"))
        alias = ""
        tag = ""
        sdt_type = ""
        if sdtPr is not None:
            alias_elem = sdtPr.find(ns("w:alias"))
            if alias_elem is not None:
                alias = alias_elem.get(f"{{{NAMESPACES['w']}}}val", "")
            tag_elem = sdtPr.find(ns("w:tag"))
            if tag_elem is not None:
                tag = tag_elem.get(f"{{{NAMESPACES['w']}}}val", "")
            if sdtPr.find(ns("w:comboBox")) is not None:
                sdt_type = "comboBox"
            elif sdtPr.find(ns("w:dropDownList")) is not None:
                sdt_type = "dropDownList"
            elif sdtPr.find(ns("w:date")) is not None:
                sdt_type = "date"
            elif sdtPr.find(ns("w:picture")) is not None:
                sdt_type = "picture"
            else:
                sdt_type = "text"
        texts = []
        for t in sdt.iter(ns("w:t")):
            if t.text:
                texts.append(t.text)
        controls.append({
            "id": f"sdt-{i:03d}",
            "alias": alias,
            "tag": tag,
            "type": sdt_type,
            "text": "".join(texts),
        })
    return controls


# ── Parse Document ────────────────────────────────────────

def parse_document(
    tree: ET.ElementTree,
    rels: dict[str, dict],
) -> tuple[list[ParagraphNode], list[TableNode], list[ImageNode], list[SectionNode], list, list, list, list, list]:
    """Parse document.xml to extract paragraphs, tables, images"""
    root = tree.getroot()
    body = root.find(ns("w:body"))
    if body is None:
        return [], [], [], [], [], [], [], [], []

    paragraphs: list[ParagraphNode] = []
    tables = []
    images = []
    sections = []

    # Current section
    current_section = SectionNode(
        id="section-0",
        section_index=0,
    )
    sections.append(current_section)

    # Image counter
    img_counter = 0
    # Table counter
    tbl_counter = 0

    # Iterate direct children of body
    para_index = 0
    body_children = list(body)
    parent_map = _build_parent_map(root)

    for child_idx, child in enumerate(body_children):
        tag = child.tag

        # ── Paragraph ──
        if tag == ns("w:p"):
            p_node = _parse_paragraph(child, para_index, root, rels)
            p_node.section_id = current_section.id
            p_node.xml_path = "word/document.xml"
            p_node.xpath = _build_xpath(child, root, parent_map)


            # Check if paragraph contains images
            for drawing in child.iter(ns("w:drawing")):
                img_node, img_id = _extract_image(drawing, img_counter, rels, root)
                if img_node:
                    images.append(img_node)
                    p_node.image_ids.append(img_id)
                    img_counter += 1

            # Check for legacy images (w:pict)
            for pict in child.iter(ns("w:pict")):
                img_node, img_id = _extract_image_legacy(pict, img_counter, rels, root)
                if img_node:
                    images.append(img_node)
                    p_node.image_ids.append(img_id)
                    img_counter += 1

            paragraphs.append(p_node)
            current_section.paragraph_ids.append(p_node.id)
            para_index += 1

        # ── SDT (content control) — parse inner paragraphs and tag with sdt_alias ──
        elif tag == ns("w:sdt"):
            sdtPr = child.find(ns("w:sdtPr"))
            sdt_alias = ""
            if sdtPr is not None:
                alias_elem = sdtPr.find(ns("w:alias"))
                if alias_elem is not None:
                    sdt_alias = alias_elem.get(f"{{{NAMESPACES['w']}}}val", "")
            # Parse paragraphs inside SDT
            sdt_content = child.find(ns("w:sdtContent"))
            if sdt_content is not None:
                for inner_child in sdt_content.findall(ns("w:p")):
                    p_node = _parse_paragraph(inner_child, para_index, root, rels)
                    p_node.section_id = current_section.id
                    p_node.xml_path = "word/document.xml"
                    if sdt_alias:
                        p_node.sdt_alias = sdt_alias
                    # Check for images
                    for drawing in inner_child.iter(ns("w:drawing")):
                        img_node, img_id = _extract_image(drawing, img_counter, rels, root)
                        if img_node:
                            images.append(img_node)
                            p_node.image_ids.append(img_id)
                            img_counter += 1
                    paragraphs.append(p_node)
                    current_section.paragraph_ids.append(p_node.id)
                    para_index += 1

        # ── Table ──
        elif tag == ns("w:tbl"):
            tbl_node = _parse_table(child, tbl_counter, root, rels)
            tbl_node.xml_path = "word/document.xml"
            tbl_node.xpath = _build_xpath(child, root, parent_map)

            tables.append(tbl_node)
            tbl_counter += 1

        # ── Section break ──
        elif tag == ns("w:sectPr"):
            # Body-level sectPr
            _apply_section_props(current_section, child)
        else:
            # Paragraph-level section breaks are handled via pPr/sectPr
            pass

    # Process paragraph-level section breaks
    _process_section_breaks(body, root, paragraphs, sections)

    # Set forward/backward references
    for i, p in enumerate(paragraphs):
        if i > 0:
            p.previous_id = paragraphs[i - 1].id
        if i < len(paragraphs) - 1:
            p.next_id = paragraphs[i + 1].id

    # Phase 7: Advanced content parsing
    charts = parse_charts(body, NAMESPACES)
    equations = parse_equations(body, NAMESPACES)
    smartart_nodes = parse_smartart(body, NAMESPACES)
    textbox_nodes = parse_textboxes(body, NAMESPACES)
    shape_nodes = parse_shapes(body, NAMESPACES)

    return paragraphs, tables, images, sections, charts, equations, smartart_nodes, textbox_nodes, shape_nodes


def _parse_paragraph(
    elem: ET.Element, index: int, root: ET.Element, rels: dict
) -> ParagraphNode:
    """Parse a single paragraph element"""
    node = ParagraphNode(id=f"p-{index:03d}", index=index)

    # Paragraph properties
    ppr = elem.find(ns("w:pPr"))
    if ppr is not None:
        # Style
        pstyle = ppr.find(ns("w:pStyle"))
        if pstyle is not None:
            node.style_id = pstyle.get(f"{{{NAMESPACES['w']}}}val", "")
        
        # Alignment
        jc = ppr.find(ns("w:jc"))
        if jc is not None:
            node.alignment = jc.get(f"{{{NAMESPACES['w']}}}val", "")
        
        # Indentation
        ind = ppr.find(ns("w:ind"))
        if ind is not None:
            node.indentation_left = ind.get(f"{{{NAMESPACES['w']}}}left", "")
            node.indentation_first_line = ind.get(f"{{{NAMESPACES['w']}}}firstLine", "")
        
        # Spacing
        spacing = ppr.find(ns("w:spacing"))
        if spacing is not None:
            node.spacing_before = spacing.get(f"{{{NAMESPACES['w']}}}before", "")
            node.spacing_after = spacing.get(f"{{{NAMESPACES['w']}}}after", "")
            node.line_spacing = spacing.get(f"{{{NAMESPACES['w']}}}line", "")

    # ── Shading (shd) ──
    if ppr is not None:
        shd = ppr.find(ns("w:shd"))
        if shd is not None:
            node.shading_fill = shd.get(f"{{{NAMESPACES['w']}}}fill", "")
            node.shading_val = shd.get(f"{{{NAMESPACES['w']}}}val", "")

    # ── Paragraph borders (pBdr) ──
    if ppr is not None:
        pBdr = ppr.find(ns("w:pBdr"))
        if pBdr is not None:
            borders = {}
            for side in ("top", "left", "bottom", "right", "between", "bar"):
                border_elem = pBdr.find(ns(f"w:{side}"))
                if border_elem is not None:
                    borders[side] = {
                        "val": border_elem.get(f"{{{NAMESPACES['w']}}}val", ""),
                        "sz": border_elem.get(f"{{{NAMESPACES['w']}}}sz", ""),
                        "space": border_elem.get(f"{{{NAMESPACES['w']}}}space", ""),
                        "color": border_elem.get(f"{{{NAMESPACES['w']}}}color", ""),
                    }
            if borders:
                node.borders = borders

    # ── Tab stops (tabs) ──
    if ppr is not None:
        tabs_elem = ppr.find(ns("w:tabs"))
        if tabs_elem is not None:
            tab_stops = []
            for tab_elem in tabs_elem.findall(ns("w:tab")):
                tab_def = {
                    "val": tab_elem.get(f"{{{NAMESPACES['w']}}}val", "left"),
                    "pos": tab_elem.get(f"{{{NAMESPACES['w']}}}pos", "0"),
                }
                leader = tab_elem.get(f"{{{NAMESPACES['w']}}}leader")
                if leader:
                    tab_def["leader"] = leader
                tab_stops.append(tab_def)
            if tab_stops:
                node.tab_stops = tab_stops

    # ── Outline level (outlineLvl) ──
    if ppr is not None:
        ol = ppr.find(ns("w:outlineLvl"))
        if ol is not None:
            try:
                node.outline_level = int(ol.get(f"{{{NAMESPACES['w']}}}val", "0"))
            except (ValueError, TypeError):
                pass

    # ── List numbering (numPr) ──
    numPr = ppr.find(ns("w:numPr")) if ppr is not None else None
    if numPr is not None:
        numId_elem = numPr.find(ns("w:numId"))
        ilvl_elem = numPr.find(ns("w:ilvl"))
        if numId_elem is not None:
            node.num_id = numId_elem.get(f"{{{NAMESPACES['w']}}}val", "")
        if ilvl_elem is not None:
            node.ilvl = int(ilvl_elem.get(f"{{{NAMESPACES['w']}}}val", "0"))

    # ── Bookmarks ──
    bookmarks = []
    for bm in elem.findall(ns("w:bookmarkStart")):
        bm_name = bm.get(f"{{{NAMESPACES['w']}}}name", "")
        if bm_name and bm_name != "_GoBack":
            bookmarks.append(bm_name)
    node.bookmarks = bookmarks

    # ── Comment references ──
    comment_ids = []
    for crs in elem.findall(ns("w:commentRangeStart")):
        cid = crs.get(f"{{{NAMESPACES['w']}}}id", "")
        if cid:
            comment_ids.append(f"cmt-{cid}")
    node.comment_ids = comment_ids

    # ── Footnote references ──
    footnote_ids = []
    for fnr in elem.iter(ns("w:footnoteReference")):
        fn_id = fnr.get(f"{{{NAMESPACES['w']}}}id", "")
        if fn_id:
            footnote_ids.append(f"fn-{fn_id}")
    node.footnote_ids = footnote_ids

    # ── Endnote references ──
    endnote_ids = []
    for enr in elem.iter(ns("w:endnoteReference")):
        en_id = enr.get(f"{{{NAMESPACES['w']}}}id", "")
        if en_id:
            endnote_ids.append(f"en-{en_id}")
    node.endnote_ids = endnote_ids

    # ── Track current hyperlink context ──
    current_hyperlink_url = ""

    # Runs — iterate all direct children to handle hyperlink wrapping
    for child_elem in elem:
        # ── w:hyperlink wrapper ──
        if child_elem.tag == ns("w:hyperlink"):
            rid = child_elem.get(f"{{{NAMESPACES['r']}}}id", "")
            anchor = child_elem.get(f"{{{NAMESPACES['w']}}}anchor", "")
            current_hyperlink_url = ""
            if rid and rid in rels:
                current_hyperlink_url = rels[rid].get("target", "")
            elif anchor:
                current_hyperlink_url = f"#{anchor}"
            # Process runs inside hyperlink
            for run_elem in child_elem.findall(ns("w:r")):
                run_info = _parse_run(run_elem, elem, current_hyperlink_url, rels)
                node.runs.append(run_info)
            current_hyperlink_url = ""
            continue

        # ── w:ins (revision insertion) ──
        if child_elem.tag == ns("w:ins"):
            ins_id = child_elem.get(f"{{{NAMESPACES['w']}}}id", "")
            ins_author = child_elem.get(f"{{{NAMESPACES['w']}}}author", "")
            ins_date = child_elem.get(f"{{{NAMESPACES['w']}}}date", "")
            for run_elem in child_elem.findall(ns("w:r")):
                run_info = _parse_run(run_elem, elem, current_hyperlink_url, rels)
                run_info.is_insertion = True
                run_info.revision_id = ins_id
                run_info.revision_author = ins_author
                run_info.revision_date = ins_date
                node.runs.append(run_info)
            continue

        # ── w:del (revision deletion) ──
        if child_elem.tag == ns("w:del"):
            del_id = child_elem.get(f"{{{NAMESPACES['w']}}}id", "")
            del_author = child_elem.get(f"{{{NAMESPACES['w']}}}author", "")
            del_date = child_elem.get(f"{{{NAMESPACES['w']}}}date", "")
            for run_elem in child_elem.findall(ns("w:r")):
                run_info = _parse_run(run_elem, elem, current_hyperlink_url, rels)
                run_info.is_deletion = True
                run_info.revision_id = del_id
                run_info.revision_author = del_author
                run_info.revision_date = del_date
                # Deleted text comes from w:delText
                dt_elem = run_elem.find(ns("w:delText"))
                if dt_elem is not None and dt_elem.text:
                    run_info.text = dt_elem.text
                node.runs.append(run_info)
            continue

        # ── Regular w:r ──
        if child_elem.tag == ns("w:r"):
            run_info = _parse_run(child_elem, elem, current_hyperlink_url, rels)
            node.runs.append(run_info)
            continue

        # ── fldChar / instrText (fields) — may appear at paragraph direct child level ──
        # These are normally inside w:r, but may appear directly in some structures
        pass

    # Concatenate full text
    node.text = "".join(r.text for r in node.runs)

    node.build_references()
    return node


def _parse_run(
    run_elem: ET.Element, para_elem: ET.Element,
    hyperlink_url: str, rels: dict,
) -> RunInfo:
    """Parse a single run element, filling all RunInfo fields"""
    run_info = RunInfo()

    # Run properties
    rpr = run_elem.find(ns("w:rPr"))
    if rpr is not None:
        run_info.bold = rpr.find(ns("w:b")) is not None
        run_info.italic = rpr.find(ns("w:i")) is not None

        # Underline (with type)
        u_elem = rpr.find(ns("w:u"))
        if u_elem is not None:
            run_info.underline = True
            run_info.has_underline = True
            run_info.underline_val = u_elem.get(f"{{{NAMESPACES['w']}}}val", "")

        # Strikethrough
        strike_elem = rpr.find(ns("w:strike"))
        if strike_elem is not None:
            run_info.strike = strike_elem.get(f"{{{NAMESPACES['w']}}}val", "1") != "0"

        rFonts = rpr.find(ns("w:rFonts"))
        if rFonts is not None:
            run_info.font_name = (rFonts.get(f"{{{NAMESPACES['w']}}}ascii", "")
                                  or rFonts.get(f"{{{NAMESPACES['w']}}}eastAsia", ""))

        sz = rpr.find(ns("w:sz"))
        if sz is not None:
            run_info.font_size = sz.get(f"{{{NAMESPACES['w']}}}val", "")

        # Color
        color_elem = rpr.find(ns("w:color"))
        if color_elem is not None:
            run_info.color = color_elem.get(f"{{{NAMESPACES['w']}}}val", "")

        # Character scaling (w:w)
        w_elem = rpr.find(ns("w:w"))
        if w_elem is not None:
            run_info.char_scale = w_elem.get(f"{{{NAMESPACES['w']}}}val", "")

        # Kerning (w:kern)
        kern_elem = rpr.find(ns("w:kern"))
        if kern_elem is not None:
            run_info.kern = kern_elem.get(f"{{{NAMESPACES['w']}}}val", "")

        # Baseline offset (w:position)
        pos_elem = rpr.find(ns("w:position"))
        if pos_elem is not None:
            run_info.position = pos_elem.get(f"{{{NAMESPACES['w']}}}val", "")

    # Text
    t_elem = run_elem.find(ns("w:t"))
    if t_elem is not None and t_elem.text:
        run_info.text = t_elem.text
    # Tab
    tab_elem = run_elem.find(ns("w:tab"))
    if tab_elem is not None:
        run_info.text = "\t"
    # Line break
    br_elem = run_elem.find(ns("w:br"))
    if br_elem is not None:
        run_info.text = "\n"

    # ── Detect blank fill areas ──
    _text = run_info.text or ""
    is_whitespace_only = _text.strip() == "" and len(_text) > 0
    # Underline fill area: text segments containing consecutive ≥3 underscore characters (e.g. "___________________")
    import re as _re
    is_underscore_fill = bool(_re.search(r'_{3,}|＿{3,}|﹍{3,}', _text))
    rsid_r = run_elem.get(f"{{{NAMESPACES['w']}}}rsidR", "")
    has_original_rsid = rsid_r == "" or rsid_r == para_elem.get(f"{{{NAMESPACES['w']}}}rsidRDefault", "")
    if (is_whitespace_only and (run_info.has_underline or not has_original_rsid)) or is_underscore_fill:
        run_info.is_blank = True

    # ── Hyperlink ──
    if hyperlink_url:
        run_info.hyperlink_url = hyperlink_url

    # ── Field detection ──
    fldChar = run_elem.find(ns("w:fldChar"))
    if fldChar is not None:
        fld_type = fldChar.get(f"{{{NAMESPACES['w']}}}fldCharType", "")
        run_info.field_type = fld_type  # "begin", "separate", "end"

    instrText = run_elem.find(ns("w:instrText"))
    if instrText is not None and instrText.text:
        run_info.field_instruction = instrText.text.strip()

    return run_info


def _extract_image(
    drawing: ET.Element, counter: int, rels: dict, root: ET.Element
) -> tuple[Optional[ImageNode], str]:
    """Extract image info from w:drawing (including floating layout)"""
    # Try to find blip (image reference)
    blip = drawing.find(f".//{ns('a:blip')}")
    if blip is None:
        return None, ""

    embed_id = blip.get(f"{{{NAMESPACES['r']}}}embed", "")
    if not embed_id:
        return None, ""

    rel_info = rels.get(embed_id, {})
    target = rel_info.get("target", "")
    filename = os.path.basename(target) if target else f"image_{counter}"

    # Try to get dimensions
    extent = drawing.find(f".//{ns('wp:extent')}")
    width = extent.get("cx", "") if extent is not None else ""
    height = extent.get("cy", "") if extent is not None else ""

    # Try to get description
    docPr = drawing.find(f".//{ns('wp:docPr')}")
    descr = docPr.get("descr", "") if docPr is not None else ""

    img_id = f"img-{counter:03d}"
    node = ImageNode(
        id=img_id,
        filename=filename,
        media_path=target,
        width=width,
        height=height,
        description=descr,
        xpath=_build_xpath(drawing, root),
        xml_path="word/document.xml",
    )

    # ── Parse floating layout properties ──
    wp_ns = NAMESPACES["wp"]
    anchor = drawing.find(f"{{{wp_ns}}}anchor")
    if anchor is not None:
        node.layout = "anchor"
        node.behind_doc = anchor.get("behindDoc", "0") == "1"
        node.locked = anchor.get("locked", "0") == "1"
        node.allow_overlap = anchor.get("allowOverlap", "1") != "0"
        node.layout_in_cell = anchor.get("layoutInCell", "1") != "0"

        # positionH
        pos_h = anchor.find(f"{{{wp_ns}}}positionH")
        if pos_h is not None:
            node.position_h_relative = pos_h.get("relativeFrom", "")
            pos_off = pos_h.find(f"{{{wp_ns}}}posOffset")
            if pos_off is not None and pos_off.text:
                node.position_h_offset = pos_off.text

        # positionV
        pos_v = anchor.find(f"{{{wp_ns}}}positionV")
        if pos_v is not None:
            node.position_v_relative = pos_v.get("relativeFrom", "")
            pos_off = pos_v.find(f"{{{wp_ns}}}posOffset")
            if pos_off is not None and pos_off.text:
                node.position_v_offset = pos_off.text

        # Wrap mode
        for wrap_tag, wrap_name in [
            ("wrapSquare", "square"), ("wrapTight", "tight"),
            ("wrapThrough", "through"), ("wrapTopAndBottom", "topAndBottom"),
            ("wrapNone", "none"),
        ]:
            if anchor.find(f"{{{wp_ns}}}{wrap_tag}") is not None:
                node.wrap = wrap_name
                break
    else:
        node.layout = "inline"

    node.build_references()
    return node, img_id


def _extract_image_legacy(
    pict: ET.Element, counter: int, rels: dict, root: ET.Element
) -> tuple[Optional[ImageNode], str]:
    """Extract image info from legacy w:pict"""
    # Try v:imagedata or similar elements
    for elem in pict.iter():
        if elem.tag.endswith("}imagedata") or elem.tag == "imagedata":
            rid = elem.get(f"{{{NAMESPACES['r']}}}id", "")
            if rid:
                rel_info = rels.get(rid, {})
                target = rel_info.get("target", "")
                filename = os.path.basename(target) if target else f"image_{counter}"
                img_id = f"img-{counter:03d}"
                node = ImageNode(
                    id=img_id,
                    filename=filename,
                    media_path=target,
                    xpath=_build_xpath(pict, root),
                    xml_path="word/document.xml",
                )
                return node, img_id
    return None, ""


def _parse_table(
    elem: ET.Element, counter: int, root: ET.Element, rels: dict
) -> TableNode:
    """Parse table element"""
    tbl_id = f"tbl-{counter:03d}"
    node = TableNode(id=tbl_id)

    rows = elem.findall(ns("w:tr"))
    node.rows = len(rows)

    for row_idx, row in enumerate(rows):
        cells = row.findall(ns("w:tc"))
        if row_idx == 0:
            node.cols = len(cells)
        
        for col_idx, cell in enumerate(cells):
            # Get cell text
            texts = []
            for t in cell.iter(ns("w:t")):
                if t.text:
                    texts.append(t.text)
            cell_text = "".join(texts)
            
            # Cell properties
            merge_type = ""
            grid_span = 1
            v_merge = ""
            text_dir = ""
            tc_pr = cell.find(ns("w:tcPr"))
            if tc_pr is not None:
                gs_elem = tc_pr.find(ns("w:gridSpan"))
                if gs_elem is not None:
                    try:
                        grid_span = int(gs_elem.get(f"{{{NAMESPACES['w']}}}val", "1"))
                    except ValueError:
                        pass
                hMerge = tc_pr.find(ns("w:hMerge"))
                if hMerge is not None:
                    merge_type = hMerge.get(f"{{{NAMESPACES['w']}}}val", "continue")
                vMerge = tc_pr.find(ns("w:vMerge"))
                if vMerge is not None:
                    v_merge = vMerge.get(f"{{{NAMESPACES['w']}}}val", "continue")
                    if not merge_type:
                        merge_type = v_merge
                # Text direction (vertical text)
                text_dir_elem = tc_pr.find(ns("w:textDirection"))
                text_dir = ""
                if text_dir_elem is not None:
                    text_dir = text_dir_elem.get(f"{{{NAMESPACES['w']}}}val", "")

            node.cells.append(TableCell(
                text=cell_text,
                row=row_idx,
                col=col_idx,
                merge_type=merge_type,
                grid_span=grid_span,
                v_merge=v_merge,
                text_direction=text_dir,
            ))

    node.build_references()
    return node


def _fix_pgSz_consistency(pgSz):
    """Ensure pgSz w/h are consistent with orient (fix inconsistent writes from WPS and similar tools).

    portrait: w <= h; landscape: w >= h. Automatically swap w/h when inconsistent.
    """
    if pgSz is None:
        return
    w = NAMESPACES["w"]
    w_val = pgSz.get(f"{{{w}}}w")
    h_val = pgSz.get(f"{{{w}}}h")
    orient = pgSz.get(f"{{{w}}}orient", "portrait")
    if not w_val or not h_val:
        return
    w_int, h_int = int(w_val), int(h_val)
    if orient == "portrait" and w_int > h_int:
        pgSz.set(f"{{{w}}}w", str(h_int))
        pgSz.set(f"{{{w}}}h", str(w_int))
    elif orient == "landscape" and w_int < h_int:
        pgSz.set(f"{{{w}}}w", str(h_int))
        pgSz.set(f"{{{w}}}h", str(w_int))


def _apply_section_props(section: SectionNode, sectPr: ET.Element):
    """Extract page settings from sectPr"""
    pgSz = sectPr.find(ns("w:pgSz"))
    if pgSz is not None:
        section.page_width = pgSz.get(f"{{{NAMESPACES['w']}}}w", "")
        section.page_height = pgSz.get(f"{{{NAMESPACES['w']}}}h", "")
        section.orientation = pgSz.get(f"{{{NAMESPACES['w']}}}orient", "portrait")

        # FIX: ensure w/h match orient (WPS may write inconsistent pgSz)
        _fix_pgSz_consistency(pgSz)
        # Re-read after fix
        section.page_width = pgSz.get(f"{{{NAMESPACES['w']}}}w", "")
        section.page_height = pgSz.get(f"{{{NAMESPACES['w']}}}h", "")

    pgMar = sectPr.find(ns("w:pgMar"))
    if pgMar is not None:
        section.margins = {
            "top": pgMar.get(f"{{{NAMESPACES['w']}}}top", ""),
            "bottom": pgMar.get(f"{{{NAMESPACES['w']}}}bottom", ""),
            "left": pgMar.get(f"{{{NAMESPACES['w']}}}left", ""),
            "right": pgMar.get(f"{{{NAMESPACES['w']}}}right", ""),
        }

    cols = sectPr.find(ns("w:cols"))
    if cols is not None:
        section.columns = {
            k: cols.get(f"{{{NAMESPACES['w']}}}{k}")
            for k in ("num", "space", "equalWidth", "sep")
            if cols.get(f"{{{NAMESPACES['w']}}}{k}") is not None
        }


def _process_section_breaks(
    body: ET.Element, root: ET.Element,
    paragraphs: list[ParagraphNode], sections: list[SectionNode]
):
    """Process paragraph-level section breaks, assign paragraphs to correct sections"""
    # Build ordered list of body direct child w:p, used to determine paragraph boundaries
    body_paragraphs = [child for child in body if child.tag == ns("w:p")]

    if not body_paragraphs or not paragraphs:
        return

    # Ensure list length matches
    if len(body_paragraphs) != len(paragraphs):
        # Count mismatch — skip processing
        return

    current_section_idx = 0

    for elem_idx, p_elem in enumerate(body_paragraphs):
        ppr = p_elem.find(ns("w:pPr"))
        if ppr is not None:
            sectPr = ppr.find(ns("w:sectPr"))
            if sectPr is not None:
                # This paragraph has a section break after it → subsequent paragraphs belong to new section
                current_section_idx += 1
                new_section = SectionNode(
                    id=f"section-{current_section_idx}",
                    section_index=current_section_idx,
                )
                _apply_section_props(new_section, sectPr)
                sections.append(new_section)

                # Update section_id for subsequent paragraphs
                for later_p in paragraphs[elem_idx + 1:]:
                    later_p.section_id = new_section.id
                    # Append paragraph to new section's paragraph_ids
                    # (first clear any references that may exist in old section; build_reverse_refs will rebuild)
                    new_section.paragraph_ids.append(later_p.id)


# ── Write Wiki files ────────────────────────────────────────

def write_wiki(model: DocumentModel, output_dir: str):
    """Write DocumentModel to wiki directory"""
    os.makedirs(output_dir, exist_ok=True)

    # Create subdirectories
    for subdir in ["paragraphs", "styles", "tables", "images", "sections"]:
        os.makedirs(os.path.join(output_dir, subdir), exist_ok=True)

    # Write node pages
    for p in model.paragraphs:
        _write_page(os.path.join(output_dir, p.file_path()), p.to_markdown())
    
    for s in model.styles.values():
        _write_page(os.path.join(output_dir, s.file_path()), s.to_markdown())
    
    for t in model.tables:
        _write_page(os.path.join(output_dir, t.file_path()), t.to_markdown())
    
    for img in model.images:
        _write_page(os.path.join(output_dir, img.file_path()), img.to_markdown())
    
    for sec in model.sections:
        _write_page(os.path.join(output_dir, sec.file_path()), sec.to_markdown())

    # Write index.md
    index_path = os.path.join(output_dir, "index.md")
    with open(index_path, "w", encoding="utf-8") as f:
        f.write(model.generate_index())

    # Write log.md
    log_path = os.path.join(output_dir, "log.md")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(model.generate_log(action="ingest", detail="Initial ingest from docx"))

    # Write SCHEMA copy (if not exists)
    schema_path = os.path.join(output_dir, "SCHEMA.md")
    if not os.path.exists(schema_path):
        _write_page(schema_path, _get_default_schema())


def _write_page(path: str, content: str):
    """Write a single wiki page"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def _get_default_schema() -> str:
    """Return default schema content"""
    return """# Wiki Schema

## Page format

Each page consists of three parts:
1. YAML Frontmatter — structured metadata
2. Markdown Body — readable content
3. Context Section — reference relationships

## Naming conventions

| Type | ID format | Path |
|------|-----------|------|
| Paragraph | p-NNN | paragraphs/p-NNN.md |
| Table | tbl-NNN | tables/tbl-NNN.md |
| Image | img-NNN | images/img-NNN.md |
| Style | style-{name} | styles/{name}.md |
| Section | section-N | sections/section-N.md |

## Edit operations (EditOps)

Agents should generate JSON-format edit instructions rather than directly modifying the wiki.
"""


# ── Main entry point ────────────────────────────────────────

def ingest(
    docx_path: str,
    output_dir: str,
    wiki_name: str = "",
) -> DocumentModel:
    """
    Compile docx into Wiki
    
    Args:
        docx_path: docx file path
        output_dir: Wiki output directory
        wiki_name: Optional wiki name
    
    Returns:
        DocumentModel — complete document model
    """
    register_namespaces()

    if not wiki_name:
        wiki_name = os.path.splitext(os.path.basename(docx_path))[0]

    # 1. Unzip docx
    with zipfile.ZipFile(docx_path, "r") as zf:
        # 1a. Read all files into files dict
        files = {}
        for name in zf.namelist():
            if name.endswith('.xml'):
                try:
                    files[name] = zf.read(name)
                except Exception:
                    pass

        # 2. Parse relationships
        rels = parse_relationships(zf)

        # 3. Parse styles.xml
        styles = {}
        try:
            styles_content = zf.read("word/styles.xml")
            styles_tree = ET.ElementTree(ET.fromstring(styles_content))
            styles = parse_styles(styles_tree)
        except KeyError:
            pass  # No styles.xml

        # 4. Parse document.xml
        doc_content = zf.read("word/document.xml")
        doc_tree = ET.ElementTree(ET.fromstring(doc_content))
        paragraphs, tables, images, sections, charts, equations, smartart_nodes, textbox_nodes, shape_nodes = parse_document(doc_tree, rels)

        # 5. Parse DocumentModel-level supplementary data
        headers_footers = parse_headers_footers(files)
        comments = parse_comments_xml(files)
        footnotes = parse_footnotes_xml(files)
        endnotes = parse_endnotes_xml(files)
        core_properties = parse_core_properties(files)

        # 5a. Detect track changes & SDT
        doc_root = doc_tree.getroot()
        body = doc_root.find(ns("w:body"))
        has_track_changes = detect_track_changes(body) if body is not None else False
        sdt_controls = parse_sdt_controls(body) if body is not None else []

    # 6. Build DocumentModel
    model = DocumentModel(
        source_file=os.path.basename(docx_path),
        paragraphs=paragraphs,
        styles=styles,
        tables=tables,
        images=images,
        sections=sections,
    )
    model.charts = charts
    model.equations = equations
    model.smartart_nodes = smartart_nodes
    model.textbox_nodes = textbox_nodes
    model.shape_nodes = shape_nodes
    # DocumentModel-level fields
    model.headers_footers = headers_footers
    model.comments = comments
    model.footnotes = footnotes
    model.endnotes = endnotes
    model.core_properties = core_properties
    model.has_track_changes = has_track_changes
    model.sdt_controls = sdt_controls
    model.index_paragraph()
    model.build_reverse_refs()

    # 6b. Fill paragraph human-readable style names (style_map: styleId → StyleNode.name)
    for para in model.paragraphs:
        if para.style_id:
            style_node = model.styles.get(para.style_id)
            if style_node and style_node.name:
                para._style_name = style_node.name

    # 6. Write Wiki
    write_wiki(model, output_dir)

    return model
