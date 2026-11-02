---
name: cw-code-review-expert
description: Conduct a rigorous, evidence-based code review for a change set, pull request, diff, or selected files. Use when users ask to review code, assess a PR, find bugs/security/performance risks, validate a refactor, or request a second engineering opinion. Inspect scope before details, load targeted checklists progressively, prioritize only actionable findings as P0-P3, and report before making any code changes.
description.zh-CN: "对变更集、Pull Request、diff 或选定文件进行严谨、基于证据的代码审查。当用户要求审查代码、评估 PR、查找缺陷/安全/性能风险、验证重构质量或需要第二工程意见时使用。先看整体范围再看细节，逐条给出可执行的修改建议。"
category: coding
tags: [code-review, security, architecture, quality, performance]
triggers:
  keywords: [code review, review代码, 代码审查, 审查PR, review PR, 检查代码, 看看改动, code quality, 安全审查, 安全检查]
---

# Code Review Expert

Perform a review as a careful senior engineer: establish the change intent and blast radius first, then evaluate correctness, architecture, security, and maintainability. A review is not a style-comment generator. Report only findings with concrete evidence, a plausible failure mode, and a proportionate remediation.

## Operating principles

- **Review before editing.** Do not modify project files unless the user explicitly asks to address selected findings after receiving the review.
- **Review the change, not the repository in the abstract.** Focus on changed code and the nearby contract/dependencies needed to assess it.
- **Be evidence-based.** Every finding needs a file path, location (line/range or uniquely identifiable symbol), observed code pattern, and consequence.
- **Avoid speculation.** Do not report a possible concern if the code or its immediate context disproves it. State assumptions when validation is unavailable.
- **Prioritize signal.** Do not pad the report with naming or formatting preferences already enforced by a formatter/linter.
- **Use progressive disclosure.** Load only the reference checklist relevant to the current review phase.

## Workflow

### 1. Establish scope and intent (Preflight)

1. Identify the review target: git diff/PR, explicit file list, commit range, or pasted code.
2. Inspect changed-file summary and the actual diff. If the toolchain or repository does not provide a diff, ask for a target or review the supplied files as a constrained code review.
3. Summarize in 2-4 bullets:
   - what behavior is being changed;
   - which system boundaries are affected (API, database, auth, filesystem, async/concurrency, UI state, external service);
   - which invariants must remain true;
   - whether the diff is too large to safely review as one unit.
4. For a large or mixed change set (roughly >500 changed lines or multiple independent features), split the review into coherent batches. State the batch boundaries before proceeding.

Do not start from line-level nits. First determine whether the change design makes sense.

### 2. Review correctness and architecture

Read `references/architecture-checklist.md` before this phase.

Check public contracts, data flow, state ownership, error boundaries, lifecycle/cleanup, dependency direction, and the smallest relevant SOLID concerns. Examine neighboring callers or tests only when needed to verify a suspected issue.

### 3. Review security and data integrity

Read `references/security-checklist.md` before this phase when the change touches user input, authentication/authorization, network, persistence, files, URLs, secrets, serialization, or concurrent state. For unrelated pure presentation changes, skip it and state why.

Assess exploitability and impact; do not label an issue as security-critical without a concrete attacker-controlled path or integrity failure.

### 4. Review quality, reliability, and performance

Read `references/quality-checklist.md` before this phase.

Check error handling, async behavior, cleanup, null/empty boundaries, resource usage, testability, unnecessary complexity, and performance regressions. Apply the checklist proportionally to the runtime and scale evident in the code.

### 5. Identify removal opportunities

Read `references/removal-plan.md` only when the change introduces replacement paths, deprecates APIs, changes feature flags, or exposes dead/duplicated code.

Separate code that is demonstrably safe to remove now from code that needs a migration or observability plan.

### 6. Validate suspected findings

Before reporting a P0 or P1 finding, inspect enough surrounding code to answer:

- Is the behavior actually reachable?
- Does an existing guard, transaction, framework guarantee, or caller contract make it safe?
- What input/state sequence triggers it?
- Is there a focused test that would expose it?

If you cannot validate it due to missing context, downgrade the certainty and ask one targeted question instead of presenting it as a defect.

## Severity rubric

| Severity | Meaning | Expected handling |
|---|---|---|
| **P0 — Blocker** | Exploitable security flaw, data loss/corruption, outage, or consistently broken core behavior. | Must fix before merge. |
| **P1 — High** | Likely production defect, authorization/integrity gap, serious reliability regression, or materially incorrect behavior. | Fix before merge unless an explicit, time-bound exception exists. |
| **P2 — Medium** | Real maintainability, edge-case, performance, or resilience issue with bounded impact. | Fix in this change when cheap, otherwise create a concrete follow-up. |
| **P3 — Low** | Optional improvement with clear benefit but no meaningful near-term risk. | Do not block merge. |

Do not invent P0/P1 findings merely to make the review look thorough.

## Required report format

Use this exact structure:

```markdown
# Code Review

## Scope understood
- [Intent and affected boundaries]

## Findings

### P1 — [short, outcome-focused title]
**Location:** `path/to/file.ts:42-57` (`functionOrSymbol`)

**Evidence:** [Describe the concrete code path or pattern.]  
**Impact:** [Describe what fails, for whom, and under which conditions.]  
**Recommendation:** [Smallest safe change or a clearly scoped alternative.]  
**Verification:** [Focused test, reproduction, or assertion.]  

## Questions / assumptions
- [Only unresolved items that materially affect review confidence.]

## Strengths
- [0-3 specific things implemented well.]

## Suggested next step
[Ask whether to fix all findings, only P0/P1, selected findings, or keep this review-only.]
```

Rules:
- Order findings P0 → P3, then by user impact.
- Omit empty severity headings.
- If no actionable issues are found, say **“No actionable findings found”**, list what you checked, and state residual risks or unreviewed boundaries.
- Never make edits as part of the report. Wait for the user's explicit choice.

## Follow-up remediation

When the user selects findings to fix:

1. Restate the selected finding IDs and intended minimal changes.
2. Make only the requested edits.
3. Run the narrowest available validation (targeted test, type-check, lint, or reproduction).
4. Report changed files, validation results, and remaining known risks.

If a finding requires a broad migration, produce a staged removal/migration plan rather than making speculative wide-ranging edits.
