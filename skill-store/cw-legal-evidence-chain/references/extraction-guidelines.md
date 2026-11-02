# Extraction Guidelines

Use these guidelines when reviewing mixed case materials. Let CreatorWeave's file tools handle reading, OCR, media transcription, spreadsheet parsing, and search. This guide governs what to extract and how to label it.

## Material Inventory

For each reviewed material, capture:

- file path/name;
- material type;
- formation time if visible;
- provider/source if visible;
- reviewed range;
- extraction limitations such as OCR uncertainty, missing pages, cropped screenshots, unreadable handwriting, incomplete chat context, or missing original media.
- whether it is an original/source material or a derivative such as OCR text, transcription, summary, report or re-export; link derivatives to their source rather than treating them as independent corroboration.

Use the review status literally. `unreadable` and `unavailable` materials cannot support their supposed contents. `partially_reviewed` materials support only the reviewed, readable range.

## Fact Extraction

Extract facts that affect proof, not every sentence. Prioritize:

- parties, identities, authority, relationships;
- formation and performance of legal relationships;
- communications, notices, confirmations, instructions;
- payment, transfer, delivery, receipt, custody, possession;
- breach, damage, loss, causation, mitigation;
- procedural facts such as filing, service, appraisal, investigation, enforcement;
- admissions, denials, inconsistent statements;
- facts necessary to explain evidence authenticity or source.

### Atomic Proposition Rule

Each fact should be capable of receiving one support state without internal conflict. Split a sentence when any of these elements has a different source or support level:

- actor or identity;
- action, communication or omission;
- object or purpose;
- amount or quantity;
- time or duration;
- result, loss or consequence;
- causal or legal characterization.

For example, an instruction, a booking, a payment and a loss are ordinarily separate facts even when narrated in one sentence. Preserve the narrative connection through `relations`, not by merging the propositions.

Classify each fact:

- `key_fact`: central to proof;
- `background`: context only;
- `procedural`: litigation/procedure-related;
- `claim`: asserted by one side;
- `defense`: opposing assertion;
- `allegation`: party statement not yet supported;
- `inference`: derived from multiple materials.
- `statement`: the observable fact that a statement, promise, admission, denial or notice was made.
- `negative_state`: a bounded non-occurrence or continuing state, such as no payment found in a defined review period and dataset.

## Evidence Extraction

Evidence items should be granular enough to cite. A long PDF may produce several evidence items if different pages prove different facts.

Capture:

- stable evidence ID;
- title;
- file path and locator;
- evidence type;
- formation time;
- provider/source;
- content summary;
- proof purpose;
- related facts/proof objects;
- authenticity/relevance/probative strength;
- risk notes.

## Distinguish Statements From Proof

Use these labels:

- **陈述事实**: appears only in a party statement, pleading, interview, or self-written explanation.
- **证据支持事实**: supported by document, electronic data, transaction record, official record, or mutually corroborating materials.
- **推断事实**: inferred from several materials, with basis and uncertainty stated.
- **待证事实**: necessary but unsupported or only partially supported.

Apply two layers to communications and pleadings:

1. **Statement occurrence/content**: who said what, to whom, when and in what context. The communication itself may directly prove this layer.
2. **Underlying truth**: whether the event described in that statement actually happened. This normally requires independent evidence or corroboration.

Do not convert “甲称目标事件已经发生” into “目标事件已经发生”. Extract “甲作出该项陈述” as a supported `statement`, and extract the underlying event separately with its own support state.

### Negative And Continuing Facts

For any non-occurrence or continuing-state proposition:

- state a cutoff using `time_scope.as_of` or a bounded end;
- state which materials, periods, actors, accounts and channels were reviewed in `support_scope`;
- identify uncovered scope in `unsupported_elements`;
- avoid unlimited words such as “一直”“至今”“全部”“从未” unless the reviewed evidence actually covers that scope.

A demand letter, pleading or chat message can prove that non-payment/non-refund was asserted at that time. It does not by itself prove the objective account state through a later cutoff.

## Common Mixed-Material Handling Notes

### Contracts and Agreements

Extract parties, title/role, date, signatures/seals, major terms, payment/performance terms, jurisdiction/dispute clauses, versions, and missing originals.

### Chat Records

Extract sender, recipient, account identity, full context, timestamps, attachments, admissions, notices, delivery/receipt confirmations, and whether original device/export is available.

### Bank and Transaction Records

Extract payer/payee, account, amount, time, purpose/remark, transaction number, sequence, refunds, split payments, and match to contract/invoice/order facts.

### Invoices and Accounting Materials

Extract issuer, recipient, amount, item, tax number, date, invoice code/number, relation to contract/performance/payment, and whether invoice alone proves performance.

### Images, Screenshots, Audio, Video

Extract visible metadata, capture context, creator/source, time, continuity, completeness, and whether original carrier exists. Flag editing, cropping, missing context, or transcript-only risks.

Visual clarity is not the same as authenticity or completeness. A clear screenshot may still have only medium or weak probative strength if account identity, original carrier, full context or metadata is missing.

### Official or Judicial Documents

Extract issuing body, date, case/reference number, findings, procedural effect, finality, and whether facts are binding or merely recorded allegations.

## Source Citation Style

In reports, cite sources compactly:

- `ev_001《文件名》第3页`
- `ev_014 聊天记录 2024-03-18 14:22-14:35`
- `ev_022 银行流水第12行`

If exact page/line is unavailable, say `定位待补`.

If exact date, amount, identity or locator is unavailable, use `unknown`, a range or an explicit limitation. Do not infer precision from filenames, output timestamps or surrounding narrative.
