export const credential = {
  temporary: { retry: 'Credentials are temporarily unavailable. Please retry.' },
  expired: { signIn: 'Your sign-in has expired. Please sign in again.' },
  missing: {
    signIn: 'You are not signed in. Please sign in first.',
    configure: 'No API key is configured. Please configure one in settings.',
  },
} as const
