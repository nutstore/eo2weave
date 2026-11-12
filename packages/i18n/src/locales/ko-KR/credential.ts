export const credential = {
  temporary: { retry: '인증 정보를 일시적으로 가져올 수 없습니다. 다시 시도해 주세요.' },
  expired: { signIn: '로그인이 만료되었습니다. 다시 로그인해 주세요.' },
  missing: {
    signIn: '로그인하지 않았습니다. 먼저 로그인해 주세요.',
    configure: 'API 키가 설정되지 않았습니다. 설정에서 API 키를 입력해 주세요.',
  },
} as const
