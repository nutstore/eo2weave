# Wiki Schema

This document defines the structural rules and editing conventions for word-editor.

## Wiki Page Format

Each page consists of three parts:

1. **YAML Frontmatter** — Structured metadata, including reference relationships
2. **Markdown Body** — Human/Agent readable content description
3. **Context Section** — Reference relationships between this node and other nodes

### Paragraph Page Example

```markdown
---
id: p-003
type: paragraph
index: 3
style: "[[style-Heading1]]"
section: "[[section-0]]"
previous: "[[p-002]]"
next: "[[p-004]]"
xpath: "/w:document[1]/w:body[1]/w:p[4]"
xml_path: "word/document.xml"
---

# Paragraph p-003

## Text

Chapter 1 Introduction

## Runs

| # | Text | Bold | Italic | Font | Size |
|---|------|------|--------|------|------|
| 1 | Chapter 1 Introduction | no | no |  |  |

## Context

- **Style**: [[style-Heading1]]
- **Section**: [[section-0]]
- **Previous**: [[p-002]]
- **Next**: [[p-004]]
```

### Style Page Example

```markdown
---
id: style-Heading1
type: style
style_id: Heading1
style_type: paragraph
name: heading 1
based_on: "[[style-Heading2]]"
is_default: false
---

# Style: Heading1

## Properties

- Font: Calibri
- Size: 26pt (52 half-points)
- Bold: yes
- Color: default

## Used By

- [[p-001]]
- [[p-005]]
- [[p-012]]
```

## Naming Conventions

| Node Type | ID Format | File Path |
|-----------|-----------|-----------|
| Paragraph | `p-NNN` | `paragraphs/p-NNN.md` |
| Table | `tbl-NNN` | `tables/tbl-NNN.md` |
| Image | `img-NNN` | `images/img-NNN.md` |
| Style | `style-{name}` | `styles/{name}.md` |
| Section | `section-N` | `sections/section-N.md` |

## Reference Conventions

- All references use `[[]]` syntax
- Reference target is the node ID
- Can include display text: `[[p-003|Third paragraph]]`
- References in Frontmatter are quoted: `style: "[[style-Heading1]]"`

## Edit Operations (EditOps)

The Agent does not directly modify wiki file content, but generates structured edit commands:

```json
[
  {
    "action": "replace_text",
    "target_id": "p-003",
    "params": {"old_text": "old text", "new_text": "new text"}
  },
  {
    "action": "insert_paragraph",
    "position": "after:p-005",
    "params": {"text": "New paragraph", "style": "Normal"}
  },
  {
    "action": "delete_paragraph",
    "target_id": "p-008"
  },
  {
    "action": "change_style",
    "target_id": "p-010",
    "params": {"new_style": "Heading2"}
  }
]
```

### Supported Edit Operations

| Operation | Description | Required Params |
|-----------|-------------|----------------|
| `replace_text` | Replace text in a paragraph | `old_text`, `new_text` |
| `insert_paragraph` | Insert a new paragraph | `text`; `position` or specify in params |
| `delete_paragraph` | Delete a paragraph | none |
| `change_style` | Change paragraph style | `new_style` |

## Lint Rules

The Agent should periodically run the following health checks:

1. **Dangling references**: Paragraph style reference points to non-existent style page
2. **Orphaned images**: Image page not referenced by any paragraph
3. **Broken prev/next links**: p-002's next is p-003, but p-003's previous is not p-002
4. **XPath validity**: XPath points to a position that matches the actual XML

## Workflow

### Ingest Workflow
1. User provides docx file
2. Run ingest to generate wiki
3. Agent reads index.md for document overview
4. Navigate to specific pages as needed

### Edit Workflow
1. Agent understands document structure and content
2. Determines required modifications
3. Generates EditOps list
4. Executes apply_edits to produce new docx
5. (Optional) Re-ingest to update wiki

### Lint Workflow
1. Check completeness of all references
2. Verify wiki structural consistency
3. Report issues and suggest fixes
