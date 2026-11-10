'use client'

import { useState, type ReactNode } from 'react'
import { Download, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  BrandButton, BrandDialog, BrandDialogBody, BrandDialogContent, BrandDialogFooter,
  BrandDialogHeader, BrandDialogTitle, BrandInput, DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@creatorweave/ui'
import { ExportConversationDialog } from '@/components/conversation/ExportConversationDialog'
import { useConversationStore } from '@/store/conversation.store'
import { useT } from '@/i18n'

export function ChatActions({ id, title, onDeleted, extraItems }: { id: string; title: string; onDeleted?: () => void; extraItems?: ReactNode }) {
  const t = useT()
  const updateTitle = useConversationStore((state) => state.updateTitle)
  const deleteConversation = useConversationStore((state) => state.deleteConversation)
  const [dialog, setDialog] = useState<'rename' | 'delete' | 'export' | null>(null)
  const [draft, setDraft] = useState(title)
  const [deleting, setDeleting] = useState(false)

  async function remove() {
    setDeleting(true)
    try {
      await deleteConversation(id)
      setDialog(null)
      onDeleted?.()
    } catch {
      toast.error(t('sidebar.deleteWorkspaceFailed'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={extraItems ? t('topbar.tooltips.more') : t('chats.home.chatActions')} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            <MoreHorizontal className="h-5 w-5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => { setDraft(title); setDialog('rename') }}><Pencil className="h-4 w-4" />{t('sidebar.renameWorkspace')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('export')}><Download className="h-4 w-4" />{t('sidebar.exportWorkspace')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('delete')}><Trash2 className="h-4 w-4" />{t('sidebar.deleteWorkspace')}</DropdownMenuItem>
          {extraItems && <><DropdownMenuSeparator />{extraItems}</>}
        </DropdownMenuContent>
      </DropdownMenu>
      <BrandDialog open={dialog === 'rename'} onOpenChange={(open) => { if (!open) setDialog(null) }}>
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader><BrandDialogTitle>{t('sidebar.renameWorkspace')}</BrandDialogTitle></BrandDialogHeader>
          <BrandDialogBody><BrandInput value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus aria-label={t('sidebar.renameWorkspace')} onKeyDown={(event) => { if (event.key === 'Enter' && draft.trim()) { updateTitle(id, draft.trim()); setDialog(null) } }} /></BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton variant="ghost" onClick={() => setDialog(null)}>{t('common.cancel')}</BrandButton>
            <BrandButton variant="primary" disabled={!draft.trim()} onClick={() => { if (draft.trim()) { updateTitle(id, draft.trim()); setDialog(null) } }}>{t('common.save')}</BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>
      <BrandDialog open={dialog === 'delete'} onOpenChange={(open) => { if (!open && !deleting) setDialog(null) }}>
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader><BrandDialogTitle>{t('sidebar.confirmDeleteWorkspace')}</BrandDialogTitle></BrandDialogHeader>
          <BrandDialogBody><p className="break-words text-sm text-muted-foreground">{title}</p></BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton variant="ghost" disabled={deleting} onClick={() => setDialog(null)}>{t('common.cancel')}</BrandButton>
            <BrandButton variant="danger" disabled={deleting} onClick={() => void remove()}>{t('common.delete')}</BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>
      {dialog === 'export' && <ExportConversationDialog open onOpenChange={(open) => { if (!open) setDialog(null) }} conversationId={id} />}
    </>
  )
}
