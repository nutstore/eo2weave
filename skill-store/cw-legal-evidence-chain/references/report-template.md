# Lawyer-Facing Evidence Chain Report Template

Use this template by default unless the lawyer requests a different format.

```markdown
# 证据链分析报告

## 一、材料审阅范围

| 序号 | 材料 | 类型 | 审阅状态 | 备注 |
| --- | --- | --- | --- | --- |
| mat_001 |  |  | reviewed/partially_reviewed/unreadable |  |

## 二、初步结论摘要

1. 本次材料可初步支持的核心事实：
2. 当前证据链的主要薄弱环节：
3. 优先补证方向：

> 说明：本报告聚焦证据链整理与补证辅助，不替代律师对实体法律问题、诉讼策略及证据可采性的最终判断。

## 三、争议焦点与证明对象

| 编号 | 争议焦点/证明对象 | 重要性 | 当前支持状态 | 关联事实 | 主要证据 |
| --- | --- | --- | --- | --- | --- |
| po_001 |  | high/medium/low | supported/partially_supported/unsupported/contradicted/unclear | fact_001 | ev_001 |

## 四、关键事实梳理

| 事实编号 | 事实陈述 | 时间/截止点 | 主体 | 来源基础 | 支持状态 | 支持证据 | 支持范围/未支持要素 | 风险提示 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fact_001 |  |  |  | direct_evidence/party_statement/inference/mixed |  | ev_001 |  |  |

## 五、证据目录

| 证据编号 | 证据名称 | 来源/定位 | 类型 | 形成时间 | 证明目的 | 证明力 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ev_001 |  |  |  |  |  | strong/medium/weak/unknown |  |

## 六、证据链总览

| 证明对象 | 关键事实 | 支持证据 | 关联关系 | 链条强度 | 主要风险 |
| --- | --- | --- | --- | --- | --- |
| po_001 | fact_001 | ev_001 | logical_support/causal/... | strong/medium/weak/unclear |  |

## 七、事实关系与链条说明

### 1. 时间关系

- rel_001：

### 2. 逻辑支持关系

- rel_002：

### 3. 因果关系

- rel_003：

### 4. 资金流/物流/信息流/身份权限关系

- rel_004：

### 5. 佐证、矛盾与削弱关系

- rel_005：

## 八、证据缺口、矛盾及薄弱环节

| 编号 | 类型 | 涉及事实/证明对象 | 问题描述 | 风险等级 | 关闭状态 | 已满足条件 | 剩余要素 | 处理建议 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gap_001 | missing_evidence | fact_001/po_001 |  | high/medium/low | remains_open/partially_closed/closed |  |  |  |

## 九、待补充证据清单

| 优先级 | 待补证据 | 证明目的 | 可能来源 | 获取/固定方式 | 对应缺口 |
| --- | --- | --- | --- | --- | --- |
| high |  |  |  |  | gap_001 |

## 十、结构化校验摘要

- JSON 校验：passed/failed
- 校验方式：strict validator / manual / not executed
- 校验命令：
- 错误数：
- 警告数：
- 未解决错误：
- 增量更新时的新增/变更/未变 ID：

## 十一、后续工作建议

1.
2.
3.

## 十二、限制与假设

- 本报告基于已审阅材料形成；
- 未读取、无法识别或来源不明的材料可能影响结论；
- 对证据真实性、合法性、关联性及证明力的最终判断，应由承办律师结合案件程序和当地裁判规则复核。
```

## Drafting Rules

- Use tables for reviewability.
- Keep facts and evidence IDs visible.
- State uncertainty in the relevant row, not only at the end.
- Do not bury contradictions; include them in the summary if material.
- If JSON is also output, keep IDs identical between report and JSON.
- Treat validated JSON as the source of truth. Generate or revise the report after JSON validation; do not independently change support states, relation strengths, gap closure states or evidence IDs in prose.
- Do not write "JSON 校验：通过/passed" unless the bundled strict validator actually returned success. A JSON parse, count check, ID uniqueness check or manual review is not equivalent to strict validation.
- If strict validation fails, either fix the JSON and rerun validation before finalizing, or label the report as a draft and copy the unresolved validator errors into the validation summary.
- For statement evidence, state whether it proves only that the statement occurred or also supports the underlying event.
- For negative/continuing facts, show the temporal cutoff and reviewed coverage in the fact row.
- For incremental updates, show closure status, criterion results and remaining elements; do not describe an open or partially closed gap as "已补齐".
- If validation fails, keep the report labeled as a draft and list the unresolved errors in the validation summary.
