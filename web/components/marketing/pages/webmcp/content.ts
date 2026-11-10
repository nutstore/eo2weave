export type WebMcpCopy = {
  heroTitleBefore: string
  heroTitleHighlight: string
  heroDesc: string
  online: string
  extensionNote: string
  whatTitle: string
  whatParagraphs: [string, string]
  compareTitle: string
  compareOldTitle: string
  compareOldDesc: string
  compareOld: { title: string; desc: string }[]
  compareNewTitle: string
  compareNewDesc: string
  compareNew: { icon: string; title: string; desc: string }[]
  howTitle: string
  howSub: string
  steps: { title: string; desc: string }[]
  ctaTitle: string
  ctaSub: string
  mobileNote: string
  mobileNoteLink: string
  demoLink: string
}

// Copy is verbatim from the previous static pages; keep it in sync with the
// design when the source HTML changes.
export const webMcpCopy: Record<'cn' | 'global', WebMcpCopy> = {
  cn: {
    heroTitleBefore: '让 AI 使用网站，',
    heroTitleHighlight: '帮你完成任务',
    heroDesc: 'WebMCP 让网站清楚地告诉 AI 自己能做什么',
    online: '在线使用',
    extensionNote: '插件提供网页侧边栏、WebMCP 和联网搜索。',
    whatTitle: '什么是 WebMCP？',
    whatParagraphs: [
      'WebMCP（Web Model Context Protocol，Web 模型上下文协议）是谷歌与微软联合提出的一项面向浏览器的 Web API 提案。通过 WebMCP，网站可以把自身能力以结构化工具的形式提供给 AI，明确说明能做什么，以及调用时需要哪些信息。',
      '简单说，它是为了解决“如何让浏览器里的 AI 助手更聪明、更精准地操作网页”而设计的技术。网站可以直接告诉 AI：“我能做什么、怎么调用”。',
    ],
    compareTitle: 'WebMCP 带来了什么变化？',
    compareOldTitle: '传统方式',
    compareOldDesc: 'AI 仅能通过视图识别和网页结构间接推断功能，操作繁琐耗时，且极易因界面微调或语义不清而出错。',
    compareOld: [
      { title: '逐项识别', desc: '要通过截图或页面结构，逐一判断控件用途和操作路径。' },
      { title: '操作耗时', desc: '查找入口、点击与输入需逐步完成。' },
      { title: '消耗较高', desc: '多轮尝试可能增加 Token 消耗和计算开销。' },
      { title: '易误操作', desc: '页面语义不清或结构变化时，可能误判控件或遗漏步骤。' },
    ],
    compareNewTitle: 'WebMCP 方式',
    compareNewDesc: '网站主动提供一份结构化的“功能说明书”，AI 无需盲目探索，直接调用对应功能精准执行。',
    compareNew: [
      { icon: 'hgi-plug', title: '无需额外配置', desc: '打开已支持的网站，即可识别其开放的能力。' },
      { icon: 'hgi-flash', title: '更快完成', desc: '减少寻找入口与重复点击，直接使用可用操作。' },
      { icon: 'hgi-cpu', title: '降低消耗', desc: '减少反复解析页面，节省 Token，让任务处理更高效。' },
      { icon: 'hgi-shield-01', title: '执行更稳定', desc: '按明确的操作信息执行，降低页面变化的影响。' },
    ],
    howTitle: '怡氧知知在其中做什么？',
    howSub:
      '怡氧知知在浏览器侧边栏连接 AI 对话、网站和本地文件，帮你处理内容、操作网站。通过 WebMCP，它能发现网站开放的工具，让 AI 按网站提供的方式完成任务。',
    steps: [
      { title: '发现网站能力', desc: '自动识别当前网站通过 WebMCP 提供的工具，让 AI 知道这个网站能做什么、该如何调用。' },
      { title: '补充适配能力', desc: '对于尚未原生支持 WebMCP 的指定网站，也可以通过专门适配补充可调用的工具。' },
      { title: '管理授权与调用', desc: '清楚展示网站开放的功能，由用户决定是否启用；确认后，AI 才会调用相应工具完成任务。' },
      { title: '浏览器内使用', desc: '发现工具、确认授权和执行任务都在浏览器的对话界面中完成，无需在多个应用之间来回切换。' },
    ],
    ctaTitle: '准备好试试了吗？',
    ctaSub: '通过在线演示体验 WebMCP 调用网站工具的完整流程',
    mobileNote: '请在电脑浏览器中安装插件并体验。',
    mobileNoteLink: '在线使用 →',
    demoLink: '在线演示',
  },
  global: {
    heroTitleBefore: 'Let AI use websites ',
    heroTitleHighlight: 'to get things done',
    heroDesc: 'WebMCP lets websites clearly tell AI what they can do.',
    online: 'Use online',
    extensionNote: 'The extension adds a browser sidebar, WebMCP, and web search.',
    whatTitle: 'What is WebMCP?',
    whatParagraphs: [
      'WebMCP (Web Model Context Protocol) is a proposed browser API from Google and Microsoft. It lets websites expose their capabilities to AI as structured tools, describing what each tool does and what information it needs.',
      'Simply put, it is designed to help AI assistants work with websites more intelligently and precisely. Websites can tell AI directly: “what I can do and how to use it.”',
    ],
    compareTitle: 'What changes with WebMCP?',
    compareOldTitle: 'Traditional approach',
    compareOldDesc:
      'AI infers what a site can do from its appearance and structure. This can take time and is sensitive to interface changes or ambiguous labels.',
    compareOld: [
      { title: 'Interpret each control', desc: "Infer each control's purpose and operation from screenshots or page structure." },
      { title: 'Time-consuming steps', desc: 'Find controls, click, and enter information step by step.' },
      { title: 'Higher cost', desc: 'Repeated attempts can increase token and compute use.' },
      { title: 'Prone to mistakes', desc: 'Ambiguous labels or page changes can lead to missed steps or mistakes.' },
    ],
    compareNewTitle: 'With WebMCP',
    compareNewDesc: 'The website provides a structured “guide to its capabilities”, so AI can call the right action directly.',
    compareNew: [
      { icon: 'hgi-plug', title: 'No extra setup', desc: 'Open a supported site to discover its available tools.' },
      { icon: 'hgi-flash', title: 'Finish faster', desc: 'Use available actions directly with fewer searches and clicks.' },
      { icon: 'hgi-cpu', title: 'Use fewer tokens', desc: 'Reduce repeated page analysis and save tokens.' },
      { icon: 'hgi-shield-01', title: 'More reliable execution', desc: 'Use clearly defined actions that are less affected by page changes.' },
    ],
    howTitle: 'What EO2Weave does',
    howSub:
      'EO2Weave connects AI conversations, websites, and local files in your browser sidebar. With WebMCP, it discovers website tools so AI can complete tasks using the actions the site provides.',
    steps: [
      { title: 'Discover website tools', desc: 'Discover WebMCP tools on the current site and how AI can call them.' },
      { title: 'Add integrations', desc: 'Provide tools through integrations for selected sites without native WebMCP support.' },
      { title: 'Manage access and calls', desc: 'Review available website tools and decide whether to enable them before AI calls them.' },
      { title: 'Work in your browser', desc: 'Discover tools, grant access, and complete tasks from your browser conversation.' },
    ],
    ctaTitle: 'Ready to try it?',
    ctaSub: 'Try the full workflow of using website tools with WebMCP.',
    mobileNote: 'Install and try the extension in a desktop browser.',
    mobileNoteLink: 'Use online →',
    demoLink: 'Open the demo',
  },
}
