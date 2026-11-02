---
name: cw-nol-editor
version: 1.0.1
description: Guide for reading, writing, and editing .nol (Outline Notes) files. Covers correct outline format, indentation rules, HTML content, and common pitfalls.
description.zh-CN: "读写与编辑 .nol（大纲笔记）文件的指南。涵盖正确的大纲格式、缩进规则、HTML 内容嵌入与常见陷阱。"
category: general
tags: [nol, outline, format, file-ops]
triggers:
  keywords: [nol, 大纲, outline, 怡氧]
---

# .nol File Editing Guide

This skill teaches how to correctly read, write, and edit `.nol` (Outline Notes) files.

## What is .nol?

`.nol` is the Outline Notes format used by 怡氧大纲笔记. It is a **ZIP archive** containing a JSON node tree and optional media files. The format handler transparently converts between the ZIP binary and an indented text representation.

## Read

`read()` returns the indented text representation:

```
Root Title
  - Level 2 node
    - Level 3 node
      - Level 4 node
```

- The first line (no indent, no `-` prefix) is the root node (title).
- Each subsequent line starts with indentation (`2 spaces per level`) + `- ` prefix.
- Node content is **raw HTML**, not Markdown.

## Write

When writing a `.nol` file, provide the same indented text format:

```
Title
  - H2 section
    - H3 item
      - detail 1
      - detail 2
  - Another H2 section
    - H3 item
```

### Indentation rules

- **Use Tab or 2-space indent** — both work. Tab is automatically converted to 2 spaces.
- **Each indent level = 2 spaces** (or 1 tab).
- Depth maps to heading levels like Markdown: root = h1, indent-1 = h2, indent-2 = h3, etc.

### Node content rules

- Content is **raw HTML**, not Markdown.
- Bold: `<strong>text</strong>`
- Italic: `<em>text</em>`
- Link: `<a href="..." data-ns-from-auto-link="false" rel="noreferrer noopener" target="_blank">text</a>`
- Color: `<span style="color: #e74c3c">red</span>`
- Highlight: `<span style="background-color: rgba(255,235,59,0.6)">text</span>`
- Do NOT use Markdown syntax (`**bold**`, `[link](url)`, etc.) — it will appear as raw text.

### Images

- New image: `![](vfs://assets/filename.png)` on a line after the node.
- Existing image: `![](media/filename.jpg)` to preserve it.

## Edit

`edit()` works on the indented text representation returned by `read()`.

1. First `read()` the file to get current content.
2. Find the exact text to change (including correct indentation).
3. Use `edit(path, old_text, new_text)` to make targeted changes.

When editing, **preserve the exact indentation** of the original lines. Wrong indentation = wrong hierarchy.

## Common mistakes

| Mistake | Correct |
|---------|---------|
| Using `**bold**` | Use `<strong>bold</strong>` |
| Using `[link](url)` | Use `<a href="url" ...>link</a>` |
| All nodes at same level | Use proper indentation for hierarchy |
| Markdown headings `## Title` | Use indentation + `- prefix` |
| Writing JSON | Write plain indented text |
| Too deep nesting (5+ levels) | Keep to 2-3 levels for readability |
| Too flat (1 level only) | Use hierarchy to group related items |

## Good outline example

```
Project Planning
  - Phase 1: Research
    - User interviews (Week 1-2)
    - Competitive analysis
  - Phase 2: Design
    - Wireframes
    - Visual design
  - Team
    - <strong>Alice</strong> — Research lead
    - <strong>Bob</strong> — Design lead
```

## Bad outline example

```
Project Planning
- Phase 1: Research
- User interviews
- Competitive analysis
- Phase 2: Design
- Wireframes
- Visual design
```
(No indentation → all nodes are flat, hierarchy lost)
