export const welcome = {
    title: "EO2Weave",
    tagline: "AI-Native Workspace for Creators",
    placeholder: "Type a message to start...",
    send: "Send",
    // Shown while the async API-key check is in flight (avoids flashing the
    // "no API key" setup card before SQLite has been consulted).
    checkingConfig: "Checking AI configuration...",
    // Setup card (shown when no API key configured)
    setupCardTitle: "Finish AI setup before you start",
    setupGatewayTitle: "Login with Jianguoyun Account",
    setupGatewayDesc: "Have a Jianguoyun account? Login instantly — no API Key needed",
    setupGatewayRecommend: "Recommended",
    setupApiKeyTitle: "Configure Your Own API Key",
    setupApiKeyDesc: "Supports OpenAI, OpenRouter, Anthropic, and more",
    // select-model step (key saved but no default provider/model chosen)
    selectModelCardTitle: "Key saved — now pick a default model",
    selectModelActionTitle: "Choose a default provider & model",
    selectModelActionDesc: "Expand a configured provider in Settings and pick one model as your default",
    // Link to the model configuration guide (shown as a ? icon on setup cards)
    setupGuideTooltip: "Open the setup guide: provider key, pinned models & default model",
    setupGuideLinkTitle: "How do I set this up?",
    setupGuideLinkDesc: "Three steps: provider key → pinned models → default model",
    setupLocalFirstHint: "All data is stored locally in your browser, never uploaded",
    // Conditional onboarding labels (these are not a linear progress count)
    welcomeLabel: "Get started",
    apiKeyLabel: "Connect AI",
    mountFolderLabel: "Add a local folder",
    welcomeHeading: "Welcome to eo2weave",
    welcomeSubtitle: "Your local AI workspace for files, code, and creation",
    continueButton: "Continue",
    skipButton: "Skip for now",
    mountFolderTitle: "Mount a local folder",
    mountFolderDesc: "AI can read and write your files. Files never leave your browser.",
    mountFolderButton: "Select folder",
    mountFolderBack: "Back",
    mountFolderMounted: "Mounted folders",
    readyHint: "Type a message, or drop in a file and I'll take it from there",
    gateway: {
        title: "Login to Jianguoyun AI",
        close: "Close",
        requesting: "Creating authorization session...",
        enterCode: "Enter the following code on the authorization page",
        authCodeLabel: "Authorization Code",
        copy: "Copy",
        openAuthPage: "Open Authorization Page",
        waiting: "Waiting for authorization...",
        success: "Login successful!",
        clientIdMissing:
            "Client ID not configured. Set NEXT_PUBLIC_JIANGUOYUN_AI_CLIENT_ID env variable.",
        authFailedFallback: "Authentication failed",
    },
} as const
