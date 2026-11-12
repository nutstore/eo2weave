export const credential = {
  temporary: { retry: '暂时无法获取凭证，请稍后重试。' },
  expired: { signIn: '登录已过期，请重新登录。' },
  missing: {
    signIn: '尚未登录，请先登录。',
    configure: '尚未配置 API Key，请在设置中配置。',
  },
} as const
