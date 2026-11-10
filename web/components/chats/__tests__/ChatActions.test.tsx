import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const actions = vi.hoisted(() => ({ rename: vi.fn(), remove: vi.fn(async () => {}) }))
vi.mock('@/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('@/store/conversation.store', () => ({
  useConversationStore: (selector: (state: unknown) => unknown) => selector({ updateTitle: actions.rename, deleteConversation: actions.remove }),
}))
vi.mock('@/components/conversation/ExportConversationDialog', () => ({ ExportConversationDialog: () => null }))
vi.mock('@creatorweave/ui', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => <button onClick={onSelect}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
  BrandDialog: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <div>{children}</div> : null,
  BrandDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BrandDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BrandDialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BrandDialogBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BrandDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BrandButton: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; iconButton?: boolean }) => <button onClick={onClick} aria-label={props['aria-label']}>{children}</button>,
  BrandInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

import { ChatActions } from '../ChatActions'

describe('standalone chat management', () => {
  it('shows additional tools in the same menu as conversation actions', () => {
    render(<ChatActions id="chat-a" title="Original" extraItems={<button>Settings</button>} />)
    expect(screen.getByText('sidebar.renameWorkspace')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('renames the selected conversation', () => {
    render(<ChatActions id="chat-a" title="Original" />)
    fireEvent.click(screen.getByText('sidebar.renameWorkspace'))
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Updated' } })
    fireEvent.click(screen.getByText('common.save'))
    expect(actions.rename).toHaveBeenCalledWith('chat-a', 'Updated')
  })

  it('deletes only after confirmation and notifies the caller', async () => {
    const onDeleted = vi.fn()
    render(<ChatActions id="chat-b" title="Delete me" onDeleted={onDeleted} />)
    fireEvent.click(screen.getByText('sidebar.deleteWorkspace'))
    expect(actions.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('common.delete'))
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(actions.remove).toHaveBeenCalledWith('chat-b')
  })
})
