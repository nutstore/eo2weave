"""
word-editor: Compile docx into LLM-native Wiki knowledge base

Core modules:
- ingest: docx → wiki compilation pipeline
- writeback: EditOps → docx writeback pipeline
- lint: wiki health check
- model: data models (DocumentModel, ParagraphNode, StyleNode, etc.)
"""

from .model import (
    DocumentModel,
    ParagraphNode,
    StyleNode,
    TableNode,
    ImageNode,
    SectionNode,
    EditOp,
    EditAction,
    RunInfo,
)
from .ingest import ingest
from .writeback import apply_edits
from .lint import lint

__all__ = [
    "ingest",
    "apply_edits",
    "lint",
    "DocumentModel",
    "ParagraphNode",
    "StyleNode",
    "TableNode",
    "ImageNode",
    "SectionNode",
    "EditOp",
    "EditAction",
    "RunInfo",
]
