export const credential = {
  temporary: { retry: '認証情報を一時的に取得できません。もう一度お試しください。' },
  expired: { signIn: 'ログインの有効期限が切れました。再度ログインしてください。' },
  missing: {
    signIn: 'ログインしていません。先にログインしてください。',
    configure: 'API キーが設定されていません。設定画面で設定してください。',
  },
} as const
