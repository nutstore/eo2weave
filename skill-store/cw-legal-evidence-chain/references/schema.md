# Evidence Chain Schema

Use this schema when producing `evidence-chain.json`. Keep IDs stable across incremental updates, not only within one run. Fields may be omitted only when genuinely unavailable; prefer `null` or `unknown` over invention. New outputs should use schema version `1.1` and include the closure and coverage fields below. The validator keeps a non-strict compatibility mode for legacy files.

## Top-Level Object

```json
{
  "case_metadata": {},
  "material_scope": [],
  "issues": [],
  "proof_objects": [],
  "facts": [],
  "evidence_items": [],
  "relations": [],
  "contradictions": [],
  "evidence_gaps": [],
  "supplement_plan": [],
  "timeline": [],
  "limits_and_assumptions": []
}
```

## case_metadata

```json
{
  "schema_version": "1.1",
  "case_name": "unknown",
  "case_type": "unknown",
  "parties": [],
  "review_date": "YYYY-MM-DD",
  "reviewer_role": "lawyer-assistant"
}
```

## material_scope

```json
{
  "id": "mat_001",
  "source_path": "materials/contract.pdf",
  "material_type": "contract | pleading | chat_record | bank_record | invoice | image | audio_transcript | witness_statement | administrative_record | judicial_document | other",
  "review_status": "reviewed | partially_reviewed | unreadable | unavailable",
  "notes": "page range, OCR limits, extraction caveats",
  "derived_from_material_ids": []
}
```

## issues

Issues are disputed issues, legal/practical questions, or proof themes.

```json
{
  "id": "issue_001",
  "title": "是否存在有效合同关系",
  "description": "需要证明合同成立、生效及相对方身份",
  "side": "claimant | respondent | prosecution | defense | applicant | third_party | neutral | unknown",
  "related_proof_object_ids": ["po_001"],
  "status": "clear | disputed | unclear"
}
```

## proof_objects

Proof objects are matters that need evidentiary support. Keep them case-type neutral.

```json
{
  "id": "po_001",
  "name": "合同关系成立",
  "description": "证明双方就主要条款达成合意并形成法律关系",
  "importance": "high | medium | low",
  "related_issue_ids": ["issue_001"],
  "support_state": "supported | partially_supported | unsupported | contradicted | unclear"
}
```

## facts

```json
{
  "id": "fact_001",
  "statement": "2024年3月1日，甲方向乙方发送盖章合同扫描件。",
  "fact_type": "background | key_fact | procedural | claim | defense | inference | allegation | statement | negative_state",
  "time": "2024-03-01 or unknown",
  "time_scope": {
    "start": null,
    "end": null,
    "as_of": null
  },
  "actors": ["甲方", "乙方"],
  "amount": null,
  "location": null,
  "source_basis": "direct_evidence | party_statement | inference | mixed | unknown",
  "support_state": "supported | partially_supported | unsupported | contradicted | unclear",
  "supporting_evidence_ids": ["ev_001"],
  "opposing_evidence_ids": [],
  "support_scope": "该证据具体支持哪些主体、行为、金额、时间、结果或仅支持陈述发生",
  "unsupported_elements": [],
  "related_proof_object_ids": ["po_001"],
  "confidence": "high | medium | low",
  "notes": "basis, assumptions, caveats"
}
```

## evidence_items

```json
{
  "id": "ev_001",
  "title": "《采购合同》扫描件",
  "source_path": "materials/contract.pdf",
  "locator": "第1-4页 or paragraph/time range",
  "evidence_type": "document | electronic_data | physical_evidence | witness_testimony | party_statement | expert_opinion | inspection_record | audio_video | transaction_record | judicial_document | administrative_record | other",
  "formation_time": "2024-03-01 or unknown",
  "provider_or_source": "甲方提供",
  "content_summary": "载明双方、标的、价款、付款节点及签章。",
  "proof_purpose": "证明合同关系成立及主要条款",
  "proof_scope": ["statement_occurrence | content_truth | underlying_event | authenticity | identity | amount | time | continuing_state | other"],
  "authenticity_status": "original | copy | screenshot | transcript | unknown | disputed",
  "relevance": "high | medium | low",
  "probative_strength": "strong | medium | weak | unknown",
  "risk_notes": "缺少原件、签章真实性待核验等",
  "related_fact_ids": ["fact_001"],
  "related_proof_object_ids": ["po_001"]
}
```

## relations

Use `references/relation-taxonomy.md` for relation types.

```json
{
  "id": "rel_001",
  "from_id": "fact_001",
  "to_id": "fact_002",
  "from_type": "fact",
  "to_type": "fact",
  "relation_type": "temporal_before | temporal_after | causal | logical_support | condition | purpose_motive | performance_breach | funds_flow | goods_flow | information_flow | authority_agency | corroborates | contradicts | weakens | gap",
  "description": "合同发送事实与后续付款事实共同支持合同履行过程。",
  "supporting_evidence_ids": ["ev_001", "ev_002"],
  "strength": "strong | medium | weak | unclear",
  "risk": "缺少乙方确认收件记录",
  "inference_level": "direct | reasonable_inference | speculative",
  "alternative_explanations": []
}
```

## contradictions

```json
{
  "id": "con_001",
  "description": "付款日期在合同约定付款节点前，需解释付款性质。",
  "conflicting_fact_ids": ["fact_003", "fact_004"],
  "conflicting_evidence_ids": ["ev_002", "ev_006"],
  "severity": "high | medium | low",
  "impact": "影响违约时间点认定",
  "resolution_suggestion": "补充银行流水用途备注、聊天确认记录或财务说明。"
}
```

## evidence_gaps

```json
{
  "id": "gap_001",
  "gap_type": "missing_evidence | weak_authenticity | weak_relevance | contradiction | timeline_break | amount_inconsistency | identity_authority | source_defect | chain_of_custody | procedural_risk | unclear_fact",
  "description": "缺少证明乙方收到合同文本的直接证据。",
  "affected_fact_ids": ["fact_001"],
  "affected_proof_object_ids": ["po_001"],
  "severity": "high | medium | low",
  "litigation_risk": "对合同成立及合意形成证明存在影响",
  "closure_status": "remains_open | partially_closed | closed",
  "closure_criteria": [
    {
      "criterion": "存在可识别接收主体、时间和内容的送达/接收记录",
      "status": "met | partially_met | unmet | unclear",
      "evidence_ids": ["ev_003"]
    }
  ],
  "closure_evidence_ids": ["ev_003"],
  "remaining_elements": [],
  "closure_reason": "逐项说明为何保持开放、部分关闭或关闭",
  "recommended_action_ids": ["supp_001"]
}
```

## supplement_plan

```json
{
  "id": "supp_001",
  "priority": "high | medium | low",
  "target_gap_id": "gap_001",
  "evidence_to_collect": "邮件发送记录、微信聊天确认、收件回执或对方后续履行行为材料",
  "proof_purpose": "补强合同文本送达及双方合意",
  "possible_source": "当事人邮箱、企业微信、业务人员手机、财务/业务系统",
  "collection_method": "调取原始记录并保留导出路径、截图元数据或公证/可信时间戳",
  "status": "open | in_progress | completed | not_applicable",
  "required_for_closure": true,
  "notes": "优先保留原始载体及完整上下文。"
}
```

## Semantic Invariants

These invariants control status assignment across all case types:

1. A `supported` fact has non-empty `supporting_evidence_ids`, no `unsupported_elements`, and cited evidence that covers every material element in the atomic fact. If any element remains unproved, split the fact or downgrade it.
2. `statement`/`claim`/`allegation` evidence proves that the statement occurred unless `proof_scope` separately supports `content_truth` or `underlying_event`.
3. A `negative_state` or any proposition expressed as continuing/non-occurrence must include `time_scope.as_of` (or a bounded end) and a `support_scope` describing reviewed periods, actors, accounts and channels. Partial coverage cannot yield an unlimited supported proposition.
4. A `speculative` relation cannot be `strong`. A `reasonable_inference` relation is normally `weak` or `medium`; any exception must explain why alternatives were excluded.
5. A gap may be `closed` only when every closure criterion is `met`, no required element remains, and `closure_evidence_ids` is non-empty. A `partially_closed` gap must have at least one non-met criterion and list `remaining_elements`.
6. Proof-object support must be compatible with its related facts. A proof object cannot be `supported` when a related material fact remains partially supported, unsupported, contradicted, unclear, or retains `unsupported_elements`, unless the proof object is split/narrowed so that the unresolved element is no longer part of it.
7. Derived materials must identify `derived_from_material_ids` and are not independent corroboration of their source.
8. The Markdown report is a presentation of this JSON. IDs, support states, strengths and gap-closure states must match exactly. A validation summary may say "passed/通过" only after the strict bundled validator has returned success.

## timeline

```json
{
  "id": "time_001",
  "time": "2024-03-01",
  "event": "甲方向乙方发送合同扫描件",
  "fact_ids": ["fact_001"],
  "evidence_ids": ["ev_001"],
  "relation_notes": "合同成立链条起点"
}
```
