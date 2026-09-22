# word-editor

Compile docx documents into an LLM-native Wiki knowledge base, enabling Agents to deeply understand document structure and perform precise edits.

## Core Idea

Based on the LLM Wiki pattern, compile complex OpenXML format into an Agent-understandable persistent Wiki:

```
┌─────────────────────────────────────┐
│  Raw Sources (immutable)            │
│  .docx files (zip + OpenXML)        │
└──────────────┬──────────────────────┘
               │ Ingest (compile)
               ▼
┌─────────────────────────────────────┐
│  The Wiki (Agent-owned, read/write) │
│  Markdown files + [[]] bidirectional│
│  Agent understands, reasons, plans  │
│  edits here                         │
└──────────────┬──────────────────────┘
               │ EditOps (structured edit commands)
               ▼
┌─────────────────────────────────────┐
│  Writeback Pipeline                 │
│  Edit commands → apply to raw XML   │
│  → repackage                        │
└─────────────────────────────────────┘
```

**Key insight**: The Wiki is not an intermediate conversion format, but a compilation artifact. The Agent doesn't need to do lossless Markdown→XML conversion. Instead:
1. **Understand** document structure on the Wiki
2. Generate structured **EditOps**
3. EditOps are **programmatically** applied to the original XML

## Architecture

### Three Layers

| Layer | Responsibility | Owner |
|-------|---------------|-------|
| Raw Sources | Original docx files, immutable | User provides |
| Wiki | Compiled markdown knowledge base | Agent reads/writes |
| Schema | Wiki structure rules and editing conventions | Agent + user co-create |

### Wiki Directory Structure

```
wiki/
├── index.md              # Document table of contents
├── log.md                # Operation log (append-only)
├── paragraphs/           # One page per paragraph
│   ├── p-000.md          # id + metadata + text + references
│   ├── p-001.md
│   └── ...
├── styles/               # One page per style
│   ├── normal.md
│   ├── heading1.md
│   └── ...
├── tables/               # One page per table
│   ├── tbl-000.md
│   └── ...
├── images/               # One page per image
│   ├── img-000.md
│   └── ...
└── sections/             # One page per section
    ├── section-0.md
    └── ...
```

### [[]] Reference System

The Wiki uses Obsidian-style bidirectional links to express OpenXML reference relationships:

| Reference Type | Example | Meaning |
|---------------|---------|---------|
| Style reference | `[[style-Heading1]]` | Paragraph uses Heading1 style |
| Adjacent reference | `[[p-002]]` | Adjacent paragraphs |
| Image reference | `[[img-000]]` | Paragraph embeds image |
| Table reference | `[[tbl-000]]` | Paragraph contains table |
| Section reference | `[[section-0]]` | Paragraph belongs to section |

## Usage

### Ingest (Compile)

```python
from word_editor import ingest

# Compile docx into wiki
model = ingest('my_document.docx', 'wiki/')
```

### Agent Editing

The Agent reads the wiki, understands the document structure, then generates EditOps:

```python
from word_editor import EditOp

edits = [
    EditOp.replace_text('p-003', 'Old Title', 'New Title'),
    EditOp.insert_paragraph('This is a new paragraph.', after_id='p-005', style='Normal'),
    EditOp.delete_paragraph('p-008'),
    EditOp.change_style('p-010', 'Heading2'),
]
```

### Writeback

```python
from word_editor import apply_edits

# Apply edit commands back to docx
apply_edits('my_document.docx', edits, 'my_document_edited.docx')
```

## Workflow

### 1. Ingest

Feed docx into the compilation pipeline:
- Unzip docx (zip)
- Parse `document.xml` → extract paragraphs, tables, images
- Parse `styles.xml` → extract style definitions
- Parse `.rels` → extract reference relationships
- Build cross-reference graph
- Generate wiki markdown files

### 2. Query

The Agent answers questions about the document by reading the wiki:
- Read `index.md` for document overview
- Navigate to specific pages for details
- Follow `[[]]` links to trace references
- Compare different pages to discover patterns

### 3. Edit

The Agent generates edit commands (EditOps) based on understanding, without directly modifying the wiki.

### 4. Lint

Periodically check wiki health:
- Dangling references (paragraph references non-existent style)
- Orphaned nodes (images not referenced by any page)
- Structural inconsistencies

## Design Principles

1. **Compile, don't convert**: The Wiki is a compiled view of the source document, not an intermediate format
2. **Decouple understanding from modification**: Agent understands on Wiki, modifies via EditOps
3. **Reference integrity**: All cross-references are explicitly expressed via `[[]]` and verifiable
4. **Format fidelity**: Writeback operations modify original XML directly, no Markdown intermediary
5. **Incremental**: Start with paragraphs/styles/tables, later extend to headers/footers/comments etc.

## Dependencies

- Python 3.8+
- Standard library: `zipfile`, `xml.etree.ElementTree`, `json`, `os`, `re`
- No third-party dependencies
