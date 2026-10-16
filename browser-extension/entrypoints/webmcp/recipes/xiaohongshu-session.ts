import { HOST, clean, visible, result, error, loginState } from './xiaohongshu-page'

const NAVIGATION = '.main-container .side-bar, .main-container .sidebar, .main-container .navigation, .main-container > nav, .main-container > header, #app > nav, #app > header'
const ACCOUNT_MENUS = '.account-menu, .user-menu, .more-menu, .sidebar-more, .side-bar .dropdown-menu, .side-bar [role="menu"]'
const PORTAL_MENUS = '[role="menu"], .dropdown-container, .dropdown-menu, .menu-container'
const CONTENT = '.note-item, .note-content, .note-scroller, .note-detail, .comments-container, .comment-item, .parent-comment, [contenteditable="true"]'
const CONTROLS = 'button, a, [role="button"], [role="menuitem"], li, .menu-item, .dropdown-item, .channel, .more-item, .more-button, .login-btn, .login-button, .login-trigger, .logout-btn, .logout-button'
const LOGIN_TRIGGERS = '.login-btn, .login-button, .login-trigger'
const LOGIN_PANELS = '.login-container, .login-modal, .login-dialog'
const WAIT_MS = 4000
const POLL_MS = 250

function rendered(element: Element | null): element is HTMLElement {
  if (!visible(element)) return false
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

function outsideContent(element: HTMLElement): boolean {
  return !element.closest(CONTENT)
}

function roots(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((element) => rendered(element) && outsideContent(element))
}

function exactControl(containers: HTMLElement[], labels: string[]): HTMLElement | null {
  for (const container of containers) {
    const candidates = [container, ...Array.from(container.querySelectorAll<HTMLElement>(CONTROLS))]
    const control = candidates.find((element) => element.matches(CONTROLS) && rendered(element) && outsideContent(element)
      && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true'
      && labels.includes(clean(element.innerText)))
    if (control) return control
  }
  return null
}

function sessionInfo() {
  const panels = roots(LOGIN_PANELS)
  return {
    login_state: loginState(),
    login_panel_visible: panels.length > 0,
    qr_visible: panels.some((panel) => Array.from(panel.querySelectorAll('.qrcode-img, .qrcode, .qr-code')).some(rendered)),
    session_scope: 'Xiaohongshu session in this browser; other Xiaohongshu tabs may be affected.',
  }
}

function loginResult() {
  const info = sessionInfo()
  const loggedIn = info.login_state === 'logged_in'
  return result('ok', {
    ...info,
    requires_user_action: !loggedIn,
    next_step: loggedIn ? 'Already signed in.' : 'Complete sign-in directly in the visible website panel, then call xhs_check_login. QR images and credentials are not returned.',
  })
}

function logoutResult() {
  return result('ok', {
    ...sessionInfo(),
    logout_verified: true,
    requires_user_action: false,
    next_step: 'The page reports signed out. Use xhs_open_login to sign in again.',
  })
}

function actionRequired(message: string) {
  return { ...error('SESSION_ACTION_REQUIRED', message), data: { ...sessionInfo(), logout_verified: false, requires_user_action: true } }
}

function visibleSessionChallenge(): boolean {
  if (roots('.captcha-container, .captcha-modal, .verify-container, .verify-dialog').length) return true
  return roots('[role="dialog"], .modal, .dialog, .confirm-dialog, .confirm-container').some((dialog) => {
    const text = clean(dialog.innerText)
    return /退出登录|确定退出|确认退出/.test(text) && /取消|确认|确定/.test(text)
  })
}

function pageError(startUrl?: string) {
  if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
  if (startUrl && location.href !== startUrl) return actionRequired('The page navigated during the session action. Check the current page and call xhs_check_login to verify the session.')
  return null
}

export const xiaohongshuSessionTools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  async xhs_open_login() {
    const invalidPage = pageError()
    if (invalidPage) return invalidPage
    if (loginState() === 'logged_in' || roots(LOGIN_PANELS).length > 0) return loginResult()
    const trigger = exactControl([...roots(NAVIGATION), ...roots(LOGIN_TRIGGERS)], ['登录', '立即登录', '登录小红书'])
    if (!trigger) return error('LOGIN_ENTRY_UNSUPPORTED', 'No recognizable sign-in control is available in site navigation. Open the website sign-in panel manually.')
    const startUrl = location.href
    trigger.click()
    const started = Date.now()
    while (Date.now() - started < WAIT_MS) {
      if (loginState() === 'logged_in' || roots(LOGIN_PANELS).length > 0) return loginResult()
      const changed = pageError(startUrl)
      if (changed) return changed
      if (visibleSessionChallenge()) return actionRequired('The website requires verification. Complete it in the website, then check login status again.')
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    return error('SESSION_TIMEOUT', 'The sign-in control was clicked, but no recognizable login panel or signed-in state appeared.')
  },

  async xhs_logout(args) {
    if (args.confirm !== true) return error('CONFIRMATION_REQUIRED', 'Set confirm to true only when the user requested signing out of Xiaohongshu in this browser. Other Xiaohongshu tabs may also sign out.')
    const invalidPage = pageError()
    if (invalidPage) return invalidPage
    if (loginState() === 'logged_out') return logoutResult()
    if (visibleSessionChallenge()) return actionRequired('The website requires a session confirmation or verification. Complete it manually, then call xhs_check_login.')
    const startUrl = location.href
    let logout = exactControl([...roots(NAVIGATION), ...roots(ACCOUNT_MENUS)], ['退出登录'])
    if (!logout) {
      const more = exactControl(roots(NAVIGATION), ['更多', '更多选项', '账户', '账号', '帐号'])
      if (!more) return error('LOGOUT_ENTRY_UNSUPPORTED', 'No recognizable sign-out or account menu control is available in site navigation. Sign out manually in the website.')
      const existingPortals = new Set(roots(PORTAL_MENUS))
      more.click()
      const menuStarted = Date.now()
      while (Date.now() - menuStarted < WAIT_MS) {
        if (loginState() === 'logged_out') return logoutResult()
        const changed = pageError(startUrl)
        if (changed) return changed
        if (visibleSessionChallenge()) return actionRequired('The website requires confirmation or verification. Complete it manually, then call xhs_check_login.')
        // Only menus revealed by this navigation action may extend the trusted account-menu scope.
        const newlyVisibleMenus = roots(PORTAL_MENUS).filter((menu) => !existingPortals.has(menu))
        logout = exactControl([...roots(NAVIGATION), ...roots(ACCOUNT_MENUS), ...newlyVisibleMenus], ['退出登录'])
        if (logout) break
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
      if (!logout) return error('LOGOUT_ENTRY_UNSUPPORTED', 'The account menu did not expose a recognizable sign-out control. Sign out manually in the website.')
    }
    logout.click()
    const started = Date.now()
    while (Date.now() - started < WAIT_MS) {
      if (loginState() === 'logged_out') return logoutResult()
      const changed = pageError(startUrl)
      if (changed) return changed
      if (visibleSessionChallenge()) return actionRequired('The website requests a second confirmation or verification for sign-out. Complete it manually, then call xhs_check_login; sign-out is not yet verified.')
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    return { ...error('SESSION_TIMEOUT', 'The sign-out control was clicked, but the page did not establish a signed-out state. Check the website before trying again.'), data: { ...sessionInfo(), logout_verified: false } }
  },
}
