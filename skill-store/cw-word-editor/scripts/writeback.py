"""
Writeback Pipeline — EditOps → docx writeback pipeline + wiki sync update

Flow:
1. Read original docx (zip)
2. Parse EditOps list
3. Locate XML nodes (via xpath or index recorded in wiki)
4. Execute modifications
5. Repackage as docx
6. Sync update wiki: log.md + modified paragraph pages
"""

from __future__ import annotations

import copy
import io
import os
import zipfile
import xml.etree.ElementTree as ET
from typing import Optional

from model import (
    NAMESPACES, ns, EditOp, EditAction, DocumentModel, ParagraphNode,
)


def register_namespaces():
    """Register namespaces"""
    for prefix, uri in NAMESPACES.items():
        ET.register_namespace(prefix, uri)


def _register_all_namespaces(xml_bytes: bytes) -> dict[str, str]:
    """Extract all xmlns declarations from original XML and register them to prevent namespace loss during serialization"""
    import re
    if isinstance(xml_bytes, bytes):
        xml_str = xml_bytes.decode("utf-8", errors="replace")
    else:
        xml_str = xml_bytes
    ns_map: dict[str, str] = {}
    for match in re.finditer(r'xmlns:(\w+)="([^"]+)"', xml_str[:5000]):
        prefix, uri = match.group(1), match.group(2)
        ns_map[prefix] = uri
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            # Python ET reserves certain prefix formats (e.g. 'ns0'-'ns9')
            # Skip registration but keep in ns_map for _inject_missing_namespaces
            pass
    return ns_map


def _inject_missing_namespaces(xml_output: bytes, ns_map: dict[str, str]) -> bytes:
    """Supplement missing xmlns declarations on the serialized XML root element"""
    import re
    xml_str = xml_output.decode("utf-8", errors="replace")

    # Find existing namespace declarations in output
    existing_ns = set(re.findall(r'xmlns:(\w+)="', xml_str[:2000]))

    # Declarations to add
    missing_ns = {k: v for k, v in ns_map.items() if k not in existing_ns}
    if not missing_ns:
        return xml_output

    # Inject missing xmlns declarations into root element start tag
    # Skip XML declaration (<?xml ... ?>) first
    search_start = 0
    if xml_str.startswith('<?xml'):
        decl_end = xml_str.find('?>')
        if decl_end >= 0:
            search_start = decl_end + 2

    # Find closing '>' of root element start tag
    # More reliable: find first non-whitespace char (i.e. '<') from search_start, then find matching '>'
    root_tag_start = -1
    for i in range(search_start, len(xml_str)):
        if xml_str[i] == '<':
            root_tag_start = i
            break
    if root_tag_start < 0:
        return xml_output

    # Find closing '>' from root tag start position (need to handle '>' in attribute values)
    # Simple approach: from root_tag_start, find '>' not inside quotes
    in_quote = False
    quote_char = None
    tag_end = -1
    for i in range(root_tag_start, min(root_tag_start + 5000, len(xml_str))):
        ch = xml_str[i]
        if in_quote:
            if ch == quote_char:
                in_quote = False
        else:
            if ch in ('"', "'"):
                in_quote = True
                quote_char = ch
            elif ch == '>':
                tag_end = i
                break

    if tag_end < 0:
        return xml_output

    # Check if self-closing tag (/>)
    if tag_end > 0 and xml_str[tag_end - 1] == '/':
        insert_pos = tag_end - 1
    else:
        insert_pos = tag_end

    ns_decls = ''.join(f' xmlns:{k}="{v}"' for k, v in sorted(missing_ns.items()))
    result = xml_str[:insert_pos] + ns_decls + xml_str[insert_pos:]
    return result.encode("utf-8")


# ── XML operation helpers ──────────────────────────────────────────

def _find_element_by_xpath(root: ET.Element, xpath: str) -> Optional[ET.Element]:
    parts = _parse_xpath(xpath)
    current = root
    for part in parts:
        tag, idx = part
        children = [c for c in current if c.tag == tag]
        if not children:
            return None
        if idx is not None and idx <= len(children):
            current = children[idx - 1]
        elif idx is None and children:
            current = children[0]
        else:
            return None
    return current


def _parse_xpath(xpath: str) -> list[tuple[str, Optional[int]]]:
    import re
    parts = []
    pattern = r"/(\{[^}]+\}\w+)(?:\[(\d+)\])?"
    for match in re.finditer(pattern, xpath):
        tag = match.group(1)
        idx = int(match.group(2)) if match.group(2) else None
        parts.append((tag, idx))
    return parts


def _find_paragraph_by_index(root: ET.Element, para_index: int) -> Optional[ET.Element]:
    body = root.find(ns("w:body"))
    if body is None:
        return None
    paras = body.findall(ns("w:p"))
    if 0 <= para_index < len(paras):
        return paras[para_index]
    return None


def _resolve_target_para(body: ET.Element, target_id: str,
                         id_to_elem: dict = None, id_to_index: dict = None,
                         target_text: str = "") -> Optional[ET.Element]:
    """FIX-017: Locate target paragraph by ID or text content"""
    # Priority 1: id_to_elem (stable object reference)
    if target_id and id_to_elem and target_id in id_to_elem:
        elem = id_to_elem[target_id]
        # Check element is still in body (not removed)
        try:
            list(body).index(elem)
            return elem
        except ValueError:
            pass  # elem removed from body, fall through

    # Priority 2: id_to_index
    if target_id and id_to_index:
        idx = id_to_index.get(target_id)
        if idx is not None:
            paras = body.findall(ns("w:p"))
            if 0 <= idx < len(paras):
                return paras[idx]

    # Priority 3: target_text search
    if target_text:
        matches = []
        for p in body.findall(ns("w:p")):
            full_text = "".join(t.text or "" for t in p.iter(ns("w:t")))
            if target_text in full_text:
                matches.append(p)

        if len(matches) == 1:
            return matches[0]
        elif len(matches) == 0:
            print(f"Warning: target_text '{target_text[:60]}' not found in any paragraph")
            return None
        else:
            print(f"Warning: target_text '{target_text[:60]}' matched {len(matches)} paragraphs, "
                  f"provide more context or use target_id")
            return None

    # Priority 4: old-style positional fallback
    if target_id:
        try:
            idx = int(target_id.replace("p-", ""))
            paras = body.findall(ns("w:p"))
            if 0 <= idx < len(paras):
                return paras[idx]
        except ValueError:
            pass

    return None


# ── Style name → styleId resolver ──────────────────────────

# Global style map: name → styleId, populated by _build_style_map()
_style_name_map: dict[str, str] = {}


def _build_style_map(files: dict):
    """FIX-013: Build style name → styleId mapping"""
    global _style_name_map
    _style_name_map = {}

    styles_xml = files.get("word/styles.xml")
    if not styles_xml:
        return

    w_ns = NAMESPACES["w"]
    try:
        styles_root = ET.fromstring(styles_xml)
    except ET.ParseError:
        return

    for style in styles_root.findall(f".//{{{w_ns}}}style"):
        style_id = style.get(f"{{{w_ns}}}styleId")
        name_el = style.find(f"{{{w_ns}}}name")
        if style_id and name_el is not None:
            name = name_el.get(f"{{{w_ns}}}val", "")
            if name:
                # Map case-insensitive name → styleId
                _style_name_map[name.lower()] = style_id
                # Also map styleId → itself (identity)
                _style_name_map[style_id.lower()] = style_id


def _resolve_style_id(style_name: str) -> str:
    """Resolve standard style name to actual styleId in template"""
    if not style_name:
        return style_name

    global _style_name_map
    if not _style_name_map:
        return style_name

    # Direct lookup
    key = style_name.lower()
    if key in _style_name_map:
        return _style_name_map[key]

    # Common aliases
    aliases = {
        "title": "title",
        "subtitle": "subtitle",
        "heading1": "heading 1",
        "heading2": "heading 2",
        "heading3": "heading 3",
        "heading4": "heading 4",
        "heading5": "heading 5",
        "heading6": "heading 6",
        "heading7": "heading 7",
        "heading8": "heading 8",
        "heading9": "heading 9",
        "normal": "normal",
        "quote": "quote",
        "header": "header",
        "footer": "footer",
        "caption": "caption",
        "toc heading": "toc heading",
    }
    alias = aliases.get(key)
    if alias and alias in _style_name_map:
        return _style_name_map[alias]

    # No mapping found — return original
    return style_name


def _make_paragraph_element(text: str, style: str = "Normal") -> ET.Element:
    """Create paragraph element. style parameter is automatically mapped via _resolve_style_id"""
    w_ns = NAMESPACES["w"]
    p = ET.Element(f"{{{w_ns}}}p")
    if style:
        resolved = _resolve_style_id(style)
        pPr = ET.SubElement(p, f"{{{w_ns}}}pPr")
        pStyle = ET.SubElement(pPr, f"{{{w_ns}}}pStyle")
        pStyle.set(f"{{{w_ns}}}val", resolved)
    if text:
        r = ET.SubElement(p, f"{{{w_ns}}}r")
        t = ET.SubElement(r, f"{{{w_ns}}}t")
        t.text = text
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return p


def _get_all_text(elem: ET.Element) -> str:
    texts = []
    for t in elem.iter(ns("w:t")):
        if t.text:
            texts.append(t.text)
    return "".join(texts)


# ── Edit operation implementations ──────────────────────────────────────────

def _do_replace_text(para_elem: ET.Element, old_text: str, new_text: str) -> bool:
    # Normalize whitespace: Word commonly uses \xa0 (non-breaking space), users typically input regular space
    # Normalize uniformly before matching to avoid mismatch due to whitespace differences
    def _norm(s: str) -> str:
        return s.replace("\xa0", " ")

    old_norm = _norm(old_text)

    # 1. Try matching within a single w:t
    for t_elem in para_elem.iter(ns("w:t")):
        if t_elem.text and old_norm in _norm(t_elem.text):
            t_elem.text = _norm(t_elem.text).replace(old_norm, new_text)
            return True

    # 2. Concatenate all text, try cross-run matching
    full_text = _get_all_text(para_elem)
    full_norm = _norm(full_text)
    if old_norm not in full_norm:
        return False

    new_full = full_norm.replace(old_norm, new_text, 1)

    # 3. Try precise replacement: preserve run structure of non-matching parts
    #    Find position of old_text in full_text (locate using normalized text)
    start = full_norm.index(old_norm)
    end = start + len(old_norm)

    # Collect all (t_elem, text) pairs, record character range for each run
    t_elems = []
    pos = 0
    for t_elem in para_elem.iter(ns("w:t")):
        txt = t_elem.text or ""
        t_elems.append((t_elem, pos, pos + len(txt), txt))
        pos += len(txt)

    # Find runs covering the old_text range
    # Split into three parts: before (unchanged), middle (replace), after (unchanged)
    # Strategy: set first affected run in replacement range to new text prefix, clear the rest
    first_affected = None
    last_affected = None
    for i, (t_elem, s, e, txt) in enumerate(t_elems):
        # run overlaps with [start, end)
        if s < end and e > start:
            if first_affected is None:
                first_affected = i
            last_affected = i

    if first_affected is not None and last_affected is not None:
        # Build text distribution after replacement
        # Before part: text before start in first_affected run
        # Middle part: new_text
        # After part: text after end in last_affected run

        fa_elem, fa_s, fa_e, fa_txt = t_elems[first_affected]
        la_elem, la_s, la_e, la_txt = t_elems[last_affected]

        prefix = full_text[:start]  # unchanged prefix (may span runs)
        suffix = full_text[end:]    # unchanged suffix

        # Simplified strategy: put new_full into first_affected, clear middle runs
        # But preserve run content before first_affected and after last_affected

        # Safest approach: put new_full only in first_affected run
        # Then clear all runs from first_affected+1 to last_affected

        # Calculate text length before start in first_affected run
        before_len = start - fa_s
        la_after_start = end - la_s  # offset of old_text end position in last_affected

        fill_text = new_text
        # first_affected run: keep before part + new_text
        fa_elem.text = fa_txt[:before_len] + fill_text + la_txt[la_after_start:]
        fa_elem.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

        # Clear middle runs (first_affected+1 to last_affected)
        for i in range(first_affected + 1, last_affected + 1):
            t_elems[i][0].text = ""

        return True

    # 4. Final fallback: merge all text into first run
    first_t = None
    for t_elem in para_elem.iter(ns("w:t")):
        if first_t is None:
            first_t = t_elem
            t_elem.text = new_full
            t_elem.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        else:
            t_elem.text = ""
    return first_t is not None


def _do_fill_blanks(para_elem: ET.Element, values: list[str]) -> bool:
    """
    Fill blank fill-area runs in template.

    Detection logic:
    1. Prefer runs with underline format (<w:u>) and all-whitespace text → typical "underline fill area"
    2. Then runs with rsidR (non-original template run) and all-whitespace text → typical "blank fill area"

    Grouping logic:
    Adjacent blank runs are merged into one "logical fill area", each values[i] fills one logical area.
    Value is written to the widest run in the group (longest text), other runs' text is cleared to "".
    This way user only needs to provide one value, without caring how many runs the template split the blank into.

    Example:
        Template XML has 3 adjacent blank runs: [" ", "      ", " "]
        → Merged into 1 logical fill area
        → fill_blanks("p-036", ["5"]) only needs 1 value
        → Result: ["", "5", ""]

        Template has 2 groups of blank areas separated by non-blank runs:
        "RMB[blank][blank][blank]yuan (uppercase: RMB[blank])"
        → Split into 2 logical fill areas
        → fill_blanks("p-051", ["360,000", "Three hundred sixty thousand yuan"])
    """
    # Step 1: iterate all runs, mark each run as blank fill area or not
    all_runs_info = []  # [(r_elem, t_elem, is_blank)]
    for r_elem in para_elem.findall(ns("w:r")):
        rpr = r_elem.find(ns("w:rPr"))
        has_underline = False
        if rpr is not None:
            u = rpr.find(ns("w:u"))
            has_underline = u is not None

        t_elem = r_elem.find(ns("w:t"))
        tab_elems = r_elem.findall(ns("w:tab"))
        # tab run (<w:tab/>) also counts as blank fill area
        if t_elem is None:
            if tab_elems:
                # tab run: treat as blank, use a virtual t_elem to hold content
                # Need to create <w:t> to replace all <w:tab/> (a run may have multiple tabs)
                all_runs_info.append((r_elem, None, True, tab_elems))
            else:
                all_runs_info.append((r_elem, None, False, None))
            continue

        text = t_elem.text or ""
        is_whitespace = text.strip() == "" and len(text) > 0
        # Underscore fill area: contains consecutive ≥3 underscore characters
        import re as _re
        is_underscore_fill = bool(_re.search(r'_{3,}|＿{3,}|﹍{3,}', text))

        if not is_whitespace and not is_underscore_fill:
            all_runs_info.append((r_elem, t_elem, False, None))
            continue

        # Determine: has underline format or has rsidR (non-default) or all underscore characters
        rsid_r = r_elem.get(f"{{{NAMESPACES['w']}}}rsidR", "")
        rsid_default = para_elem.get(f"{{{NAMESPACES['w']}}}rsidRDefault", "")
        has_modified_rsid = rsid_r and rsid_r != rsid_default

        if has_underline or has_modified_rsid or is_underscore_fill:
            all_runs_info.append((r_elem, t_elem, True, None))
        else:
            all_runs_info.append((r_elem, t_elem, False, None))

    # Step 2: group adjacent blank runs
    groups = []  # Each group: [(r_elem, t_elem_or_none, tab_elem_or_none)]
    current_group = []
    for r_elem, t_elem, is_blank, tab_elem in all_runs_info:
        if is_blank:
            current_group.append((r_elem, t_elem, tab_elem))
        else:
            if current_group:
                groups.append(current_group)
                current_group = []
    if current_group:
        groups.append(current_group)

    if not groups:
        return False

    # Step 3: fill one value per group
    filled = 0
    for i, value in enumerate(values):
        if i >= len(groups):
            break
        group = groups[i]

        # Find widest run in group (best suited to carry actual content)
        # Prefer run with w:t, then tab run (tab run needs conversion to w:t)
        widest_idx = 0
        widest_len = 0
        has_text_run = False
        for j, (r_elem, t_elem, tab_elem) in enumerate(group):
            if t_elem is not None:
                text_len = len(t_elem.text or "")
                if text_len > widest_len:
                    widest_len = text_len
                    widest_idx = j
                    has_text_run = True
            elif tab_elem is not None:
                # tab run treated as 1 character wide
                if not has_text_run and widest_len == 0:
                    widest_idx = j

        # Determine if spaces need to be added before/after the value
        # Check last character of the run before the blank area
        group_start_idx = None
        for k, (r_e, t_e, is_b, tab_e) in enumerate(all_runs_info):
            if r_e is group[0][0]:
                group_start_idx = k
                break
        need_prefix_space = True
        need_suffix_space = True
        if group_start_idx is not None:
            # Previous run
            if group_start_idx > 0:
                prev_r, prev_t, _, _ = all_runs_info[group_start_idx - 1]
                if prev_t is not None and prev_t.text and prev_t.text.endswith(" "):
                    need_prefix_space = False
            # Next run
            group_end_idx = group_start_idx + len(group) - 1
            if group_end_idx + 1 < len(all_runs_info):
                next_r, next_t, _, _ = all_runs_info[group_end_idx + 1]
                if next_t is not None and next_t.text and next_t.text.startswith(" "):
                    need_suffix_space = False

        # Build final fill value (add spaces before/after)
        fill_value = value
        if need_prefix_space and not fill_value.startswith(" "):
            fill_value = " " + fill_value
        if need_suffix_space and not fill_value.endswith(" "):
            fill_value = fill_value + " "

        # Fill value into widest run, clear other runs
        for j, (r_elem, t_elem, tab_elem) in enumerate(group):
            if j == widest_idx:
                if t_elem is not None:
                    # Preserve label text in run (non-underscore part before underscores)
                    old_text = t_elem.text or ""
                    import re as _re2
                    label_match = _re2.match(r'^(.*?)(_{3,}|＿{3,}|﹍{3,})', old_text)
                    if label_match:
                        t_elem.text = label_match.group(1) + fill_value
                    else:
                        t_elem.text = fill_value
                    t_elem.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                elif tab_elem is not None:
                    # tab run: replace all <w:tab/> with <w:t>value</w:t>
                    for tb in tab_elem:
                        r_elem.remove(tb)
                    new_t = ET.SubElement(r_elem, f"{{{NAMESPACES['w']}}}t")
                    new_t.text = fill_value
                    new_t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            else:
                if t_elem is not None:
                    t_elem.text = ""
                    t_elem.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                elif tab_elem is not None:
                    # Remove all tab elements
                    for tb in tab_elem:
                        r_elem.remove(tb)

        filled += 1

    return filled > 0


def _do_edit_table_cell(
    root: ET.Element, body: ET.Element,
    table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None
) -> bool:
    """
    Edit table cell content.

    Locate table by table_id (tbl-000 → 1st w:tbl under body),
    then locate cell by row/col.
    """
    row = params.get("row", 0)
    col = params.get("col", 0)
    text = params.get("text", "")
    # Auto type conversion: LLM may pass strings
    try:
        row = int(row)
        col = int(col)
    except (ValueError, TypeError):
        return False

    # Find table — FIX-018: prefer resolved_tbl → tbl_to_elem over positional lookup
    if resolved_tbl is not None:
        tbl = resolved_tbl
    else:
        tbl = _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False

    # Locate row
    rows = tbl.findall(ns("w:tr"))
    if row >= len(rows):
        return False
    tr = rows[row]

    # Locate column
    cells = tr.findall(ns("w:tc"))
    if col >= len(cells):
        return False
    tc = cells[col]

    # Find first w:t element, modify text
    t_elems = list(tc.iter(ns("w:t")))
    if t_elems:
        t_elems[0].text = text
        t_elems[0].set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        # Clear remaining w:t (if any)
        for t in t_elems[1:]:
            t.text = ""
    else:
        # Cell is empty, need to create paragraph and run
        w_ns = NAMESPACES["w"]
        p = tc.find(ns("w:p"))
        if p is None:
            p = ET.SubElement(tc, f"{{{w_ns}}}p")
        r = ET.SubElement(p, f"{{{w_ns}}}r")
        t = ET.SubElement(r, f"{{{w_ns}}}t")
        t.text = text
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    return True


def _do_insert_paragraph(body: ET.Element, position: str, text: str, style: str,
                         id_to_index: dict = None, id_to_elem: dict = None) -> bool:
    """FIX-002: Locate using id_to_elem, empty position inserts before sectPr"""
    new_p = _make_paragraph_element(text, style)
    if not position:
        _append_before_sectPr(body, new_p)
        return True
    parts = position.split(":", 1)
    if len(parts) != 2:
        _append_before_sectPr(body, new_p)
        return True
    direction = parts[0]
    target_id = parts[1]

    # FIX-002: prefer element reference
    if id_to_elem and target_id in id_to_elem:
        target_elem = id_to_elem[target_id]
        try:
            target_index = list(body).index(target_elem)
            if direction == "before":
                body.insert(target_index, new_p)
            elif direction == "after":
                body.insert(target_index + 1, new_p)
            else:
                return False
            return True
        except ValueError:
            pass

    # Fallback to index — prefer id_to_index dict over parsing ID string
    if id_to_index:
        idx = id_to_index.get(target_id)
        if idx is None:
            try:
                idx = int(target_id.replace("p-", ""))
            except ValueError:
                return False
        paras = body.findall(ns("w:p"))
        if idx is not None and 0 <= idx < len(paras):
            target_elem = paras[idx]
            if direction == "before":
                target_index = list(body).index(target_elem)
                body.insert(target_index, new_p)
            elif direction == "after":
                target_index = list(body).index(target_elem)
                body.insert(target_index + 1, new_p)
            else:
                return False
            return True

    _append_before_sectPr(body, new_p)
    return True


def _do_delete_paragraph(body: ET.Element, para_index: int) -> bool:
    """Delete paragraph with cascade cleanup (bookmarks, comment markers, footnote/endnote references)"""
    w = NAMESPACES["w"]
    paras = body.findall(ns("w:p"))
    if not (0 <= para_index < len(paras)):
        return False

    para = paras[para_index]

    # ── Cascade cleanup: remove associated elements within paragraph ──

    # 1. Collect bookmarkStart/End within paragraph (record name and id)
    removed_bm_ids = set()
    for bm_start in para.findall(ns("w:bookmarkStart")):
        bm_id = bm_start.get(f"{{{w}}}id", "")
        bm_name = bm_start.get(f"{{{w}}}name", "")
        if bm_id:
            removed_bm_ids.add(bm_id)
        # If bookmark spans multiple paragraphs (start here, end in other paragraph),
        # need to remove corresponding bookmarkEnd in other paragraphs
        if bm_name and bm_name.startswith("_") and bm_name != "_GoBack":
            pass  # Internal bookmark (e.g. TOC jump), only remove from this paragraph
    # Remove corresponding bookmarkEnd from other paragraphs in body
    for bm_id in removed_bm_ids:
        for bm_end in list(body.iter(ns("w:bookmarkEnd"))):
            if bm_end.get(f"{{{w}}}id") == bm_id:
                parent = _find_parent(body, bm_end)
                if parent is not None and parent is not para:
                    parent.remove(bm_end)

    # 2. Collect commentRangeStart id within paragraph (cascade remove corresponding markers)
    removed_cmt_ids = set()
    for crs in para.findall(ns("w:commentRangeStart")):
        cmt_id = crs.get(f"{{{w}}}id", "")
        if cmt_id:
            removed_cmt_ids.add(cmt_id)
    # Remove corresponding commentRangeEnd and commentReference from body
    for cmt_id in removed_cmt_ids:
        for tag_name in ("commentRangeEnd", "commentReference"):
            for elem in list(body.iter(ns(f"w:{tag_name}"))):
                if elem.get(f"{{{w}}}id") == cmt_id:
                    parent = _find_parent(body, elem)
                    if parent is not None and parent is not para:
                        # If commentReference is in w:r, remove entire run
                        if tag_name == "commentReference":
                            r_parent = _find_parent(body, elem)
                            if r_parent is not None and r_parent.tag == ns("w:r"):
                                p_parent = _find_parent(body, r_parent)
                                if p_parent is not None and p_parent is not para:
                                    p_parent.remove(r_parent)
                                    continue
                        parent.remove(elem)

    # Note: do not delete comment content in comments.xml itself (comments may be referenced by other paragraphs)
    # Also do not delete footnote content in footnotes.xml (preserve in case of other references)

    # ── Delete paragraph ──
    body.remove(para)
    return True


def _do_change_style(para_elem: ET.Element, new_style: str) -> bool:
    """Modify paragraph style, automatically mapped via _resolve_style_id"""
    resolved = _resolve_style_id(new_style)
    pPr = para_elem.find(ns("w:pPr"))
    w_ns = NAMESPACES["w"]
    if pPr is None:
        pPr = ET.SubElement(para_elem, f"{{{w_ns}}}pPr")
        runs = para_elem.findall(ns("w:r"))
        para_elem.remove(pPr)
        para_elem.insert(0, pPr)
    pStyle = pPr.find(ns("w:pStyle"))
    if pStyle is None:
        pStyle = ET.SubElement(pPr, f"{{{w_ns}}}pStyle")
    pStyle.set(f"{{{w_ns}}}val", resolved)
    return True


def _do_edit_chart(root: ET.Element, edit: EditOp) -> bool:
    """Edit chart data. Charts in OOXML are linked to the document via relationships"""
    params = edit.params
    body = root.find(ns("w:body"))
    if body is None:
        return False
    target_id = edit.target_id
    # Find drawing/graphic in paragraph containing chart reference
    for drawing in body.iter(ns("w:drawing")):
        a_ns = NAMESPACES.get("a", "http://schemas.openxmlformats.org/drawingml/2006/main")
        for graphic in drawing.iter(f"{{{a_ns}}}graphic"):
            graphicData = graphic.find(f"{{{a_ns}}}graphicData")
            if graphicData is not None:
                for child in graphicData:
                    tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                    if tag == 'chart':
                        # Actual chart data is in chart XML, document.xml only has reference
                        # Can update reference attributes here
                        return True
    return False


def _do_edit_equation(root: ET.Element, edit: EditOp) -> bool:
    """Edit equation (OMML). Replace m:oMath content"""
    params = edit.params
    body = root.find(ns("w:body"))
    if body is None:
        return False
    target_id = edit.target_id
    eq_text = params.get("equation_text", "")
    m_ns = NAMESPACES.get("m", "http://schemas.openxmlformats.org/officeDocument/2006/math")
    for omath in body.iter(f"{{{m_ns}}}oMath"):
        if eq_text:
            # Clear existing content
            for child in list(omath):
                omath.remove(child)
            # Create simple r+t structure
            mr = ET.SubElement(omath, f"{{{m_ns}}}r")
            mt = ET.SubElement(mr, f"{{{m_ns}}}t")
            mt.text = eq_text
            return True
    return False


def _do_edit_smartart(root: ET.Element, edit: EditOp) -> bool:
    """Edit SmartArt. Locate SmartArt graphic reference in document.xml"""
    params = edit.params
    body = root.find(ns("w:body"))
    if body is None:
        return False

    a_ns = NAMESPACES.get("a", "http://schemas.openxmlformats.org/openxmlformats.org/drawingml/2006/main")

    # Find SmartArt graphic references in document body
    for drawing in body.iter(ns("w:drawing")):
        for graphic in drawing.iter(f"{{{a_ns}}}graphic"):
            graphicData = graphic.find(f"{{{a_ns}}}graphicData")
            if graphicData is not None:
                for child in graphicData:
                    tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                    if tag == 'relIds':
                        # Found a SmartArt reference (dgm:relIds)
                        return True

    return False


def _do_edit_textbox(root: ET.Element, edit: EditOp) -> bool:
    """Edit textbox. Modify text in w:txbxContent"""
    params = edit.params
    body = root.find(ns("w:body"))
    if body is None:
        return False
    target_id = edit.target_id
    new_text = params.get("text", "")
    for txbx_content in body.iter(ns("w:txbxContent")):
        if new_text:
            # Clear existing paragraphs
            for p in list(txbx_content.findall(ns("w:p"))):
                txbx_content.remove(p)
            # Insert new text
            new_p = ET.SubElement(txbx_content, f"{{{NAMESPACES['w']}}}p")
            new_r = ET.SubElement(new_p, f"{{{NAMESPACES['w']}}}r")
            new_t = ET.SubElement(new_r, f"{{{NAMESPACES['w']}}}t")
            new_t.text = new_text
            new_t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            return True
    return False


def _do_edit_shape(root: ET.Element, edit: EditOp) -> bool:
    """Edit shape. Modify alt_text, dimensions, fill color, border color"""
    params = edit.params
    body = root.find(ns("w:body"))
    if body is None:
        return False
    target_id = edit.target_id
    alt_text = params.get("alt_text", "")
    width = params.get("width")
    height = params.get("height")
    wp_ns = NAMESPACES.get("wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing")

    # Locate the Nth drawing by target_id (e.g. "img-000" or "shape-000")
    drawing = _find_drawing_by_id(body, target_id)
    if drawing is None:
        return False

    modified = False
    for anchor_or_inline in list(drawing):
        tag = anchor_or_inline.tag.split('}')[-1] if '}' in anchor_or_inline.tag else anchor_or_inline.tag
        if tag in ('anchor', 'inline'):
            # Dimensions
            extent = anchor_or_inline.find(f"{{{wp_ns}}}extent")
            if extent is not None:
                if width:
                    extent.set("cx", str(width))
                    modified = True
                if height:
                    extent.set("cy", str(height))
                    modified = True
            # Alt text
            docPr = anchor_or_inline.find(f"{{{wp_ns}}}docPr")
            if docPr is not None and alt_text:
                docPr.set("descr", alt_text)
                modified = True
    return modified


def _do_clone_element(root: ET.Element, edit: EditOp) -> bool:
    """Clone element (paragraph/table). Deep copy and reassign IDs"""
    import copy
    import uuid
    params = edit.params
    body = root.find(ns("w:body"))
    if body is None:
        return False
    source_id = edit.target_id
    position = edit.position
    clone_count = params.get("count", 1)

    # Locate source element by parsing target_id as index (e.g. "p-003" → index 3)
    source_elem = None
    source_idx = -1
    try:
        idx = int(source_id.replace("p-", "").replace("tbl-", ""))
    except ValueError:
        return False

    if source_id.startswith("p-"):
        paras = body.findall(ns("w:p"))
        if 0 <= idx < len(paras):
            source_elem = paras[idx]
            source_idx = list(body).index(source_elem)
    elif source_id.startswith("tbl-"):
        tbls = body.findall(ns("w:tbl"))
        if 0 <= idx < len(tbls):
            source_elem = tbls[idx]
            source_idx = list(body).index(source_elem)

    if source_elem is None:
        return False

    # Parse position
    import re
    m = re.match(r'(before|after):(.+)', position) if position else None
    if m:
        direction = m.group(1)
        ref_id = m.group(2)
        try:
            ref_idx = int(ref_id.replace("p-", "").replace("tbl-", ""))
        except ValueError:
            ref_idx = -1
        if ref_idx < 0:
            insert_idx = source_idx + 1
        else:
            if ref_id.startswith("p-"):
                paras = body.findall(ns("w:p"))
                ref_body_idx = list(body).index(paras[ref_idx]) if 0 <= ref_idx < len(paras) else -1
            else:
                tbls = body.findall(ns("w:tbl"))
                ref_body_idx = list(body).index(tbls[ref_idx]) if 0 <= ref_idx < len(tbls) else -1
            insert_idx = ref_body_idx + 1 if direction == "after" and ref_body_idx >= 0 else ref_body_idx if ref_body_idx >= 0 else source_idx + 1
    else:
        insert_idx = source_idx + 1
    for c in range(clone_count):
        clone = copy.deepcopy(source_elem)
        body.insert(insert_idx + c, clone)
    return True


# ── Helper: locate table by table_id ─────────────────────────

def _find_table_by_id(body: ET.Element, table_id: str, tbl_to_elem: dict = None) -> Optional[ET.Element]:
    """Locate w:tbl element by table_id (tbl-000)"""
    # FIX-016: prefer tbl_to_elem (stable object reference)
    if tbl_to_elem and table_id in tbl_to_elem:
        elem = tbl_to_elem[table_id]
        # Verify element is still in body
        if elem in body or elem.getparent() is not None:
            return elem
    try:
        tbl_idx = int(table_id.replace("tbl-", ""))
    except ValueError:
        return None
    tbls = body.findall(ns("w:tbl"))
    if 0 <= tbl_idx < len(tbls):
        return tbls[tbl_idx]
    return None


def _resolve_target_table(body: ET.Element, table_id: str, params: dict = None,
                          tbl_to_elem: dict = None) -> Optional[ET.Element]:
    """FIX-018: Locate target table by ID or cell text content"""
    # Priority 1 & 2: delegate to _find_table_by_id
    if table_id:
        tbl = _find_table_by_id(body, table_id, tbl_to_elem)
        if tbl is not None:
            return tbl

    # Priority 3: target_text search
    target_text = (params or {}).get("target_text", "")
    if target_text:
        matches = []
        for tbl in body.findall(ns("w:tbl")):
            # Concatenate all cell texts in this table
            full_text = ""
            for t in tbl.iter(ns("w:t")):
                if t.text:
                    full_text += t.text
            if target_text in full_text:
                matches.append(tbl)

        if len(matches) == 1:
            return matches[0]
        elif len(matches) == 0:
            print(f"Warning: target_text '{target_text[:60]}' not found in any table")
            return None
        else:
            print(f"Warning: target_text '{target_text[:60]}' matched {len(matches)} tables, "
                  f"provide more context or use target_id")
            return None

    return None


def _ensure_or_get_child(parent: ET.Element, tag: str) -> ET.Element:
    """Ensure parent element has specified child element, create if missing and return"""
    child = parent.find(tag)
    if child is None:
        child = ET.SubElement(parent, tag)
    return child


def _set_or_remove_attr(elem: ET.Element, attr: str, value):
    """Set attribute (set when non-empty, delete when empty)"""
    if value:
        elem.set(attr, str(value))
    elif attr in elem.attrib:
        del elem.attrib[attr]


def _append_before_sectPr(body: ET.Element, elem: ET.Element):
    """Insert element before sectPr in body (OOXML spec requires sectPr to be the last child of body)"""
    w_ns = NAMESPACES["w"]
    sectPr = body.find(ns("w:sectPr"))
    if sectPr is not None:
        idx = list(body).index(sectPr)
        body.insert(idx, elem)
    else:
        body.append(elem)


def _insert_at_position(body: ET.Element, elem: ET.Element, position: str,
                        id_to_index: dict, id_to_elem: dict = None):
    """Insert element in body by position"""
    if not position:
        _append_before_sectPr(body, elem)
        return True
    parts = position.split(":", 1)
    if len(parts) != 2:
        _append_before_sectPr(body, elem)
        return True
    direction, ref_id = parts

    # FIX-001: prefer element reference for positioning
    if id_to_elem and ref_id in id_to_elem:
        target_elem = id_to_elem[ref_id]
        try:
            target_pos = list(body).index(target_elem)
            if direction == "before":
                body.insert(target_pos, elem)
            else:
                body.insert(target_pos + 1, elem)
            return True
        except ValueError:
            pass  # elem removed from body, fall through

    # Fallback to index
    ref_idx = id_to_index.get(ref_id)
    if ref_idx is not None:
        paras = body.findall(ns("w:p"))
        if 0 <= ref_idx < len(paras):
            target_elem = paras[ref_idx]
            target_pos = list(body).index(target_elem)
            if direction == "before":
                body.insert(target_pos, elem)
            else:
                body.insert(target_pos + 1, elem)
            return True

    _append_before_sectPr(body, elem)
    return True


# ── Phase 1.1: Paragraph Formatting ──────────────────────

def _do_set_paragraph_format(para_elem: ET.Element, params: dict) -> bool:
    """Set paragraph format properties (alignment, indentation, spacing, pagination control, etc.)"""
    w = NAMESPACES["w"]
    pPr = para_elem.find(ns("w:pPr"))
    if pPr is None:
        pPr = ET.SubElement(para_elem, f"{{{w}}}pPr")
        para_elem.remove(pPr)
        para_elem.insert(0, pPr)

    # Alignment
    if "alignment" in params:
        jc = pPr.find(ns("w:jc"))
        val = params["alignment"]
        if val:
            if jc is None:
                jc = ET.SubElement(pPr, f"{{{w}}}jc")
            jc.set(f"{{{w}}}val", val)
        elif jc is not None:
            pPr.remove(jc)

    # Indentation
    indent_keys = {
        "left": "left", "right": "right",
        "first_line": "firstLine", "hanging": "hanging",
        "start": "start", "end": "end",
    }
    indent_params = {k: v for k, v in params.items() if k in indent_keys}
    if indent_params:
        ind = pPr.find(ns("w:ind"))
        if ind is None:
            ind = ET.SubElement(pPr, f"{{{w}}}ind")
        for k, v in indent_params.items():
            ind.set(f"{{{w}}}{indent_keys[k]}", str(v))

    # Spacing
    spacing_keys = {
        "before": "before", "after": "after",
        "line": "line", "line_rule": "lineRule",
        "before_lines": "beforeLines", "after_lines": "afterLines",
    }
    spacing_params = {k: v for k, v in params.items() if k in spacing_keys}
    if spacing_params:
        sp = pPr.find(ns("w:spacing"))
        if sp is None:
            sp = ET.SubElement(pPr, f"{{{w}}}spacing")
        for k, v in spacing_params.items():
            sp.set(f"{{{w}}}{spacing_keys[k]}", str(v))

    # Page break before
    if "page_break_before" in params:
        tag = ns("w:pageBreakBefore")
        if params["page_break_before"]:
            _ensure_or_get_child(pPr, tag)
        else:
            el = pPr.find(tag)
            if el is not None:
                pPr.remove(el)

    # Keep with next
    if "keep_with_next" in params:
        tag = ns("w:keepNext")
        if params["keep_with_next"]:
            _ensure_or_get_child(pPr, tag)
        else:
            el = pPr.find(tag)
            if el is not None:
                pPr.remove(el)

    # Keep lines together
    if "keep_lines" in params:
        tag = ns("w:keepLines")
        if params["keep_lines"]:
            _ensure_or_get_child(pPr, tag)
        else:
            el = pPr.find(tag)
            if el is not None:
                pPr.remove(el)

    # Widow control
    if "widow_control" in params:
        tag = ns("w:widowControl")
        el = pPr.find(tag)
        if params["widow_control"]:
            if el is None:
                el = ET.SubElement(pPr, tag)
            el.set(f"{{{w}}}val", "1")
        else:
            if el is None:
                el = ET.SubElement(pPr, tag)
            el.set(f"{{{w}}}val", "0")

    # Shading
    if "shading" in params:
        shd_data = params["shading"]
        shd = pPr.find(ns("w:shd"))
        if shd is None:
            shd = ET.SubElement(pPr, f"{{{w}}}shd")
        for k, v in shd_data.items():
            shd.set(f"{{{w}}}{k}", str(v))

    # Contextual spacing
    if "contextual_spacing" in params:
        tag = ns("w:contextualSpacing")
        if params["contextual_spacing"]:
            _ensure_or_get_child(pPr, tag)
        else:
            el = pPr.find(tag)
            if el is not None:
                pPr.remove(el)

    # Word wrap
    if "word_wrap" in params:
        tag = ns("w:wordWrap")
        el = pPr.find(tag)
        if el is None:
            el = ET.SubElement(pPr, tag)
        el.set(f"{{{w}}}val", "1" if params["word_wrap"] else "0")

    # Text direction (paragraph-level)
    if "text_direction" in params:
        td = pPr.find(ns("w:textDirection"))
        if td is None:
            td = ET.SubElement(pPr, f"{{{w}}}textDirection")
        td.set(f"{{{w}}}val", params["text_direction"])

    return True


def _do_set_paragraph_shading(para_elem: ET.Element, params: dict) -> bool:
    """Set paragraph shading/background color"""
    w = NAMESPACES["w"]
    pPr = para_elem.find(ns("w:pPr"))
    if pPr is None:
        pPr = ET.SubElement(para_elem, f"{{{w}}}pPr")
        para_elem.remove(pPr)
        para_elem.insert(0, pPr)

    shd = pPr.find(ns("w:shd"))
    if shd is None:
        shd = ET.SubElement(pPr, f"{{{w}}}shd")

    fill = params.get("fill", "D9E2F3")
    val = params.get("val", "clear")
    color = params.get("color", "auto")

    shd.set(f"{{{w}}}fill", fill)
    shd.set(f"{{{w}}}val", val)
    shd.set(f"{{{w}}}color", color)

    return True


def _do_set_paragraph_border(para_elem: ET.Element, params: dict) -> bool:
    """Set paragraph borders"""
    w = NAMESPACES["w"]
    borders = params.get("borders", {})
    if not borders:
        return True  # no-op

    pPr = para_elem.find(ns("w:pPr"))
    if pPr is None:
        pPr = ET.SubElement(para_elem, f"{{{w}}}pPr")
        para_elem.remove(pPr)
        para_elem.insert(0, pPr)

    pBdr = pPr.find(ns("w:pBdr"))
    if pBdr is None:
        pBdr = ET.SubElement(pPr, f"{{{w}}}pBdr")

    for side, border_data in borders.items():
        if not isinstance(border_data, dict):
            continue
        border_elem = pBdr.find(ns(f"w:{side}"))
        if border_elem is None:
            border_elem = ET.SubElement(pBdr, f"{{{w}}}{side}")
        for attr in ("val", "sz", "space", "color"):
            if attr in border_data:
                border_elem.set(f"{{{w}}}{attr}", str(border_data[attr]))

    return True


def _do_set_tab_stops(para_elem: ET.Element, params: dict) -> bool:
    """Set paragraph tab stops"""
    w = NAMESPACES["w"]
    tabs = params.get("tabs", [])
    clear_existing = params.get("clear_existing", True)

    if not tabs and not clear_existing:
        return True  # no-op

    pPr = para_elem.find(ns("w:pPr"))
    if pPr is None:
        pPr = ET.SubElement(para_elem, f"{{{w}}}pPr")
        para_elem.remove(pPr)
        para_elem.insert(0, pPr)

    tabs_elem = pPr.find(ns("w:tabs"))

    if clear_existing:
        # Remove existing tabs
        if tabs_elem is not None:
            pPr.remove(tabs_elem)
            tabs_elem = None

    if not tabs:
        return True  # clear only

    if tabs_elem is None:
        tabs_elem = ET.SubElement(pPr, f"{{{w}}}tabs")

    for tab_def in tabs:
        if not isinstance(tab_def, dict):
            continue
        val = tab_def.get("val", "left")
        pos = tab_def.get("pos", "0")
        tab_elem = ET.SubElement(tabs_elem, f"{{{w}}}tab")
        tab_elem.set(f"{{{w}}}val", str(val))
        tab_elem.set(f"{{{w}}}pos", str(pos))
        # Optional leader
        leader = tab_def.get("leader")
        if leader:
            tab_elem.set(f"{{{w}}}leader", str(leader))

    return True


# ── Phase 1.2: Run Formatting ────────────────────────────

def _do_set_run_format(para_elem: ET.Element, params: dict) -> bool:
    """Set run format properties"""
    w = NAMESPACES["w"]
    run_index = params.get("_run_index")
    runs = para_elem.findall(ns("w:r"))
    if not runs:
        return False

    if run_index is not None:
        if 0 <= run_index < len(runs):
            target_runs = [runs[run_index]]
        else:
            return False
    else:
        target_runs = runs

    for r_elem in target_runs:
        rPr = r_elem.find(ns("w:rPr"))
        if rPr is None:
            rPr = ET.SubElement(r_elem, f"{{{w}}}rPr")
            r_elem.remove(rPr)
            r_elem.insert(0, rPr)

        _apply_run_format_props(rPr, params, w)

    return True


def _apply_run_format_props(rPr: ET.Element, params: dict, w: str):
    """Apply format props to rPr element"""
    # Bold
    if "bold" in params:
        tag = ns("w:b")
        if params["bold"]:
            _ensure_or_get_child(rPr, tag)
        else:
            el = rPr.find(tag)
            if el is not None:
                rPr.remove(el)

    # Italic
    if "italic" in params:
        tag = ns("w:i")
        if params["italic"]:
            _ensure_or_get_child(rPr, tag)
        else:
            el = rPr.find(tag)
            if el is not None:
                rPr.remove(el)

    # Font
    if "font_name" in params or "font_ascii" in params:
        rFonts = rPr.find(ns("w:rFonts"))
        if rFonts is None:
            rFonts = ET.SubElement(rPr, f"{{{w}}}rFonts")
        if "font_name" in params:
            rFonts.set(f"{{{w}}}ascii", params["font_name"])
            rFonts.set(f"{{{w}}}hAnsi", params["font_name"])
            rFonts.set(f"{{{w}}}cs", params["font_name"])
        if "font_ascii" in params:
            rFonts.set(f"{{{w}}}ascii", params["font_ascii"])
        if "font_eastasia" in params:
            rFonts.set(f"{{{w}}}eastAsia", params["font_eastasia"])

    # Size
    if "font_size" in params:
        sz = rPr.find(ns("w:sz"))
        if sz is None:
            sz = ET.SubElement(rPr, f"{{{w}}}sz")
        sz.set(f"{{{w}}}val", str(params["font_size"]))
        szCs = rPr.find(ns("w:szCs"))
        if szCs is None:
            szCs = ET.SubElement(rPr, f"{{{w}}}szCs")
        szCs.set(f"{{{w}}}val", str(params["font_size"]))

    # Color
    if "color" in params:
        c = rPr.find(ns("w:color"))
        if c is None:
            c = ET.SubElement(rPr, f"{{{w}}}color")
        c.set(f"{{{w}}}val", params["color"])

    # Underline
    if "underline" in params:
        u = rPr.find(ns("w:u"))
        if u is None:
            u = ET.SubElement(rPr, f"{{{w}}}u")
        val = params["underline"]
        if isinstance(val, bool):
            u.set(f"{{{w}}}val", "single" if val else "none")
        else:
            u.set(f"{{{w}}}val", str(val))

    # Strike
    if "strike" in params:
        tag = ns("w:strike")
        if params["strike"]:
            _ensure_or_get_child(rPr, tag)
        else:
            el = rPr.find(tag)
            if el is not None:
                rPr.remove(el)

    # Double strike
    if "dstrike" in params:
        tag = ns("w:dstrike")
        if params["dstrike"]:
            _ensure_or_get_child(rPr, tag)
        else:
            el = rPr.find(tag)
            if el is not None:
                rPr.remove(el)

    # Highlight
    if "highlight" in params:
        hl = rPr.find(ns("w:highlight"))
        if hl is None:
            hl = ET.SubElement(rPr, f"{{{w}}}highlight")
        hl.set(f"{{{w}}}val", params["highlight"])

    # Vertical alignment
    if "vert_align" in params:
        va = rPr.find(ns("w:vertAlign"))
        if va is None:
            va = ET.SubElement(rPr, f"{{{w}}}vertAlign")
        va.set(f"{{{w}}}val", params["vert_align"])

    # Caps
    if "caps" in params:
        tag = ns("w:caps")
        if params["caps"]:
            _ensure_or_get_child(rPr, tag)
        else:
            el = rPr.find(tag)
            if el is not None:
                rPr.remove(el)

    # Small caps
    if "small_caps" in params:
        tag = ns("w:smallCaps")
        if params["small_caps"]:
            _ensure_or_get_child(rPr, tag)
        else:
            el = rPr.find(tag)
            if el is not None:
                rPr.remove(el)

    # Vanish (hidden)
    if "vanish" in params:
        tag = ns("w:vanish")
        if params["vanish"]:
            _ensure_or_get_child(rPr, tag)
        else:
            el = rPr.find(tag)
            if el is not None:
                rPr.remove(el)

    # No proof
    if "no_proof" in params:
        tag = ns("w:noProof")
        if params["no_proof"]:
            _ensure_or_get_child(rPr, tag)
        else:
            el = rPr.find(tag)
            if el is not None:
                rPr.remove(el)

    # Character spacing
    if "char_spacing" in params:
        sp = rPr.find(ns("w:spacing"))
        if sp is None:
            sp = ET.SubElement(rPr, f"{{{w}}}spacing")
        sp.set(f"{{{w}}}val", str(params["char_spacing"]))

    # Shading
    if "shading" in params:
        shd_data = params["shading"]
        shd = rPr.find(ns("w:shd"))
        if shd is None:
            shd = ET.SubElement(rPr, f"{{{w}}}shd")
        for k, v in shd_data.items():
            shd.set(f"{{{w}}}{k}", str(v))

    # Language
    if "lang" in params:
        lang = rPr.find(ns("w:lang"))
        if lang is None:
            lang = ET.SubElement(rPr, f"{{{w}}}lang")
        for k, v in params["lang"].items():
            lang.set(f"{{{w}}}{k}", str(v))

    # Complex script
    if "complex_script" in params:
        tag = ns("w:cs")
        if params["complex_script"]:
            _ensure_or_get_child(rPr, tag)
        else:
            el = rPr.find(tag)
            if el is not None:
                rPr.remove(el)

    # Character scaling (w:w) — percentage, e.g. 150 = 150% width
    if "char_scale" in params:
        cw = rPr.find(ns("w:w"))
        if cw is None:
            cw = ET.SubElement(rPr, f"{{{w}}}w")
        cw.set(f"{{{w}}}val", str(params["char_scale"]))

    # Kerning (w:kern) — half-points, e.g. 24 = 12pt minimum
    if "kern" in params:
        k = rPr.find(ns("w:kern"))
        if k is None:
            k = ET.SubElement(rPr, f"{{{w}}}kern")
        k.set(f"{{{w}}}val", str(params["kern"]))

    # Character position (w:position) — half-points offset from baseline
    if "position" in params:
        pos = rPr.find(ns("w:position"))
        if pos is None:
            pos = ET.SubElement(rPr, f"{{{w}}}position")
        pos.set(f"{{{w}}}val", str(params["position"]))


def _do_set_run_text_effects(para_elem: ET.Element, params: dict) -> bool:
    """Set run text effects (outline, shadow, emboss, imprint)"""
    w = NAMESPACES["w"]
    run_index = params.get("_run_index")
    runs = para_elem.findall(ns("w:r"))
    if not runs:
        return False

    if run_index is not None:
        if 0 <= run_index < len(runs):
            target_runs = [runs[run_index]]
        else:
            return False
    else:
        target_runs = runs

    for r_elem in target_runs:
        rPr = r_elem.find(ns("w:rPr"))
        if rPr is None:
            rPr = ET.SubElement(r_elem, f"{{{w}}}rPr")
            r_elem.remove(rPr)
            r_elem.insert(0, rPr)

        # Outline
        if "outline" in params:
            tag = ns("w:outline")
            if params["outline"]:
                _ensure_or_get_child(rPr, tag)
            else:
                el = rPr.find(tag)
                if el is not None:
                    rPr.remove(el)

        # Shadow
        if "shadow" in params:
            tag = ns("w:shadow")
            if params["shadow"]:
                _ensure_or_get_child(rPr, tag)
            else:
                el = rPr.find(tag)
                if el is not None:
                    rPr.remove(el)

        # Emboss
        if "emboss" in params:
            tag = ns("w:emboss")
            if params["emboss"]:
                _ensure_or_get_child(rPr, tag)
            else:
                el = rPr.find(tag)
                if el is not None:
                    rPr.remove(el)

        # Imprint
        if "imprint" in params:
            tag = ns("w:imprint")
            if params["imprint"]:
                _ensure_or_get_child(rPr, tag)
            else:
                el = rPr.find(tag)
                if el is not None:
                    rPr.remove(el)

    return True


# ── Phase 1.3: Find & Replace / Format ───────────────────

def _do_find_and_replace(body: ET.Element, params: dict) -> bool:
    """Global or scoped text replacement (cross-run boundary matching)"""
    old_text = params.get("old_text", "")
    new_text = params.get("new_text", "")
    scope = params.get("scope", "all")
    target_id = params.get("target_id", "")

    if not old_text:
        return False

    count = 0
    for p_elem in body.findall(ns("w:p")):
        full = _get_all_text(p_elem)
        if old_text in full:
            # Use existing _do_replace_text logic
            if _do_replace_text(p_elem, old_text, new_text):
                count += 1
                if scope != "all":
                    break

    return count > 0


def _do_find_and_format(body: ET.Element, params: dict, id_to_index: dict, root: ET.Element) -> bool:
    """Find text and apply formatting"""
    find_text = params.get("find_text", "")
    format_props = params.get("format_props", {})
    scope = params.get("scope", "all")

    if not find_text:
        return False

    count = 0
    for p_elem in body.findall(ns("w:p")):
        full = _get_all_text(p_elem)
        if find_text in full:
            # Find the run(s) containing the text and apply format
            for r_elem in p_elem.findall(ns("w:r")):
                t_elem = r_elem.find(ns("w:t"))
                if t_elem is not None and t_elem.text and find_text in t_elem.text:
                    w = NAMESPACES["w"]
                    rPr = r_elem.find(ns("w:rPr"))
                    if rPr is None:
                        rPr = ET.SubElement(r_elem, f"{{{w}}}rPr")
                        r_elem.remove(rPr)
                        r_elem.insert(0, rPr)
                    _apply_run_format_props(rPr, format_props, w)
                    count += 1
                    if scope != "all":
                        break
        if scope != "all" and count > 0:
            break

    return count > 0


# ── Phase 1.4: Breaks ───────────────────────────────────

def _do_add_break(para_elem: ET.Element, params: dict) -> bool:
    """Insert page break/column break in paragraph"""
    w = NAMESPACES["w"]
    break_type = params.get("break_type", "page")

    # Create a new run with break
    r = ET.SubElement(para_elem, f"{{{w}}}r")
    br = ET.SubElement(r, f"{{{w}}}br")
    br.set(f"{{{w}}}type", break_type)
    return True


# ── Phase 1.5: Table Editing ─────────────────────────────

def _do_edit_table_cell_format(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Set cell format (border, shading, width, etc.)"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    row = params.get("row", 0)
    col = params.get("col", 0)

    rows = tbl.findall(ns("w:tr"))
    if row >= len(rows):
        return False
    cells = rows[row].findall(ns("w:tc"))
    if col >= len(cells):
        return False
    tc = cells[col]

    w = NAMESPACES["w"]
    tcPr = tc.find(ns("w:tcPr"))
    if tcPr is None:
        tcPr = ET.SubElement(tc, f"{{{w}}}tcPr")
        tc.remove(tcPr)
        tc.insert(0, tcPr)

    # Width
    if "width" in params:
        tcW = tcPr.find(ns("w:tcW"))
        if tcW is None:
            tcW = ET.SubElement(tcPr, f"{{{w}}}tcW")
        tcW.set(f"{{{w}}}w", str(params["width"]))
        if "width_type" in params:
            tcW.set(f"{{{w}}}type", params["width_type"])

    # Shading
    if "shading" in params:
        shd = tcPr.find(ns("w:shd"))
        if shd is None:
            shd = ET.SubElement(tcPr, f"{{{w}}}shd")
        shading_val = params["shading"]
        if isinstance(shading_val, str):
            # Shorthand: string treated as fill color
            shd.set(f"{{{w}}}val", "clear")
            shd.set(f"{{{w}}}fill", shading_val)
            shd.set(f"{{{w}}}color", "auto")
        elif isinstance(shading_val, dict):
            for k, v in shading_val.items():
                shd.set(f"{{{w}}}{k}", str(v))

    # Borders
    if "borders" in params:
        tcBorders = tcPr.find(ns("w:tcBorders"))
        if tcBorders is None:
            tcBorders = ET.SubElement(tcPr, f"{{{w}}}tcBorders")
        for side, border_data in params["borders"].items():
            border_elem = tcBorders.find(ns(f"w:{side}"))
            if border_elem is None:
                border_elem = ET.SubElement(tcBorders, f"{{{w}}}{side}")
            for k, v in border_data.items():
                border_elem.set(f"{{{w}}}{k}", str(v))

    # Vertical alignment
    if "vertical_alignment" in params:
        vAlign = tcPr.find(ns("w:vAlign"))
        if vAlign is None:
            vAlign = ET.SubElement(tcPr, f"{{{w}}}vAlign")
        vAlign.set(f"{{{w}}}val", params["vertical_alignment"])

    return True


def _do_set_table_properties(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Set table-level properties"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    w = NAMESPACES["w"]
    tblPr = tbl.find(ns("w:tblPr"))
    if tblPr is None:
        tblPr = ET.SubElement(tbl, f"{{{w}}}tblPr")
        tbl.remove(tblPr)
        tbl.insert(0, tblPr)

    # Table width
    if "width" in params:
        tblW = tblPr.find(ns("w:tblW"))
        if tblW is None:
            tblW = ET.SubElement(tblPr, f"{{{w}}}tblW")
        tblW.set(f"{{{w}}}w", str(params["width"]))
        if "width_type" in params:
            tblW.set(f"{{{w}}}type", params["width_type"])

    # Alignment
    if "alignment" in params:
        jc = tblPr.find(ns("w:jc"))
        if jc is None:
            jc = ET.SubElement(tblPr, f"{{{w}}}jc")
        jc.set(f"{{{w}}}val", params["alignment"])

    # Table style
    if "style" in params:
        tblStyle = tblPr.find(ns("w:tblStyle"))
        if tblStyle is None:
            tblStyle = ET.SubElement(tblPr, f"{{{w}}}tblStyle")
        tblStyle.set(f"{{{w}}}val", params["style"])

    # Table layout
    if "layout" in params:
        tblLayout = tblPr.find(ns("w:tblLayout"))
        if tblLayout is None:
            tblLayout = ET.SubElement(tblPr, f"{{{w}}}tblLayout")
        tblLayout.set(f"{{{w}}}type", params["layout"])

    return True


def _do_set_table_border(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Set table borders"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    w = NAMESPACES["w"]
    tblPr = tbl.find(ns("w:tblPr"))
    if tblPr is None:
        tblPr = ET.SubElement(tbl, f"{{{w}}}tblPr")
        tbl.remove(tblPr)
        tbl.insert(0, tblPr)

    tblBorders = tblPr.find(ns("w:tblBorders"))
    if tblBorders is None:
        tblBorders = ET.SubElement(tblPr, f"{{{w}}}tblBorders")

    # params contains side → {val, sz, space, color}
    for side, border_data in params.items():
        if isinstance(border_data, dict):
            border_elem = tblBorders.find(ns(f"w:{side}"))
            if border_elem is None:
                border_elem = ET.SubElement(tblBorders, f"{{{w}}}{side}")
            for k, v in border_data.items():
                border_elem.set(f"{{{w}}}{k}", str(v))

    return True


def _fill_table_data(tbl: ET.Element, data: list):
    """Fill 2D array into table XML element"""
    w = NAMESPACES["w"]
    rows = tbl.findall(f"{{{w}}}tr")
    for r_idx, row_data in enumerate(data):
        if r_idx >= len(rows):
            break
        cells = rows[r_idx].findall(f"{{{w}}}tc")
        for c_idx, cell_text in enumerate(row_data):
            if c_idx >= len(cells):
                break
            p = cells[c_idx].find(f"{{{w}}}p")
            if p is None:
                p = ET.SubElement(cells[c_idx], f"{{{w}}}p")
            r = p.find(f"{{{w}}}r")
            if r is None:
                r = ET.SubElement(p, f"{{{w}}}r")
            t = r.find(f"{{{w}}}t")
            if t is None:
                t = ET.SubElement(r, f"{{{w}}}t")
            t.text = str(cell_text)
            t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")


def _make_table_element(rows: int, cols: int, **kwargs) -> ET.Element:
    """Create a complete table XML element"""
    w = NAMESPACES["w"]
    tbl = ET.Element(f"{{{w}}}tbl")

    # tblPr
    tblPr = ET.SubElement(tbl, f"{{{w}}}tblPr")
    tblStyle = ET.SubElement(tblPr, f"{{{w}}}tblStyle")
    tblStyle.set(f"{{{w}}}val", kwargs.get("style", "TableGrid"))
    tblW = ET.SubElement(tblPr, f"{{{w}}}tblW")
    tblW.set(f"{{{w}}}w", str(kwargs.get("width", 0)))
    tblW.set(f"{{{w}}}type", kwargs.get("width_type", "auto"))
    if kwargs.get("borders", True):
        tblBorders = ET.SubElement(tblPr, f"{{{w}}}tblBorders")
        for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
            b = ET.SubElement(tblBorders, f"{{{w}}}{side}")
            b.set(f"{{{w}}}val", "single")
            b.set(f"{{{w}}}sz", "4")
            b.set(f"{{{w}}}space", "0")
            b.set(f"{{{w}}}color", "000000")

    # tblGrid
    tblGrid = ET.SubElement(tbl, f"{{{w}}}tblGrid")
    for c in range(cols):
        gridCol = ET.SubElement(tblGrid, f"{{{w}}}gridCol")

    # Rows
    for r in range(rows):
        tr = ET.SubElement(tbl, f"{{{w}}}tr")
        for c in range(cols):
            tc = ET.SubElement(tr, f"{{{w}}}tc")
            p = ET.SubElement(tc, f"{{{w}}}p")

    return tbl


def _do_add_table(body: ET.Element, position: str, params: dict,
                  id_to_index: dict = None, id_to_elem: dict = None) -> bool:
    """Add new table"""
    rows = params.get("rows", 3)
    cols = params.get("cols", 3)
    data = params.get("data", [])
    header_row = params.get("header_row", None)
    tbl_kwargs = {k: v for k, v in params.items() if k not in ("rows", "cols", "data", "header_row", "position")}
    tbl = _make_table_element(rows, cols, **tbl_kwargs)

    # Merge header_row + data into table
    all_data = []
    if header_row:
        all_data.append(header_row)
    all_data.extend(data)
    if all_data:
        _fill_table_data(tbl, all_data)

    return _insert_at_position(body, tbl, position, id_to_index or {}, id_to_elem)


def _do_remove_table(body: ET.Element, table_id: str, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Remove table"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    body.remove(tbl)
    return True


def _do_add_table_row(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Add table row"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    w = NAMESPACES["w"]
    row_index = params.get("row_index", -1)

    # Get column count from tblGrid
    tblGrid = tbl.find(ns("w:tblGrid"))
    if tblGrid is None:
        cols = 1
    else:
        cols = len(tblGrid.findall(ns("w:gridCol")))
        if cols == 0:
            cols = 1

    # Create new row
    tr = ET.Element(f"{{{w}}}tr")
    for c in range(cols):
        tc = ET.SubElement(tr, f"{{{w}}}tc")
        p = ET.SubElement(tc, f"{{{w}}}p")

    rows = tbl.findall(ns("w:tr"))
    if row_index < 0 or row_index >= len(rows):
        tbl.append(tr)
    else:
        # Insert after existing elements: find all tr indices
        all_children = list(tbl)
        tr_children = [ch for ch in all_children if ch.tag == ns("w:tr")]
        if row_index < len(tr_children):
            ref_idx = all_children.index(tr_children[row_index])
            tbl.insert(ref_idx, tr)
        else:
            tbl.append(tr)

    return True


def _do_remove_table_row(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Remove table row"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    row_index = params.get("row_index", -1)
    rows = tbl.findall(ns("w:tr"))
    if 0 <= row_index < len(rows):
        tbl.remove(rows[row_index])
        return True
    return False


def _do_add_table_column(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Add table column"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    w = NAMESPACES["w"]
    col_index = params.get("col_index", -1)

    # Add gridCol to tblGrid
    tblGrid = tbl.find(ns("w:tblGrid"))
    if tblGrid is None:
        tblGrid = ET.SubElement(tbl, f"{{{w}}}tblGrid")

    gridCol = ET.SubElement(tblGrid, f"{{{w}}}gridCol")
    existing_cols = tblGrid.findall(ns("w:gridCol"))
    if 0 <= col_index < len(existing_cols):
        # Reorder: move new gridCol to correct position
        all_grid = list(tblGrid)
        tblGrid.remove(gridCol)
        tblGrid.insert(col_index + 1, gridCol)

    # Add cell to each row
    for tr in tbl.findall(ns("w:tr")):
        tc = ET.Element(f"{{{w}}}tc")
        p = ET.SubElement(tc, f"{{{w}}}p")
        cells = tr.findall(ns("w:tc"))
        if 0 <= col_index < len(cells):
            # Insert at position
            tr_children = list(tr)
            ref_idx = tr_children.index(cells[col_index])
            tr.insert(ref_idx + 1, tc)
        else:
            tr.append(tc)

    return True


def _do_remove_table_column(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Remove table column"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    col_index = params.get("col_index", -1)

    # Remove gridCol
    tblGrid = tbl.find(ns("w:tblGrid"))
    if tblGrid is not None:
        gridCols = tblGrid.findall(ns("w:gridCol"))
        if 0 <= col_index < len(gridCols):
            tblGrid.remove(gridCols[col_index])

    # Remove cell from each row
    for tr in tbl.findall(ns("w:tr")):
        cells = tr.findall(ns("w:tc"))
        if 0 <= col_index < len(cells):
            tr.remove(cells[col_index])

    return True


def _do_set_table_row_properties(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Set row-level properties"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    w = NAMESPACES["w"]
    row_index = params.get("row_index", 0)
    rows = tbl.findall(ns("w:tr"))
    if row_index >= len(rows):
        return False
    tr = rows[row_index]

    trPr = tr.find(ns("w:trPr"))
    if trPr is None:
        trPr = ET.SubElement(tr, f"{{{w}}}trPr")
        tr.remove(trPr)
        tr.insert(0, trPr)

    # Height
    if "height" in params:
        trHeight = trPr.find(ns("w:trHeight"))
        if trHeight is None:
            trHeight = ET.SubElement(trPr, f"{{{w}}}trHeight")
        trHeight.set(f"{{{w}}}val", str(params["height"]))
        if "height_rule" in params:
            trHeight.set(f"{{{w}}}hRule", params["height_rule"])

    # Header row
    if "header" in params:
        tag = ns("w:tblHeader")
        if params["header"]:
            _ensure_or_get_child(trPr, tag)
        else:
            el = trPr.find(tag)
            if el is not None:
                trPr.remove(el)

    return True


def _do_set_table_cell_properties(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Set cell properties"""
    # Delegate to edit_table_cell_format (same implementation)
    return _do_edit_table_cell_format(body, table_id, params, tbl_to_elem, resolved_tbl)


def _do_merge_cells(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Merge cells"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    w = NAMESPACES["w"]
    row_start = params.get("row_start", 0)
    col_start = params.get("col_start", 0)
    row_end = params.get("row_end", 0)
    col_end = params.get("col_end", 0)

    rows = tbl.findall(ns("w:tr"))
    if row_end >= len(rows):
        return False

    # Horizontal merge
    for r in range(row_start, row_end + 1):
        cells = rows[r].findall(ns("w:tc"))
        for c in range(col_start, col_end + 1):
            if c >= len(cells):
                continue
            tcPr = cells[c].find(ns("w:tcPr"))
            if tcPr is None:
                tcPr = ET.SubElement(cells[c], f"{{{w}}}tcPr")
                cells[c].remove(tcPr)
                cells[c].insert(0, tcPr)

            if c == col_start:
                # First cell: gridSpan for horizontal, vMerge for vertical
                if col_end > col_start:
                    gridSpan = tcPr.find(ns("w:gridSpan"))
                    if gridSpan is None:
                        gridSpan = ET.SubElement(tcPr, f"{{{w}}}gridSpan")
                    gridSpan.set(f"{{{w}}}val", str(col_end - col_start + 1))
                if row_end > row_start:
                    vMerge = tcPr.find(ns("w:vMerge"))
                    if vMerge is None:
                        vMerge = ET.SubElement(tcPr, f"{{{w}}}vMerge")
                    if r == row_start:
                        vMerge.set(f"{{{w}}}val", "restart")
                    # else: no val = "continue"
            else:
                # Subsequent cells: mark as horizontally merged (no gridSpan)
                if col_end > col_start:
                    # Remove gridSpan if present — these are continuation cells
                    gridSpan = tcPr.find(ns("w:gridSpan"))
                    if gridSpan is not None:
                        tcPr.remove(gridSpan)
                if row_end > row_start and r > row_start:
                    vMerge = tcPr.find(ns("w:vMerge"))
                    if vMerge is None:
                        vMerge = ET.SubElement(tcPr, f"{{{w}}}vMerge")
                    # No val = "continue"

    return True


def _do_split_cells(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Split merged table cells"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    w = NAMESPACES["w"]
    row_idx = params.get("row", 0)
    col_idx = params.get("col", 0)
    horizontal = params.get("horizontal", 1)
    vertical = params.get("vertical", 1)

    rows = tbl.findall(ns("w:tr"))
    if row_idx >= len(rows):
        return False

    cells = rows[row_idx].findall(ns("w:tc"))
    if col_idx >= len(cells):
        return False

    target_cell = cells[col_idx]
    tcPr = target_cell.find(ns("w:tcPr"))
    if tcPr is None:
        tcPr = ET.SubElement(target_cell, f"{{{w}}}tcPr")
        target_cell.remove(tcPr)
        target_cell.insert(0, tcPr)

    # Horizontal: remove gridSpan, insert empty cells
    gridSpan_elem = tcPr.find(ns("w:gridSpan"))
    if gridSpan_elem is not None:
        tcPr.remove(gridSpan_elem)

    cells_to_insert = horizontal - 1
    if cells_to_insert > 0:
        for i in range(cells_to_insert):
            new_tc = ET.SubElement(rows[row_idx], f"{{{w}}}tc")
            new_p = ET.SubElement(new_tc, f"{{{w}}}p")
            rows[row_idx].remove(new_tc)
            insert_pos = col_idx + 1 + i
            row_children = list(rows[row_idx])
            cell_count = 0
            inserted = False
            for ci, child in enumerate(row_children):
                if child.tag == f"{{{w}}}tc":
                    if cell_count == insert_pos:
                        rows[row_idx].insert(ci, new_tc)
                        inserted = True
                        break
                    cell_count += 1
            if not inserted:
                rows[row_idx].append(new_tc)

    # Vertical: remove vMerge
    vMerge_elem = tcPr.find(ns("w:vMerge"))
    if vMerge_elem is not None:
        tcPr.remove(vMerge_elem)

    for r in range(row_idx + 1, len(rows)):
        r_cells = rows[r].findall(ns("w:tc"))
        if col_idx >= len(r_cells):
            continue
        cont_cell = r_cells[col_idx]
        cont_tcPr = cont_cell.find(ns("w:tcPr"))
        if cont_tcPr is not None:
            cont_vMerge = cont_tcPr.find(ns("w:vMerge"))
            if cont_vMerge is not None:
                cont_tcPr.remove(cont_vMerge)

    return True


def _do_set_row_cell_text(body: ET.Element, table_id: str, params: dict, tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Row-level shortcut: set entire row cell text at once"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    w = NAMESPACES["w"]
    row_index = params.get("row_index", 0)
    rows = tbl.findall(ns("w:tr"))
    if row_index >= len(rows):
        return False
    tr = rows[row_index]

    col_idx = 0
    for key, text in params.items():
        if key.startswith("col_") or key.startswith("cell_"):
            try:
                idx = int(key.split("_", 1)[1])
            except ValueError:
                continue
            cells = tr.findall(ns("w:tc"))
            if idx < len(cells):
                tc = cells[idx]
                t_elems = list(tc.iter(ns("w:t")))
                if t_elems:
                    t_elems[0].text = str(text)
                    t_elems[0].set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                    for t in t_elems[1:]:
                        t.text = ""
                else:
                    p = tc.find(ns("w:p"))
                    if p is None:
                        p = ET.SubElement(tc, f"{{{w}}}p")
                    r = ET.SubElement(p, f"{{{w}}}r")
                    t = ET.SubElement(r, f"{{{w}}}t")
                    t.text = str(text)
                    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    return True


# ── Phase 1.6: Clone/Move ───────────────────────────────

def _do_copy_paragraph(body: ET.Element, para_elem: ET.Element, position: str, id_to_index: dict, id_to_elem: dict = None) -> bool:
    """Clone paragraph"""
    new_p = copy.deepcopy(para_elem)
    return _insert_at_position(body, new_p, position, id_to_index, id_to_elem)


def _do_copy_table(body: ET.Element, table_id: str, position: str, tbl_to_elem: dict = None) -> bool:
    """Clone table"""
    tbl = _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    new_tbl = copy.deepcopy(tbl)
    # Append after original table
    idx = list(body).index(tbl)
    body.insert(idx + 1, new_tbl)
    return True


def _do_move_paragraph(body: ET.Element, para_elem: ET.Element, position: str, id_to_index: dict, id_to_elem: dict = None) -> bool:
    """Move paragraph"""
    new_p = copy.deepcopy(para_elem)
    body.remove(para_elem)
    return _insert_at_position(body, new_p, position, id_to_index, id_to_elem)


def _do_swap_paragraph(body: ET.Element, target_id: str, params: dict, id_to_index: dict, root: ET.Element) -> bool:
    """Swap positions of two paragraphs"""
    target_id_2 = params.get("target_id_2", "")
    idx1 = id_to_index.get(target_id)
    idx2 = id_to_index.get(target_id_2)
    if idx1 is None or idx2 is None:
        return False

    paras = body.findall(ns("w:p"))
    if not (0 <= idx1 < len(paras) and 0 <= idx2 < len(paras)):
        return False

    p1 = paras[idx1]
    p2 = paras[idx2]

    # Swap positions
    all_children = list(body)
    pos1 = all_children.index(p1)
    pos2 = all_children.index(p2)

    # Deep copy for safety
    p1_copy = copy.deepcopy(p1)
    p2_copy = copy.deepcopy(p2)

    body.remove(p1)
    body.remove(p2)

    # Re-find positions since body changed
    all_children = list(body)
    # Insert at the lower position first
    min_pos = min(pos1, pos2)
    max_pos = max(pos1, pos2)

    if pos1 < pos2:
        body.insert(min_pos, p2_copy)
        body.insert(max_pos, p1_copy)
    else:
        body.insert(min_pos, p1_copy)
        body.insert(max_pos, p2_copy)

    return True


# ── Phase 1.8: Track Changes ─────────────────────────────

def _do_accept_all_changes(body: ET.Element) -> bool:
    """Accept all changes: keep inserted content, remove deletion-marked content"""
    w = NAMESPACES["w"]
    modified = False

    # Process insertions: remove w:ins markers, keep content
    for ins in list(body.iter(ns("w:ins"))):
        parent = _find_parent(body, ins)
        if parent is not None:
            # Move children of ins before ins
            idx = list(parent).index(ins)
            for child in list(ins):
                parent.insert(idx, child)
                idx += 1
            parent.remove(ins)
            modified = True

    # Process deletions: remove w:del and all content inside
    for del_elem in list(body.iter(ns("w:del"))):
        parent = _find_parent(body, del_elem)
        if parent is not None:
            parent.remove(del_elem)
            modified = True

    # Remove rPr change tracking
    for rPrChange in list(body.iter(ns("w:rPrChange"))):
        parent = _find_parent(body, rPrChange)
        if parent is not None:
            parent.remove(rPrChange)
            modified = True

    for pPrChange in list(body.iter(ns("w:pPrChange"))):
        parent = _find_parent(body, pPrChange)
        if parent is not None:
            parent.remove(pPrChange)
            modified = True

    return True  # Always succeed (no changes to accept is OK)


def _do_reject_all_changes(body: ET.Element) -> bool:
    """Reject all changes: remove inserted content, restore deleted content"""
    w = NAMESPACES["w"]
    modified = False

    # Process insertions: remove inserted content
    for ins in list(body.iter(ns("w:ins"))):
        parent = _find_parent(body, ins)
        if parent is not None:
            parent.remove(ins)
            modified = True

    # Process deletions: remove w:del markers, keep content
    for del_elem in list(body.iter(ns("w:del"))):
        parent = _find_parent(body, del_elem)
        if parent is not None:
            idx = list(parent).index(del_elem)
            for child in list(del_elem):
                parent.insert(idx, child)
                idx += 1
            parent.remove(del_elem)
            modified = True

    return True  # Always succeed (no changes to reject is OK)


def _find_parent(root: ET.Element, target: ET.Element) -> Optional[ET.Element]:
    """Find parent element of target in XML tree"""
    for elem in root.iter():
        if target in list(elem):
            return elem
    return None


# ── Phase 2.1: Image ─────────────────────────────────────

def _do_add_image(body: ET.Element, target_id: str, position: str, params: dict,
                  id_to_index: dict, root: ET.Element, id_to_elem: dict = None) -> bool:
    """Insert image placeholder XML (drawing element)"""
    w = NAMESPACES["w"]
    wp = NAMESPACES["wp"]
    a = NAMESPACES["a"]
    pic = NAMESPACES["pic"]

    width = params.get("width", 400)
    height = params.get("height", 300)
    image_path = params.get("image_path", "")
    r_id = params.get("r_id", "rImg1")
    layout = params.get("layout", "inline")  # "inline" or "anchor"
    wrap = params.get("wrap", "")  # "square"/"tight"/"through"/"topAndBottom"/"none"
    behind_doc = params.get("behind_doc", False)
    position_h = params.get("position_h")  # {"relative_from": "column", "offset": "360045"}
    position_v = params.get("position_v")  # {"relative_from": "paragraph", "offset": "0"}

    # FIX-004: Auto-increment docPr/cNvPr ids to avoid duplicates
    max_doc_id = 0
    for docPr in body.iter(f"{{{wp}}}docPr"):
        try:
            doc_id = int(docPr.get("id", "0"))
            max_doc_id = max(max_doc_id, doc_id)
        except (ValueError, TypeError):
            pass
    next_doc_id = max_doc_id + 1

    # Create drawing XML
    r_elem = ET.Element(f"{{{w}}}r")
    drawing = ET.SubElement(r_elem, f"{{{w}}}drawing")

    if layout == "anchor":
        # ── Floating image (wp:anchor) ──
        anchor = ET.SubElement(drawing, f"{{{wp}}}anchor")
        anchor.set("distT", "0")
        anchor.set("distB", "0")
        anchor.set("distL", "114300")
        anchor.set("distR", "114300")
        anchor.set("simplePos", "0")
        anchor.set("relativeHeight", str(next_doc_id))
        anchor.set("behindDoc", "1" if behind_doc else "0")
        anchor.set("locked", "0")
        anchor.set("layoutInCell", "1")
        anchor.set("allowOverlap", "1")

        # simplePos
        simplePos = ET.SubElement(anchor, f"{{{wp}}}simplePos")
        simplePos.set("x", "0")
        simplePos.set("y", "0")

        # positionH
        pos_h = ET.SubElement(anchor, f"{{{wp}}}positionH")
        pos_h.set("relativeFrom", position_h.get("relative_from", "column") if position_h else "column")
        pos_h_offset = ET.SubElement(pos_h, f"{{{wp}}}posOffset")
        pos_h_offset.text = str(position_h.get("offset", "0")) if position_h else "0"

        # positionV
        pos_v = ET.SubElement(anchor, f"{{{wp}}}positionV")
        pos_v.set("relativeFrom", position_v.get("relative_from", "paragraph") if position_v else "paragraph")
        pos_v_offset = ET.SubElement(pos_v, f"{{{wp}}}posOffset")
        pos_v_offset.text = str(position_v.get("offset", "0")) if position_v else "0"

        # wrap
        if wrap == "square":
            wrap_elem = ET.SubElement(anchor, f"{{{wp}}}wrapSquare")
            wrap_elem.set("wrapText", "bothSides")
        elif wrap == "tight":
            wrap_elem = ET.SubElement(anchor, f"{{{wp}}}wrapTight")
            wrap_elem.set("wrapText", "bothSides")
        elif wrap == "through":
            wrap_elem = ET.SubElement(anchor, f"{{{wp}}}wrapThrough")
            wrap_elem.set("wrapText", "bothSides")
        elif wrap == "topAndBottom":
            ET.SubElement(anchor, f"{{{wp}}}wrapTopAndBottom")
        elif wrap == "none":
            ET.SubElement(anchor, f"{{{wp}}}wrapNone")
        else:
            # Default: wrapNone if no wrap specified for anchor
            ET.SubElement(anchor, f"{{{wp}}}wrapNone")

        container = anchor
    else:
        # ── Inline image (wp:inline) ──
        inline = ET.SubElement(drawing, f"{{{wp}}}inline")
        inline.set("distT", "0")
        inline.set("distB", "0")
        inline.set("distL", "0")
        inline.set("distR", "0")
        container = inline

    # ── Common children (extent, effectExtent, docPr, cNvGraphicFramePr, graphic) ──
    extent = ET.SubElement(container, f"{{{wp}}}extent")
    extent.set("cx", str(int(width * 9525)))  # EMU
    extent.set("cy", str(int(height * 9525)))

    effectExtent = ET.SubElement(container, f"{{{wp}}}effectExtent")
    effectExtent.set("l", "0")
    effectExtent.set("t", "0")
    effectExtent.set("r", "0")
    effectExtent.set("b", "0")

    docPr = ET.SubElement(container, f"{{{wp}}}docPr")
    docPr.set("id", str(next_doc_id))
    docPr.set("name", f"Picture {next_doc_id}")

    cNvGraphicFramePr = ET.SubElement(container, f"{{{wp}}}cNvGraphicFramePr")
    graphicFrameLocks = ET.SubElement(cNvGraphicFramePr, f"{{{a}}}graphicFrameLocks")
    graphicFrameLocks.set("noChangeAspect", "1")

    graphic = ET.SubElement(container, f"{{{a}}}graphic")
    graphicData = ET.SubElement(graphic, f"{{{a}}}graphicData")
    graphicData.set("uri", "http://schemas.openxmlformats.org/drawingml/2006/picture")

    pic_elem = ET.SubElement(graphicData, f"{{{pic}}}pic")
    nvPicPr = ET.SubElement(pic_elem, f"{{{pic}}}nvPicPr")
    cNvPr = ET.SubElement(nvPicPr, f"{{{pic}}}cNvPr")
    cNvPr.set("id", str(next_doc_id))
    cNvPr.set("name", image_path or "image")
    cNvPicPr = ET.SubElement(nvPicPr, f"{{{pic}}}cNvPicPr")

    blipFill = ET.SubElement(pic_elem, f"{{{pic}}}blipFill")
    r_ns = NAMESPACES["r"]
    blip = ET.SubElement(blipFill, f"{{{a}}}blip")
    blip.set(f"{{{r_ns}}}embed", r_id)

    stretch = ET.SubElement(blipFill, f"{{{pic}}}stretch")
    fillRect = ET.SubElement(stretch, f"{{{a}}}fillRect")

    spPr = ET.SubElement(pic_elem, f"{{{pic}}}spPr")

    # Insert into a paragraph
    p = _make_paragraph_element("", "")
    p.append(r_elem)

    return _insert_at_position(body, p, position, id_to_index, id_to_elem)


def _find_drawing_by_id(body: ET.Element, image_id: str) -> Optional[ET.Element]:
    """Locate N-th w:drawing element by image_id (img-000)"""
    try:
        idx = int(image_id.replace("img-", ""))
    except ValueError:
        return None
    drawings = list(body.iter(ns("w:drawing")))
    if 0 <= idx < len(drawings):
        return drawings[idx]
    return None


def _do_replace_image(body: ET.Element, image_id: str, params: dict) -> bool:
    """Replace image (modify blip r:embed reference)"""
    drawing = _find_drawing_by_id(body, image_id)
    if drawing is None:
        return False
    r_ns = NAMESPACES["r"]
    a_ns = NAMESPACES["a"]
    r_id = params.get("r_id", "")
    if not r_id:
        return False
    for blip in drawing.iter(f"{{{a_ns}}}blip"):
        blip.set(f"{{{r_ns}}}embed", r_id)
        return True
    return False


def _do_set_image_size(body: ET.Element, image_id: str, params: dict) -> bool:
    """Modify image dimensions"""
    drawing = _find_drawing_by_id(body, image_id)
    if drawing is None:
        return False
    wp = NAMESPACES["wp"]
    width = params.get("width")
    height = params.get("height")

    for extent in drawing.iter(f"{{{wp}}}extent"):
        if width:
            extent.set("cx", str(int(width * 9525)))
        if height:
            extent.set("cy", str(int(height * 9525)))
        return True
    return False


def _do_remove_image(body: ET.Element, image_id: str) -> bool:
    """Remove image (remove run containing the specified image drawing element)"""
    drawing = _find_drawing_by_id(body, image_id)
    if drawing is None:
        return False
    # Find parent run containing this drawing and remove it
    for r_elem in body.iter(ns("w:r")):
        if drawing in list(r_elem):
            parent = _find_parent(body, r_elem)
            if parent is not None:
                parent.remove(r_elem)
                return True
    return False


def _do_set_image_alt(body: ET.Element, image_id: str, params: dict) -> bool:
    """Set image alt text"""
    drawing = _find_drawing_by_id(body, image_id)
    if drawing is None:
        return False
    wp = NAMESPACES["wp"]
    alt_text = params.get("alt_text", "")

    for docPr in drawing.iter(f"{{{wp}}}docPr"):
        docPr.set("descr", alt_text)
        return True
    return False


def _do_set_image_layout(body: ET.Element, image_id: str, params: dict) -> bool:
    """Set image layout: inline↔anchor switching, text wrapping, positioning.

    Supports:
    - layout: "inline" or "anchor" (convert layout type)
    - wrap: "square"/"tight"/"through"/"topAndBottom"/"none" (anchor only)
    - behind_doc: bool
    - position_h: {"relative_from": str, "offset": str} (EMU)
    - position_v: {"relative_from": str, "offset": str} (EMU)
    - allow_overlap: bool
    - locked: bool
    """
    drawing = _find_drawing_by_id(body, image_id)
    if drawing is None:
        return False

    wp = NAMESPACES["wp"]
    w = NAMESPACES["w"]
    a = NAMESPACES["a"]
    layout = params.get("layout", "")
    wrap = params.get("wrap", "")
    behind_doc = params.get("behind_doc")
    position_h = params.get("position_h")
    position_v = params.get("position_v")
    allow_overlap = params.get("allow_overlap")
    locked = params.get("locked")

    # Find current layout element (inline or anchor)
    old_inline = drawing.find(f"{{{wp}}}inline")
    old_anchor = drawing.find(f"{{{wp}}}anchor")

    if layout == "inline" and old_anchor is not None:
        # ── anchor → inline conversion ──
        # Extract shared child elements
        extent = old_anchor.find(f"{{{wp}}}extent")
        docPr = old_anchor.find(f"{{{wp}}}docPr")
        cNvGraphicFramePr = old_anchor.find(f"{{{wp}}}cNvGraphicFramePr")
        graphic = old_anchor.find(f"{{{a}}}graphic")

        # Create inline
        new_inline = ET.Element(f"{{{wp}}}inline")
        new_inline.set("distT", "0")
        new_inline.set("distB", "0")
        new_inline.set("distL", "0")
        new_inline.set("distR", "0")
        if extent is not None:
            new_inline.append(extent)
        eff = ET.SubElement(new_inline, f"{{{wp}}}effectExtent")
        eff.set("l", "0"); eff.set("t", "0"); eff.set("r", "0"); eff.set("b", "0")
        if docPr is not None:
            new_inline.append(docPr)
        if cNvGraphicFramePr is not None:
            new_inline.append(cNvGraphicFramePr)
        if graphic is not None:
            new_inline.append(graphic)

        drawing.remove(old_anchor)
        drawing.append(new_inline)
        return True

    elif layout == "anchor" and old_inline is not None:
        # ── inline → anchor conversion ──
        extent = old_inline.find(f"{{{wp}}}extent")
        docPr = old_inline.find(f"{{{wp}}}docPr")
        cNvGraphicFramePr = old_inline.find(f"{{{wp}}}cNvGraphicFramePr")
        graphic = old_inline.find(f"{{{a}}}graphic")

        # Build anchor
        new_anchor = ET.Element(f"{{{wp}}}anchor")
        new_anchor.set("distT", "0")
        new_anchor.set("distB", "0")
        new_anchor.set("distL", "114300")
        new_anchor.set("distR", "114300")
        new_anchor.set("simplePos", "0")
        rel_h = docPr.get("id", "0") if docPr is not None else "0"
        new_anchor.set("relativeHeight", rel_h)
        new_anchor.set("behindDoc", "1" if behind_doc else "0")
        new_anchor.set("locked", "1" if locked else "0")
        new_anchor.set("layoutInCell", "1")
        new_anchor.set("allowOverlap", "1" if allow_overlap is not False else "0")

        simplePos = ET.SubElement(new_anchor, f"{{{wp}}}simplePos")
        simplePos.set("x", "0"); simplePos.set("y", "0")

        pos_h = ET.SubElement(new_anchor, f"{{{wp}}}positionH")
        pos_h.set("relativeFrom", position_h.get("relative_from", "column") if position_h else "column")
        pos_h_off = ET.SubElement(pos_h, f"{{{wp}}}posOffset")
        pos_h_off.text = str(position_h.get("offset", "0")) if position_h else "0"

        pos_v = ET.SubElement(new_anchor, f"{{{wp}}}positionV")
        pos_v.set("relativeFrom", position_v.get("relative_from", "paragraph") if position_v else "paragraph")
        pos_v_off = ET.SubElement(pos_v, f"{{{wp}}}posOffset")
        pos_v_off.text = str(position_v.get("offset", "0")) if position_v else "0"

        # wrap
        wrap_type = wrap or "none"
        if wrap_type == "square":
            we = ET.SubElement(new_anchor, f"{{{wp}}}wrapSquare"); we.set("wrapText", "bothSides")
        elif wrap_type == "tight":
            we = ET.SubElement(new_anchor, f"{{{wp}}}wrapTight"); we.set("wrapText", "bothSides")
        elif wrap_type == "through":
            we = ET.SubElement(new_anchor, f"{{{wp}}}wrapThrough"); we.set("wrapText", "bothSides")
        elif wrap_type == "topAndBottom":
            ET.SubElement(new_anchor, f"{{{wp}}}wrapTopAndBottom")
        else:
            ET.SubElement(new_anchor, f"{{{wp}}}wrapNone")

        if extent is not None:
            new_anchor.append(extent)
        eff = ET.SubElement(new_anchor, f"{{{wp}}}effectExtent")
        eff.set("l", "0"); eff.set("t", "0"); eff.set("r", "0"); eff.set("b", "0")
        if docPr is not None:
            new_anchor.append(docPr)
        if cNvGraphicFramePr is not None:
            new_anchor.append(cNvGraphicFramePr)
        if graphic is not None:
            new_anchor.append(graphic)

        drawing.remove(old_inline)
        drawing.append(new_anchor)
        return True

    elif old_anchor is not None:
        # ── Modify existing anchor attributes (no type conversion) ──
        if behind_doc is not None:
            old_anchor.set("behindDoc", "1" if behind_doc else "0")
        if allow_overlap is not None:
            old_anchor.set("allowOverlap", "1" if allow_overlap else "0")
        if locked is not None:
            old_anchor.set("locked", "1" if locked else "0")

        # Update positionH
        if position_h:
            pos_h = old_anchor.find(f"{{{wp}}}positionH")
            if pos_h is not None:
                pos_h.set("relativeFrom", position_h.get("relative_from", pos_h.get("relativeFrom", "column")))
                pos_off = pos_h.find(f"{{{wp}}}posOffset")
                if pos_off is not None:
                    pos_off.text = str(position_h.get("offset", pos_off.text or "0"))

        # Update positionV
        if position_v:
            pos_v = old_anchor.find(f"{{{wp}}}positionV")
            if pos_v is not None:
                pos_v.set("relativeFrom", position_v.get("relative_from", pos_v.get("relativeFrom", "paragraph")))
                pos_off = pos_v.find(f"{{{wp}}}posOffset")
                if pos_off is not None:
                    pos_off.text = str(position_v.get("offset", pos_off.text or "0"))

        # Update wrap
        if wrap:
            # Remove old wrap element
            for tag in ["wrapSquare", "wrapTight", "wrapThrough", "wrapTopAndBottom", "wrapNone"]:
                old_wrap = old_anchor.find(f"{{{wp}}}{tag}")
                if old_wrap is not None:
                    old_anchor.remove(old_wrap)
                    break
            # Insert new wrap (before extent)
            insert_idx = 0
            for i, child in enumerate(old_anchor):
                if child.tag == f"{{{wp}}}extent":
                    insert_idx = i
                    break
            if wrap == "square":
                we = ET.Element(f"{{{wp}}}wrapSquare"); we.set("wrapText", "bothSides")
            elif wrap == "tight":
                we = ET.Element(f"{{{wp}}}wrapTight"); we.set("wrapText", "bothSides")
            elif wrap == "through":
                we = ET.Element(f"{{{wp}}}wrapThrough"); we.set("wrapText", "bothSides")
            elif wrap == "topAndBottom":
                we = ET.Element(f"{{{wp}}}wrapTopAndBottom")
            else:
                we = ET.Element(f"{{{wp}}}wrapNone")
            old_anchor.insert(insert_idx, we)

        return True

    return False


# ── Phase 2.2: List ──────────────────────────────────────

def _do_set_list_style(para_elem: ET.Element, params: dict) -> bool:
    """Set list style (via numPr)"""
    w = NAMESPACES["w"]
    list_type = params.get("list_type", "bullet")
    num_id = params.get("num_id", "1")
    ilvl = params.get("ilvl", "0")

    pPr = para_elem.find(ns("w:pPr"))
    if pPr is None:
        pPr = ET.SubElement(para_elem, f"{{{w}}}pPr")
        para_elem.remove(pPr)
        para_elem.insert(0, pPr)

    numPr = pPr.find(ns("w:numPr"))
    if numPr is None:
        numPr = ET.SubElement(pPr, f"{{{w}}}numPr")

    ilvl_elem = numPr.find(ns("w:ilvl"))
    if ilvl_elem is None:
        ilvl_elem = ET.SubElement(numPr, f"{{{w}}}ilvl")
    ilvl_elem.set(f"{{{w}}}val", str(ilvl))

    numId = numPr.find(ns("w:numId"))
    if numId is None:
        numId = ET.SubElement(numPr, f"{{{w}}}numId")
    numId.set(f"{{{w}}}val", str(num_id))

    return True


def _do_set_list_level(para_elem: ET.Element, params: dict) -> bool:
    """Set list level"""
    w = NAMESPACES["w"]
    num_id = params.get("num_id", "1")
    ilvl = params.get("ilvl", 0)

    pPr = para_elem.find(ns("w:pPr"))
    if pPr is None:
        pPr = ET.SubElement(para_elem, f"{{{w}}}pPr")
        para_elem.remove(pPr)
        para_elem.insert(0, pPr)

    numPr = pPr.find(ns("w:numPr"))
    if numPr is None:
        numPr = ET.SubElement(pPr, f"{{{w}}}numPr")

    ilvl_elem = numPr.find(ns("w:ilvl"))
    if ilvl_elem is None:
        ilvl_elem = ET.SubElement(numPr, f"{{{w}}}ilvl")
    ilvl_elem.set(f"{{{w}}}val", str(ilvl))

    numId = numPr.find(ns("w:numId"))
    if numId is None:
        numId = ET.SubElement(numPr, f"{{{w}}}numId")
    numId.set(f"{{{w}}}val", str(num_id))

    return True


def _do_set_paragraph_numbering_restart(para_elem: ET.Element, params: dict,
                                          body: ET.Element) -> bool:
    """Restart numbering — Phase 1: set paragraph numPr to new numId (Phase 2 adds lvlOverride in numbering.xml)"""
    w = NAMESPACES["w"]
    start = params.get("start", 1)
    num_id_override = params.get("num_id")

    pPr = para_elem.find(ns("w:pPr"))
    if pPr is None:
        return False  # Paragraph has no pPr, cannot read current numbering

    numPr = pPr.find(ns("w:numPr"))
    if numPr is None:
        return False  # Paragraph has no numbering

    # Read current numId and ilvl
    cur_numId_elem = numPr.find(ns("w:numId"))
    if cur_numId_elem is None:
        return False
    cur_num_id = cur_numId_elem.get(f"{{{w}}}val", "")
    if not cur_num_id or cur_num_id == "0":
        return False  # No valid numbering

    cur_ilvl = "0"
    ilvl_elem = numPr.find(ns("w:ilvl"))
    if ilvl_elem is not None:
        cur_ilvl = ilvl_elem.get(f"{{{w}}}val", "0")

    # Use provided num_id or auto-assign new one
    if num_id_override:
        new_num_id = num_id_override
    else:
        # Auto-assign: find max numId + 1
        # First scan numbering.xml (may not be available in Phase 1) or all numPr in document.xml
        try:
            max_num_id = int(cur_num_id)
        except ValueError:
            max_num_id = 0  # non-numeric numId (e.g. "list1"), scan body for max
        for np in body.iter(ns("w:numId")):
            try:
                nid = int(np.get(f"{{{w}}}val", "0"))
                max_num_id = max(max_num_id, nid)
            except ValueError:
                pass
        new_num_id = str(max_num_id + 1)

    # Find abstractNumId corresponding to current numId (need to search in numbering.xml)
    # Temporarily read from params (Phase 2 will supplement), or use default
    abstract_num_id = params.get("_abstract_num_id")
    if not abstract_num_id:
        # Try to infer from existing files: abstractNumId is usually close to numId
        # But correct approach is to read from numbering.xml during Phase 2 processing
        # Set to same as numId for now (holds in most cases)
        abstract_num_id = cur_num_id  # fallback

    # Update paragraph numPr
    cur_numId_elem.set(f"{{{w}}}val", new_num_id)

    # Store parameters needed for Phase 2
    params["num_id"] = new_num_id
    params["ilvl"] = cur_ilvl
    params["_abstract_num_id"] = abstract_num_id
    params["_original_num_id"] = cur_num_id

    return True


# ── Phase 2.3: Hyperlink ─────────────────────────────────

def _do_add_hyperlink(para_elem: ET.Element, params: dict) -> bool:
    """Add hyperlink"""
    w = NAMESPACES["w"]
    r_ns = NAMESPACES["r"]
    url = params.get("url", "")
    text = params.get("text", url)

    # Generate rId
    r_id = params.get("r_id", "rLink1")

    hyper = ET.SubElement(para_elem, f"{{{w}}}hyperlink")
    hyper.set(f"{{{r_ns}}}id", r_id)

    r = ET.SubElement(hyper, f"{{{w}}}r")
    t = ET.SubElement(r, f"{{{w}}}t")
    t.text = text
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    # Add hyperlink style to run
    rPr = ET.SubElement(r, f"{{{w}}}rPr")
    rStyle = ET.SubElement(rPr, f"{{{w}}}rStyle")
    rStyle.set(f"{{{w}}}val", "Hyperlink")

    return True


def _do_remove_hyperlink(para_elem: ET.Element, params: dict) -> bool:
    """Remove hyperlink (keep text)"""
    w = NAMESPACES["w"]
    hyperlink_index = params.get("hyperlink_index", 0)

    hyperlinks = para_elem.findall(ns("w:hyperlink"))
    if hyperlink_index >= len(hyperlinks):
        return False

    hyper = hyperlinks[hyperlink_index]
    parent = para_elem

    # Move runs out of hyperlink
    idx = list(parent).index(hyper)
    for child in list(hyper):
        parent.insert(idx, child)
        idx += 1
    parent.remove(hyper)

    return True


def _do_set_hyperlink(para_elem: ET.Element, params: dict) -> bool:
    """Modify hyperlink"""
    w = NAMESPACES["w"]
    r_ns = NAMESPACES["r"]
    url = params.get("url", "")
    text = params.get("text", "")
    hyperlink_index = params.get("hyperlink_index", 0)
    r_id = params.get("r_id", "")

    hyperlinks = para_elem.findall(ns("w:hyperlink"))
    if hyperlink_index >= len(hyperlinks):
        return False

    hyper = hyperlinks[hyperlink_index]

    # Update relationship reference
    if r_id:
        hyper.set(f"{{{r_ns}}}id", r_id)
    elif url:
        # Only set r:id directly if it looks like an rId reference
        # TODO: For arbitrary URLs, the .rels file needs to be updated via files dict
        if url.startswith("rId"):
            hyper.set(f"{{{r_ns}}}id", url)
        # Otherwise, we cannot update the actual URL target from document.xml alone

    if text:
        # Update text in the first run
        for r_elem in hyper.findall(ns("w:r")):
            t_elem = r_elem.find(ns("w:t"))
            if t_elem is not None:
                t_elem.text = text
                t_elem.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                break

    return True


# ── Phase 2.4: Page Setup ────────────────────────────────

# Common paper sizes (twips). 1 inch = 1440 twips.
PAPER_SIZES = {
    "A4":       (11906, 16838),    # 210mm × 297mm
    "A3":       (16838, 23811),    # 297mm × 420mm
    "Letter":   (12240, 15840),    # 8.5" × 11"
    "Legal":    (12240, 20160),    # 8.5" × 14"
    "B5":       (10063, 14173),    # 176mm × 250mm
}


def _ensure_pgSz_consistent(pgSz: ET.Element):
    """Ensure pgSz w/h are consistent with orient attribute"""
    if pgSz is None:
        return
    w = NAMESPACES["w"]
    w_val = pgSz.get(f"{{{w}}}w")
    h_val = pgSz.get(f"{{{w}}}h")
    orient = pgSz.get(f"{{{w}}}orient", "portrait")

    if not w_val or not h_val:
        return

    w_int = int(w_val)
    h_int = int(h_val)

    # portrait: w should be the shorter side (w <= h)
    # landscape: w should be the longer side (w >= h)
    if orient == "portrait" and w_int > h_int:
        pgSz.set(f"{{{w}}}w", str(h_int))
        pgSz.set(f"{{{w}}}h", str(w_int))
    elif orient == "landscape" and w_int < h_int:
        pgSz.set(f"{{{w}}}w", str(h_int))
        pgSz.set(f"{{{w}}}h", str(w_int))


def _do_set_page_setup(body: ET.Element, params: dict) -> bool:
    """Modify sectPr (page setup)"""
    w = NAMESPACES["w"]
    # Find the last sectPr (document-level)
    sectPr = body.find(ns("w:sectPr"))
    if sectPr is None:
        # Look in last paragraph
        paras = body.findall(ns("w:p"))
        if paras:
            last_pPr = paras[-1].find(ns("w:pPr"))
            if last_pPr is not None:
                sectPr = last_pPr.find(ns("w:sectPr"))
        if sectPr is None:
            sectPr = ET.SubElement(body, f"{{{w}}}sectPr")

    # Page size
    if "page_width" in params or "page_height" in params:
        pgSz = sectPr.find(ns("w:pgSz"))
        if pgSz is None:
            pgSz = ET.SubElement(sectPr, f"{{{w}}}pgSz")
        if "page_width" in params:
            pgSz.set(f"{{{w}}}w", str(params["page_width"]))
        if "page_height" in params:
            pgSz.set(f"{{{w}}}h", str(params["page_height"]))
        if "orient" in params:
            pgSz.set(f"{{{w}}}orient", params["orient"])
        # FIX: ensure w/h match orient (WPS may write inconsistent pgSz)
        _ensure_pgSz_consistent(pgSz)

    # Orientation (independent of page size)
    if "orientation" in params:
        pgSz = sectPr.find(ns("w:pgSz"))
        if pgSz is None:
            pgSz = ET.SubElement(sectPr, f"{{{w}}}pgSz")
        orient_val = params["orientation"]
        pgSz.set(f"{{{w}}}orient", orient_val)
        # Auto-swap w/h for landscape if not explicitly set
        if orient_val == "landscape":
            cur_w = pgSz.get(f"{{{w}}}w")
            cur_h = pgSz.get(f"{{{w}}}h")
            if cur_w and cur_h and int(cur_w) < int(cur_h):
                pgSz.set(f"{{{w}}}w", cur_h)
                pgSz.set(f"{{{w}}}h", cur_w)
        # FIX: ensure w/h match orient
        _ensure_pgSz_consistent(pgSz)

    # Margins
    margin_keys = ("top", "right", "bottom", "left", "header", "footer", "gutter")
    margin_params = {k: v for k, v in params.items() if k in margin_keys}
    if margin_params:
        pgMar = sectPr.find(ns("w:pgMar"))
        if pgMar is None:
            pgMar = ET.SubElement(sectPr, f"{{{w}}}pgMar")
        for k, v in margin_params.items():
            pgMar.set(f"{{{w}}}{k}", str(v))

    # Columns
    if "columns" in params:
        cols = sectPr.find(ns("w:cols"))
        if cols is None:
            cols = ET.SubElement(sectPr, f"{{{w}}}cols")
        if isinstance(params["columns"], dict):
            for k, v in params["columns"].items():
                cols.set(f"{{{w}}}{k}", str(v))
        else:
            cols.set(f"{{{w}}}num", str(params["columns"]))

    return True


# ── Phase 3.1: Header/Footer ─────────────────────────────

def _do_set_header(body: ET.Element, params: dict) -> bool:
    """Set header (add headerReference in sectPr)"""
    w = NAMESPACES["w"]
    r_ns = NAMESPACES["r"]
    section_index = params.get("section_index", 0)
    text = params.get("text", "")
    r_id = params.get("r_id", "rHeader1")

    sectPr = _find_sectPr(body, section_index)
    if sectPr is None:
        return False

    # Add headerReference
    headerRef = ET.SubElement(sectPr, f"{{{w}}}headerReference")
    headerRef.set(f"{{{r_ns}}}id", r_id)
    headerRef.set(f"{{{w}}}type", params.get("type", "default"))

    return True


def _do_set_footer(body: ET.Element, params: dict) -> bool:
    """Set footer (add footerReference in sectPr)"""
    w = NAMESPACES["w"]
    r_ns = NAMESPACES["r"]
    section_index = params.get("section_index", 0)
    text = params.get("text", "")
    r_id = params.get("r_id", "rFooter1")

    sectPr = _find_sectPr(body, section_index)
    if sectPr is None:
        return False

    # Add footerReference
    footerRef = ET.SubElement(sectPr, f"{{{w}}}footerReference")
    footerRef.set(f"{{{r_ns}}}id", r_id)
    footerRef.set(f"{{{w}}}type", params.get("type", "default"))

    return True


def _do_add_page_number(body: ET.Element, params: dict) -> bool:
    """Add page number (add page number field in sectPr)"""
    w = NAMESPACES["w"]
    section_index = params.get("section_index", 0)
    alignment = params.get("alignment", "center")

    # Create a paragraph with PAGE field
    p = ET.Element(f"{{{w}}}p")
    pPr = ET.SubElement(p, f"{{{w}}}pPr")
    jc = ET.SubElement(pPr, f"{{{w}}}jc")
    jc.set(f"{{{w}}}val", alignment)

    r1 = ET.SubElement(p, f"{{{w}}}r")
    fldChar_begin = ET.SubElement(r1, f"{{{w}}}fldChar")
    fldChar_begin.set(f"{{{w}}}fldCharType", "begin")

    r2 = ET.SubElement(p, f"{{{w}}}r")
    instrText = ET.SubElement(r2, f"{{{w}}}instrText")
    instrText.text = " PAGE "
    instrText.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    r3 = ET.SubElement(p, f"{{{w}}}r")
    fldChar_separate = ET.SubElement(r3, f"{{{w}}}fldChar")
    fldChar_separate.set(f"{{{w}}}fldCharType", "separate")

    r4 = ET.SubElement(p, f"{{{w}}}r")
    t = ET.SubElement(r4, f"{{{w}}}t")
    t.text = "1"

    r5 = ET.SubElement(p, f"{{{w}}}r")
    fldChar_end = ET.SubElement(r5, f"{{{w}}}fldChar")
    fldChar_end.set(f"{{{w}}}fldCharType", "end")

    # FIX-003: PAGE field paragraph must be before sectPr, not after
    _append_before_sectPr(body, p)
    return True


def _do_remove_header(body: ET.Element, params: dict) -> bool:
    """Remove header (remove headerReference from sectPr)"""
    w = NAMESPACES["w"]
    r_ns = NAMESPACES["r"]
    section_index = params.get("section_index", 0)
    header_type = params.get("header_type", "default")

    sectPr = _find_sectPr(body, section_index)
    if sectPr is None:
        return False

    # Find and remove matching headerReference
    removed = False
    for ref in sectPr.findall(ns("w:headerReference")):
        ref_type = ref.get(f"{{{w}}}type", "default")
        if ref_type == header_type:
            sectPr.remove(ref)
            removed = True
            break

    return True  # Return True even if not found (idempotent)


def _do_remove_footer(body: ET.Element, params: dict) -> bool:
    """Remove footer (remove footerReference from sectPr)"""
    w = NAMESPACES["w"]
    r_ns = NAMESPACES["r"]
    section_index = params.get("section_index", 0)
    footer_type = params.get("footer_type", "default")

    sectPr = _find_sectPr(body, section_index)
    if sectPr is None:
        return False

    # Find and remove matching footerReference
    removed = False
    for ref in sectPr.findall(ns("w:footerReference")):
        ref_type = ref.get(f"{{{w}}}type", "default")
        if ref_type == footer_type:
            sectPr.remove(ref)
            removed = True
            break

    return True  # Return True even if not found (idempotent)


def _do_set_run_language(para_elem: ET.Element, params: dict) -> bool:
    """Set run proofing language tags"""
    w = NAMESPACES["w"]
    run_index = params.get("_run_index")
    runs = para_elem.findall(ns("w:r"))
    if not runs:
        return False

    if run_index is not None:
        if 0 <= run_index < len(runs):
            target_runs = [runs[run_index]]
        else:
            return False
    else:
        target_runs = runs

    for r_elem in target_runs:
        rPr = r_elem.find(ns("w:rPr"))
        if rPr is None:
            rPr = ET.SubElement(r_elem, f"{{{w}}}rPr")
            r_elem.remove(rPr)
            r_elem.insert(0, rPr)

        lang = rPr.find(ns("w:lang"))
        if lang is None:
            lang = ET.SubElement(rPr, f"{{{w}}}lang")

        if "val" in params:
            lang.set(f"{{{w}}}val", params["val"])
        if "eastAsia" in params:
            lang.set(f"{{{w}}}eastAsia", params["eastAsia"])
        if "bidi" in params:
            lang.set(f"{{{w}}}bidi", params["bidi"])

    return True


def _do_set_run_border(para_elem: ET.Element, params: dict) -> bool:
    """Set run character border"""
    w = NAMESPACES["w"]
    run_index = params.get("_run_index")
    runs = para_elem.findall(ns("w:r"))
    if not runs:
        return False

    if run_index is not None:
        if 0 <= run_index < len(runs):
            target_runs = [runs[run_index]]
        else:
            return False
    else:
        target_runs = runs

    val = params.get("val", "single")
    sz = params.get("sz", "4")
    space = params.get("space", "1")
    color = params.get("color", "auto")

    for r_elem in target_runs:
        rPr = r_elem.find(ns("w:rPr"))
        if rPr is None:
            rPr = ET.SubElement(r_elem, f"{{{w}}}rPr")
            r_elem.remove(rPr)
            r_elem.insert(0, rPr)

        bdr = rPr.find(ns("w:bdr"))
        if bdr is None:
            bdr = ET.SubElement(rPr, f"{{{w}}}bdr")

        bdr.set(f"{{{w}}}val", val)
        bdr.set(f"{{{w}}}sz", sz)
        bdr.set(f"{{{w}}}space", space)
        bdr.set(f"{{{w}}}color", color)

    return True


def _do_set_paragraph_outline_level(para_elem: ET.Element, params: dict) -> bool:
    """Set paragraph outline level"""
    w = NAMESPACES["w"]
    level = params.get("level", 0)

    pPr = para_elem.find(ns("w:pPr"))
    if pPr is None:
        pPr = ET.SubElement(para_elem, f"{{{w}}}pPr")
        para_elem.remove(pPr)
        para_elem.insert(0, pPr)

    if level < 0:
        # Remove outlineLvl
        ol = pPr.find(ns("w:outlineLvl"))
        if ol is not None:
            pPr.remove(ol)
    else:
        ol = pPr.find(ns("w:outlineLvl"))
        if ol is None:
            ol = ET.SubElement(pPr, f"{{{w}}}outlineLvl")
        ol.set(f"{{{w}}}val", str(level))

    return True


def _do_set_table_cell_margin(body: ET.Element, table_id: str, params: dict,
                                tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Set table cell margins (table-level defaults)"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    w = NAMESPACES["w"]
    tblPr = tbl.find(ns("w:tblPr"))
    if tblPr is None:
        tblPr = ET.SubElement(tbl, f"{{{w}}}tblPr")
        tbl.remove(tblPr)
        tbl.insert(0, tblPr)

    # Cell margins: top/bottom/left/right/start/end
    sides = {"top", "bottom", "left", "right", "start", "end"}
    margin_params = {k: v for k, v in params.items() if k in sides}

    if not margin_params:
        return True

    tblCellMar = tblPr.find(ns("w:tblCellMar"))
    if tblCellMar is None:
        tblCellMar = ET.SubElement(tblPr, f"{{{w}}}tblCellMar")

    for side, value in margin_params.items():
        el = tblCellMar.find(ns(f"w:{side}"))
        if el is None:
            el = ET.SubElement(tblCellMar, f"{{{w}}}{side}")
        el.set(f"{{{w}}}w", str(value))
        el.set(f"{{{w}}}type", "dxa")

    return True


def _do_set_table_cell_text_direction(body: ET.Element, table_id: str,
                                        params: dict,
                                        tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Set table cell text direction (vertical text)"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    row = params.get("row", 0)
    col = params.get("col", 0)
    direction = params.get("direction", "btLr")
    w = NAMESPACES["w"]

    rows = tbl.findall(ns("w:tr"))
    if row >= len(rows):
        return False
    cells = rows[row].findall(ns("w:tc"))
    if col >= len(cells):
        return False
    tc = cells[col]

    tcPr = tc.find(ns("w:tcPr"))
    if tcPr is None:
        tcPr = ET.SubElement(tc, f"{{{w}}}tcPr")
        tc.remove(tcPr)
        tc.insert(0, tcPr)

    textDirection = tcPr.find(ns("w:textDirection"))
    if textDirection is None:
        textDirection = ET.SubElement(tcPr, f"{{{w}}}textDirection")
    textDirection.set(f"{{{w}}}val", direction)

    return True


def _do_edit_table_cell_rich_text(body: ET.Element, table_id: str,
                                    params: dict,
                                    tbl_to_elem: dict = None, resolved_tbl=None) -> bool:
    """Edit rich text content of table cell (multi-run with formatting)"""
    tbl = resolved_tbl if resolved_tbl is not None else _find_table_by_id(body, table_id, tbl_to_elem)
    if tbl is None:
        return False
    row = params.get("row", 0)
    col = params.get("col", 0)
    runs_data = params.get("runs", [])
    w = NAMESPACES["w"]

    if not runs_data:
        return True

    rows = tbl.findall(ns("w:tr"))
    if row >= len(rows):
        return False
    cells = rows[row].findall(ns("w:tc"))
    if col >= len(cells):
        return False
    tc = cells[col]

    # Preserve tcPr if exists
    tcPr = tc.find(ns("w:tcPr"))

    # Clear existing content
    for child in list(tc):
        tc.remove(child)

    # Restore tcPr
    if tcPr is not None:
        tc.insert(0, tcPr)

    # Build new paragraph with rich text runs
    p = ET.SubElement(tc, f"{{{w}}}p")
    for run_data in runs_data:
        text = run_data.get("text", "")
        r = ET.SubElement(p, f"{{{w}}}r")

        # Build rPr from run_data format keys
        fmt_keys = {"bold", "italic", "underline", "font_ascii", "font_east_asia",
                     "font_size", "color", "strike", "highlight", "caps", "small_caps"}
        has_fmt = any(k in run_data for k in fmt_keys)

        if has_fmt:
            rPr = ET.SubElement(r, f"{{{w}}}rPr")
            _apply_run_format_props(rPr, run_data, w)

        t = ET.SubElement(r, f"{{{w}}}t")
        t.text = text
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    return True


def _find_sectPr(body: ET.Element, section_index: int = 0) -> Optional[ET.Element]:
    """Find sectPr for specified section"""
    # Look in paragraphs first
    count = 0
    for p in body.findall(ns("w:p")):
        pPr = p.find(ns("w:pPr"))
        if pPr is not None:
            sectPr = pPr.find(ns("w:sectPr"))
            if sectPr is not None:
                if count == section_index:
                    return sectPr
                count += 1

    # Last resort: body-level sectPr
    if section_index <= count:
        sectPr = body.find(ns("w:sectPr"))
        return sectPr

    return None


# ── Phase 3.2: Comments ──────────────────────────────────

def _do_add_comment(para_elem: ET.Element, params: dict) -> bool:
    """Add comment marker to paragraph (actual comment content in comments.xml)"""
    w = NAMESPACES["w"]
    text = params.get("text", "")
    author = params.get("author", "")
    comment_id = params.get("comment_id", "0")

    # Add commentRangeStart
    rangeStart = ET.SubElement(para_elem, f"{{{w}}}commentRangeStart")
    rangeStart.set(f"{{{w}}}id", comment_id)

    # Add commentRangeEnd + commentReference run at end
    rangeEnd = ET.SubElement(para_elem, f"{{{w}}}commentRangeEnd")
    rangeEnd.set(f"{{{w}}}id", comment_id)

    r = ET.SubElement(para_elem, f"{{{w}}}r")
    rPr = ET.SubElement(r, f"{{{w}}}rPr")
    rStyle = ET.SubElement(rPr, f"{{{w}}}rStyle")
    rStyle.set(f"{{{w}}}val", "CommentReference")
    commentRef = ET.SubElement(r, f"{{{w}}}commentReference")
    commentRef.set(f"{{{w}}}id", comment_id)

    return True


def _do_remove_comment(body: ET.Element, comment_id: str) -> bool:
    """Remove comment marker"""
    w = NAMESPACES["w"]
    removed = False

    for tag_name in ("commentRangeStart", "commentRangeEnd", "commentReference"):
        for elem in list(body.iter(ns(f"w:{tag_name}"))):
            if elem.get(f"{{{w}}}id") == comment_id:
                parent = _find_parent(body, elem)
                if parent is not None:
                    parent.remove(elem)
                    removed = True

    # Also remove the run containing commentReference
    for r_elem in list(body.findall(f".//{ns('w:r')}")):
        for ref in r_elem.findall(ns("w:commentReference")):
            if ref.get(f"{{{w}}}id") == comment_id:
                parent = _find_parent(body, r_elem)
                if parent is not None:
                    parent.remove(r_elem)
                    removed = True

    return removed


# ── Phase 3.3: Footnotes ─────────────────────────────────

def _do_add_footnote(para_elem: ET.Element, params: dict) -> bool:
    """Add footnote reference marker"""
    w = NAMESPACES["w"]
    text = params.get("text", "")
    footnote_id = params.get("footnote_id", "1")

    # Add footnoteReference run
    r = ET.SubElement(para_elem, f"{{{w}}}r")
    rPr = ET.SubElement(r, f"{{{w}}}rPr")
    rStyle = ET.SubElement(rPr, f"{{{w}}}rStyle")
    rStyle.set(f"{{{w}}}val", "FootnoteReference")

    footnoteRef = ET.SubElement(r, f"{{{w}}}footnoteReference")
    footnoteRef.set(f"{{{w}}}id", footnote_id)

    return True


def _do_remove_footnote(body: ET.Element, footnote_id: str) -> bool:
    """Remove footnote: remove footnoteReference run from paragraph"""
    w = NAMESPACES["w"]
    # Extract numeric ID from "fn-X" format
    fn_id = footnote_id.replace("fn-", "") if footnote_id.startswith("fn-") else footnote_id

    removed = False
    # Remove footnoteReference runs from all paragraphs
    for r_elem in list(body.findall(f".//{ns('w:r')}")):
        for ref in r_elem.findall(ns("w:footnoteReference")):
            if ref.get(f"{{{w}}}id") == fn_id:
                parent = _find_parent(body, r_elem)
                if parent is not None:
                    parent.remove(r_elem)
                    removed = True
    return removed


# ── Phase 3.3b: Endnotes ─────────────────────────────────

def _do_add_endnote(para_elem: ET.Element, params: dict) -> bool:
    """Add endnote reference marker"""
    w = NAMESPACES["w"]
    endnote_id = params.get("endnote_id", "1")

    # Add endnoteReference run
    r = ET.SubElement(para_elem, f"{{{w}}}r")
    rPr = ET.SubElement(r, f"{{{w}}}rPr")
    rStyle = ET.SubElement(rPr, f"{{{w}}}rStyle")
    rStyle.set(f"{{{w}}}val", "EndnoteReference")

    endnoteRef = ET.SubElement(r, f"{{{w}}}endnoteReference")
    endnoteRef.set(f"{{{w}}}id", endnote_id)

    return True


def _do_remove_endnote(body: ET.Element, endnote_id: str) -> bool:
    """Remove endnote: remove endnoteReference run from paragraph"""
    w = NAMESPACES["w"]
    en_id = endnote_id.replace("en-", "") if endnote_id.startswith("en-") else endnote_id

    removed = False
    for r_elem in list(body.findall(f".//{ns('w:r')}")):
        for ref in r_elem.findall(ns("w:endnoteReference")):
            if ref.get(f"{{{w}}}id") == en_id:
                parent = _find_parent(body, r_elem)
                if parent is not None:
                    parent.remove(r_elem)
                    removed = True
    return removed


# ── Phase 3.4: Bookmarks ─────────────────────────────────

def _do_add_bookmark(para_elem: ET.Element, params: dict) -> bool:
    """Add bookmark"""
    w = NAMESPACES["w"]
    bookmark_name = params.get("bookmark_name", "bookmark1")
    bookmark_id = params.get("bookmark_id", "0")

    # Add bookmarkStart
    bmStart = ET.SubElement(para_elem, f"{{{w}}}bookmarkStart")
    bmStart.set(f"{{{w}}}id", bookmark_id)
    bmStart.set(f"{{{w}}}name", bookmark_name)

    # Add bookmarkEnd
    bmEnd = ET.SubElement(para_elem, f"{{{w}}}bookmarkEnd")
    bmEnd.set(f"{{{w}}}id", bookmark_id)

    return True


def _do_remove_bookmark(body: ET.Element, params: dict) -> bool:
    """Remove bookmark"""
    w = NAMESPACES["w"]
    bookmark_name = params.get("bookmark_name", "")

    removed = False
    removed_ids = []
    # First pass: find and remove matching bookmarkStart elements, record their IDs
    for elem in list(body.iter(ns("w:bookmarkStart"))):
        if elem.get(f"{{{w}}}name") == bookmark_name:
            bm_id = elem.get(f"{{{w}}}id", "")
            parent = _find_parent(body, elem)
            if parent is not None:
                parent.remove(elem)
                removed = True
                if bm_id:
                    removed_ids.append(bm_id)

    # Second pass: remove bookmarkEnd elements with matching IDs
    for bm_id in removed_ids:
        for elem in list(body.iter(ns("w:bookmarkEnd"))):
            if elem.get(f"{{{w}}}id") == bm_id:
                parent = _find_parent(body, elem)
                if parent is not None:
                    parent.remove(elem)
                    removed = True

    return removed


# ── Phase 3.5: TOC ───────────────────────────────────────

def _do_add_toc(body: ET.Element, position: str, params: dict, id_to_index: dict, id_to_elem: dict = None) -> bool:
    """Insert table of contents (TOC field code)"""
    w = NAMESPACES["w"]
    outline_levels = params.get("outline_levels", "1-3")

    # Create TOC paragraph
    p = ET.Element(f"{{{w}}}p")
    pPr = ET.SubElement(p, f"{{{w}}}pPr")

    # Field begin
    r1 = ET.SubElement(p, f"{{{w}}}r")
    fldChar1 = ET.SubElement(r1, f"{{{w}}}fldChar")
    fldChar1.set(f"{{{w}}}fldCharType", "begin")

    # Field instruction
    r2 = ET.SubElement(p, f"{{{w}}}r")
    instrText = ET.SubElement(r2, f"{{{w}}}instrText")
    instrText.text = f' TOC \\o "{outline_levels}" \\h \\z \\u '
    instrText.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    # Field separate
    r3 = ET.SubElement(p, f"{{{w}}}r")
    fldChar2 = ET.SubElement(r3, f"{{{w}}}fldChar")
    fldChar2.set(f"{{{w}}}fldCharType", "separate")

    # Placeholder text
    r4 = ET.SubElement(p, f"{{{w}}}r")
    t = ET.SubElement(r4, f"{{{w}}}t")
    t.text = "[Table of Contents]"

    # Field end
    r5 = ET.SubElement(p, f"{{{w}}}r")
    fldChar3 = ET.SubElement(r5, f"{{{w}}}fldChar")
    fldChar3.set(f"{{{w}}}fldCharType", "end")

    return _insert_at_position(body, p, position, id_to_index, id_to_elem)


def _do_refresh_toc(body: ET.Element, params: dict) -> bool:
    """Refresh TOC (update field instruction text)"""
    w = NAMESPACES["w"]
    update_instr = params.get("update_instr")

    for instrText in body.iter(ns("w:instrText")):
        text = (instrText.text or "").strip()
        if text.startswith("TOC"):
            if update_instr:
                instrText.text = update_instr
                instrText.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            return True
    return False


# ── Phase 3.6: Section Breaks ─────────────────────────────

def _do_add_section_break(body: ET.Element, params: dict, para_idx: Optional[int] = None) -> bool:
    """Add section break"""
    w = NAMESPACES["w"]
    break_type = params.get("break_type", "nextPage")

    if para_idx is not None:
        paras = body.findall(ns("w:p"))
        if 0 <= para_idx < len(paras):
            p = paras[para_idx]
            pPr = p.find(ns("w:pPr"))
            if pPr is None:
                pPr = ET.SubElement(p, f"{{{w}}}pPr")
                p.remove(pPr)
                p.insert(0, pPr)
            sectPr = ET.SubElement(pPr, f"{{{w}}}sectPr")
            sectPr.set(f"{{{w}}}type", break_type)
            return True

    # Fallback: append new paragraph with section break
    p = ET.Element(f"{{{w}}}p")
    pPr = ET.SubElement(p, f"{{{w}}}pPr")
    sectPr = ET.SubElement(pPr, f"{{{w}}}sectPr")
    sectPr.set(f"{{{w}}}type", break_type)
    body.append(p)
    return True


def _do_remove_section_break(body: ET.Element, params: dict,
                              para_elem: ET.Element = None) -> bool:
    """Remove section break (remove sectPr from paragraph pPr, cannot remove body-level sectPr)"""
    w = NAMESPACES["w"]

    if para_elem is not None:
        # Locate by target_id: directly delete sectPr in paragraph pPr
        pPr = para_elem.find(ns("w:pPr"))
        if pPr is not None:
            sectPr = pPr.find(ns("w:sectPr"))
            if sectPr is not None:
                pPr.remove(sectPr)
                return True
        return False

    # Locate by section_index
    section_index = params.get("section_index", 0)
    count = 0
    for p in body.findall(ns("w:p")):
        pPr = p.find(ns("w:pPr"))
        if pPr is not None:
            sectPr = pPr.find(ns("w:sectPr"))
            if sectPr is not None:
                if count == section_index:
                    pPr.remove(sectPr)
                    return True
                count += 1

    # Do not delete body-level sectPr (last section cannot be deleted)
    return False


def _rescale_images_for_columns(body: ET.Element, sectPr: ET.Element,
                                 num_cols: int, col_space_twips: int):
    """Auto-rescale images in a section to fit within column width.

    When multi-column layout is applied, images wider than the column
    width are proportionally scaled down to fit (with 5% margin).
    """
    w = NAMESPACES["w"]
    wp = NAMESPACES["wp"]

    # 1. Determine which paragraphs belong to this section
    paras = body.findall(ns("w:p"))
    prev = 0
    target_range = None

    for i, p in enumerate(paras):
        pPr = p.find(ns("w:pPr"))
        if pPr is not None:
            sp = pPr.find(ns("w:sectPr"))
            if sp is not None:
                if sp is sectPr:
                    target_range = (prev, i)
                prev = i + 1

    # If not found in inline, check if it's the final body sectPr
    if target_range is None:
        final_sp = body.find(ns("w:sectPr"))
        if final_sp is not None and final_sp is sectPr:
            target_range = (prev, len(paras))

    if target_range is None:
        return

    # 2. Calculate column width in EMU
    pgSz = sectPr.find(ns("w:pgSz"))
    pgMar = sectPr.find(ns("w:pgMar"))
    if pgSz is None:
        # Try to find from another section
        for sp_tag in body.iter(ns("w:sectPr")):
            candidate = sp_tag.find(ns("w:pgSz"))
            if candidate is not None:
                pgSz = candidate
                break
        if pgSz is None:
            return
    page_w = int(pgSz.get(f"{{{w}}}w", "11906"))
    margin_l = int(pgMar.get(f"{{{w}}}left", "1440")) if pgMar is not None else 1440
    margin_r = int(pgMar.get(f"{{{w}}}right", "1440")) if pgMar is not None else 1440
    content_w_twips = page_w - margin_l - margin_r
    col_w_twips = (content_w_twips - col_space_twips * (num_cols - 1)) / num_cols
    col_w_emu = col_w_twips * 635  # twips → EMU

    # 3. Scan images in section paragraphs and rescale if needed
    rescaled = 0
    for pidx in range(target_range[0], target_range[1] + 1):
        if pidx >= len(paras):
            break
        p = paras[pidx]
        for drawing in p.iter(f"{{{wp}}}inline"):
            extent = drawing.find(f"{{{wp}}}extent")
            if extent is None:
                continue
            cx = int(extent.get("cx", "0"))
            cy = int(extent.get("cy", "0"))
            if cx <= 0 or cy <= 0:
                continue
            if cx > col_w_emu:
                scale = (col_w_emu * 0.95) / cx
                extent.set("cx", str(int(cx * scale)))
                extent.set("cy", str(int(cy * scale)))
                rescaled += 1

    if rescaled > 0:
        print(f"  Columns: rescaled {rescaled} image(s) to fit {num_cols}-col layout")


def _do_set_section_properties(body: ET.Element, params: dict) -> bool:
    """Modify section properties"""
    w = NAMESPACES["w"]
    section_index = params.get("section_index", 0)
    sectPr = _find_sectPr(body, section_index)
    if sectPr is None:
        return False

    # Delegate to common property setting
    if "page_width" in params or "page_height" in params or "orient" in params:
        pgSz = sectPr.find(ns("w:pgSz"))
        if pgSz is None:
            pgSz = ET.SubElement(sectPr, f"{{{w}}}pgSz")
        for k in ("page_width", "page_height", "orient"):
            if k in params:
                attr = {"page_width": "w", "page_height": "h", "orient": "orient"}[k]
                pgSz.set(f"{{{w}}}{attr}", str(params[k]))

    margin_keys = ("top", "right", "bottom", "left", "header", "footer", "gutter")
    margin_params = {k: v for k, v in params.items() if k in margin_keys}
    if margin_params:
        pgMar = sectPr.find(ns("w:pgMar"))
        if pgMar is None:
            pgMar = ET.SubElement(sectPr, f"{{{w}}}pgMar")
        for k, v in margin_params.items():
            pgMar.set(f"{{{w}}}{k}", str(v))

    # Section type
    if "type" in params:
        sectPr.set(f"{{{w}}}type", params["type"])

    # Columns — with automatic image rescaling to fit column width
    if "columns" in params:
        cols = sectPr.find(ns("w:cols"))
        if cols is None:
            cols = ET.SubElement(sectPr, f"{{{w}}}cols")
        cols_data = params["columns"]
        if isinstance(cols_data, dict):
            for k, v in cols_data.items():
                cols.set(f"{{{w}}}{k}", str(v))
            num_cols = int(cols_data.get("num", "1"))
            col_space = int(cols_data.get("space", "708"))
        else:
            cols.set(f"{{{w}}}num", str(cols_data))
            num_cols = int(cols_data)
            col_space = 708  # default 0.5 inch

        # Auto-rescale images in this section to fit column width
        if num_cols > 1:
            _rescale_images_for_columns(body, sectPr, num_cols, col_space)

    # Document grid
    if "doc_grid" in params:
        grid = sectPr.find(ns("w:docGrid"))
        if grid is None:
            grid = ET.SubElement(sectPr, f"{{{w}}}docGrid")
        grid_data = params["doc_grid"]
        if isinstance(grid_data, dict):
            for k, v in grid_data.items():
                grid.set(f"{{{w}}}{k}", str(v))

    # Text direction (section-level)
    if "text_direction" in params:
        td = sectPr.find(ns("w:textDirection"))
        if td is None:
            td = ET.SubElement(sectPr, f"{{{w}}}textDirection")
        td.set(f"{{{w}}}val", params["text_direction"])

    return True


def _do_set_page_number_format(body: ET.Element, params: dict) -> bool:
    """Set page number format"""
    w = NAMESPACES["w"]
    section_index = params.get("section_index", 0)
    fmt = params.get("fmt", "decimal")

    sectPr = _find_sectPr(body, section_index)
    if sectPr is None:
        return False

    pgNumType = sectPr.find(ns("w:pgNumType"))
    if pgNumType is None:
        pgNumType = ET.SubElement(sectPr, f"{{{w}}}pgNumType")
    pgNumType.set(f"{{{w}}}fmt", fmt)

    if "start" in params:
        pgNumType.set(f"{{{w}}}start", str(params["start"]))

    return True


# ── Phase 3.7: Fields ─────────────────────────────────────

def _do_add_field(para_elem: ET.Element, params: dict) -> bool:
    """Insert field code"""
    w = NAMESPACES["w"]
    field_type = params.get("field_type", "")
    field_text = params.get("text", "")

    # Field begin
    r1 = ET.SubElement(para_elem, f"{{{w}}}r")
    fldChar1 = ET.SubElement(r1, f"{{{w}}}fldChar")
    fldChar1.set(f"{{{w}}}fldCharType", "begin")

    # Field instruction
    r2 = ET.SubElement(para_elem, f"{{{w}}}r")
    instrText = ET.SubElement(r2, f"{{{w}}}instrText")
    instrText.text = f" {field_type} "
    instrText.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    # Field separate
    r3 = ET.SubElement(para_elem, f"{{{w}}}r")
    fldChar2 = ET.SubElement(r3, f"{{{w}}}fldChar")
    fldChar2.set(f"{{{w}}}fldCharType", "separate")

    # Result text
    if field_text:
        r4 = ET.SubElement(para_elem, f"{{{w}}}r")
        t = ET.SubElement(r4, f"{{{w}}}t")
        t.text = field_text
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    # Field end
    r5 = ET.SubElement(para_elem, f"{{{w}}}r")
    fldChar3 = ET.SubElement(r5, f"{{{w}}}fldChar")
    fldChar3.set(f"{{{w}}}fldCharType", "end")

    return True


# ── Multi-file Edit Handlers ─────────────────────────────

def _apply_settings_edits(files: dict, edits: list[EditOp]) -> bool:
    """Process settings.xml edits"""
    settings_xml = files.get("word/settings.xml")
    if settings_xml is None:
        # Create minimal settings.xml
        w = NAMESPACES["w"]
        root = ET.Element(f"{{{w}}}settings")
        # Add required child elements
    else:
        root = ET.fromstring(settings_xml)
        ns_map = _register_all_namespaces(settings_xml)

    w = NAMESPACES["w"]
    success = True

    for edit in edits:
        if edit.action == EditAction.SET_DOC_DEFAULTS:
            # Find or create w:docDefaults
            docDefaults = root.find(ns("w:docDefaults"))
            if docDefaults is None:
                docDefaults = ET.SubElement(root, f"{{{w}}}docDefaults")

            params = edit.params
            # rPrDefault
            rPrDefault = docDefaults.find(ns("w:rPrDefault"))
            if rPrDefault is None:
                rPrDefault = ET.SubElement(docDefaults, f"{{{w}}}rPrDefault")
            rPr = rPrDefault.find(ns("w:rPr"))
            if rPr is None:
                rPr = ET.SubElement(rPrDefault, f"{{{w}}}rPr")

            if "font_name" in params:
                rFonts = rPr.find(ns("w:rFonts"))
                if rFonts is None:
                    rFonts = ET.SubElement(rPr, f"{{{w}}}rFonts")
                rFonts.set(f"{{{w}}}ascii", params["font_name"])
                rFonts.set(f"{{{w}}}hAnsi", params["font_name"])

            if "font_size" in params:
                sz = rPr.find(ns("w:sz"))
                if sz is None:
                    sz = ET.SubElement(rPr, f"{{{w}}}sz")
                sz.set(f"{{{w}}}val", str(params["font_size"]))

            # pPrDefault
            pPrDefault = docDefaults.find(ns("w:pPrDefault"))
            if pPrDefault is None:
                pPrDefault = ET.SubElement(docDefaults, f"{{{w}}}pPrDefault")

        elif edit.action == EditAction.SET_DOCUMENT_PROTECTION:
            protection_type = edit.params.get("protection_type", "read-only")
            docProtection = root.find(ns("w:documentProtection"))
            if docProtection is None:
                docProtection = ET.SubElement(root, f"{{{w}}}documentProtection")
            docProtection.set(f"{{{w}}}edit", protection_type)
            docProtection.set(f"{{{w}}}enforcement", "1")
            if "password" in edit.params:
                docProtection.set(f"{{{w}}}hash", edit.params["password"])

        elif edit.action == EditAction.SET_EVEN_ODD_HEADERS:
            enabled = edit.params.get("enabled", True)
            elem = root.find(ns("w:evenAndOddHeaders"))
            if enabled:
                if elem is None:
                    elem = ET.SubElement(root, f"{{{w}}}evenAndOddHeaders")
            else:
                if elem is not None:
                    root.remove(elem)

        elif edit.action == EditAction.SET_AUTO_HYPHENATION:
            enabled = edit.params.get("enabled", True)
            autoHyphenation = root.find(ns("w:autoHyphenation"))
            if autoHyphenation is None:
                autoHyphenation = ET.SubElement(root, f"{{{w}}}autoHyphenation")
            autoHyphenation.set(f"{{{w}}}val", "1" if enabled else "0")

        elif edit.action == EditAction.UPDATE_FIELDS:
            updateFields = root.find(ns("w:updateFields"))
            if updateFields is None:
                updateFields = ET.SubElement(root, f"{{{w}}}updateFields")
            updateFields.set(f"{{{w}}}val", "true")

    # Serialize back
    settings_output = ET.tostring(root, encoding="UTF-8", xml_declaration=True)
    files["word/settings.xml"] = _inject_missing_namespaces(settings_output, ns_map)
    return success


def _apply_styles_edits(files: dict, edits: list[EditOp]) -> bool:
    """Process styles.xml edits"""
    styles_xml = files.get("word/styles.xml")
    if styles_xml is None:
        return False

    root = ET.fromstring(styles_xml)
    ns_map = _register_all_namespaces(styles_xml)
    w = NAMESPACES["w"]

    for edit in edits:
        if edit.action == EditAction.ADD_STYLE:
            style_id = edit.target_id
            style_type = edit.params.get("style_type", "paragraph")
            base_style = edit.params.get("base_style", "")
            name = edit.params.get("name", style_id)

            # Check if style already exists
            existing = None
            for s in root.findall(ns("w:style")):
                if s.get(f"{{{w}}}styleId") == style_id:
                    existing = s
                    break

            if existing is None:
                style_elem = ET.SubElement(root, f"{{{w}}}style")
                style_elem.set(f"{{{w}}}type", style_type)
                style_elem.set(f"{{{w}}}styleId", style_id)

                name_elem = ET.SubElement(style_elem, f"{{{w}}}name")
                name_elem.set(f"{{{w}}}val", name)

                if base_style:
                    basedOn = ET.SubElement(style_elem, f"{{{w}}}basedOn")
                    basedOn.set(f"{{{w}}}val", base_style)

                # Add format properties from params
                rPr_params = {k: v for k, v in edit.params.items()
                              if k not in ("style_type", "base_style", "name")}
                if rPr_params:
                    rPr = ET.SubElement(style_elem, f"{{{w}}}rPr")
                    _apply_run_format_props(rPr, rPr_params, w)

        elif edit.action == EditAction.SET_STYLE_PROPERTIES:
            style_id = edit.target_id
            # Find existing style
            style_elem = None
            for s in root.findall(ns("w:style")):
                if s.get(f"{{{w}}}styleId") == style_id:
                    style_elem = s
                    break

            if style_elem is None:
                continue

            # Update properties
            rPr = style_elem.find(ns("w:rPr"))
            if rPr is None:
                rPr = ET.SubElement(style_elem, f"{{{w}}}rPr")
            _apply_run_format_props(rPr, edit.params, w)

            # Paragraph properties
            pPr = style_elem.find(ns("w:pPr"))
            pPr_params = {k: v for k, v in edit.params.items()
                          if k in ("alignment", "spacing_before", "spacing_after",
                                   "indentation_left", "line_spacing")}
            if pPr_params and pPr is None:
                pPr = ET.SubElement(style_elem, f"{{{w}}}pPr")
            if pPr_params:
                _do_set_paragraph_format_pPr(pPr, pPr_params)

    # Serialize
    styles_output = ET.tostring(root, encoding="UTF-8", xml_declaration=True)
    files["word/styles.xml"] = _inject_missing_namespaces(styles_output, ns_map)
    return True


def _do_set_paragraph_format_pPr(pPr: ET.Element, params: dict):
    """Helper: set paragraph format directly on pPr (for style editing)"""
    w = NAMESPACES["w"]
    if "alignment" in params:
        jc = pPr.find(ns("w:jc"))
        if jc is None:
            jc = ET.SubElement(pPr, f"{{{w}}}jc")
        jc.set(f"{{{w}}}val", params["alignment"])

    spacing_keys = {"spacing_before": "before", "spacing_after": "after", "line_spacing": "line"}
    spacing_params = {v: params[k] for k, v in spacing_keys.items() if k in params}
    if spacing_params:
        sp = pPr.find(ns("w:spacing"))
        if sp is None:
            sp = ET.SubElement(pPr, f"{{{w}}}spacing")
        for k, v in spacing_params.items():
            sp.set(f"{{{w}}}{k}", str(v))


def _apply_core_properties_edits(files: dict, edits: list[EditOp]) -> bool:
    """Process docProps/core.xml edits"""
    core_xml = files.get("docProps/core.xml")

    dc_ns = "http://purl.org/dc/elements/1.1/"
    cp_ns = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
    dcterms_ns = "http://purl.org/dc/terms/"

    if core_xml is None:
        # Create new core.xml
        root = ET.Element(f"{{{cp_ns}}}coreProperties")
        ns_map = {}
    else:
        root = ET.fromstring(core_xml)
        ns_map = _register_all_namespaces(core_xml)

    for edit in edits:
        params = edit.params
        for key, value in params.items():
            tag_map = {
                "title": f"{{{dc_ns}}}title",
                "subject": f"{{{dc_ns}}}subject",
                "creator": f"{{{dc_ns}}}creator",
                "description": f"{{{dc_ns}}}description",
                "keywords": f"{{{cp_ns}}}keywords",
                "category": f"{{{cp_ns}}}category",
            }
            if key in tag_map:
                tag = tag_map[key]
                elem = root.find(tag)
                if elem is None:
                    elem = ET.SubElement(root, tag)
                elem.text = str(value)

    # Serialize
    core_output = ET.tostring(root, encoding="UTF-8", xml_declaration=True)
    files["docProps/core.xml"] = _inject_missing_namespaces(core_output, ns_map)
    # Ensure core.xml is registered in [Content_Types].xml
    _ensure_content_type(files, "docProps/core.xml",
                         "application/vnd.openxmlformats-package.core-properties+xml")
    # Ensure relationship from .rels to core.xml
    _rels = files.get("_rels/.rels")
    if _rels:
        rels_root = ET.fromstring(_rels)
        rel_type = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"
        existing = False
        for rel in rels_root:
            if rel.get("Type") == rel_type:
                existing = True; break
        if not existing:
            # Find max rId
            max_id = 0
            rel_ns_uri = "http://schemas.openxmlformats.org/package/2006/relationships"
            for rel in rels_root.findall(f"{{{rel_ns_uri}}}Relationship"):
                rid = rel.get("Id", "")
                if rid.startswith("rId"):
                    try: max_id = max(max_id, int(rid[3:]))
                    except: pass
            new_rel = ET.SubElement(rels_root, f"{{{rel_ns_uri}}}Relationship")
            new_rel.set("Id", f"rId{max_id+1}")
            new_rel.set("Type", rel_type)
            new_rel.set("Target", "docProps/core.xml")
            files["_rels/.rels"] = ET.tostring(rels_root, encoding="UTF-8", xml_declaration=True)
    return True


def _apply_numbering_edits(files: dict, edits: list[EditOp]) -> bool:
    """Process numbering.xml edits"""
    numbering_xml = files.get("word/numbering.xml")
    w = NAMESPACES["w"]

    if numbering_xml is None:
        # Create new numbering.xml
        root = ET.Element(f"{{{w}}}numbering")
        ns_map = {}
    else:
        root = ET.fromstring(numbering_xml)
        ns_map = _register_all_namespaces(numbering_xml)

    for edit in edits:
        if edit.action == EditAction.CREATE_NUMBERING_DEFINITION:
            list_type = edit.params.get("list_type", "bullet")
            start = edit.params.get("start", 1)
            num_id = edit.params.get("num_id", "1")

            # Find max existing numId
            max_id = 0
            for num in root.findall(ns("w:num")):
                nid = int(num.get(f"{{{w}}}numId", "0"))
                max_id = max(max_id, nid)
            new_num_id = str(max_id + 1)

            # Create abstract numbering definition
            max_abs_id = 0
            for absNum in root.findall(ns("w:abstractNum")):
                aid = int(absNum.get(f"{{{w}}}abstractNumId", "0"))
                max_abs_id = max(max_abs_id, aid)
            new_abs_id = str(max_abs_id + 1)

            absNum = ET.SubElement(root, f"{{{w}}}abstractNum")
            absNum.set(f"{{{w}}}abstractNumId", new_abs_id)

            # Add multi-level type
            ml = ET.SubElement(absNum, f"{{{w}}}multiLevelType")
            ml.set(f"{{{w}}}val", "hybridMultilevel")

            # Add levels
            custom_levels = edit.params.get("levels")
            if custom_levels:
                # Enhanced: per-level configuration
                for li, lvl_cfg in enumerate(custom_levels):
                    lvl_elem = ET.SubElement(absNum, f"{{{w}}}lvl")
                    lvl_elem.set(f"{{{w}}}ilvl", str(li))

                    l_start = ET.SubElement(lvl_elem, f"{{{w}}}start")
                    l_start.set(f"{{{w}}}val", str(lvl_cfg.get("start", start)))

                    l_fmt = ET.SubElement(lvl_elem, f"{{{w}}}numFmt")
                    l_fmt.set(f"{{{w}}}val", lvl_cfg.get("numFmt", "decimal" if list_type != "bullet" else "bullet"))

                    l_text = ET.SubElement(lvl_elem, f"{{{w}}}lvlText")
                    l_text.set(f"{{{w}}}val", lvl_cfg.get("lvlText", f"%{li + 1}."))

                    l_jc = ET.SubElement(lvl_elem, f"{{{w}}}lvlJc")
                    l_jc.set(f"{{{w}}}val", "left")

                    # Indentation
                    indent_left = lvl_cfg.get("indent_left")
                    indent_hanging = lvl_cfg.get("indent_hanging")
                    if indent_left or indent_hanging:
                        pPr_lvl = ET.SubElement(lvl_elem, f"{{{w}}}pPr")
                        ind = ET.SubElement(pPr_lvl, f"{{{w}}}ind")
                        if indent_left:
                            ind.set(f"{{{w}}}left", str(indent_left))
                        if indent_hanging:
                            ind.set(f"{{{w}}}hanging", str(indent_hanging))

                    # Run properties (font)
                    font_ascii = lvl_cfg.get("font_ascii")
                    font_ea = lvl_cfg.get("font_east_asia")
                    if font_ascii or font_ea:
                        rPr_lvl = ET.SubElement(lvl_elem, f"{{{w}}}rPr")
                        rFonts = ET.SubElement(rPr_lvl, f"{{{w}}}rFonts")
                        if font_ascii:
                            rFonts.set(f"{{{w}}}ascii", font_ascii)
                        if font_ea:
                            rFonts.set(f"{{{w}}}eastAsia", font_ea)
            else:
                # Default: 3 levels with simple formatting
                for lvl in range(3):
                    lvl_elem = ET.SubElement(absNum, f"{{{w}}}lvl")
                    lvl_elem.set(f"{{{w}}}ilvl", str(lvl))
                    lvl_elem.set(f"{{{w}}}tplc", "04090001")

                    start_elem = ET.SubElement(lvl_elem, f"{{{w}}}start")
                    start_elem.set(f"{{{w}}}val", str(start))

                    numFmt = ET.SubElement(lvl_elem, f"{{{w}}}numFmt")
                    numFmt.set(f"{{{w}}}val", "bullet" if list_type == "bullet" else "decimal")

                    lvlText = ET.SubElement(lvl_elem, f"{{{w}}}lvlText")
                    lvlText.set(f"{{{w}}}val", "" if list_type == "bullet" else f"%{lvl + 1}.")

                    lvlJc = ET.SubElement(lvl_elem, f"{{{w}}}lvlJc")
                    lvlJc.set(f"{{{w}}}val", "left")

            # Create num reference
            num = ET.SubElement(root, f"{{{w}}}num")
            num.set(f"{{{w}}}numId", new_num_id)
            absNumRef = ET.SubElement(num, f"{{{w}}}abstractNumId")
            absNumRef.set(f"{{{w}}}val", new_abs_id)

        elif edit.action == EditAction.SET_PARAGRAPH_NUMBERING_RESTART:
            # Add <w:lvlOverride><w:startOverride> to a <w:num> in numbering.xml
            # This creates a new num instance referencing the same abstractNum,
            # with an override that restarts numbering at the specified value.
            restart_num_id = edit.params.get("num_id")
            start_val = str(edit.params.get("start", 1))
            ilvl = str(edit.params.get("ilvl", "0"))
            abstract_num_id = edit.params.get("_abstract_num_id")
            original_num_id = edit.params.get("_original_num_id", "")

            # If abstract_num_id not provided by Phase 1, look it up in numbering.xml
            if not abstract_num_id and original_num_id:
                for num_elem in root.findall(ns("w:num")):
                    if num_elem.get(f"{{{w}}}numId") == original_num_id:
                        abs_ref = num_elem.find(ns("w:abstractNumId"))
                        if abs_ref is not None:
                            abstract_num_id = abs_ref.get(f"{{{w}}}val", "")
                        break

            if restart_num_id and abstract_num_id:
                # Create a new <w:num> with lvlOverride
                new_num = ET.SubElement(root, f"{{{w}}}num")
                new_num.set(f"{{{w}}}numId", restart_num_id)
                absRef = ET.SubElement(new_num, f"{{{w}}}abstractNumId")
                absRef.set(f"{{{w}}}val", abstract_num_id)

                lvlOverride = ET.SubElement(new_num, f"{{{w}}}lvlOverride")
                lvlOverride.set(f"{{{w}}}ilvl", ilvl)
                startOverride = ET.SubElement(lvlOverride, f"{{{w}}}startOverride")
                startOverride.set(f"{{{w}}}val", start_val)

    # Serialize
    numbering_output = ET.tostring(root, encoding="UTF-8", xml_declaration=True)
    files["word/numbering.xml"] = _inject_missing_namespaces(numbering_output, ns_map)
    # Ensure numbering.xml is registered in [Content_Types].xml
    _ensure_content_type(files, "word/numbering.xml",
                         "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml")
    return True


def _apply_relationship_edits(files: dict, edits: list[EditOp], doc_root: ET.Element):
    """
    Process multi-file edits that depend on relationships:
    - ADD_COMMENT: create word/comments.xml + update Content_Types
    - SET_HEADER/SET_FOOTER: create header/footer XML + update rels
    - ADD_HYPERLINK: update document.xml.rels
    """
    w = NAMESPACES["w"]
    r_ns = NAMESPACES["r"]
    ct_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
    rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"

    # ── Collect edits to process ──
    comment_edits = [e for e in edits if e.action == EditAction.ADD_COMMENT]
    header_edits = [e for e in edits if e.action == EditAction.SET_HEADER]
    footer_edits = [e for e in edits if e.action == EditAction.SET_FOOTER]
    hyperlink_edits = [e for e in edits if e.action == EditAction.ADD_HYPERLINK]

    # ── 1. Comments ──
    if comment_edits:
        comments_ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        existing_comments = files.get("word/comments.xml")
        if existing_comments:
            comments_root = ET.fromstring(existing_comments)
        else:
            comments_root = ET.Element(f"{{{comments_ns}}}comments")

        for edit in comment_edits:
            cid = edit.params.get("comment_id", "0")
            author = edit.params.get("author", "")
            text = edit.params.get("text", "")

            comment = ET.SubElement(comments_root, f"{{{comments_ns}}}comment")
            comment.set(f"{{{comments_ns}}}id", cid)
            comment.set(f"{{{comments_ns}}}author", author)
            comment.set(f"{{{comments_ns}}}date", "2026-01-01T00:00:00Z")
            p = ET.SubElement(comment, f"{{{comments_ns}}}p")
            r = ET.SubElement(p, f"{{{comments_ns}}}r")
            t = ET.SubElement(r, f"{{{comments_ns}}}t")
            t.text = text
            t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

        comments_bytes = ET.tostring(comments_root, encoding="UTF-8", xml_declaration=True)
        files["word/comments.xml"] = comments_bytes
        _ensure_content_type(files, "word/comments.xml",
                             "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml")

    # ── 2. Headers ──
    if header_edits:
        rels = _load_rels(files)
        for edit in header_edits:
            r_id = edit.params.get("r_id", "rHeader1")
            text = edit.params.get("text", "")
            h_type = edit.params.get("type", "default")

            # Determine filename
            header_num = len([k for k in files if "header" in k.lower() and k.endswith(".xml")]) + 1
            header_file = f"word/header{header_num}.xml"

            # Create header XML
            header_root = ET.Element(f"{{{w}}}hdr")
            hp = ET.SubElement(header_root, f"{{{w}}}p")
            hr = ET.SubElement(hp, f"{{{w}}}r")
            ht = ET.SubElement(hr, f"{{{w}}}t")
            ht.text = text
            ht.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

            files[header_file] = ET.tostring(header_root, encoding="UTF-8", xml_declaration=True)
            _ensure_content_type(files, header_file,
                                 "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml")

            # Add relationship
            _add_relationship(rels, r_id,
                              "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
                              header_file.replace("word/", ""))

        _save_rels(files, rels)

    # ── 3. Footers ──
    if footer_edits:
        rels = _load_rels(files)
        for edit in footer_edits:
            r_id = edit.params.get("r_id", "rFooter1")
            text = edit.params.get("text", "")

            footer_num = len([k for k in files if "footer" in k.lower() and k.endswith(".xml")]) + 1
            footer_file = f"word/footer{footer_num}.xml"

            footer_root = ET.Element(f"{{{w}}}ftr")
            fp = ET.SubElement(footer_root, f"{{{w}}}p")
            fr = ET.SubElement(fp, f"{{{w}}}r")
            ft = ET.SubElement(fr, f"{{{w}}}t")
            ft.text = text
            ft.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

            files[footer_file] = ET.tostring(footer_root, encoding="UTF-8", xml_declaration=True)
            _ensure_content_type(files, footer_file,
                                 "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml")

            _add_relationship(rels, r_id,
                              "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
                              footer_file.replace("word/", ""))

        _save_rels(files, rels)

    # ── 4. Hyperlinks ──
    if hyperlink_edits:
        rels = _load_rels(files)
        for edit in hyperlink_edits:
            url = edit.params.get("url", "")
            r_id = edit.params.get("r_id", "rLink1")

            _add_relationship(rels, r_id,
                              "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
                              url, target_mode="External")

        _save_rels(files, rels)


def _load_rels(files: dict) -> ET.Element:
    """Load document.xml.rels"""
    rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    rels_xml = files.get("word/_rels/document.xml.rels")
    if rels_xml:
        return ET.fromstring(rels_xml)
    return ET.Element(f"{{{rel_ns}}}Relationships")


def _save_rels(files: dict, rels_root: ET.Element):
    """Save document.xml.rels"""
    rels_bytes = ET.tostring(rels_root, encoding="UTF-8", xml_declaration=True)
    files["word/_rels/document.xml.rels"] = rels_bytes


def _add_relationship(rels_root: ET.Element, r_id: str, rel_type: str, target: str, target_mode: str = ""):
    """Add or update a Relationship"""
    rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    # Check if r_id already exists
    for rel in rels_root.findall(f"{{{rel_ns}}}Relationship"):
        if rel.get("Id") == r_id:
            rel.set("Target", target)
            return
    # Create new
    rel = ET.SubElement(rels_root, f"{{{rel_ns}}}Relationship")
    rel.set("Id", r_id)
    rel.set("Type", rel_type)
    rel.set("Target", target)
    if target_mode:
        rel.set("TargetMode", target_mode)


def _apply_smartart_edits(files: dict, edits: list[EditOp], doc_root: ET.Element):
    """
    Process SmartArt edits: modify text content in word/diagrams/data*.xml.

    SmartArt structure in OOXML:
    - document.xml has <w:drawing> → <a:graphic> → <a:graphicData> → <dgm:relIds>
    - relIds contains r:dm (data), r:lo (layout), r:qs (quickStyle), r:cs (colors) relationship IDs
    - Actual text is in word/diagrams/dataN.xml, containing <dgm:datapoint> → <dgm:tx> → <a:bodyPr> ... <a:p> → <a:r> → <a:t>
    """
    w = NAMESPACES["w"]
    r_ns = NAMESPACES["r"]
    a_ns = NAMESPACES.get("a", "http://schemas.openxmlformats.org/openxmlformats.org/drawingml/2006/main")
    dgm_ns = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
    rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"

    body = doc_root.find(ns("w:body"))
    if body is None:
        return

    # Collect all SmartArt relIds from document.xml
    # Map: dm_rId → [(edit, datapoint_index, new_text)]
    smartart_edits_by_dm = {}

    for edit in edits:
        new_texts = edit.params.get("texts", [])
        new_text = edit.params.get("text", "")
        if not new_texts and new_text:
            new_texts = [new_text]

        if not new_texts:
            continue

        # Find the SmartArt graphic referenced by target_id
        # target_id can be "sa-000" meaning first SmartArt, "sa-001" second, etc.
        target_id = edit.target_id
        sa_index = 0
        if target_id and target_id.startswith("sa-"):
            try:
                sa_index = int(target_id.replace("sa-", ""))
            except ValueError:
                pass

        # Find the Nth SmartArt reference
        current_sa = 0
        for drawing in body.iter(ns("w:drawing")):
            for graphic in drawing.iter(f"{{{a_ns}}}graphic"):
                graphicData = graphic.find(f"{{{a_ns}}}graphicData")
                if graphicData is None:
                    continue
                for child in graphicData:
                    tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                    if tag == 'relIds':
                        if current_sa == sa_index:
                            dm_rid = child.get(f"{{{r_ns}}}dm", "")
                            if dm_rid:
                                if dm_rid not in smartart_edits_by_dm:
                                    smartart_edits_by_dm[dm_rid] = []
                                smartart_edits_by_dm[dm_rid].append((edit, new_texts))
                            break
                        current_sa += 1
                        break

    if not smartart_edits_by_dm:
        return

    # Load document.xml.rels to resolve dm_rId → file path
    rels_xml = files.get("word/_rels/document.xml.rels")
    if not rels_xml:
        return

    rels_root = ET.fromstring(rels_xml)
    rid_to_target = {}
    for rel in rels_root.findall(f"{{{rel_ns}}}Relationship"):
        rid_to_target[rel.get("Id", "")] = rel.get("Target", "")

    # For each SmartArt data file, apply text edits
    for dm_rid, edit_list in smartart_edits_by_dm.items():
        data_target = rid_to_target.get(dm_rid, "")
        if not data_target:
            continue

        # Resolve path (relative to word/)
        if not data_target.startswith("word/"):
            data_path = f"word/{data_target}"
        else:
            data_path = data_target

        data_xml = files.get(data_path)
        if not data_xml:
            continue

        try:
            data_root = ET.fromstring(data_xml)
        except ET.ParseError:
            continue

        # Find all datapoints with text content
        datapoints = []
        for dp in data_root.iter(f"{{{dgm_ns}}}datapoint"):
            # Each datapoint has <dgm:tx> containing <a:bodyPr> ... <a:p> ...
            tx = dp.find(f"{{{dgm_ns}}}tx")
            if tx is not None:
                datapoints.append(dp)

        # Apply text edits to datapoints
        for edit, new_texts in edit_list:
            for i, new_text in enumerate(new_texts):
                if i < len(datapoints):
                    dp = datapoints[i]
                    tx = dp.find(f"{{{dgm_ns}}}tx")
                    if tx is not None:
                        # Update all <a:t> elements within this datapoint's tx
                        for t_elem in tx.iter(f"{{{a_ns}}}t"):
                            t_elem.text = new_text

        # Write back modified data XML
        files[data_path] = ET.tostring(data_root, encoding="UTF-8", xml_declaration=True)


def _ensure_content_type(files: dict, part_name: str, content_type: str):
    """Ensure corresponding Override exists in [Content_Types].xml"""
    ct_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
    ct_xml = files.get("[Content_Types].xml")
    if ct_xml is None:
        return
    ct_root = ET.fromstring(ct_xml)
    # Check if Override already exists
    for override in ct_root.findall(f"{{{ct_ns}}}Override"):
        if override.get("PartName") == f"/{part_name}":
            return
    # Add Override
    override = ET.SubElement(ct_root, f"{{{ct_ns}}}Override")
    override.set("PartName", f"/{part_name}")
    override.set("ContentType", content_type)
    files["[Content_Types].xml"] = ET.tostring(ct_root, encoding="UTF-8", xml_declaration=True)


# ── Phase 2 Post-processing Helpers ──────────────────────────

def _ensure_default_content_types(files: dict):
    """FIX-006: Ensure [Content_Types].xml has Default entries for xml and rels"""
    ct_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
    ct_xml = files.get("[Content_Types].xml")
    if ct_xml is None:
        return
    ct_root = ET.fromstring(ct_xml)

    existing_defaults = {}
    for default in ct_root.findall(f"{{{ct_ns}}}Default"):
        ext = default.get("Extension", "")
        existing_defaults[ext] = default

    required = {
        "xml": "application/xml",
        "rels": "application/vnd.openxmlformats-package.relationships+xml",
        "png": "image/png",
    }
    changed = False
    for ext, ctype in required.items():
        if ext not in existing_defaults:
            default = ET.SubElement(ct_root, f"{{{ct_ns}}}Default")
            default.set("Extension", ext)
            default.set("ContentType", ctype)
            changed = True

    if changed:
        files["[Content_Types].xml"] = ET.tostring(ct_root, encoding="UTF-8", xml_declaration=True)


def _ensure_required_styles(files: dict):
    """FIX-007: Auto-complete character/paragraph styles required by docx-preview"""
    styles_xml = files.get("word/styles.xml")
    if styles_xml is None:
        return
    w_ns = NAMESPACES["w"]

    try:
        styles_root = ET.fromstring(styles_xml)
    except ET.ParseError:
        return

    # Collect existing styleIds
    existing_ids = set()
    for style in styles_root.findall(f".//{{{w_ns}}}style"):
        sid = style.get(f"{{{w_ns}}}styleId")
        if sid:
            existing_ids.add(sid)

    changed = False

    # Character styles needed for docx-preview
    char_styles = {
        "FootnoteReference": ("footnote reference", True),
        "EndnoteReference": ("endnote reference", True),
        "CommentReference": ("annotation reference", True),
        "Hyperlink": ("Hyperlink", False),
    }
    for style_id, (style_name, is_note_ref) in char_styles.items():
        if style_id not in existing_ids:
            style = ET.SubElement(styles_root, f"{{{w_ns}}}style")
            style.set(f"{{{w_ns}}}type", "character")
            style.set(f"{{{w_ns}}}styleId", style_id)
            name_elem = ET.SubElement(style, f"{{{w_ns}}}name")
            name_elem.set(f"{{{w_ns}}}val", style_name)
            basedOn = ET.SubElement(style, f"{{{w_ns}}}basedOn")
            basedOn.set(f"{{{w_ns}}}val", "DefaultParagraphFont")
            uiPriority = ET.SubElement(style, f"{{{w_ns}}}uiPriority")
            uiPriority.set(f"{{{w_ns}}}val", "99")
            ET.SubElement(style, f"{{{w_ns}}}semiHidden")
            ET.SubElement(style, f"{{{w_ns}}}unhideWhenUsed")
            # Note reference styles need superscript + small font for numbering
            if is_note_ref:
                rPr = ET.SubElement(style, f"{{{w_ns}}}rPr")
                vertAlign = ET.SubElement(rPr, f"{{{w_ns}}}vertAlign")
                vertAlign.set(f"{{{w_ns}}}val", "superscript")
                sz = ET.SubElement(rPr, f"{{{w_ns}}}sz")
                sz.set(f"{{{w_ns}}}val", "18")
            changed = True

    # TableGrid style for proper table rendering
    if "TableGrid" not in existing_ids:
        style = ET.SubElement(styles_root, f"{{{w_ns}}}style")
        style.set(f"{{{w_ns}}}type", "table")
        style.set(f"{{{w_ns}}}styleId", "TableGrid")
        name_elem = ET.SubElement(style, f"{{{w_ns}}}name")
        name_elem.set(f"{{{w_ns}}}val", "Normal Table")
        basedOn = ET.SubElement(style, f"{{{w_ns}}}basedOn")
        basedOn.set(f"{{{w_ns}}}val", "TableNormal")
        uiPriority = ET.SubElement(style, f"{{{w_ns}}}uiPriority")
        uiPriority.set(f"{{{w_ns}}}val", "39")
        hidden = ET.SubElement(style, f"{{{w_ns}}}hidden")
        tblPr = ET.SubElement(style, f"{{{w_ns}}}tblPr")
        tblStyle = ET.SubElement(tblPr, f"{{{w_ns}}}tblStyle")
        tblStyle.set(f"{{{w_ns}}}val", "TableGrid")
        tblBorders = ET.SubElement(tblPr, f"{{{w_ns}}}tblBorders")
        for border_name in ("top", "left", "bottom", "right", "insideH", "insideV"):
            border = ET.SubElement(tblBorders, f"{{{w_ns}}}{border_name}")
            border.set(f"{{{w_ns}}}val", "single")
            border.set(f"{{{w_ns}}}sz", "4")
            border.set(f"{{{w_ns}}}space", "0")
            border.set(f"{{{w_ns}}}color", "000000")
        changed = True

    if changed:
        files["word/styles.xml"] = ET.tostring(styles_root, encoding="UTF-8", xml_declaration=True)


def _ensure_xml_declarations(files: dict):
    """FIX-008: Add <?xml?> declarations to all XML files in ZIP.

    Also strips UTF-8 BOM (\ufeff) that WPS/Office may prepend to XML files
    (e.g. fontTable.xml, webSettings.xml). BOM causes lstrip() to miss the
    <?xml declaration, resulting in duplicate declarations.
    """
    import re
    for name, data in list(files.items()):
        if not name.endswith(".xml") and not name.endswith(".rels"):
            continue
        if isinstance(data, bytes):
            text = data.decode("utf-8", errors="replace")
        else:
            text = data
        # Strip leading whitespace and BOM before checking
        text = text.lstrip()
        if text.startswith("\ufeff"):
            text = text[1:]  # Remove BOM
        if not text.startswith("<?xml"):
            text = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + text
        # Always write back to ensure BOM is cleaned from all files
        files[name] = text.encode("utf-8")


def _apply_image_embed_edits(files: dict, edits: list, root: ET.Element):
    """FIX-009: Phase 2 — Embed image_data (base64) from EditOp into docx ZIP"""
    import base64
    import re

    r_ns = NAMESPACES["r"]
    rels_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    ct_ns = "http://schemas.openxmlformats.org/package/2006/content-types"

    # Collect image edits with image_data
    image_edits = [e for e in edits
                   if e.action == EditAction.ADD_IMAGE and e.params.get("image_data")]
    if not image_edits:
        return

    # Find existing max image number
    max_img_num = 0
    for name in files:
        m = re.match(r"word/media/image(\d+)", name)
        if m:
            max_img_num = max(max_img_num, int(m.group(1)))

    # Find existing max rImg number in rels
    rels_xml = files.get("word/_rels/document.xml.rels", b"")
    max_rimg_num = 0
    if rels_xml:
        rels_root = ET.fromstring(rels_xml)
        for rel in rels_root.findall(f"{{{rels_ns}}}Relationship"):
            rid = rel.get("Id", "")
            m = re.match(r"rImg(\d+)", rid)
            if m:
                max_rimg_num = max(max_rimg_num, int(m.group(1)))

    # Parse document.xml rels
    if not rels_xml:
        return
    rels_root = ET.fromstring(rels_xml)

    # Get body for finding drawing elements
    body = root.find(ns("w:body"))
    if body is None:
        return

    wp_ns = NAMESPACES["wp"]

    for edit in image_edits:
        image_data_b64 = edit.params["image_data"]
        # Strip data URL prefix if present
        if "," in image_data_b64 and image_data_b64.startswith("data:"):
            image_data_b64 = image_data_b64.split(",", 1)[1]

        try:
            image_bytes = base64.b64decode(image_data_b64)
        except Exception as e:
            print(f"Warning: failed to decode image_data: {e}")
            continue

        # Determine image number and filename
        max_img_num += 1
        img_num = max_img_num
        img_filename = f"word/media/image{img_num}.png"

        # Determine rId
        max_rimg_num += 1
        r_id = f"rImg{max_rimg_num}"

        # Write image to ZIP
        files[img_filename] = image_bytes

        # Add relationship
        rel = ET.SubElement(rels_root, f"{{{rels_ns}}}Relationship")
        rel.set("Id", r_id)
        rel.set("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image")
        rel.set("Target", f"media/image{img_num}.png")

        # Update [Content_Types].xml with png Default (handled by _ensure_default_content_types)

        # Update the drawing's blip r:embed to use the assigned rId
        # Find the paragraph that was just inserted (it should be the last one with a drawing)
        # We need to match by position — the drawing paragraph was inserted at edit.position
        # Simple approach: find all blips without a valid rId and update the next one
        a_ns = NAMESPACES["a"]
        for blip in body.iter(f"{{{a_ns}}}blip"):
            current_rid = blip.get(f"{{{r_ns}}}embed", "")
            if current_rid == "rImg1" or current_rid == edit.params.get("r_id", "rImg1"):
                # This might be ours — update it
                blip.set(f"{{{r_ns}}}embed", r_id)
                edit.params["_assigned_r_id"] = r_id
                break

    # Write updated rels
    files["word/_rels/document.xml.rels"] = ET.tostring(rels_root, encoding="UTF-8", xml_declaration=True)


def _apply_footnotes_edits(files: dict, edits: list, root: ET.Element):
    """FIX-010: Phase 2 — Create footnotes.xml (with separator + all footnote content)"""
    w_ns = NAMESPACES["w"]
    rels_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    ct_ns = "http://schemas.openxmlformats.org/package/2006/content-types"

    footnote_edits = [e for e in edits if e.action == EditAction.ADD_FOOTNOTE]
    if not footnote_edits:
        return

    # Auto-assign footnote IDs
    fn_counter = 0
    body = root.find(ns("w:body"))
    if body is None:
        return

    for edit in footnote_edits:
        fn_counter += 1
        fn_id = str(fn_counter)
        edit.params["_footnote_id"] = fn_id

        # Update footnoteReference in document.xml to match
        for fnRef in body.iter(ns("w:footnoteReference")):
            current_id = fnRef.get(f"{{{w_ns}}}id", "")
            # If it has a default/placeholder ID or matches edit, update it
            if current_id == edit.params.get("footnote_id", "1") or current_id == "1":
                fnRef.set(f"{{{w_ns}}}id", fn_id)
                break

    # Create footnotes.xml
    # Note: Don't set xmlns:w manually — ET handles it from the element tag namespace
    footnotes_root = ET.Element(f"{{{w_ns}}}footnotes")

    # Add separator (required by OOXML spec)
    sep_fn = ET.SubElement(footnotes_root, f"{{{w_ns}}}footnote")
    sep_fn.set("type", "separator")
    sep_fn.set(f"{{{w_ns}}}id", "-1")
    sep_p = ET.SubElement(sep_fn, f"{{{w_ns}}}p")
    sep_r = ET.SubElement(sep_p, f"{{{w_ns}}}r")
    sep_rPr = ET.SubElement(sep_r, f"{{{w_ns}}}rPr")
    sep_rStyle = ET.SubElement(sep_rPr, f"{{{w_ns}}}rStyle")
    sep_rStyle.set(f"{{{w_ns}}}val", "FootnoteReference")
    sep_sep = ET.SubElement(sep_r, f"{{{w_ns}}}separator")

    # Add continuationSeparator
    cont_fn = ET.SubElement(footnotes_root, f"{{{w_ns}}}footnote")
    cont_fn.set("type", "continuationSeparator")
    cont_fn.set(f"{{{w_ns}}}id", "0")
    cont_p = ET.SubElement(cont_fn, f"{{{w_ns}}}p")
    cont_r = ET.SubElement(cont_p, f"{{{w_ns}}}r")
    cont_sep = ET.SubElement(cont_r, f"{{{w_ns}}}continuationSeparator")

    # Add actual footnotes
    for edit in footnote_edits:
        fn_id = edit.params["_footnote_id"]
        text = edit.params.get("text", "")

        fn = ET.SubElement(footnotes_root, f"{{{w_ns}}}footnote")
        fn.set(f"{{{w_ns}}}id", fn_id)

        fn_p = ET.SubElement(fn, f"{{{w_ns}}}p")
        # Footnote reference marker
        fn_r1 = ET.SubElement(fn_p, f"{{{w_ns}}}r")
        fn_rPr1 = ET.SubElement(fn_r1, f"{{{w_ns}}}rPr")
        fn_rStyle1 = ET.SubElement(fn_rPr1, f"{{{w_ns}}}rStyle")
        fn_rStyle1.set(f"{{{w_ns}}}val", "FootnoteReference")
        fn_footnoteRef = ET.SubElement(fn_r1, f"{{{w_ns}}}footnoteRef")

        # Footnote text
        fn_r2 = ET.SubElement(fn_p, f"{{{w_ns}}}r")
        fn_t = ET.SubElement(fn_r2, f"{{{w_ns}}}t")
        fn_t.text = f" {text}"
        fn_t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    files["word/footnotes.xml"] = ET.tostring(footnotes_root, encoding="UTF-8", xml_declaration=True)

    # Update rels to include footnotes
    rels_xml = files.get("word/_rels/document.xml.rels", b"")
    if rels_xml:
        rels_root = ET.fromstring(rels_xml)
        # Check if footnotes rel already exists
        has_fn_rel = False
        for rel in rels_root.findall(f"{{{rels_ns}}}Relationship"):
            if "footnotes" in rel.get("Target", ""):
                has_fn_rel = True
                break
        if not has_fn_rel:
            rel = ET.SubElement(rels_root, f"{{{rels_ns}}}Relationship")
            rel.set("Id", "rFootnotes1")
            rel.set("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes")
            rel.set("Target", "footnotes.xml")
            files["word/_rels/document.xml.rels"] = ET.tostring(rels_root, encoding="UTF-8", xml_declaration=True)

    # Update [Content_Types].xml
    _ensure_content_type(files, "word/footnotes.xml",
                         "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml")


def _apply_endnotes_edits(files: dict, edits: list, root: ET.Element):
    """Phase 2 — Create endnotes.xml (with separator + all endnote content)"""
    w_ns = NAMESPACES["w"]

    endnote_edits = [e for e in edits if e.action == EditAction.ADD_ENDNOTE]
    if not endnote_edits:
        return

    # Auto-assign endnote IDs
    en_counter = 0
    body = root.find(ns("w:body"))
    if body is None:
        return

    for edit in endnote_edits:
        en_counter += 1
        en_id = str(en_counter)
        edit.params["_endnote_id"] = en_id

        # Update endnoteReference in document.xml
        for enRef in body.iter(ns("w:endnoteReference")):
            current_id = enRef.get(f"{{{w_ns}}}id", "")
            if current_id == edit.params.get("endnote_id", "1") or current_id == "1":
                enRef.set(f"{{{w_ns}}}id", en_id)
                break

    # Create endnotes.xml
    endnotes_root = ET.Element(f"{{{w_ns}}}endnotes")

    # Separator (required by OOXML spec)
    sep = ET.SubElement(endnotes_root, f"{{{w_ns}}}endnote")
    sep.set("type", "separator")
    sep.set(f"{{{w_ns}}}id", "-1")
    sep_p = ET.SubElement(sep, f"{{{w_ns}}}p")
    sep_r = ET.SubElement(sep_p, f"{{{w_ns}}}r")
    sep_rPr = ET.SubElement(sep_r, f"{{{w_ns}}}rPr")
    sep_rStyle = ET.SubElement(sep_rPr, f"{{{w_ns}}}rStyle")
    sep_rStyle.set(f"{{{w_ns}}}val", "EndnoteReference")
    ET.SubElement(sep_r, f"{{{w_ns}}}separator")

    # Continuation separator
    cont = ET.SubElement(endnotes_root, f"{{{w_ns}}}endnote")
    cont.set("type", "continuationSeparator")
    cont.set(f"{{{w_ns}}}id", "0")
    cont_p = ET.SubElement(cont, f"{{{w_ns}}}p")
    cont_r = ET.SubElement(cont_p, f"{{{w_ns}}}r")
    ET.SubElement(cont_r, f"{{{w_ns}}}continuationSeparator")

    # Actual endnotes
    for edit in endnote_edits:
        en_id = edit.params["_endnote_id"]
        text = edit.params.get("text", "")

        en = ET.SubElement(endnotes_root, f"{{{w_ns}}}endnote")
        en.set(f"{{{w_ns}}}id", en_id)

        en_p = ET.SubElement(en, f"{{{w_ns}}}p")
        # Reference marker
        en_r1 = ET.SubElement(en_p, f"{{{w_ns}}}r")
        en_rPr1 = ET.SubElement(en_r1, f"{{{w_ns}}}rPr")
        en_rStyle1 = ET.SubElement(en_rPr1, f"{{{w_ns}}}rStyle")
        en_rStyle1.set(f"{{{w_ns}}}val", "EndnoteReference")
        ET.SubElement(en_r1, f"{{{w_ns}}}endnoteRef")

        # Text
        en_r2 = ET.SubElement(en_p, f"{{{w_ns}}}r")
        en_t = ET.SubElement(en_r2, f"{{{w_ns}}}t")
        en_t.text = f" {text}"
        en_t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    files["word/endnotes.xml"] = ET.tostring(endnotes_root, encoding="UTF-8", xml_declaration=True)

    # Update rels
    rels_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    rels_xml = files.get("word/_rels/document.xml.rels", b"")
    if rels_xml:
        rels_root = ET.fromstring(rels_xml)
        has_en_rel = False
        for rel in rels_root.findall(f"{{{rels_ns}}}Relationship"):
            if "endnotes" in rel.get("Target", ""):
                has_en_rel = True
                break
        if not has_en_rel:
            rel = ET.SubElement(rels_root, f"{{{rels_ns}}}Relationship")
            rel.set("Id", "rEndnotes1")
            rel.set("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes")
            rel.set("Target", "endnotes.xml")
            files["word/_rels/document.xml.rels"] = ET.tostring(rels_root, encoding="UTF-8", xml_declaration=True)

    # Update [Content_Types].xml
    _ensure_content_type(files, "word/endnotes.xml",
                         "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml")


def _rebuild_id_to_elem(body: ET.Element) -> dict:
    """FIX-011: Build id → ET.Element reference dictionary"""
    result = {}
    paras = body.findall(ns("w:p"))
    for i, p in enumerate(paras):
        result[f"p-{i:03d}"] = p
    return result


def _rebuild_tbl_to_elem(body: ET.Element) -> dict:
    """FIX-016: Build tbl_id → ET.Element reference dictionary"""
    result = {}
    tbls = body.findall(ns("w:tbl"))
    for i, tbl in enumerate(tbls):
        result[f"tbl-{i:03d}"] = tbl
    return result


def _remove_empty_template_paragraph(body: ET.Element):
    """FIX-014: Remove empty template paragraph"""
    w_ns = NAMESPACES["w"]
    paras = body.findall(ns("w:p"))
    if not paras:
        return

    first_p = paras[0]

    # Check for meaningful content
    has_text = False
    has_drawing = False

    for t in first_p.iter(f"{{{w_ns}}}t"):
        if t.text and t.text.strip():
            has_text = True
            break

    if first_p.find(f".//{{{w_ns}}}drawing") is not None:
        has_drawing = True

    # Only remove if truly empty
    if has_text or has_drawing:
        return

    # Before removing: migrate footnote/comment references to last content paragraph
    last_content_p = None
    for p in reversed(paras[1:]):
        for t in p.iter(f"{{{w_ns}}}t"):
            if t.text and t.text.strip():
                last_content_p = p
                break
        if last_content_p is not None:
            break

    if last_content_p is not None:
        # Move footnoteReference/commentReference runs to last content paragraph
        refs_to_move = []
        for r in first_p.findall(f"{{{w_ns}}}r"):
            if (r.find(f"{{{w_ns}}}footnoteReference") is not None or
                r.find(f"{{{w_ns}}}commentReference") is not None):
                refs_to_move.append(r)
        for r in refs_to_move:
            first_p.remove(r)
            last_content_p.append(r)

        # Move standalone elements (commentRangeStart/End, bookmarkStart/End)
        for tag in ("commentRangeStart", "commentRangeEnd",
                    "bookmarkStart", "bookmarkEnd"):
            for elem in list(first_p.findall(f"{{{w_ns}}}{tag}")):
                first_p.remove(elem)
                last_content_p.append(elem)

    # Remove the empty paragraph
    body.remove(first_p)


# ── Wiki sync updates ─────────────────────────────────────────

def _update_wiki_log(wiki_dir: str, edits: list[EditOp], success_count: int, fail_count: int):
    """Append edit log to wiki/log.md"""
    import datetime
    log_path = os.path.join(wiki_dir, "log.md")
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    # Build new entry
    entry_lines = [
        f"\n## [{now}] edit\n",
        f"- Edits: {len(edits)} ({success_count} success, {fail_count} failed)",
    ]
    for edit in edits:
        action = edit.action.value
        target = edit.target_id or edit.position
        detail = ""
        if edit.action == EditAction.REPLACE_TEXT:
            old = edit.params.get("old_text", "")
            new = edit.params.get("new_text", "")
            detail = f' `{old}` → `{new}`'
        elif edit.action == EditAction.CHANGE_STYLE:
            detail = f' → {edit.params.get("new_style", "")}'
        elif edit.action == EditAction.INSERT_PARAGRAPH:
            detail = f' text="{edit.params.get("text", "")[:40]}"'
        elif edit.action == EditAction.FILL_BLANKS:
            values = edit.params.get("values", [])
            detail = f' values={values}'
        elif edit.action == EditAction.EDIT_TABLE_CELL:
            row = edit.params.get("row", "?")
            col = edit.params.get("col", "?")
            text = edit.params.get("text", "")
            detail = f' [{row},{col}] = `{text}`'
        entry_lines.append(f"  - {action} {target}{detail}")
    entry_lines.append("")

    entry = "\n".join(entry_lines)

    if os.path.exists(log_path):
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(entry)
    else:
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("# Change Log\n")
            f.write(entry)


def _update_wiki_pages(wiki_dir: str, model: DocumentModel, edits: list[EditOp], applied_edits: list[bool]):
    """Sync update wiki pages for modified paragraphs"""
    if not wiki_dir or not model:
        return

    for edit, applied in zip(edits, applied_edits):
        if not applied:
            continue

        if edit.action == EditAction.REPLACE_TEXT and edit.target_id:
            p = model.get_paragraph(edit.target_id)
            if p:
                # Update text in model
                old_text = edit.params.get("old_text", "")
                new_text = edit.params.get("new_text", "")
                p.text = p.text.replace(old_text, new_text, 1)
                # Update text in runs
                for run in p.runs:
                    if old_text in run.text:
                        run.text = run.text.replace(old_text, new_text, 1)
                        break
                # Rewrite wiki page
                page_path = os.path.join(wiki_dir, p.file_path())
                if os.path.exists(page_path):
                    with open(page_path, "w", encoding="utf-8") as f:
                        f.write(p.to_markdown())

        elif edit.action == EditAction.FILL_BLANKS and edit.target_id:
            p = model.get_paragraph(edit.target_id)
            if p:
                values = edit.params.get("values", [])
                val_idx = 0
                for run in p.runs:
                    if run.is_blank and val_idx < len(values):
                        run.text = values[val_idx]
                        run.is_blank = False
                        val_idx += 1
                # Re-concatenate full text
                p.text = "".join(r.text for r in p.runs)
                page_path = os.path.join(wiki_dir, p.file_path())
                if os.path.exists(page_path):
                    with open(page_path, "w", encoding="utf-8") as f:
                        f.write(p.to_markdown())

        elif edit.action == EditAction.CHANGE_STYLE and edit.target_id:
            p = model.get_paragraph(edit.target_id)
            if p:
                p.style_id = edit.params.get("new_style", "")
                p.build_references()
                page_path = os.path.join(wiki_dir, p.file_path())
                if os.path.exists(page_path):
                    with open(page_path, "w", encoding="utf-8") as f:
                        f.write(p.to_markdown())

        elif edit.action == EditAction.DELETE_PARAGRAPH and edit.target_id:
            p = model.get_paragraph(edit.target_id)
            if p:
                page_path = os.path.join(wiki_dir, p.file_path())
                if os.path.exists(page_path):
                    os.remove(page_path)

        # insert_paragraph is special — new paragraph has no wiki page (requires re-ingest for full attributes)
        # But we can record it in log


# ── Main entry point ────────────────────────────────────────────────

def apply_edits(
    docx_path: str,
    edits: list[EditOp],
    output_path: str,
    model: Optional[DocumentModel] = None,
    wiki_dir: str = "",
) -> bool:
    """
    Apply EditOps to docx and sync update wiki
    
    Args:
        docx_path: Original docx path
        edits: Edit operation list
        output_path: Output docx path
        model: Optional DocumentModel (for locating paragraphs by ID + syncing wiki pages)
        wiki_dir: Optional wiki directory path (when provided, updates log.md and related paragraph pages)
    
    Returns:
        True if all edits were applied successfully
    """
    # Read original docx into memory
    with open(docx_path, "rb") as f:
        docx_bytes = f.read()

    # Read all files
    files = {}
    with zipfile.ZipFile(io.BytesIO(docx_bytes), "r") as zin:
        for name in zin.namelist():
            files[name] = zin.read(name)

    # Parse document.xml
    doc_xml = files.get("word/document.xml")
    if doc_xml is None:
        raise ValueError("Invalid docx: missing word/document.xml")

    root = ET.fromstring(doc_xml)
    body = root.find(ns("w:body"))
    if body is None:
        raise ValueError("Invalid docx: missing w:body")

    # Extract all namespace declarations from original XML to prevent loss during serialization
    ns_map = _register_all_namespaces(doc_xml)

    # FIX-013: Build style name mapping (WPS templates may use numeric styleId)
    _build_style_map(files)

    # Build ID → index mapping
    id_to_index = {}
    if model:
        for p in model.paragraphs:
            try:
                idx = int(p.id.replace("p-", ""))
                id_to_index[p.id] = idx
            except ValueError:
                pass

    # FIX-011: Build element reference dictionary (unaffected by body.insert/remove)
    id_to_elem = _rebuild_id_to_elem(body)

    # FIX-016: Build table element reference dictionary
    tbl_to_elem = _rebuild_tbl_to_elem(body)

    # FIX-015: Structural actions that change paragraph positions
    _structural_actions = {
        EditAction.INSERT_PARAGRAPH, EditAction.DELETE_PARAGRAPH,
        EditAction.ADD_TABLE, EditAction.ADD_IMAGE, EditAction.ADD_TOC,
        EditAction.COPY_PARAGRAPH, EditAction.COPY_TABLE,
        EditAction.MOVE_PARAGRAPH, EditAction.SWAP_PARAGRAPH,
        EditAction.CLONE_ELEMENT,
    }

    # Apply edits, record success of each
    applied_edits = []
    success_count = 0
    for edit in edits:
        ok = _apply_single_edit(edit, root, body, id_to_index, id_to_elem, model, tbl_to_elem)
        applied_edits.append(ok)
        if ok:
            success_count += 1
            # FIX-015: additive rebuild after structural edits
            # CRITICAL: never rebuild id_to_elem from scratch (causes reversal).
            # Instead, add new paragraphs with incremental IDs, remove deleted ones.
            if edit.action in _structural_actions:
                paras = body.findall(ns("w:p"))
                existing_elems = set(id_to_elem.values())

                # Find max existing id number
                max_id = -1
                for k in id_to_elem:
                    try:
                        max_id = max(max_id, int(k.replace("p-", "")))
                    except ValueError:
                        pass
                next_id = max_id + 1

                # Add entries for new paragraphs (not yet tracked)
                for p in paras:
                    if p not in existing_elems:
                        id_to_elem[f"p-{next_id:03d}"] = p
                        next_id += 1

                # GC: remove entries for deleted paragraphs (no longer in body)
                body_set = set(id(p) for p in paras)
                stale_keys = [k for k, v in id_to_elem.items() if id(v) not in body_set]
                for k in stale_keys:
                    del id_to_elem[k]

                # Rebuild id_to_index (position-based, always fresh)
                id_to_index.clear()
                for i, p in enumerate(paras):
                    id_to_index[f"p-{i:03d}"] = i

                # FIX-016: additive rebuild for tables (same pattern as paragraphs)
                if edit.action in (EditAction.ADD_TABLE, EditAction.REMOVE_TABLE,
                                   EditAction.COPY_TABLE):
                    tbls = body.findall(ns("w:tbl"))
                    existing_tbl_elems = set(tbl_to_elem.values())

                    # Find max existing tbl id number
                    max_tbl_id = -1
                    for k in tbl_to_elem:
                        try:
                            max_tbl_id = max(max_tbl_id, int(k.replace("tbl-", "")))
                        except ValueError:
                            pass
                    next_tbl_id = max_tbl_id + 1

                    # Add entries for new tables
                    for tbl in tbls:
                        if tbl not in existing_tbl_elems:
                            tbl_to_elem[f"tbl-{next_tbl_id:03d}"] = tbl
                            next_tbl_id += 1

                    # GC: remove entries for deleted tables
                    tbl_body_set = set(id(t) for t in tbls)
                    stale_tbls = [k for k, v in tbl_to_elem.items() if id(v) not in tbl_body_set]
                    for k in stale_tbls:
                        del tbl_to_elem[k]
        else:
            print(f"Warning: edit failed: {edit}")

    fail_count = len(edits) - success_count

    # ── Phase 2: Multi-file edits (settings.xml, styles.xml, core.xml, etc.) ──

    # Settings-level actions
    _settings_actions = {
        EditAction.SET_DOC_DEFAULTS, EditAction.SET_DOCUMENT_PROTECTION,
        EditAction.SET_EVEN_ODD_HEADERS, EditAction.SET_AUTO_HYPHENATION,
        EditAction.UPDATE_FIELDS,
    }
    settings_edits = [e for e in edits if e.action in _settings_actions]
    if settings_edits:
        ok = _apply_settings_edits(files, settings_edits)
        if ok:
            success_count += len(settings_edits) - sum(1 for a, _ in zip(applied_edits, settings_edits) if not a)
        for i, e in enumerate(edits):
            if e.action in _settings_actions:
                applied_edits[i] = True

    # Styles actions
    _styles_actions = {EditAction.ADD_STYLE, EditAction.SET_STYLE_PROPERTIES}
    styles_edits = [e for e in edits if e.action in _styles_actions]
    if styles_edits:
        ok = _apply_styles_edits(files, styles_edits)
        for i, e in enumerate(edits):
            if e.action in _styles_actions:
                applied_edits[i] = ok

    # Core properties
    _core_actions = {EditAction.SET_CORE_PROPERTIES}
    core_edits = [e for e in edits if e.action in _core_actions]
    if core_edits:
        ok = _apply_core_properties_edits(files, core_edits)
        for i, e in enumerate(edits):
            if e.action in _core_actions:
                applied_edits[i] = ok

    # Numbering definitions
    _num_actions = {EditAction.CREATE_NUMBERING_DEFINITION,
                    EditAction.SET_PARAGRAPH_NUMBERING_RESTART}
    num_edits = [e for e in edits if e.action in _num_actions]
    if num_edits:
        ok = _apply_numbering_edits(files, num_edits)
        for i, e in enumerate(edits):
            if e.action in _num_actions:
                applied_edits[i] = ok

    # Relationship-dependent edits (comments, headers, footers, hyperlinks)
    _rel_actions = {
        EditAction.ADD_COMMENT,
        EditAction.SET_HEADER, EditAction.SET_FOOTER,
        EditAction.ADD_HYPERLINK,
    }
    rel_edits = [e for e in edits if e.action in _rel_actions]
    if rel_edits:
        _apply_relationship_edits(files, rel_edits, root)
        for i, e in enumerate(edits):
            if e.action in _rel_actions:
                applied_edits[i] = True

    # SmartArt edits (modify word/diagrams/data*.xml)
    _sa_actions = {EditAction.EDIT_SMARTART}
    sa_edits = [e for e in edits if e.action in _sa_actions]
    if sa_edits:
        _apply_smartart_edits(files, sa_edits, root)
        for i, e in enumerate(edits):
            if e.action in _sa_actions:
                applied_edits[i] = True

    # ── Phase 2.5: Post-processing fixes (FIX-006 through FIX-014) ──

    # FIX-014: Remove empty template paragraph (p-000) if it's empty and first in body
    # When creating from blank.docx, p-000 is an empty placeholder that shouldn't appear in output.
    # But only remove it if it's truly empty (no meaningful content beyond structural elements).
    _remove_empty_template_paragraph(body)

    # FIX-009: Embed image_data from EditOps
    _apply_image_embed_edits(files, edits, root)

    # FIX-010: Create footnotes.xml if any ADD_FOOTNOTE edits
    _apply_footnotes_edits(files, edits, root)

    # Create endnotes.xml if any ADD_ENDNOTE edits
    _apply_endnotes_edits(files, edits, root)

    # FIX-006: Ensure xml/rels Default entries in [Content_Types].xml
    _ensure_default_content_types(files)

    # FIX-007: Ensure required character/table styles
    _ensure_required_styles(files)

    # FIX-008: Add XML declarations to all XML files
    _ensure_xml_declarations(files)

    # Recount
    success_count = sum(1 for a in applied_edits if a)
    fail_count = len(edits) - success_count

    # Serialize modified XML
    modified_xml_bytes = ET.tostring(root, encoding="UTF-8", xml_declaration=True)
    modified_xml_bytes = _inject_missing_namespaces(modified_xml_bytes, ns_map)
    files["word/document.xml"] = modified_xml_bytes

    # ── XML Validation Gate ──
    # Validate all XML parts for well-formedness and structural integrity
    # before writing the ZIP. Catches stray characters, unclosed tags,
    # broken bookmarks/comments, duplicate drawing IDs, etc.
    from validate_xml import validate_and_report
    xml_ok = validate_and_report(files, verbose=True)
    if not xml_ok:
        print("Warning: XML validation detected errors — docx may be corrupted")

    # Repackage as docx
    # Ensure output directory exists (OPFS lazy mount may not have parent dir)
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in files.items():
            zout.writestr(name, data)

    # ── Sync update wiki ──
    if wiki_dir and os.path.isdir(wiki_dir):
        # 1. Update log.md
        _update_wiki_log(wiki_dir, edits, success_count, fail_count)
        # 2. Update wiki pages for modified paragraphs
        if model:
            _update_wiki_pages(wiki_dir, model, edits, applied_edits)

    return fail_count == 0


def _validate_edit(edit: EditOp) -> str | None:
    """
    Validate EditOp parameter completeness. Returns None if passed, returns error description string if failed.

    When LLM passes incorrect parameters, this function provides clear error hints and correct usage,
    facilitating LLM self-debugging and parameter correction.
    """
    a = edit.action
    p = edit.params
    t = edit.target_id

    def _need(*keys):
        missing = [k for k in keys if k not in p or p[k] is None]
        if missing:
            example_params = {k: f"<{k}>" for k in keys}
            return f"Missing required param: {missing}。Correct usage: params={example_params}"
        return None

    def _need_target():
        """Check that either target_id or target_text is provided."""
        if t:
            return None
        if p and p.get("target_text"):
            return None
        return 'Missing required param: target_id or target_text. Correct usage: target_id="p-002" or params={"target_text": "paragraph text fragment"}'

    if a == EditAction.REPLACE_TEXT:
        return _need("old_text", "new_text")
    elif a == EditAction.FILL_BLANKS:
        if "values" not in p or not isinstance(p["values"], list):
            return 'Missing required param: ["values"]。Correct usage: params={"values": ["value1", "value2"]}'
    elif a == EditAction.EDIT_TABLE_CELL:
        err = _need("row", "col", "text")
        if err: return err
        # row/col should be integers
        try:
            int(p["row"]); int(p["col"])
        except (ValueError, TypeError):
            return f'Parameter type error: row and col must be integers. Current row={p["row"]!r}, col={p["col"]!r}。Correct usage: params={{"row": 1, "col": 2, "text": "content"}}'
    elif a == EditAction.INSERT_PARAGRAPH:
        pass  # FIX-012: position optional, defaults to before sectPr
    elif a == EditAction.DELETE_PARAGRAPH:
        err = _need_target()  # FIX-017: accept target_text as alternative
        if err: return err
    elif a == EditAction.CHANGE_STYLE:
        return _need("new_style")
    elif a == EditAction.ADD_TABLE:
        err = _need("rows", "cols")
        if err: return err
        # FIX-012: position optional, defaults to before sectPr
    elif a == EditAction.ADD_TABLE_ROW:
        if "row_index" not in p and "index" not in p:
            return 'Missing required param: row_index。Correct usage: params={"row_index": 2, "count": 1}'
        # Alias compatibility: LLM may use index instead of row_index
        if "row_index" not in p and "index" in p:
            p["row_index"] = p["index"]
    elif a == EditAction.REMOVE_TABLE_ROW:
        if "row_index" not in p and "index" not in p:
            return 'Missing required param: row_index。Correct usage: params={"row_index": 3}'
        if "row_index" not in p and "index" in p:
            p["row_index"] = p["index"]
    elif a == EditAction.ADD_TABLE_COLUMN:
        if "col_index" not in p and "index" not in p:
            return 'Missing required param: col_index。Correct usage: params={"col_index": 2}'
        if "col_index" not in p and "index" in p:
            p["col_index"] = p["index"]
    elif a == EditAction.REMOVE_TABLE_COLUMN:
        if "col_index" not in p and "index" not in p:
            return 'Missing required param: col_index。Correct usage: params={"col_index": 3}'
        if "col_index" not in p and "index" in p:
            p["col_index"] = p["index"]
    elif a == EditAction.MERGE_CELLS:
        return _need("row_start", "col_start", "row_end", "col_end")
    elif a == EditAction.SPLIT_CELLS:
        return _need("row", "col")
    elif a == EditAction.FIND_AND_REPLACE:
        return _need("old_text", "new_text")
    elif a == EditAction.ADD_BREAK:
        if not t and not p.get("target_text", ""):
            return 'Missing required param: target_id or target_text. Correct usage: target_id="p-005" or params={"target_text": "page break after this paragraph"}'
    elif a == EditAction.ADD_HYPERLINK:
        return _need("url")
    elif a == EditAction.SET_HEADER:
        return _need("text")
    elif a == EditAction.SET_FOOTER:
        return _need("text")
    elif a == EditAction.REMOVE_HEADER:
        pass  # section_index + header_type have defaults
    elif a == EditAction.REMOVE_FOOTER:
        pass  # section_index + footer_type have defaults
    elif a == EditAction.ADD_COMMENT:
        return _need("text")
    elif a == EditAction.ADD_BOOKMARK:
        return _need("bookmark_name")
    elif a == EditAction.REMOVE_FOOTNOTE:
        if not t:
            return 'Missing required param: target_id。Correct usage: target_id="fn-0"'
    elif a == EditAction.REMOVE_ENDNOTE:
        if not t:
            return 'Missing required param: target_id。Correct usage: target_id="en-0"'
    elif a == EditAction.SWAP_PARAGRAPH:
        if "target_id_2" not in p:
            return 'Missing required param: target_id_2。Correct usage: params={"target_id_2": "p-013"}'
    elif a == EditAction.MOVE_PARAGRAPH:
        if not edit.position:
            return 'Missing required param: position。Correct usage: position="after:p-014"'
    elif a == EditAction.ADD_IMAGE:
        # FIX-012: position optional, defaults to before sectPr
        pass
    # ── Missing from original ──
    elif a == EditAction.REMOVE_TABLE:
        if not t:
            return 'Missing required param: target_id (table_id)。Correct usage: target_id="tbl-000"'
    elif a == EditAction.ADD_STYLE:
        if not t:
            return 'Missing required param: target_id (style_id)。Correct usage: target_id="MyStyle", params={"name": "My Style", "style_type": "paragraph"}'
    elif a == EditAction.SET_STYLE_PROPERTIES:
        if not t:
            return 'Missing required param: target_id (style_id)。Correct usage: target_id="Normal", params={"font_size": "28", "bold": true}'
        if not p:
            return 'Missing required param: params needs at least one property in。Correct usage: params={"font_size": "28"}'
    elif a == EditAction.REMOVE_COMMENT:
        if not t:
            return 'Missing required param: target_id (comment_id)。Correct usage: target_id="cmt-000"'
    elif a == EditAction.ADD_SECTION_BREAK:
        if not t and not edit.position:
            return 'Missing required param: target_id or position. Correct usage: target_id="p-003", params={"break_type": "page"}'
    elif a == EditAction.REMOVE_SECTION_BREAK:
        pass  # target_id or section_index optional (has default value)
    elif a == EditAction.SET_DOC_DEFAULTS:
        if not p:
            return 'Missing required param: params needs at least one property in。Correct usage: params={"font_name": "Arial", "font_size": "22"}'
    # ── Phase 1.1-1.2: Formatting ──
    elif a == EditAction.SET_PARAGRAPH_FORMAT:
        if not p:
            return 'Missing required param: params needs at least one format property in。Correct usage: params={"alignment": "center", "spacing_before": "200"}'
        err = _need_target()
        if err: return err
    elif a == EditAction.SET_PARAGRAPH_SHADING:
        if not p.get("fill"):
            return 'Missing required param: fill。Correct usage: params={"fill": "D9E2F3", "val": "clear", "color": "auto"}'
        err = _need_target()
        if err: return err
    elif a == EditAction.SET_PARAGRAPH_BORDER:
        borders = p.get("borders")
        if not borders or not isinstance(borders, dict):
            return 'Missing required param: borders。Correct usage: params={"borders": {"top": {"val": "single", "sz": "4", "space": "1", "color": "000000"}}}'
        err = _need_target()
        if err: return err
    elif a == EditAction.SET_TAB_STOPS:
        tabs = p.get("tabs")
        if tabs is not None and not isinstance(tabs, list):
            return 'Parameter type error: tabs must be a list. Correct usage: params={"tabs": [{"val": "right", "pos": "9360", "leader": "dot"}]}'
        err = _need_target()
        if err: return err
    elif a == EditAction.SET_PARAGRAPH_NUMBERING_RESTART:
        err = _need_target()
        if err: return err
    elif a == EditAction.SET_RUN_FORMAT:
        if not p:
            return 'Missing required param: params needs at least one format property in。Correct usage: params={"bold": True, "run_index": 0}'
        err = _need_target()
        if err: return err
    elif a == EditAction.SET_RUN_TEXT_EFFECTS:
        if not p:
            return 'Missing required param: params needs at least one effect property. Correct usage: params={"glow": True, "glow_color": "FF0000"}'
        err = _need_target()
        if err: return err
    elif a == EditAction.SET_RUN_LANGUAGE:
        if not p.get("val") and not p.get("eastAsia") and not p.get("bidi"):
            return 'Missing required param: Needs at least one language property (val/eastAsia/bidi)。Correct usage: params={"val": "en-US", "eastAsia": "zh-CN"}'
        err = _need_target()
        if err: return err
    elif a == EditAction.SET_RUN_BORDER:
        err = _need_target()
        if err: return err
    elif a == EditAction.SET_PARAGRAPH_OUTLINE_LEVEL:
        err = _need_target()
        if err: return err
    elif a == EditAction.FIND_AND_FORMAT:
        return _need("find_text")
    # ── Phase 1.5: Table ──
    elif a == EditAction.EDIT_TABLE_CELL_FORMAT:
        err = _need("row", "col")
        if err: return err
        if not p.get("bold") and not p.get("italic") and not p.get("alignment") and not p.get("shading"):
            return 'Missing format param: Needs at least one format property (bold/italic/alignment/shading)。Correct usage: params={"row": 0, "col": 0, "bold": True}'
    elif a == EditAction.SET_TABLE_PROPERTIES:
        if not p:
            return 'Missing required param: params needs at least one property in。Correct usage: params={"alignment": "center"}'
    elif a == EditAction.SET_TABLE_BORDER:
        return _need("border_type", "style")
    elif a == EditAction.SET_TABLE_ROW_PROPERTIES:
        err = _need("row_index")
        if err: return err
        if "index" in p and "row_index" not in p:
            p["row_index"] = p["index"]
    elif a == EditAction.SET_TABLE_CELL_PROPERTIES:
        return _need("row", "col")
    elif a == EditAction.SET_TABLE_CELL_MARGIN:
        if not t:
            return 'Missing required param: target_id (table_id)。Correct usage: target_id="tbl-000", params={"top": "108", "bottom": "108", "left": "108", "right": "108"}'
        if not any(k in p for k in ("top", "bottom", "left", "right", "start", "end")):
            return 'Missing required param: Need at least one direction of margin (top/bottom/left/right)。Correct usage: params={"top": "108", "bottom": "108"}'
    elif a == EditAction.SET_TABLE_CELL_TEXT_DIRECTION:
        err = _need("row", "col", "direction")
        if err: return err
    elif a == EditAction.EDIT_TABLE_CELL_RICH_TEXT:
        err = _need("row", "col")
        if err: return err
        if "runs" not in p or not isinstance(p["runs"], list) or not p["runs"]:
            return 'Missing required param: runs (non-empty list)。Correct usage: params={"row": 0, "col": 0, "runs": [{"text": "bold text", "bold": True}, {"text": "normal"}]}'
    elif a == EditAction.SET_ROW_CELL_TEXT:
        err = _need("row_index")
        if err: return err
        if not p.get("values") and not any(k.startswith("col_") or k.startswith("cell_") for k in p):
            return 'Missing required param: values list or col_N/cell_N keys. Correct usage: params={"row_index": 0, "col_0": "text"} or params={"row_index": 0, "values": ["a", "b"]}'
    # ── Phase 1.6: Clone/Move ──
    elif a == EditAction.COPY_PARAGRAPH:
        err = _need_target()
        if err: return err
        if not edit.position:
            return 'Missing required param: position。Correct usage: position="after:p-005"'
    elif a == EditAction.COPY_TABLE:
        if not t:
            return 'Missing required param: target_id (table_id)。Correct usage: target_id="tbl-000"'
        if not edit.position:
            return 'Missing required param: position。Correct usage: position="after:p-005"'
    # ── Phase 2.1: Image ──
    elif a == EditAction.REPLACE_IMAGE:
        if not t:
            return 'Missing required param: target_id (image_id)。Correct usage: target_id="img-000", params={"r_id": "rImg2"}'
    elif a == EditAction.SET_IMAGE_SIZE:
        if not t:
            return 'Missing required param: target_id (image_id)。Correct usage: target_id="img-000", params={"width": 200, "height": 200}'
        return _need("width", "height")
    elif a == EditAction.REMOVE_IMAGE:
        if not t:
            return 'Missing required param: target_id (image_id)。Correct usage: target_id="img-000"'
    elif a == EditAction.SET_IMAGE_ALT:
        if not t:
            return 'Missing required param: target_id (image_id)。Correct usage: target_id="img-000"'
        return _need("alt_text")
    elif a == EditAction.SET_IMAGE_LAYOUT:
        if not t:
            return 'Missing required param: target_id (image_id)。Correct usage: target_id="img-000"'
        # Need at least one layout-related parameter
        p = edit.params if hasattr(edit, 'params') else params
        layout_keys = {"layout", "wrap", "behind_doc", "position_h", "position_v", "allow_overlap", "locked"}
        if not any(k in p for k in layout_keys):
            return 'SET_IMAGE_LAYOUT needs at least one layout param (layout/wrap/behind_doc/position_h/position_v/allow_overlap/locked)'
    # ── Phase 2.2: List ──
    elif a == EditAction.SET_LIST_STYLE:
        err = _need_target()
        if err: return err
        return _need("num_id")
    elif a == EditAction.SET_LIST_LEVEL:
        err = _need_target()
        if err: return err
        return _need("ilvl")
    # ── Phase 2.3: Hyperlink ──
    elif a == EditAction.REMOVE_HYPERLINK:
        err = _need_target()
        if err: return err
        return _need("hyperlink_index")
    elif a == EditAction.SET_HYPERLINK:
        err = _need_target()
        if err: return err
        return _need("hyperlink_index", "url")
    # ── Phase 2.4: Properties ──
    elif a == EditAction.SET_PAGE_SETUP:
        if not p:
            return 'Missing required param: params needs at least one property in。Correct usage: params={"page_width": "16800", "orientation": "landscape"}'
    # ── Phase 3.1: Header/Footer ──
    elif a == EditAction.ADD_PAGE_NUMBER:
        pass  # r_id has default
    # ── Phase 3.3: Footnotes ──
    elif a == EditAction.ADD_FOOTNOTE:
        err = _need_target()
        if err: return err
        return _need("text")
    elif a == EditAction.ADD_ENDNOTE:
        err = _need_target()
        if err: return err
        return _need("text")
    # ── Phase 3.4: Bookmarks ──
    elif a == EditAction.REMOVE_BOOKMARK:
        return _need("bookmark_name")
    # ── Phase 3.5: TOC ──
    elif a == EditAction.ADD_TOC:
        pass  # FIX-012: position optional, defaults to before sectPr
    # ── Phase 3.6: Sections ──
    elif a == EditAction.SET_SECTION_PROPERTIES:
        if not p:
            return 'Missing required param: params needs at least one property in。Correct usage: params={"page_width": "12240", "page_height": "15840"}'
    elif a == EditAction.SET_PAGE_NUMBER_FORMAT:
        return _need("fmt")
    # ── Phase 3.7: Fields ──
    elif a == EditAction.ADD_FIELD:
        err = _need_target()
        if err: return err
        return _need("field_type")
    # ── Phase 0.3: Global settings ──
    elif a == EditAction.SET_CORE_PROPERTIES:
        if not p:
            return 'Missing required param: params needs at least one property in。Correct usage: params={"title": "Document Title", "creator": "Author"}'
    elif a == EditAction.SET_DOCUMENT_PROTECTION:
        return _need("protection_type")
    elif a == EditAction.SET_EVEN_ODD_HEADERS:
        if "enabled" not in p:
            return 'Missing required param: enabled。Correct usage: params={"enabled": true}'
    elif a == EditAction.SET_AUTO_HYPHENATION:
        if "enabled" not in p:
            return 'Missing required param: enabled。Correct usage: params={"enabled": true}'
    elif a == EditAction.UPDATE_FIELDS:
        pass  # no params needed
    # ── Phase 7: Advanced ──
    elif a == EditAction.CLONE_ELEMENT:
        if not t:
            return 'Missing required param: target_id。Correct usage: target_id="p-002", params={"position": "after:p-005"}'
        if not edit.position:
            return 'Missing required param: position。Correct usage: position="after:p-005"'
    elif a == EditAction.EDIT_CHART:
        if not t:
            return 'Missing required param: target_id (chart_id)。Correct usage: target_id="chart-000"'
    elif a == EditAction.EDIT_EQUATION:
        if not t:
            return 'Missing required param: target_id (equation_id)。Correct usage: target_id="eq-000"'
    elif a == EditAction.EDIT_SMARTART:
        if not t:
            return 'Missing required param: target_id (smartart_id)。Correct usage: target_id="sa-000"'
    elif a == EditAction.EDIT_TEXTBOX:
        if not t:
            return 'Missing required param: target_id (textbox_id)。Correct usage: target_id="tbx-000"'
    elif a == EditAction.EDIT_SHAPE:
        if not t:
            return 'Missing required param: target_id (shape_id)。Correct usage: target_id="shp-000"'
    return None


def _apply_single_edit(
    edit: EditOp,
    root: ET.Element,
    body: ET.Element,
    id_to_index: dict[str, int],
    id_to_elem: dict = None,
    model: Optional[DocumentModel] = None,
    tbl_to_elem: dict = None,
) -> bool:
    """Apply single edit operation"""

    # Parameter validation — give LLM clear error hints
    validation_error = _validate_edit(edit)
    if validation_error:
        print(f"Error: {edit.action.name} parameter validation failed: {validation_error}")
        return False

    # FIX-018: Table actions don't need paragraph resolution
    _TABLE_ACTIONS = {
        EditAction.EDIT_TABLE_CELL, EditAction.EDIT_TABLE_CELL_FORMAT,
        EditAction.SET_TABLE_PROPERTIES, EditAction.SET_TABLE_BORDER,
        EditAction.REMOVE_TABLE, EditAction.ADD_TABLE_ROW,
        EditAction.REMOVE_TABLE_ROW, EditAction.ADD_TABLE_COLUMN,
        EditAction.REMOVE_TABLE_COLUMN, EditAction.SET_TABLE_ROW_PROPERTIES,
        EditAction.SET_TABLE_CELL_PROPERTIES, EditAction.SET_TABLE_CELL_MARGIN,
        EditAction.SET_TABLE_CELL_TEXT_DIRECTION, EditAction.EDIT_TABLE_CELL_RICH_TEXT,
        EditAction.MERGE_CELLS, EditAction.SPLIT_CELLS, EditAction.SET_ROW_CELL_TEXT,
        EditAction.ADD_TABLE,
    }

    # FIX-017: Central paragraph resolution via target_id + target_text
    target_text = edit.params.get("target_text", "") if edit.params else ""
    _resolved_para = None
    if edit.action not in _TABLE_ACTIONS and (edit.target_id or target_text):
        _resolved_para = _resolve_target_para(
            body, edit.target_id, id_to_elem, id_to_index, target_text
        )

    if edit.action == EditAction.REPLACE_TEXT:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_replace_text(
            para_elem,
            edit.params["old_text"],
            edit.params["new_text"],
        )

    elif edit.action == EditAction.FILL_BLANKS:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_fill_blanks(para_elem, edit.params.get("values", []))

    elif edit.action == EditAction.INSERT_PARAGRAPH:
        return _do_insert_paragraph(
            body,
            edit.position,
            edit.params.get("text", ""),
            edit.params.get("style", "Normal"),
            id_to_index, id_to_elem,
        )

    elif edit.action == EditAction.DELETE_PARAGRAPH:
        # FIX-017: try _resolved_para first, compute index from body position
        if _resolved_para is not None:
            paras = body.findall(ns("w:p"))
            try:
                para_idx = list(body).index(_resolved_para)
            except ValueError:
                para_idx = None
                for i, p in enumerate(paras):
                    if p is _resolved_para:
                        para_idx = i
                        break
        else:
            para_idx = id_to_index.get(edit.target_id)
        if para_idx is None:
            return False
        return _do_delete_paragraph(body, para_idx)

    elif edit.action == EditAction.CHANGE_STYLE:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_change_style(
            para_elem,
            edit.params["new_style"],
        )

    # ── Phase 1.1: Paragraph formatting ──
    elif edit.action == EditAction.SET_PARAGRAPH_FORMAT:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_set_paragraph_format(para_elem, edit.params)

    elif edit.action == EditAction.SET_PARAGRAPH_SHADING:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        ok = _do_set_paragraph_shading(para_elem, edit.params)
        return ok

    elif edit.action == EditAction.SET_PARAGRAPH_BORDER:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        ok = _do_set_paragraph_border(para_elem, edit.params)
        return ok

    elif edit.action == EditAction.SET_TAB_STOPS:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        ok = _do_set_tab_stops(para_elem, edit.params)
        return ok

    # ── Phase 1.2: Run formatting ──
    elif edit.action == EditAction.SET_RUN_FORMAT:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_set_run_format(para_elem, edit.params)

    elif edit.action == EditAction.SET_RUN_TEXT_EFFECTS:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_set_run_text_effects(para_elem, edit.params)

    elif edit.action == EditAction.SET_RUN_LANGUAGE:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_set_run_language(para_elem, edit.params)

    elif edit.action == EditAction.SET_RUN_BORDER:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_set_run_border(para_elem, edit.params)

    elif edit.action == EditAction.SET_PARAGRAPH_OUTLINE_LEVEL:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_set_paragraph_outline_level(para_elem, edit.params)

    # ── Phase 1.3: Find & Replace ──
    elif edit.action == EditAction.FIND_AND_REPLACE:
        return _do_find_and_replace(body, edit.params)

    elif edit.action == EditAction.FIND_AND_FORMAT:
        return _do_find_and_format(body, edit.params, id_to_index, root)

    # ── Phase 1.4: Breaks ──
    elif edit.action == EditAction.ADD_BREAK:
        para_elem = _resolved_para
        if para_elem is None:
            print(f"Warning: ADD_BREAK could not resolve target paragraph "
                  f"(target_id='{edit.target_id}', target_text='{target_text[:40]}')")
            return False
        return _do_add_break(para_elem, edit.params)

    # ── Phase 1.5: Table editing (FIX-018: _resolve_target_table) ──
    elif edit.action == EditAction.EDIT_TABLE_CELL:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_edit_table_cell(root, body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.EDIT_TABLE_CELL_FORMAT:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_edit_table_cell_format(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.SET_TABLE_PROPERTIES:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_set_table_properties(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.SET_TABLE_BORDER:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_set_table_border(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.ADD_TABLE:
        return _do_add_table(body, edit.position, edit.params, id_to_index, id_to_elem)

    elif edit.action == EditAction.REMOVE_TABLE:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_remove_table(body, edit.target_id, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.ADD_TABLE_ROW:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_add_table_row(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.REMOVE_TABLE_ROW:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_remove_table_row(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.ADD_TABLE_COLUMN:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_add_table_column(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.REMOVE_TABLE_COLUMN:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_remove_table_column(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.SET_TABLE_ROW_PROPERTIES:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_set_table_row_properties(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.SET_TABLE_CELL_PROPERTIES:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_set_table_cell_properties(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.SET_TABLE_CELL_MARGIN:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_set_table_cell_margin(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.SET_TABLE_CELL_TEXT_DIRECTION:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_set_table_cell_text_direction(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.EDIT_TABLE_CELL_RICH_TEXT:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_edit_table_cell_rich_text(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.MERGE_CELLS:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_merge_cells(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.SPLIT_CELLS:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_split_cells(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    elif edit.action == EditAction.SET_ROW_CELL_TEXT:
        _resolved_tbl = _resolve_target_table(body, edit.target_id, edit.params, tbl_to_elem)
        if _resolved_tbl is None:
            return False
        return _do_set_row_cell_text(body, edit.target_id, edit.params, tbl_to_elem, _resolved_tbl)

    # ── Phase 1.6: Clone/Move ──
    elif edit.action == EditAction.COPY_PARAGRAPH:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_copy_paragraph(body, para_elem, edit.position, id_to_index, id_to_elem)

    elif edit.action == EditAction.COPY_TABLE:
        return _do_copy_table(body, edit.target_id, edit.position, tbl_to_elem)

    elif edit.action == EditAction.MOVE_PARAGRAPH:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_move_paragraph(body, para_elem, edit.position, id_to_index, id_to_elem)

    elif edit.action == EditAction.SWAP_PARAGRAPH:
        return _do_swap_paragraph(body, edit.target_id, edit.params, id_to_index, root)

    # ── Phase 1.8: Track changes ──
    elif edit.action == EditAction.ACCEPT_ALL_CHANGES:
        return _do_accept_all_changes(body)

    elif edit.action == EditAction.REJECT_ALL_CHANGES:
        return _do_reject_all_changes(body)

    # ── Phase 2.1: Image ──
    elif edit.action == EditAction.ADD_IMAGE:
        return _do_add_image(body, edit.target_id, edit.position, edit.params, id_to_index, root, id_to_elem)

    elif edit.action == EditAction.REPLACE_IMAGE:
        return _do_replace_image(body, edit.target_id, edit.params)

    elif edit.action == EditAction.SET_IMAGE_SIZE:
        return _do_set_image_size(body, edit.target_id, edit.params)

    elif edit.action == EditAction.REMOVE_IMAGE:
        return _do_remove_image(body, edit.target_id)

    elif edit.action == EditAction.SET_IMAGE_ALT:
        return _do_set_image_alt(body, edit.target_id, edit.params)

    elif edit.action == EditAction.SET_IMAGE_LAYOUT:
        return _do_set_image_layout(body, edit.target_id, edit.params)

    # ── Phase 2.2: List ──
    elif edit.action == EditAction.SET_LIST_STYLE:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_set_list_style(para_elem, edit.params)

    elif edit.action == EditAction.SET_LIST_LEVEL:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_set_list_level(para_elem, edit.params)

    elif edit.action == EditAction.SET_PARAGRAPH_NUMBERING_RESTART:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_set_paragraph_numbering_restart(para_elem, edit.params, body)

    # ── Phase 2.3: Hyperlink ──
    elif edit.action == EditAction.ADD_HYPERLINK:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_add_hyperlink(para_elem, edit.params)

    elif edit.action == EditAction.REMOVE_HYPERLINK:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_remove_hyperlink(para_elem, edit.params)

    elif edit.action == EditAction.SET_HYPERLINK:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_set_hyperlink(para_elem, edit.params)

    # ── Phase 2.4: Page setup ──
    elif edit.action == EditAction.SET_PAGE_SETUP:
        return _do_set_page_setup(body, edit.params)

    # ── Phase 3.1: Header/Footer ──
    elif edit.action == EditAction.SET_HEADER:
        return _do_set_header(body, edit.params)

    elif edit.action == EditAction.SET_FOOTER:
        return _do_set_footer(body, edit.params)

    elif edit.action == EditAction.ADD_PAGE_NUMBER:
        return _do_add_page_number(body, edit.params)

    elif edit.action == EditAction.REMOVE_HEADER:
        return _do_remove_header(body, edit.params)

    elif edit.action == EditAction.REMOVE_FOOTER:
        return _do_remove_footer(body, edit.params)

    # ── Phase 3.2: Comments ──
    elif edit.action == EditAction.ADD_COMMENT:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_add_comment(para_elem, edit.params)

    elif edit.action == EditAction.REMOVE_COMMENT:
        return _do_remove_comment(body, edit.params.get("comment_id", edit.target_id))

    # ── Phase 3.3: Footnotes ──
    elif edit.action == EditAction.ADD_FOOTNOTE:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_add_footnote(para_elem, edit.params)

    elif edit.action == EditAction.REMOVE_FOOTNOTE:
        fn_id = edit.target_id or edit.params.get("footnote_id", "")
        return _do_remove_footnote(body, fn_id)

    # ── Phase 3.3b: Endnotes ──
    elif edit.action == EditAction.ADD_ENDNOTE:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_add_endnote(para_elem, edit.params)

    elif edit.action == EditAction.REMOVE_ENDNOTE:
        en_id = edit.target_id or edit.params.get("endnote_id", "")
        return _do_remove_endnote(body, en_id)

    # ── Phase 3.4: Bookmarks ──
    elif edit.action == EditAction.ADD_BOOKMARK:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_add_bookmark(para_elem, edit.params)

    elif edit.action == EditAction.REMOVE_BOOKMARK:
        return _do_remove_bookmark(body, edit.params)

    # ── Phase 3.5: TOC ──
    elif edit.action == EditAction.ADD_TOC:
        return _do_add_toc(body, edit.position, edit.params, id_to_index, id_to_elem)

    elif edit.action == EditAction.REFRESH_TOC:
        return _do_refresh_toc(body, edit.params)

    # ── Phase 3.6: Section breaks ──
    elif edit.action == EditAction.ADD_SECTION_BREAK:
        # FIX-017: resolve paragraph index via _resolved_para
        para_idx = None
        if _resolved_para is not None:
            paras = body.findall(ns("w:p"))
            for i, p in enumerate(paras):
                if p is _resolved_para:
                    para_idx = i
                    break
        if para_idx is None and edit.target_id:
            para_idx = id_to_index.get(edit.target_id)
        return _do_add_section_break(body, edit.params, para_idx)

    elif edit.action == EditAction.REMOVE_SECTION_BREAK:
        return _do_remove_section_break(body, edit.params, _resolved_para)

    elif edit.action == EditAction.SET_SECTION_PROPERTIES:
        return _do_set_section_properties(body, edit.params)

    elif edit.action == EditAction.SET_PAGE_NUMBER_FORMAT:
        return _do_set_page_number_format(body, edit.params)

    # ── Phase 3.7: Fields ──
    elif edit.action == EditAction.ADD_FIELD:
        para_elem = _resolved_para
        if para_elem is None:
            return False
        return _do_add_field(para_elem, edit.params)

    # ── Phase 7: Charts/Equations/SmartArt/Textboxes/Shapes/Clone ──
    elif edit.action == EditAction.EDIT_CHART:
        return _do_edit_chart(root, edit)
    elif edit.action == EditAction.EDIT_EQUATION:
        return _do_edit_equation(root, edit)
    elif edit.action == EditAction.EDIT_SMARTART:
        return _do_edit_smartart(root, edit)
    elif edit.action == EditAction.EDIT_TEXTBOX:
        return _do_edit_textbox(root, edit)
    elif edit.action == EditAction.EDIT_SHAPE:
        return _do_edit_shape(root, edit)
    elif edit.action == EditAction.CLONE_ELEMENT:
        return _do_clone_element(root, edit)

    # ── Multi-file actions (handled by separate processors, not here) ──
    elif edit.action in (
        EditAction.SET_DOC_DEFAULTS, EditAction.SET_DOCUMENT_PROTECTION,
        EditAction.SET_EVEN_ODD_HEADERS, EditAction.SET_AUTO_HYPHENATION,
        EditAction.UPDATE_FIELDS, EditAction.ADD_STYLE,
        EditAction.SET_STYLE_PROPERTIES, EditAction.SET_CORE_PROPERTIES,
        EditAction.CREATE_NUMBERING_DEFINITION,
    ):
        # These are handled by _apply_settings_edits, _apply_styles_edits,
        # _apply_core_properties_edits, _apply_numbering_edits in the main loop.
        return True

    else:
        print(f"Unknown edit action: {edit.action}")
        return False
