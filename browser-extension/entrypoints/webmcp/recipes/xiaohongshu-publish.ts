import { HOST, error, result, navigation } from './xiaohongshu-page'
import { CREATOR_HOST, PUBLISH_URL, publishRequest, imageMime, MAX_IMAGE_BYTES } from './xiaohongshu-publish-policy'
import type { PublishRequest, ImagePayload } from './xiaohongshu-publish-policy'
import { takeXiaohongshuImage } from './xiaohongshu-publish-transfer'
import { imageTab, previews, elements, editorText, configureForm, formSnapshot, publishButton, clickable, challenge, lengthError, until, successEvidence } from './xiaohongshu-publish-dom'

const JOURNAL_KEY = 'eo2_xhs_image_publish_v1'
type Phase = 'prepared' | 'upload_pending' | 'uploaded' | 'configuring' | 'ready' | 'submitted' | 'verified'
interface Journal {
  operation_id: string; request: PublishRequest; phase: Phase; uploaded: number
  pending_index: number | null; snapshot: string | null; review: unknown
  submitted_at: string | null; evidence: unknown
}
let busy = false
function load(): Journal | null {
  const raw = sessionStorage.getItem(JOURNAL_KEY)
  return raw ? JSON.parse(raw) as Journal : null
}
function save(journal: Journal) { sessionStorage.setItem(JOURNAL_KEY, JSON.stringify(journal)) }
function summary(journal: Journal) {
  return { operation_id: journal.operation_id, phase: journal.phase, image_count: journal.request.images.length,
    uploaded_count: journal.uploaded, rendered_preview_count: previews().length, pending_image_index: journal.pending_index,
    title: journal.request.title, content_length: journal.request.content.length, review: journal.review,
    submit_attempted: journal.submitted_at !== null, published_verified: journal.phase === 'verified' && !journal.request.schedule_at,
    scheduled_submission_verified: journal.phase === 'verified' && journal.request.schedule_at !== null,
    future_delivery_verified: journal.request.schedule_at ? false : null, evidence: journal.evidence,
    automatic_retry_allowed: false }
}
function failed(code: string, message: string, journal: Journal | null) {
  return { ...error(code, message), data: journal ? summary(journal) : { submit_attempted: false, automatic_retry_allowed: false } }
}
function reconcile(journal: Journal) {
  if (journal.phase === 'upload_pending' && journal.pending_index !== null && previews().length === journal.pending_index + 1) {
    journal.uploaded = journal.pending_index + 1; journal.pending_index = null
    journal.phase = journal.uploaded === journal.request.images.length ? 'uploaded' : 'prepared'
    save(journal)
  }
  if (journal.phase === 'submitted') {
    const evidence = successEvidence()
    if (evidence && !location.pathname.includes('/publish/publish')) {
      journal.phase = 'verified'; journal.evidence = evidence; save(journal)
    }
  }
}
function filePayload(raw: unknown): File {
  const payload = raw as ImagePayload | undefined
  if (!payload || typeof payload.base64 !== 'string' || typeof payload.mime !== 'string' || typeof payload.name !== 'string') throw new Error('EO2 image transfer unavailable. Use call_tool from the side panel with an authorized file or HTTP/HTTPS image.')
  if (payload.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Image payload exceeds transport capacity.')
  const binary = atob(payload.base64)
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || imageMime(bytes) !== payload.mime) throw new Error('Transferred image signature or size did not verify.')
  return new File([bytes], payload.name, { type: payload.mime })
}
export const xiaohongshuPublishTools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  async xhs_publish_content(args) {
    if (![HOST, CREATOR_HOST].includes(location.hostname)) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    if (args.action === 'open') {
      if (location.hostname === CREATOR_HOST && location.pathname === '/publish/publish') return result('ok', { publish_page_open: true })
      return navigation(PUBLISH_URL, 'Navigate this same tab to the upstream creator publish page, then rediscover tools. Complete creator sign-in manually if required.')
    }
    if (location.hostname !== CREATOR_HOST) return error('NOT_CREATOR_PAGE', 'Call action=open, then rediscover tools on the same bound tab.')
    if (!['prepare', 'upload', 'configure', 'submit', 'status'].includes(String(args.action))) return error('INVALID_ACTION', 'Unknown publication action.')
    if (typeof args.operation_id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(args.operation_id)) return error('INVALID_OPERATION_ID', 'Use the same 8-80 character operation_id for all steps of one publication.')
    if (busy) return error('PUBLISH_BUSY', 'Another publication action is running in this tab. Query status after it finishes.')
    busy = true
    let journal: Journal | null = null
    try {
      journal = load()
      if (journal) reconcile(journal)
      if (args.action === 'status') {
        if (!journal || journal.operation_id !== args.operation_id) return failed('OPERATION_NOT_FOUND', 'No matching publication journal in this tab. An interrupted submit must be checked manually; do not create a replacement task automatically.', journal)
        if (journal.phase === 'submitted') return failed('PUBLISH_RESULT_UNKNOWN', 'Submission was attempted, but publication is not verified. Navigation alone is not success. Inspect the creator website; never automatically resubmit.', journal)
        return result('ok', summary(journal))
      }
      if (journal && journal.operation_id !== args.operation_id && journal.phase !== 'verified') {
        const emptyUploadForm = document.querySelector('input.upload-input[type="file"]') && !previews().length && !elements('div.d-input input').some((el) => (el as HTMLInputElement).value) && !elements('[contenteditable="true"]').some((el) => editorText(el))
        if (args.action === 'prepare' && !journal.submitted_at && emptyUploadForm) journal = null
        else return failed('PUBLISH_OPERATION_UNRESOLVED', 'This tab has an unfinished publication. Before submission, clear the website draft to start another task. Uncertain submissions must not be repeated.', journal)
      }
      if (journal?.operation_id === args.operation_id && journal.submitted_at) {
        return journal.phase === 'verified' ? result('ok', summary(journal)) : failed('PUBLISH_RESULT_UNKNOWN', 'This operation already attempted submission. Query status and verify manually; another click is prohibited.', journal)
      }
      if (challenge()) return failed('CREATOR_ACTION_REQUIRED', 'The creator website requires sign-in or verification. Complete it manually; no login automation is added.', journal)
      if (location.pathname !== '/publish/publish') return failed('NOT_PUBLISH_PAGE', 'Open the upstream creator publish page in this same tab.', journal)
      const deadline = Date.now() + 45000
      if (args.action === 'prepare') {
        const request = publishRequest(args)
        if (journal?.operation_id === args.operation_id) {
          if (JSON.stringify(request) !== JSON.stringify(journal.request)) return failed('OPERATION_ARGUMENT_MISMATCH', 'An operation_id cannot be reused with different content or options.', journal)
          return result('ok', summary(journal))
        }
        await imageTab(Math.min(deadline, Date.now() + 15000))
        // Preserve the existing draft instead of overwriting a user's unrelated content.
        if (previews().length || elements('div.d-input input').some((el) => (el as HTMLInputElement).value) || elements('[contenteditable="true"]').some((el) => editorText(el))) return failed('EXISTING_DRAFT', 'The creator form contains an existing draft. Review or clear it on the website before preparing this publication.', journal)
        journal = { operation_id: args.operation_id, request, phase: 'prepared', uploaded: 0, pending_index: null, snapshot: null, review: null, submitted_at: null, evidence: null }
        save(journal)
        return result('ok', summary(journal))
      }
      if (!journal || journal.operation_id !== args.operation_id) return failed('OPERATION_NOT_FOUND', 'Prepare this operation before uploading or submitting.', journal)
      if (args.action === 'upload') {
        const index = args.image_index
        if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= journal.request.images.length || args.image !== journal.request.images[Number(index)]) return failed('IMAGE_ARGUMENT_MISMATCH', 'image_index and image must match the original ordered image list.', journal)
        if (Number(index) < journal.uploaded) return result('ok', summary(journal))
        if (journal.phase === 'upload_pending') return failed('UPLOAD_PENDING', 'An image was already supplied to the website. Query status to observe its preview; do not upload it again automatically.', journal)
        if (journal.phase !== 'prepared' || index !== journal.uploaded || previews().length !== journal.uploaded) return failed('UPLOAD_STATE_MISMATCH', 'Upload images in order; current previews must match the acknowledged count.', journal)
        const file = filePayload(takeXiaohongshuImage(args))
        // Use upstream image input selection; never fall back to an unrelated video input.
        const candidates = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
          .filter((el) => !el.disabled && (journal!.uploaded === 0 ? el.matches('.upload-input') : /image\/|\.(?:jpe?g|png|webp|heic)/i.test(el.accept)))
        if (candidates.length !== 1) return failed('UPLOAD_INPUT_UNAVAILABLE', 'Image upload input unavailable or ambiguous.', journal)
        const transfer = new DataTransfer(); transfer.items.add(file)
        journal.phase = 'upload_pending'; journal.pending_index = Number(index); save(journal)
        candidates[0].files = transfer.files
        candidates[0].dispatchEvent(new Event('change', { bubbles: true }))
        try { await until(() => previews().length === Number(index) + 1, Date.now() + 20000, 'Image preview not observed within this call.') }
        catch { return failed('UPLOAD_PENDING', 'File was supplied but its preview is not yet verified. Query status before continuing; do not automatically re-upload.', journal) }
        reconcile(journal)
        return result('ok', summary(journal))
      }
      if (args.action === 'configure') {
        if (journal.phase === 'ready') return result('ok', summary(journal))
        if (!['uploaded', 'configuring'].includes(journal.phase) || previews().length !== journal.request.images.length) return failed('CONFIGURATION_NOT_READY', 'All ordered image previews must be observed before filling the form. A partial configuration requires manual review before explicitly retrying configure.', journal)
        journal.phase = 'configuring'; save(journal)
        journal.review = await configureForm(journal.request, deadline)
        journal.snapshot = formSnapshot(); journal.phase = 'ready'; save(journal)
        return result('ok', { ...summary(journal), next_step: 'Review the visible form and returned options; submit only when the user requested this exact publication.' })
      }
      if (args.confirm !== true) return failed('CONFIRMATION_REQUIRED', 'submit requires confirm=true only for user-requested publication of the reviewed content.', journal)
      if (journal.phase !== 'ready' || !journal.snapshot) return failed('PUBLICATION_NOT_READY', 'Configure and review this publication before submitting.', journal)
      if (formSnapshot() !== journal.snapshot || previews().length !== journal.request.images.length || lengthError()) return failed('DRAFT_CHANGED', 'The visible draft differs from the reviewed form or has validation errors. Publication was not submitted.', journal)
      if (journal.request.schedule_at) publishRequest({ ...journal.request, schedule_at: journal.request.schedule_at })
      const button = clickable(publishButton())
      if (successEvidence()) return failed('STALE_SUCCESS_EVIDENCE', 'A preexisting success message cannot verify a new publication.', journal)
      // Persist before clicking. A page teardown or relay failure cannot authorize a second click.
      journal.phase = 'submitted'; journal.submitted_at = new Date().toISOString(); save(journal)
      button.click()
      try { await until(() => { reconcile(journal!); return journal!.phase === 'verified' }, Date.now() + 15000, 'Publication outcome unknown.') }
      catch { return failed('PUBLISH_RESULT_UNKNOWN', 'Submission was attempted, but no verified success page was observed. Query status after navigation or inspect the creator website; never automatically repeat publishing.', journal) }
      return result('ok', summary(journal))
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Publication action failed.'
      return failed(journal?.submitted_at ? 'PUBLISH_RESULT_UNKNOWN' : 'PUBLISH_STEP_FAILED', message, journal)
    } finally { busy = false }
  },
}
