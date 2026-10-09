import { HOST, error, result, navigation } from './xiaohongshu-page'
import { CREATOR_HOST, PUBLISH_URL, publishRequest, updatePublishRequest, PUBLISH_FORM_FIELDS, MAX_IMAGE_BYTES } from './xiaohongshu-publish-policy'
import type { PublishRequest, ImagePayload } from './xiaohongshu-publish-policy'
import { takeXiaohongshuImage } from './xiaohongshu-publish-transfer'
import { imageTab, imageUploadInput, delay, previews, elements, configureForm, until } from './xiaohongshu-publish-dom'

const JOURNAL_KEY = 'eo2_xhs_image_publish_v1'
type Phase = 'prepared' | 'upload_pending' | 'uploaded' | 'configuring' | 'ready' | 'submitted' | 'verified'
interface Journal {
  operation_id: string; request: PublishRequest; phase: Phase; uploaded: number; existing_previews?: number
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
    uploaded_count: journal.uploaded, rendered_preview_count: elements('.img-preview-area .pr').length,
    dom_preview_count: previews().length, pending_image_index: journal.pending_index,
    title: journal.request.title, content_length: journal.request.content.length, review: journal.review,
    submit_attempted: journal.submitted_at !== null, published_verified: journal.phase === 'verified' && !journal.request.schedule_at,
    scheduled_submission_verified: journal.phase === 'verified' && journal.request.schedule_at !== null,
    future_delivery_verified: journal.request.schedule_at ? false : null, evidence: journal.evidence,
    existing_preview_count: journal.existing_previews ?? 0, publication_enabled: false,
    next_step: journal.phase === 'ready' ? 'Review the prepared form on the website. Final publishing is deferred; stop here.' : null }
}
function failed(code: string, message: string, journal: Journal | null) {
  return { ...error(code, message), data: journal ? summary(journal) : { submit_attempted: false, publication_enabled: false } }
}
function reconcile(journal: Journal) {
  if (journal.phase === 'upload_pending' && journal.pending_index !== null && previews().length >= (journal.existing_previews ?? 0) + journal.pending_index + 1) {
    journal.uploaded = journal.pending_index + 1; journal.pending_index = null
    journal.phase = journal.uploaded === journal.request.images.length ? 'uploaded' : 'prepared'
    save(journal)
  }
}
function filePayload(raw: unknown): File {
  const payload = raw as ImagePayload | undefined
  if (!payload || typeof payload.base64 !== 'string' || typeof payload.mime !== 'string' || typeof payload.name !== 'string') throw new Error('EO2 image transfer unavailable. Use call_tool from the side panel with an authorized file or HTTP/HTTPS image.')
  if (payload.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Image payload exceeds transport capacity.')
  const binary = atob(payload.base64)
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Transferred file exceeds transport capacity.')
  return new File([bytes], payload.name, { type: payload.mime })
}
export const xiaohongshuPublishTools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  async xhs_publish_content(args) {
    // Block stale catalogs too: final publishing is explicitly outside this stage.
    if (args.action === 'submit') return failed('PUBLICATION_DEFERRED', '最终发布已暂缓。本工具只上传图片、填写文稿和设置选项，不点击发布。', null)
    if (![HOST, CREATOR_HOST].includes(location.hostname)) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    if (args.action === 'open') {
      if (location.hostname === CREATOR_HOST && location.pathname === '/publish/publish') return result('ok', { publish_page_open: true })
      return navigation(PUBLISH_URL, 'Navigate this same tab to the upstream creator publish page, then rediscover tools. Complete creator sign-in manually if required.')
    }
    if (location.hostname !== CREATOR_HOST) return error('NOT_CREATOR_PAGE', 'Call action=open, then rediscover tools on the same bound tab.')
    if (!['prepare', 'upload', 'configure', 'status'].includes(String(args.action))) return error('INVALID_ACTION', 'Unknown preparation action.')
    if (typeof args.operation_id !== 'string' || !args.operation_id) return error('INVALID_OPERATION_ID', 'Use a nonempty operation_id to associate the preparation steps.')
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
      if (location.pathname !== '/publish/publish') return failed('NOT_PUBLISH_PAGE', 'Open the upstream creator publish page in this same tab.', journal)
      const deadline = Date.now() + 45000
      if (args.action === 'prepare') {
        const request = publishRequest(args)
        await imageTab(Math.min(deadline, Date.now() + 15000))
        const continuing = journal?.operation_id === args.operation_id
          && !journal.submitted_at && JSON.stringify(journal.request.images) === JSON.stringify(request.images)
          && previews().length >= (journal.existing_previews ?? 0) + journal.uploaded
        if (continuing && journal) {
          // Updating text/options keeps already supplied images, rather than uploading them twice.
          journal.request = request; journal.review = null; journal.snapshot = null
          if (journal.phase !== 'upload_pending') journal.phase = journal.uploaded === request.images.length ? 'uploaded' : 'prepared'
        } else {
          // Existing website images are retained and reported, not mistaken for this upload.
          journal = { operation_id: args.operation_id, request, phase: 'prepared', uploaded: 0, existing_previews: previews().length,
            pending_index: null, snapshot: null, review: null, submitted_at: null, evidence: null }
        }
        save(journal)
        return result('ok', summary(journal))
      }
      if (!journal || journal.operation_id !== args.operation_id) return failed('OPERATION_NOT_FOUND', 'Prepare this operation before uploading or filling the form.', journal)
      if (args.action === 'upload') {
        const index = args.image_index
        if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= journal.request.images.length || args.image !== journal.request.images[Number(index)]) return failed('IMAGE_ARGUMENT_MISMATCH', 'image_index and image must match the original ordered image list.', journal)
        if (Number(index) < journal.uploaded) return result('ok', summary(journal))
        if (journal.phase === 'upload_pending') return failed('UPLOAD_PENDING', 'An image was already supplied to the website. Query status to observe its preview; do not upload it again automatically.', journal)
        if (index !== journal.uploaded || previews().length < (journal.existing_previews ?? 0) + journal.uploaded) return failed('UPLOAD_STATE_MISMATCH', 'Upload images in order; current previews must reach the acknowledged count.', journal)
        const file = filePayload(takeXiaohongshuImage(args))
        const uploadInput = imageUploadInput(journal.uploaded === 0 && (journal.existing_previews ?? 0) === 0)
        if (!uploadInput) return failed('UPLOAD_INPUT_UNAVAILABLE', 'Image upload input unavailable.', journal)
        const transfer = new DataTransfer(); transfer.items.add(file)
        journal.phase = 'upload_pending'; journal.pending_index = Number(index); save(journal)
        uploadInput.files = transfer.files
        uploadInput.dispatchEvent(new Event('change', { bubbles: true }))
        try { await until(() => previews().length >= (journal!.existing_previews ?? 0) + Number(index) + 1, Date.now() + 20000, 'Image preview not observed within this call.') }
        catch { return failed('UPLOAD_PENDING', 'File was supplied but its preview is not yet verified. Query status before continuing; do not automatically re-upload.', journal) }
        reconcile(journal)
        // Upstream waits for the form to settle after every observed preview.
        await delay(1000)
        return result('ok', summary(journal))
      }
      if (args.action === 'configure') {
        if (journal.uploaded < journal.request.images.length || previews().length < (journal.existing_previews ?? 0) + journal.request.images.length) return failed('CONFIGURATION_NOT_READY', 'Wait for the requested image previews before filling the form.', journal)
        const updatedFields = PUBLISH_FORM_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(args, field))
        const fields = journal.phase === 'ready' && updatedFields.length ? new Set(updatedFields) : undefined
        journal.request = updatePublishRequest(journal.request, args)
        journal.review = null
        journal.phase = 'configuring'; save(journal)
        journal.review = await configureForm(journal.request, deadline, fields)
        journal.phase = 'ready'; save(journal)
        return result('ok', summary(journal))
      }
      return error('INVALID_ACTION', 'Unknown preparation action.')
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Publication action failed.'
      return failed(journal?.submitted_at ? 'PUBLISH_RESULT_UNKNOWN' : 'PUBLISH_STEP_FAILED', message, journal)
    } finally { busy = false }
  },
}
