# 轮次记录结构 1.0

`round-input.json` 是 C 在一次正式案件更新检查点写下的观察。聊天中的每条消息不单独构成轮次；它与 schema 1.1 的证据链 JSON 并存，不增加核心字段、不重定义核心状态。`record_evidence_round.py` 接收 before/after 快照及该记录，严格校验两份快照，计算变化并生成不可覆盖的轮次目录。

## 输入结构

```json
{
  "schema_version": "1.0",
  "case_id": "case_001",
  "round_id": "round_0001",
  "previous_round_id": null,
  "created_at": "2026-10-14T14:00:00+08:00",
  "run_context": {"model": "unknown", "run_ref": "当前会话或运行记录定位"},
  "demand": {
    "before": "律师确认的当前诉讼需求",
    "after": "律师确认的当前诉讼需求",
    "change_reason": null
  },
  "inputs": [
    {
      "id": "input_001",
      "kind": "text",
      "source_ref": "会话记录:消息12",
      "locator": "第2段",
      "provider": "当事人B",
      "summary": "当事人称无法取得完整记录",
      "response_to_request_ids": ["req_001"]
    }
  ],
  "decisions": [
    {
      "id": "dec_001",
      "input_ids": ["input_001"],
      "action": "no_material",
      "object_ids": ["gap_001"],
      "evidence_ids": [],
      "reason": "回答了取得障碍，但未提供可满足关闭条件的新材料",
      "limits": "不能据此判断目标事件是否发生",
      "important": false,
      "duplicate_of": null,
      "supersedes": []
    }
  ],
  "requests": [
    {
      "id": "req_001",
      "question": "能否从原始设备导出所需期间的完整记录？",
      "requested_material": "带身份、时间和完整上下文的原始记录",
      "proof_purpose": "核查 gap_001 尚缺要素",
      "gap_ids": ["gap_001"],
      "proof_object_ids": [],
      "supplement_ids": [],
      "criterion_targets": [{"gap_id": "gap_001", "criterion": "对应A中条件的原文"}],
      "priority": "high",
      "status": "blocked",
      "blocked_reason": "原始设备暂不可取得"
    }
  ],
  "feedback": [],
  "next_step_reason": "尝试其他来源；本轮没有关闭 gap_001"
}
```

这是字段示意，引用必须替换为真实 A 中的 ID 和关闭条件。未知信息写 `unknown`，不虚构时间、模型或意见来源。

## 字段要求

- 顶层上述字段全部提供；数组可以为空。`created_at` 必须包含时区。case_id 跨轮稳定，round_id 在案件内唯一；previous_round_id 用于关联前轮。
- previous_round_id 非空时，命令必须提供 `--previous-record`；A-before 的字节哈希和 demand.before 必须接续前轮 A-after 和 demand.after。前轮 open/blocked 请求必须继续列出并更新状态；未复核事项自动继承。
- `run_context.model/run_ref` 为非空字符串。模型未知时写 unknown。工具自动记录当时技能文件哈希、before/after 文件哈希和实际校验结果。
- `demand.before/after` 非空；发生变化时必须说明 `change_reason`，并用 `reassessment` 决策关联 `$demand`，指出真实律师需求来源。
- `inputs.kind` 为 `text/file/unavailable`；id、source_ref、locator、provider、summary 非空。所有输入至少对应一项决定。source_ref 应定位原话或原始文件，不能只指向 C 的总结。
- 输入的 `response_to_request_ids` 指向本记录 requests 中沿用或新建的请求；不是回复特定问题时用空数组。请求可携带此前状态。
- input、decision、feedback 的 ID 在案件内作为事件 ID 唯一；新轮次不要复用旧事件 ID。request ID 则沿用以保持问题连续性。
- `decisions.action` 为 `use/pending/exclude_duplicate/exclude_irrelevant/no_material/correction/reassessment`。id、reason、limits 非空，important 为布尔值；常规输入决定至少有一个 input_id。无新输入的重评必须有明确理由或真实反馈。
- `object_ids` 是 before/after 中受影响或已检查的 ID；需求、元数据、限制的变化分别用 `$demand`、`$case_metadata`、`$limits_and_assumptions`。每个实际改变或移除的对象必须得到至少一项决策解释。
- `evidence_ids` 引用快照内真实证据。决定中的 use 不意味着所关联事实 supported；状态由原有流程决定。
- `duplicate_of` 在 exclude_duplicate 时必填，指向原始文件/消息或此前 input 定位。`supersedes` 为被更正决定的定位列表，如 `round_0001:dec_001`；correction 时非空。先查看被引用的旧轮次，再引用它。工具校验格式，不能代替查看跨轮来源。
- `requests` 必填 question、requested_material、proof_purpose；priority 为 high/medium/low，status 为 open/answered/blocked/withdrawn。引用字段均为数组。每个请求至少关联一个 gap、po 或 supplement；每个 gap 至少关联其一个尚未 met 的关闭条件原文。工具检查条件存在，C 判断该问题是否有用。
- blocked 请求提供 blocked_reason；不重复追问已回答的问题，必要时另建更具体请求。脚本拒绝把关闭 gap 作为唯一目标的 open 请求。
- `feedback` 每项包含 id、target_id、verdict、reviewer、source_ref、reason。verdict 为 confirmed/corrected/disputed；target_id 为本轮 decision ID 或 before/after 对象 ID。source_ref 必须定位实际律师意见，不允许 C 自填确认。此前复核项可在后轮引用其对象 ID；此前决定使用 reassessment 的 supersedes 留存跨轮定位。
- `next_step_reason` 非空；解释继续补证、等待、重评或没有可行补证方向的原因。no_actionable_request 不等于案件完成。

## 自动产物

`round-record.json` 保存原始 round-input 字段，以及：

- `snapshot_hashes`、`skill_hashes`：可复核的 SHA-256。
- `validation`：原有 strict 校验的 before/after 错误、警告与信息；与轮次记录检查分列。passed 只指实际执行的检查。
- `changes`：逐 section/ID 计算 added/changed/retired；保留 before、after 完整对象。`unchanged_ids` 按 section 列出；数组重排不算对象变化。
- `review_queue`：脚本按变化和 important 决策生成，记录 target_id、原因及真实反馈结果，未反馈显示 pending。corrected/disputed 保留为待重评，不当作已经修复。
- `workflow_status`：优先为 needs_reassessment，其次 awaiting_lawyer、awaiting_client、blocked_collection、no_actionable_request。

`round-update.md` 从这些实际结果渲染，包括每项字段变化、引用决策、缺口条件、反馈和下一轮问题。它不替代 `evidence-chain-report.md`。

`A-before.json` 和 `A-after.json` 是原文件字节快照。每轮创建新目录，脚本拒绝覆盖旧目录或输入文件。历史反馈通过后轮追加，不覆写旧记录。文件引用会保留原定位，但原始材料仍需案件目录自行保存；哈希不证明来源真实性。
