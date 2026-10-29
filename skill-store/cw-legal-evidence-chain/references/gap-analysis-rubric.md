# Gap Analysis Rubric

Use this rubric to identify evidence gaps and prioritize supplement actions.

## Support State

| State | Meaning |
| --- | --- |
| `supported` | Key fact is supported by relevant, identifiable evidence with acceptable authenticity and source basis. |
| `partially_supported` | Some evidence exists but key elements are missing, indirect, copied, incomplete, or not independently corroborated. |
| `unsupported` | No reviewed evidence supports the fact. |
| `contradicted` | Reviewed evidence materially conflicts with the fact. |
| `unclear` | Materials are insufficient or unreadable; support cannot be assessed. |

## Support Gates

Apply these gates after initial extraction:

1. **Atomicity gate**: can every material element of the fact receive the same state? If not, split it.
2. **Citation gate**: `supported` requires at least one identifiable reviewed evidence item. An empty citation list is invalid.
3. **Proof-scope gate**: determine whether the evidence proves statement occurrence, content truth, the underlying event, identity, amount, time or a continuing state. Adjacent facts do not substitute for the target fact.
4. **Readability gate**: unreadable/unavailable material supports no content proposition; partially reviewed material supports only its readable range.
5. **Coverage gate**: a negative or continuing proposition requires a temporal cutoff plus defined account/channel/actor/material coverage. Partial coverage normally yields `partially_supported` at most.
6. **Characterization gate**: observable conduct and a legal/mental-state characterization are separate facts. Delay, non-performance or evasiveness alone does not establish intent, fraud or another legal conclusion.
7. **Unsupported-element gate**: if a fact still lists any unsupported actor, identity, authority, amount, time, object, result, source, coverage, or causal element, the fact cannot be `supported`. Split out the proven portion or downgrade the fact.
8. **Proof-object compatibility gate**: a proof object cannot be more certain than the material facts needed to prove it. If a required related fact is partial/open, keep the proof object partial/open or narrow the proof object.

## Evidence Strength Factors

Assess each proof link by:

1. **Authenticity**: original vs copy/screenshot/transcript; metadata; signature/seal; source traceability.
2. **Relevance**: direct proof vs background or collateral fact.
3. **Completeness**: full context, full pages, full chat sequence, full transaction flow.
4. **Independence**: objective third-party record vs self-produced statement.
5. **Consistency**: aligns with timeline, amounts, identity, and other evidence.
6. **Admissibility/procedure**: collection method, legality, notarization, preservation, translation, certification, chain of custody.
7. **Causal/proof link**: whether the evidence proves the target fact itself or only an adjacent fact.

Score dimensions separately in the analysis. A readable or clear exhibit is not automatically authentic, complete, independent or strong. Overall `probative_strength` cannot exceed the weakest dimension that is essential to the stated proof purpose.

## Gap Types

- `missing_evidence`: necessary proof has no evidence.
- `weak_authenticity`: authenticity or original carrier is uncertain.
- `weak_relevance`: evidence exists but does not directly prove the target fact.
- `contradiction`: evidence conflicts.
- `timeline_break`: sequence has unexplained missing time/event.
- `amount_inconsistency`: payment, price, loss, quantity, or invoice amount mismatch.
- `identity_authority`: identity, agency, authority, account ownership, seal/signature issue.
- `source_defect`: source/provider unclear or self-produced without corroboration.
- `chain_of_custody`: original data/media custody or preservation defect.
- `procedural_risk`: collection, notarization, translation, certification, limitation-period, or filing/service issue.
- `unclear_fact`: fact is too vague to prove as stated.

## Severity

- `high`: may prevent proof of a key issue/proof object or create serious contradiction.
- `medium`: weakens proof but can likely be cured or explained.
- `low`: affects polish, citation precision, or secondary context.

## Gap Closure Protocol

Define `closure_criteria` when a gap is created. Criteria must describe observable evidentiary conditions, not a desired conclusion. On incremental review, assess each criterion separately:

| Closure status | Required condition |
| --- | --- |
| `remains_open` | No criterion is met, or the newly reviewed material does not address the gap's essential element. |
| `partially_closed` | At least one criterion is met, but one or more essential criteria remain partially met, unmet or unclear; list `remaining_elements`. |
| `closed` | Every criterion is met by reviewed evidence, `closure_evidence_ids` is non-empty, and no essential element remains. |

Do not close a gap because:

- a file with a promising name was uploaded but is unreadable or unreviewed;
- a party repeats the proposition that needs proof;
- evidence proves an adjacent fact but not the missing element;
- a supplement action was attempted rather than completed;
- the narrative becomes more plausible.

When new evidence affects one gap, identify the impact set and preserve unrelated gap states. A gap can change only when the new evidence or a necessary dependency is cited in its closure assessment.

## Supplement Priority

Use `high` priority when:

- a core proof object is unsupported or contradicted;
- original evidence is missing where authenticity will likely be challenged;
- amount/time/identity inconsistency affects claim scope;
- causal link requires objective or expert proof.

Use `medium` priority when:

- evidence exists but needs corroboration;
- locator/source details are incomplete;
- party statement requires objective support.

Use `low` priority when:

- evidence only improves completeness or presentation;
- issue is background or not central to the current theory.

## Supplement Suggestion Pattern

For each suggestion, include:

1. Evidence to collect.
2. Proof purpose.
3. Possible source.
4. Collection method.
5. Priority.
6. Related gap/fact/proof object.
7. The exact closure criterion the evidence is expected to satisfy.

Keep suggestions practical. Examples:

- obtain contract original or signing platform certificate;
- export full chat record from original device, with account identity and timestamps;
- retrieve bank statement with account holder and transaction remarks;
- collect logistics receipt, warehouse record, delivery confirmation, or sign-off sheet;
- request invoice issuance details and matching accounting vouchers;
- preserve webpage/app data through notarization or trusted timestamp;
- obtain authorization letter, employment record, board resolution, seal-use record;
- obtain expert appraisal, audit report, forensic report, medical record, or technical log where causation/specialized fact requires expert support.
