# Relation Taxonomy

Use this taxonomy to avoid merely listing events. An evidence chain must explain how facts, evidence, and proof objects connect.

## Relation Types

| Type | Chinese Label | Use When | Notes |
| --- | --- | --- | --- |
| `temporal_before` | 时间先后-在前 | One fact occurs before another. | Useful for timelines and sequence disputes. |
| `temporal_after` | 时间先后-在后 | One fact occurs after another. | Use the direction from `from_id` to `to_id`. |
| `causal` | 因果关系 | One fact plausibly causes or explains another. | Mark inference level; avoid overstating causation. |
| `condition` | 条件关系 | One fact is a precondition for another. | Example: authorization before signing. |
| `logical_support` | 逻辑支持 | One fact makes another more likely but is not causal. | Example: repeated performance supports contract existence. |
| `purpose_motive` | 目的/动机关系 | A fact indicates why an actor acted. | Usually inference, rarely direct. |
| `performance_breach` | 履行/违约关系 | Contract or obligation performance, non-performance, delay, defect, notice. | Common in civil/commercial matters. |
| `funds_flow` | 资金流关系 | Payment, transfer, refund, loan, proceeds. | Link payer, payee, amount, account, purpose. |
| `goods_flow` | 物流/货物流关系 | Delivery, receipt, inventory, custody, transport. | Link goods, carrier, time, recipient. |
| `information_flow` | 信息流关系 | Notice, communication, instruction, negotiation, confirmation. | Preserve sender, recipient, channel, time. |
| `authority_agency` | 身份/权限/代理关系 | Identity, title, authorization, agency, representative capacity. | Flag missing authorization documents. |
| `corroborates` | 佐证关系 | Evidence/fact reinforces another from an independent source. | Stronger when source is independent. |
| `contradicts` | 矛盾关系 | Two facts/evidence items cannot both be true or materially diverge. | Create a contradiction record. |
| `weakens` | 削弱关系 | Evidence reduces reliability/probative value but does not directly contradict. | Example: screenshot without context. |
| `gap` | 缺口关系 | A necessary link lacks evidence. | Create an evidence gap and supplement action. |

## Strength Levels

- `strong`: direct source, clear identity/time/content, low authenticity risk, independent corroboration if needed.
- `medium`: relevant but indirect, partial, copied, or dependent on context.
- `weak`: mainly party statement, unclear source, missing original/context, or speculative inference.
- `unclear`: cannot assess from reviewed materials.

## Inference Levels

- `direct`: expressly shown by evidence.
- `reasonable_inference`: not directly stated but reasonably follows from multiple materials.
- `speculative`: possible but not reliably supported; avoid using as a conclusion.

Strength and inference level constrain each other:

- `speculative` must be `weak` or `unclear` and must not carry a proof object to `supported`.
- `reasonable_inference` is normally `weak` or `medium`. Use `strong` only when all premises are independently supported, the mechanism is clear and credible alternatives have been addressed in `alternative_explanations`.
- A direct relation may still be weak because authenticity, identity, context or completeness is defective.

## Causal Relationship Rules

For `causal`, identify:

1. Cause fact.
2. Result fact.
3. Mechanism or explanation.
4. Supporting evidence.
5. Alternative explanations or missing links.

If the mechanism, necessary intermediate event or alternative explanations are absent, record a `gap` relation or downgrade causation. Temporal sequence, a request to act, opportunity, or later loss does not alone prove that the requested act occurred or caused the loss.

Write causation carefully:

- Prefer "材料显示/可初步推断 X 与 Y 存在关联" over "X 必然导致 Y" unless direct proof exists.
- If a causal link depends on expert, accounting, technical, medical, or forensic proof, mark the need for specialized evidence.

## Contradiction Rules

Use `contradicts` only after a mutual-exclusivity test:

1. Normalize both propositions to the same actor/object, event, time and scope.
2. Ask whether both could be true because they refer to different periods, accounts, meanings, versions or levels of proof.
3. If both cannot be true in the normalized scope, use `contradicts` and create a contradiction record.
4. If both may be true but one reduces reliability, use `weakens`. If the difference is merely missing context/source, record the relevant gap.

These may become contradictions after normalization:

- Different dates for the same event.
- Different amounts, account numbers, quantities, locations, identities, signatures, or versions.
- Party statement conflicts with objective records.
- Later conduct conflicts with pleaded position.
- Evidence metadata conflicts with stated formation time.

These are not direct contradictions by themselves:

- a changed, incomplete or evolving explanation;
- a statement of opinion, valuation or legal characterization;
- silence, delay, non-performance or evasiveness;
- a difference that can be explained by distinct time periods, accounts, transaction stages or data coverage;
- a source-quality defect or missing original.

For each contradiction, state whether it is:

- direct contradiction;
- explainable discrepancy;
- source reliability issue;
- issue requiring further verification.

Record the exact two incompatible propositions and their sources. Do not use a contradiction record merely as a general risk list.

## Characterization Guardrail

Relations should connect observable propositions. Do not infer fraud, intent, conspiracy, agency, causation or another legal characterization solely from conduct that is also consistent with ordinary breach, delay, mistake or dispute. Where materials justify concern but not proof, use `weakens`, `gap`, or a separately labeled `inference`/risk with the alternative explanation stated.
