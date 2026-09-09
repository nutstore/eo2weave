// 欢迎页
export const welcome = {
    title: "怡氧知知",
    tagline: "面向创作者的 AI 原生工作台",
    placeholder: "输入消息开始对话...",
    send: "发送",
    // Drag and drop overlay
    // Shown while the async API-key check is in flight (avoids flashing the
    // "no API key" setup card before SQLite has been consulted).
    checkingConfig: "正在检查 AI 配置...",
    // Setup card (shown when no API key configured)
    setupCardTitle: "开始之前，请先完成 AI 配置",
    setupGatewayTitle: "用坚果云账号登录",
    setupGatewayDesc: "已有坚果云账号？一键登录即可使用，无需配置 API Key",
    setupGatewayRecommend: "推荐",
    setupApiKeyTitle: "配置自己的 API Key",
    setupApiKeyDesc: "支持 OpenAI、OpenRouter、Anthropic 等自定义模型",
    // select-model step (key saved but no default provider/model chosen)
    selectModelCardTitle: "Key 已保存，再选一个默认模型",
    selectModelActionTitle: "选择默认服务商和模型",
    selectModelActionDesc: "在设置里展开已配置的服务商，从模型列表中选一个作为默认",
    // Link to the model configuration guide (shown as a ? icon on setup cards)
    setupGuideTooltip: "查看配置教程：服务商 Key、常用模型与默认模型",
    setupGuideLinkTitle: "如何配置？",
    setupGuideLinkDesc: "三步完成：服务商 Key → 常用模型 → 默认模型",
    setupLocalFirstHint: "所有数据存储在本地浏览器中，不会上传到服务器",
    // Conditional onboarding labels (these are not a linear progress count)
    welcomeLabel: "开始使用",
    apiKeyLabel: "连接 AI",
    mountFolderLabel: "添加本地文件夹",
    welcomeHeading: "欢迎使用 怡氧知知",
    welcomeSubtitle: "本地 AI 创作工坊，文件和代码都在浏览器中",
    continueButton: "继续",
    skipButton: "暂时跳过",
    mountFolderTitle: "挂载本地文件夹",
    mountFolderDesc: "AI 可以直接读写你的文件。文件不离开浏览器。",
    mountFolderButton: "选择文件夹",
    mountFolderBack: "上一步",
    mountFolderMounted: "已挂载的文件夹",
    readyHint: "可以直接对话，或拖入文件让我处理",
    gateway: {
        title: "登录坚果云 AI",
        close: "关闭",
        requesting: "正在创建授权会话...",
        enterCode: "请在新打开的页面输入以下代码完成授权",
        authCodeLabel: "授权代码",
        copy: "复制",
        openAuthPage: "打开授权页面",
        waiting: "等待授权完成...",
        success: "登录成功！",
        clientIdMissing:
            "Client ID 未配置，请设置 NEXT_PUBLIC_JIANGUOYUN_AI_CLIENT_ID 环境变量",
        authFailedFallback: "认证失败",
    },
} as const
