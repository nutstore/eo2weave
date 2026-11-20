/**
 * SQLite-backed persistence for agent step replay data.
 *
 * Migration version 23 (web/sqlite/migrations/index.ts) owns the schema.
 * Only per-step rows are stored: replay matches by (run_id, step_index) plus
 * the prompt hash to detect divergence on rerun.
 */

import { getSQLiteDB } from '@/sqlite/sqlite-database'
import type { AgentStepRecord, AgentStepStore } from './agent-runner'

interface StepRow {
  step_index: number
  prompt_hash: string
  prompt: string | null
  options_key: string | null
  status: string
  agent_id: string | null
  name: string | null
  result: string | null
  started_at: number | null
  finished_at: number | null
}

export function createWorkflowStore(): AgentStepStore {
  const db = () => getSQLiteDB()
  return {
    async listSteps(runId) {
      const rows = await db().queryAll<StepRow>(
        [
          'SELECT step_index, prompt_hash, prompt, options_key, status, agent_id, name, result, started_at, finished_at',
          'FROM workflow_agent_steps',
          'WHERE run_id = ?',
          'ORDER BY step_index ASC',
        ].join(' '),
        [runId]
      )
      return rows.map<AgentStepRecord>((row) => ({
        stepIndex: row.step_index,
        promptHash: row.prompt_hash,
        prompt: row.prompt,
        optionsKey: row.options_key,
        status: row.status === 'completed' ? 'completed' : 'failed',
        agentId: row.agent_id,
        name: row.name,
        result: row.result,
        startedAt: row.started_at ?? undefined,
        finishedAt: row.finished_at ?? undefined,
      }))
    },

    async saveStep(input) {
      await db().execute(
        [
          'INSERT INTO workflow_agent_steps',
          '  (run_id, step_index, prompt_hash, prompt, options_key, agent_id, name, status, result, usage_json, error_json, started_at, finished_at)',
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          'ON CONFLICT(run_id, step_index) DO UPDATE SET',
          '  prompt_hash = excluded.prompt_hash,',
          '  prompt = excluded.prompt,',
          '  options_key = excluded.options_key,',
          '  agent_id = excluded.agent_id,',
          '  name = excluded.name,',
          '  status = excluded.status,',
          '  result = excluded.result,',
          '  usage_json = excluded.usage_json,',
          '  error_json = excluded.error_json,',
          '  started_at = excluded.started_at,',
          '  finished_at = excluded.finished_at',
        ].join('\n'),
        [
          input.runId,
          input.stepIndex,
          input.promptHash,
          input.prompt,
          input.optionsKey,
          input.agentId,
          input.name,
          input.status,
          input.result,
          input.usageJson,
          input.errorJson,
          input.startedAt,
          input.finishedAt,
        ]
      )
    },
  }
}
