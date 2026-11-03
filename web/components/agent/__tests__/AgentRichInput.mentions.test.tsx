import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AgentRichInput } from '@/components/agent/AgentRichInput'
import { InlineMessageEditor } from '@/components/agent/InlineMessageEditor'

vi.mock('@/store/asset.store', () => ({
  useAssetStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ pendingAssets: [] }),
    {
      getState: () => ({ clearAll: vi.fn() }),
    }
  ),
}))
vi.mock('@/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('@creatorweave/ui', () => ({
  TooltipProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/agent/SlashCommandExtension', () => ({ SlashCommandExtension: { configure: () => ({}) } }))

const agents = [{ id: 'resource-loop', name: 'Resource Loop' }]
function inputProps(candidates = agents) {
  return {
    placeholder: 'Message',
    agents: candidates,
    allAgents: candidates,
    activeAgentId: 'default',
    onSetActiveAgent: vi.fn(async () => {}),
    onCreateAgent: vi.fn(async () => null),
    onDeleteAgent: vi.fn(async () => true),
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onSearchFiles: vi.fn(async () => []),
  }
}
async function getEditor(container: HTMLElement) {
  let editor!: Editor
  await waitFor(() => {
    editor = (container.querySelector('.tiptap') as HTMLElement & { editor: Editor })?.editor
    expect(editor).toBeDefined()
  })
  return editor
}

describe('AgentRichInput mentions', () => {
  it('shows @ candidates, selects with Enter, and emits a highlighted Agent ID without submitting', async () => {
    const props = inputProps()
    const { container } = render(<AgentRichInput {...props} />)
    const editor = await getEditor(container)
    await act(async () => {
      editor.chain().focus().insertContent('@res').run()
    })
    await screen.findByRole('option')
    expect(container.querySelector('[data-decoration-id]')?.className).toContain('bg-primary-100')
    fireEvent.keyDown(editor.view.dom, { key: 'Enter' })
    await waitFor(() => {
      expect(
        container.querySelector('[data-type="mention"][data-id="resource-loop"]')
      ).not.toBeNull()
      expect(props.onChange).toHaveBeenLastCalledWith({
        text: '@resource-loop ',
        mentionedAgentIds: ['resource-loop'],
      })
    })
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('refreshes candidates when Agents finish loading after @ was typed', async () => {
    const props = inputProps([])
    const { container, rerender } = render(<AgentRichInput {...props} />)
    const editor = await getEditor(container)
    await act(async () => {
      editor.chain().focus().insertContent('@').run()
    })
    expect(screen.queryByRole('option')).toBeNull()
    rerender(<AgentRichInput {...props} agents={agents} allAgents={agents} />)
    await screen.findByRole('option')
  })

  it('keeps dismissed suggestions closed when the Agent catalog changes', async () => {
    const props = inputProps()
    const { container, rerender } = render(<AgentRichInput {...props} />)
    const editor = await getEditor(container)
    await act(async () => {
      editor.chain().focus().insertContent('@').run()
    })
    await screen.findByRole('option')
    fireEvent.keyDown(editor.view.dom, { key: 'Escape' })
    rerender(<AgentRichInput {...props} agents={[...agents]} />)
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('also refreshes late Agent candidates in the inline message editor', async () => {
    const props = {
      initialContent: '',
      agents: [] as typeof agents,
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
      cancelLabel: 'Cancel',
      submitLabel: 'Save',
    }
    const { container, rerender } = render(<InlineMessageEditor {...props} />)
    const editor = await getEditor(container)
    await act(async () => {
      editor.chain().focus().insertContent('@res').run()
    })
    rerender(<InlineMessageEditor {...props} agents={agents} />)
    await waitFor(() => expect(container.textContent).toContain('@resource-loop'))
    const candidate = screen.getByText('@resource-loop')
    fireEvent.mouseDown(candidate)
    await waitFor(() =>
      expect(
        container.querySelector('[data-type="mention"][data-id="resource-loop"]')
      ).not.toBeNull()
    )
    expect(props.onSubmit).not.toHaveBeenCalled()
  })
})
