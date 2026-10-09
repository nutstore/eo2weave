// Port publish_video.go/service.go at 7797fd37; final submission is deferred.
import { HOST, error, result, navigation } from './xiaohongshu-page'
import { CREATOR_HOST, PUBLISH_URL, publishFormRequest, PUBLISH_FORM_FIELDS } from './xiaohongshu-publish-policy'
import type { PublishFormRequest, PublishFormField } from './xiaohongshu-publish-policy'
import { rendered, selectPublishTab, configureForm, delay } from './xiaohongshu-publish-dom'
import { takeXiaohongshuVideo } from './xiaohongshu-publish-video-transfer'
import { XHS_OPERATION_TIMEOUT_MS } from '../xiaohongshu-input-protocol'

export interface VideoRequest extends PublishFormRequest { video: string }
const fields = PUBLISH_FORM_FIELDS.filter((field) => field !== 'is_original')
export function videoRequest(args: Record<string, unknown>): VideoRequest {
  const form = publishFormRequest(args)
  if (typeof args.video !== 'string' || !args.video) throw new Error('A single local video source is required.')
  if (/^https?:\/\//i.test(args.video)) throw new Error('Upstream publish_with_video accepts a local video file, not a remote URL.')
  return { ...form, video: args.video }
}
function updateRequest(request: VideoRequest, args: Record<string, unknown>): VideoRequest {
  const updates = Object.fromEntries(fields.filter((field) => Object.prototype.hasOwnProperty.call(args, field)).map((field) => [field, args[field]]))
  const updated = videoRequest({ ...request, ...updates, schedule_at: 'schedule_at' in updates ? updates.schedule_at : undefined })
  if (!('schedule_at' in updates)) updated.schedule_at = request.schedule_at
  if (!('tags' in updates)) updated.dropped_tags = request.dropped_tags
  return updated
}
export function videoUploadInput(): HTMLInputElement | null {
  // Upstream uploadVideo prefers .upload-input, then the first file input.
  return document.querySelector<HTMLInputElement>('.upload-input') ?? document.querySelector<HTMLInputElement>("input[type='file']")
}
export function videoProcessingState() {
  // Port findPublishButton exactly as the uploadVideo readiness criterion.
  // Reading this control does not click or submit anything.
  for (const widget of Array.from(document.querySelectorAll<HTMLElement>('xhs-publish-btn'))) {
    if (!rendered(widget) || widget.getAttribute('is-publish') === 'false') continue
    const reason = widget.getAttribute('submit-disabled') === 'true' ? '新版发布按钮不可点击' : null
    return { ready: reason === null, button_kind: 'widget', disabled_reason: reason, source: 'upstream_publish_button_state' }
  }
  for (const button of Array.from(document.querySelectorAll<HTMLElement>('.publish-page-publish-btn button.bg-red'))) {
    if (!rendered(button)) continue
    const reason = button.hasAttribute('disabled') ? '旧版发布按钮 disabled' : button.getAttribute('aria-disabled') === 'true' ? '旧版发布按钮 aria-disabled=true' : button.classList.contains('disabled') ? '旧版发布按钮包含 disabled class' : null
    return { ready: reason === null, button_kind: 'legacy', disabled_reason: reason, source: 'upstream_publish_button_state' }
  }
  return { ready: false, button_kind: null, disabled_reason: null, source: 'upstream_publish_button_state' }
}
type Phase = 'prepared' | 'processing' | 'uploaded' | 'configuring' | 'ready'
interface Journal {
  operation_id: string; request: VideoRequest; phase: Phase; supplied_to_page: boolean
  file: { name: string; size: number; mime: string | null } | null; review: unknown; configure_fields?: PublishFormField[] | null
}
const JOURNAL_KEY = 'eo2_xhs_video_prepare_v1'
let busy = false
const load = (): Journal | null => { const raw = sessionStorage.getItem(JOURNAL_KEY); return raw ? JSON.parse(raw) as Journal : null }
const save = (journal: Journal) => sessionStorage.setItem(JOURNAL_KEY, JSON.stringify(journal))
function reconcile(journal: Journal) {
  if (journal.phase === 'processing' && videoProcessingState().ready) { journal.phase = 'uploaded'; save(journal) }
}
function summary(journal: Journal) {
  return { operation_id: journal.operation_id, phase: journal.phase, video: journal.request.video, file: journal.file,
    supplied_to_page: journal.supplied_to_page, processing: videoProcessingState(), review: journal.review,
    publication_enabled: false, submit_attempted: false, published_verified: false,
    next_step: journal.phase === 'ready' ? 'Review the prepared video on the website. Final publishing is deferred; stop here.' : journal.phase === 'processing' ? 'Query status on this same tab to observe the upstream processing criterion.' : null }
}
function failed(code: string, message: string, journal: Journal | null) {
  return { ...error(code, message), data: journal ? summary(journal) : { publication_enabled: false, submit_attempted: false } }
}
export const xiaohongshuVideoPublishTools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  async xhs_publish_video(args) {
    if (args.action === 'submit') return failed('PUBLICATION_DEFERRED', '最终发布已暂缓。本工具仅准备视频，不点击发布或暂存离开。', null)
    if (![HOST, CREATOR_HOST].includes(location.hostname)) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    if (args.action === 'open') {
      if (location.hostname === CREATOR_HOST && location.pathname === '/publish/publish') return result('ok', { publish_page_open: true })
      return navigation(PUBLISH_URL, 'Open this same tab on the upstream creator page, then rediscover tools. Complete sign-in manually if required.')
    }
    if (location.hostname !== CREATOR_HOST) return error('NOT_CREATOR_PAGE', 'Call open, then rediscover this same tab.')
    if (!['prepare', 'upload', 'configure', 'status'].includes(String(args.action))) return error('INVALID_ACTION', 'Unknown video preparation action.')
    if (typeof args.operation_id !== 'string' || !args.operation_id) return error('INVALID_OPERATION_ID', 'Use a nonempty operation_id to associate the video preparation steps.')
    if (busy) return error('PUBLISH_BUSY', 'Another video action is running in this tab.')
    busy = true
    let journal: Journal | null = null
    try {
      journal = load()
      if (journal) reconcile(journal)
      if (args.action === 'status') {
        if (!journal || journal.operation_id !== args.operation_id) return failed('OPERATION_NOT_FOUND', 'No matching video preparation in this tab.', journal)
        return result('ok', summary(journal))
      }
      if (location.pathname !== '/publish/publish') return failed('NOT_PUBLISH_PAGE', 'Open the creator publish page in this same tab.', journal)
      const deadline = Date.now() + XHS_OPERATION_TIMEOUT_MS
      if (args.action === 'prepare') {
        const request = videoRequest(args)
        if (journal?.operation_id === args.operation_id && journal.request.video === request.video) {
          journal.request = request; journal.review = null
          if (journal.supplied_to_page && videoProcessingState().ready) journal.phase = 'uploaded'
          else journal.phase = journal.supplied_to_page ? 'processing' : 'prepared'
        } else {
          await selectPublishTab('上传视频', deadline)
          journal = { operation_id: args.operation_id, request, phase: 'prepared', supplied_to_page: false, file: null, review: null }
        }
        delete journal.configure_fields; save(journal)
        return result('ok', summary(journal))
      }
      if (!journal || journal.operation_id !== args.operation_id) return failed('OPERATION_NOT_FOUND', 'Prepare this video operation first.', journal)
      if (args.action === 'upload') {
        if (args.video !== journal.request.video) return failed('VIDEO_ARGUMENT_MISMATCH', 'Use the prepared video source.', journal)
        if (journal.supplied_to_page) return result('ok', summary(journal))
        const file = takeXiaohongshuVideo(args)
        if (!file) return failed('VIDEO_TRANSFER_UNAVAILABLE', 'EO2 must transfer the authorized local file before upload.', journal)
        const upload = videoUploadInput()
        if (!upload) return failed('UPLOAD_INPUT_UNAVAILABLE', 'Video upload input unavailable.', journal)
        const transfer = new DataTransfer(); transfer.items.add(file)
        upload.files = transfer.files
        journal.phase = 'processing'; journal.supplied_to_page = true; journal.file = { name: file.name, size: file.size, mime: file.type || null }; save(journal)
        upload.dispatchEvent(new Event('change', { bubbles: true }))
        // Upstream waits in one-second intervals, with a five-minute page context
        // around its ten-minute button waiter. EO2 can continue via status.
        while (Date.now() < deadline) {
          reconcile(journal)
          if (journal.phase !== 'processing') return result('ok', summary(journal))
          await delay(1000)
        }
        return failed('VIDEO_PROCESSING_PENDING', 'File supplied; the upstream publish-button readiness criterion was not observed within this call. Query status.', journal)
      }
      if (!journal.supplied_to_page || !videoProcessingState().ready) return failed('VIDEO_PROCESSING_PENDING', 'Wait for the uploaded video to satisfy the upstream publish-button readiness criterion before filling.', journal)
      const updatedFields = fields.filter((field) => Object.prototype.hasOwnProperty.call(args, field))
      let scope: Set<PublishFormField> | undefined
      if (journal.phase === 'configuring' && Array.isArray(journal.configure_fields)) scope = new Set([...journal.configure_fields, ...updatedFields])
      else if (journal.phase === 'ready' && updatedFields.length) scope = new Set(updatedFields)
      journal.request = updateRequest(journal.request, args); journal.review = null
      journal.configure_fields = scope ? [...scope] : null; journal.phase = 'configuring'; save(journal)
      const { is_original: _original, observed_options, ...review } = await configureForm(journal.request, deadline, scope, 'video')
      const { is_original: _observedOriginal, ...options } = observed_options
      journal.review = { ...review, observed_options: options }
      delete journal.configure_fields; journal.phase = 'ready'; save(journal)
      return result('ok', summary(journal))
    } catch (caught) {
      return failed('PUBLISH_STEP_FAILED', caught instanceof Error ? caught.message : 'Video preparation failed.', journal)
    } finally { busy = false }
  },
}
