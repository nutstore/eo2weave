import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { xiaohongshuSessionTools as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-session'

const origin = 'https://www.xiaohongshu.com'
const stateWindow = window as Window & { __INITIAL_STATE__?: unknown }

interface Result {
  status: string
  error_code: string | null
  data: {
    login_state: string
    login_panel_visible: boolean
    qr_visible: boolean
    requires_user_action: boolean
    logout_verified?: boolean
  } | null
}

function setPage(path = '/explore') {
  const url = new URL(path, origin)
  vi.stubGlobal('location', { href: url.href, hostname: url.hostname, pathname: url.pathname, search: '' })
}

function loginState(guest: boolean) {
  stateWindow.__INITIAL_STATE__ = { user: { userInfo: { guest, userId: guest ? undefined : 'test-user' } } }
}

function navigation(markup: string) {
  document.body.innerHTML = `<div class="main-container"><div class="side-bar">${markup}</div></div>`
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return await tools[name](args) as Result
}

beforeEach(() => {
  vi.useFakeTimers()
  setPage()
  loginState(true)
  document.body.innerHTML = ''
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete stateWindow.__INITIAL_STATE__
  document.body.innerHTML = ''
})

describe('Xiaohongshu login panel tools', () => {
  it('returns an existing login panel without exposing QR contents or form credentials', async () => {
    document.body.innerHTML = '<div class="login-container"><img class="qrcode-img" src="data:image/png;base64,SECRET_QR"><input value="SECRET_PHONE"><input type="password" value="SECRET_PASSWORD"></div>'
    const response = await call('xhs_open_login')
    expect(response.data).toMatchObject({ login_state: 'logged_out', login_panel_visible: true, qr_visible: true, requires_user_action: true })
    expect(JSON.stringify(response)).not.toContain('SECRET')
  })

  it('is idempotent when already logged in', async () => {
    loginState(false)
    navigation('<button>登录</button>')
    const click = vi.spyOn(document.querySelector('button')!, 'click')
    const response = await call('xhs_open_login')
    expect(response.data).toMatchObject({ login_state: 'logged_in', requires_user_action: false })
    expect(click).not.toHaveBeenCalled()
  })

  it('opens an exact navigation login control and waits for a recognizable panel', async () => {
    navigation('<button>登录</button>')
    document.querySelector('button')!.addEventListener('click', () => {
      setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<div class="login-container"><img class="qrcode-img"></div>'), 250)
    })
    const pending = call('xhs_open_login')
    await vi.advanceTimersByTimeAsync(500)
    expect((await pending).data).toMatchObject({ login_panel_visible: true, qr_visible: true })
  })

  it('supports known login triggers outside navigation', async () => {
    document.body.innerHTML = '<button class="login-btn">立即登录</button>'
    document.querySelector('button')!.addEventListener('click', () => loginState(false))
    expect((await call('xhs_open_login')).data?.login_state).toBe('logged_in')
  })

  it('excludes buttons inside note/comment content and nonexact labels', async () => {
    document.body.innerHTML = '<div class="note-content"><button class="login-btn">登录</button></div><div class="comments-container"><button class="login-trigger">登录</button></div><div class="main-container"><div class="side-bar"><button>登录后点赞</button></div></div>'
    const clicks = Array.from(document.querySelectorAll('button')).map((button) => vi.spyOn(button, 'click'))
    expect((await call('xhs_open_login')).error_code).toBe('LOGIN_ENTRY_UNSUPPORTED')
    clicks.forEach((click) => expect(click).not.toHaveBeenCalled())
  })

  it('ignores hidden panels and hidden navigation controls', async () => {
    navigation('<div style="display:none"><button>登录</button></div>')
    document.body.insertAdjacentHTML('beforeend', '<div style="display:none"><div class="login-container"><img class="qrcode-img"></div></div>')
    expect((await call('xhs_open_login')).error_code).toBe('LOGIN_ENTRY_UNSUPPORTED')
  })

  it('does not report success when a login click has no effect', async () => {
    navigation('<button>登录</button>')
    const pending = call('xhs_open_login')
    await vi.advanceTimersByTimeAsync(4500)
    expect((await pending).error_code).toBe('SESSION_TIMEOUT')
  })

  it('reports required verification without interacting with it', async () => {
    navigation('<button>登录</button>')
    document.querySelector('button')!.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<div class="captcha-container">Complete verification</div>')
    })
    expect((await call('xhs_open_login')).error_code).toBe('SESSION_ACTION_REQUIRED')
  })
})

describe('Xiaohongshu logout tools', () => {
  beforeEach(() => loginState(false))

  it.each([{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }])('requires the explicit boolean confirmation %o', async (args) => {
    navigation('<button>退出登录</button>')
    const click = vi.spyOn(document.querySelector('button')!, 'click')
    expect((await call('xhs_logout', args)).error_code).toBe('CONFIRMATION_REQUIRED')
    expect(click).not.toHaveBeenCalled()
  })

  it('returns a verified already-signed-out state idempotently', async () => {
    loginState(true)
    expect((await call('xhs_logout', { confirm: true })).data).toMatchObject({ login_state: 'logged_out', logout_verified: true })
  })

  it('waits for a reliable signed-out state after clicking navigation logout', async () => {
    navigation('<button>退出登录</button>')
    document.querySelector('button')!.addEventListener('click', () => setTimeout(() => loginState(true), 250))
    const pending = call('xhs_logout', { confirm: true })
    await vi.advanceTimersByTimeAsync(500)
    expect((await pending).data).toMatchObject({ login_state: 'logged_out', logout_verified: true })
  })

  it('opens a navigation More menu and recognizes the new portal account menu', async () => {
    navigation('<button>更多</button>')
    const existingMenu = document.createElement('div')
    existingMenu.className = 'dropdown-menu'
    existingMenu.innerHTML = '<button>退出登录</button>'
    document.body.appendChild(existingMenu)
    const unrelatedClick = vi.spyOn(existingMenu.querySelector('button')!, 'click')
    document.querySelector('.side-bar button')!.addEventListener('click', () => {
      setTimeout(() => {
        const menu = document.createElement('div')
        menu.setAttribute('role', 'menu')
        menu.innerHTML = '<button>退出登录</button>'
        menu.querySelector('button')!.addEventListener('click', () => loginState(true))
        document.body.appendChild(menu)
      }, 250)
    })
    const pending = call('xhs_logout', { confirm: true })
    await vi.advanceTimersByTimeAsync(500)
    expect((await pending).data?.logout_verified).toBe(true)
    expect(unrelatedClick).not.toHaveBeenCalled()
  })

  it('leaves website confirmation to the user without reporting success', async () => {
    navigation('<button>退出登录</button>')
    document.querySelector('button')!.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<div role="dialog">确定退出登录？<button>确认</button><button>取消</button></div>')
    })
    const response = await call('xhs_logout', { confirm: true })
    expect(response.error_code).toBe('SESSION_ACTION_REQUIRED')
    expect(response.data).toMatchObject({ logout_verified: false, requires_user_action: true })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('excludes content buttons and does not infer arbitrary account controls', async () => {
    document.body.innerHTML = '<div class="note-content"><div class="account-menu"><button>退出登录</button></div></div><div class="comments-container"><button>退出登录</button></div><button>退出登录</button>'
    const clicks = Array.from(document.querySelectorAll('button')).map((button) => vi.spyOn(button, 'click'))
    expect((await call('xhs_logout', { confirm: true })).error_code).toBe('LOGOUT_ENTRY_UNSUPPORTED')
    clicks.forEach((click) => expect(click).not.toHaveBeenCalled())
  })

  it('does not equate an unknown state after logout with success', async () => {
    navigation('<button>退出登录</button>')
    document.querySelector('button')!.addEventListener('click', () => { delete stateWindow.__INITIAL_STATE__ })
    const pending = call('xhs_logout', { confirm: true })
    await vi.advanceTimersByTimeAsync(4500)
    const response = await pending
    expect(response.error_code).toBe('SESSION_TIMEOUT')
    expect(response.data).toMatchObject({ login_state: 'unknown', logout_verified: false })
  })

  it('requires a fresh session check after a page navigation without signed-out evidence', async () => {
    navigation('<button>退出登录</button>')
    document.querySelector('button')!.addEventListener('click', () => setPage('/search_result'))
    const response = await call('xhs_logout', { confirm: true })
    expect(response.error_code).toBe('SESSION_ACTION_REQUIRED')
    expect(response.data?.logout_verified).toBe(false)
  })

  it('fails conservatively when More has no recognizable logout option', async () => {
    navigation('<button>更多</button>')
    const pending = call('xhs_logout', { confirm: true })
    await vi.advanceTimersByTimeAsync(4500)
    expect((await pending).error_code).toBe('LOGOUT_ENTRY_UNSUPPORTED')
  })
})
