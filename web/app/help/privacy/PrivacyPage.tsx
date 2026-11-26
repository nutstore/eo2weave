import Link from 'next/link'
import type { ReactNode } from 'react'
import { IS_CN_BUILD } from '@/lib/site-footer-config'
import styles from './privacy-page.module.css'

type Locale = 'en' | 'zh'

type Section = {
  id: string
  title: string
  body: ReactNode
}

type Copy = {
  documentLabel: string
  title: string
  lead: string
  appliesTo: string
  updated: string
  updatedValue: string
  localLabel?: string
  localValue?: string
  summary?: Array<{ icon: 'device' | 'choice' | 'shield'; title: string; body: string }>
  contents: string
  intro: ReactNode
  sections: Section[]
  backToProduct: string
  contactLabel: string
}

const copy: Record<Locale, Copy> = {
  en: {
    documentLabel: 'Privacy, by design',
    title: 'Your work stays yours.',
    lead:
      'EO2Weave is built around local processing, explicit actions, and controls you can revoke. This policy explains what the EO2Weave websites and browser extension process and when data may leave your device.',
    appliesTo: 'EO2Weave websites and browser extension',
    updated: 'Last updated',
    updatedValue: 'August 26, 2026',
    localLabel: 'Operating model',
    localValue: 'Local-first',
    summary: [
      {
        icon: 'device',
        title: 'Processed on your device',
        body: 'Settings, authorizations, caches, and task context remain local unless a task requires an external service.',
      },
      {
        icon: 'choice',
        title: 'Only when you ask',
        body: 'Page reading and interactions happen for tasks you explicitly initiate—never as silent background collection.',
      },
      {
        icon: 'shield',
        title: 'No ads or tracking',
        body: 'We do not sell your data, run behavioral advertising, or add third-party trackers to EO2Weave.',
      },
    ],
    contents: 'On this page',
    intro: (
      <>
        This policy applies to the EO2Weave services available at weave.eo2suite.cn and weave.eo2suite.com (the “websites”), as well as the EO2Weave browser extension (the “extension”). Together, they are referred to as the “services”. In this policy, “EO2Weave”, “we”, and “us” refer to the provider of these services. We do not operate a server that receives your conversations, files, or browsing activity.
      </>
    ),
    sections: [
      {
        id: 'data-we-process',
        title: 'Data we process',
        body: (
          <>
            <p>The services run primarily in your browser and process task data locally where possible. To complete tasks, they may process the following information on your device:</p>
            <ul>
              <li><strong>Page content.</strong> When you or your agent ask about a page, the services extract the relevant content for that task.</li>
              <li><strong>Page interactions.</strong> With your consent, the agent may click controls or fill forms only for a task you initiate.</li>
              <li><strong>Local state.</strong> Settings, per-site authorization grants, and cached tool descriptions are stored locally on your device.</li>
              <li><strong>Search queries.</strong> When you request a web search, the query is passed to the search service needed to fulfill it.</li>
            </ul>
          </>
        ),
      },
      {
        id: 'what-we-do-not-do',
        title: 'What we do not do',
        body: (
          <ul>
            <li>We do not collect or upload your browsing history.</li>
            <li>We do not read pages in the background; content is processed only for tasks you explicitly run.</li>
            <li>We do not send your data to servers operated by us.</li>
            <li>We do not include ads or third-party trackers in the services, and we do not sell or share your data.</li>
          </ul>
        ),
      },
      {
        id: 'ai-providers',
        title: 'AI model providers',
        body: (
          <p>To answer your request, the services send the relevant task content—which may include page content you asked about—to the AI model provider you configure. That provider processes the content under its own privacy policy. This happens only when you run a task, never automatically in the background.</p>
        ),
      },
      {
        id: 'webmcp',
        title: 'Website tools (WebMCP)',
        body: (
          <p>When you use the browser extension and a website exposes tools through WebMCP, the extension can list them for you. Using those tools requires your explicit per-site authorization, which you can revoke at any time. Tool calls are routed between your browser tabs only.</p>
        ),
      },
      {
        id: 'desktop-helper',
        title: 'Optional local helper',
        body: (
          <>
            <p>You may separately install and connect the EO2Weave local helper to extend the agent’s capabilities on your device. Within project folders you explicitly authorize, it may:</p>
            <ul>
              <li><strong>Access local files.</strong> Read, create, modify, and organize files needed for tasks you initiate.</li>
              <li><strong>Run local commands.</strong> Execute approved development commands, such as tests, builds, type checks, and other project tooling.</li>
            </ul>
            <p>The local helper is never installed or connected silently. File access is limited to folders you authorize, and command execution is subject to the configured permission and approval policy. EO2Weave remains usable without the local helper.</p>
          </>
        ),
      },
      {
        id: 'storage-deletion',
        title: 'Storage and deletion',
        body: <p>Local state—including settings, authorizations, and caches—stays on your device. You can remove website data through your browser settings; removing the extension deletes data stored by the extension.</p>,
      },
      {
        id: 'changes',
        title: 'Changes to this policy',
        body: <p>We may update this policy as the services change. Material changes will be reflected on this page together with a revised update date.</p>,
      },
      {
        id: 'contact',
        title: 'Contact',
        body: <p>Questions about this policy are welcome.</p>,
      },
    ],
    backToProduct: 'Open EO2Weave',
    contactLabel: 'Email privacy support',
  },
  zh: {
    documentLabel: '隐私政策',
    title: '怡氧®AI 隐私政策',
    lead: '我们重视您的个人信息安全。本政策说明我们在提供本产品时收集和使用哪些信息、如何保存和提供这些信息，以及您如何管理自己的信息。请在使用前阅读本政策。',
    appliesTo: '怡氧®AI 网站与浏览器扩展',
    updated: '最近更新',
    updatedValue: '2026 年 11 月 26 日',
    contents: '本页目录',
    intro: (
      <>
        怡氧®AI（英文名 EO2Weave，下称“本产品”）由上海奕惟网络科技有限公司（下称“我们”）提供和运营，是支持 Chrome、Edge 的浏览器 AI 助手扩展程序，并提供配套的网页端工作台。您可以在浏览器侧边栏中，让本产品基于您正在浏览的网页、您授权访问的本地文件，以及您所在网站开放的功能，帮助您阅读、总结、写作、分析与协作。
      </>
    ),
    sections: [
      {
        id: 'account',
        title: '账号的注册和登录',
        body: (
          <>
            <p><strong>本产品支持两种使用方式</strong>：通过第三方账号（如坚果云账号）登录，登录后可使用账号对应的内置模型，无需自行配置；或<strong>不登录账号，自行配置模型服务商（如填写 API Key）</strong>后使用。我们仅收集实现相应功能所必需的信息。</p>
            <p>当您选择通过第三方账号登录时，我们会在您明确授权后，从该第三方账号服务方获取以下必要信息：</p>
            <table>
              <thead>
                <tr>
                  <th>信息类型</th>
                  <th>具体内容</th>
                  <th>用途</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>账号标识</td>
                  <td>用于登录校验的账号标识</td>
                  <td>验证您的身份、维持登录状态</td>
                </tr>
                <tr>
                  <td>服务权益信息</td>
                  <td>积分、额度等</td>
                  <td>关联并管理您可使用的模型与额度</td>
                </tr>
              </tbody>
            </table>
            <p>第三方账号的注册、密码管理和注销由相应账号服务方按照其规则处理。</p>
          </>
        ),
      },
      {
        id: 'usage',
        title: '使用产品时涉及的信息',
        body: (
          <>
            <p>为提供您使用的功能，本产品及相关服务方可能需要处理以下信息。使用 AI 功能时，完成任务所需的内容会发送给您选择的模型服务方，具体请参阅第三节。</p>
            <ul>
              <li><strong>对话与任务内容。</strong>您输入的指令、对话、上传或选取的内容、AI 返回的结果及必要的任务记录，用于理解请求、执行任务和保持会话连续。</li>
              <li><strong>网页与文件内容。</strong>在您发起任务并授予相应权限后，本产品可能读取相关网页或您关联的本地文件，并按您的指令生成或修改内容。实际访问范围受浏览器、系统和产品授权控制。</li>
              <li><strong>模型与工具配置。</strong>您选择的模型，以及自行填写的服务商名称、接口地址、模型信息和 API Key 等，用于连接您选择的模型或工具、发起请求和返回结果。</li>
              <li><strong>使用与安全信息。</strong>模型调用和额度使用记录、设备与浏览器信息、IP 地址及必要的运行日志，用于展示用量、保障安全、排查故障和维护服务。</li>
              <li><strong>意见与反馈。</strong>当您向我们反馈问题或提出建议时，我们可能处理您主动提供的反馈内容及联系方式，以便与您沟通并处理相关问题。</li>
            </ul>
            <p>如果您提供的内容涉及他人个人信息，请确保您有权使用相关信息。</p>
          </>
        ),
      },
      {
        id: 'third-party-models',
        title: '第三方大模型和相关服务',
        body: (
          <>
            <p>您可以通过以下两种方式使用 AI 模型：</p>
            <ul>
              <li><strong>使用内置模型。</strong>您登录坚果云账号后，可以选择账号对应的内置第三方大模型。发起任务时，完成任务所需的指令、对话上下文、网页或文件内容会发送给所选模型的服务方，用于处理您的请求并返回结果。</li>
              <li><strong>自行配置模型服务商。</strong>您也可以填写 API Key 使用预置服务商，或自定义服务商。发起任务时，完成任务所需的内容会发送至您配置的服务方或接口，以处理您的请求并返回结果。</li>
            </ul>
            <p>有关本产品接入的第三方大模型及相关算法备案信息，您可以查阅<Link href="/help/models/">《怡氧®AI 第三方大模型及算法备案信息说明》</Link>。</p>
            <p>您自行接入的模型、网站或工具可能按照其自身的隐私政策处理收到的信息。使用前请核对服务商、接口地址及其规则。我们会就本产品自身参与的信息处理履行相应保护义务；对于由我们接入并向其提供个人信息的合作方，我们会依法履行告知、合同管理及必要的同意程序。有关模型和合作方的信息，可通过产品展示的模型或服务商说明了解。</p>
            <p>API Key 是访问模型服务的凭证，请妥善保管，并注意核对您填写的服务商及接口地址。我们仅为实现您选择的连接和调用功能处理相关配置，并采取与其风险相适应的保护措施。</p>
          </>
        ),
      },
      {
        id: 'sharing',
        title: '信息的提供、保存与安全',
        body: (
          <>
            <p>我们仅在提供服务、保障安全、履行法定义务等必要范围内处理或向合作方提供信息。因您选择第三方账号登录、接入模型或使用外部工具而涉及其他服务方时，我们会按照适用法律处理与这些服务方之间的信息流转。</p>
            <p>您可以通过相关购买页面购买积分或升级服务。购买过程中涉及的信息处理，适用购买页面所展示的隐私政策；与您账号关联的积分和服务权益，可用于在本产品中展示和使用相应功能。</p>
            <p><strong>数据统计与分析</strong>：为了解产品使用情况、改进功能和服务体验，我们可能接入火山引擎提供的数据统计 SDK（提供方：北京火山引擎科技有限公司）。该 SDK 可能处理必要的设备及浏览器信息、使用记录等，用于统计和分析产品使用情况。</p>
            <p>我们在实现处理目的所需的期限内保存个人信息；法律法规要求另行保存的，从其规定。超出保存期限后，我们将依法删除或匿名化处理。我们会采取合理的访问控制、传输保护和安全管理措施，防止信息遭到未经授权的访问、泄露、篡改或丢失。如果发生个人信息安全事件，我们将及时采取必要的补救措施，并按照法律法规要求告知您相关情况。</p>
          </>
        ),
      },
      {
        id: 'cookies',
        title: '我们如何使用 Cookie 等同类技术',
        body: (
          <>
            <p>为了让您更方便、安全地使用本产品，我们可能在网页端使用 Cookie 等同类技术，用于维持登录状态、保存必要设置，以及保障服务的安全和正常运行。</p>
            <p>您可以通过浏览器设置管理或清除 Cookie。请注意，清除或关闭 Cookie 后，您可能需要重新登录，部分依赖 Cookie 的功能也可能受到影响。</p>
            <p>如果您访问第三方网站，该网站使用 Cookie 等技术的情况适用其自身的隐私政策。</p>
          </>
        ),
      },
      {
        id: 'rights',
        title: '您如何管理个人信息',
        body: (
          <>
            <p>您可以退出第三方账号登录，也可以在产品设置中管理自行配置的模型服务商和 API Key。对于授予本产品的浏览器或文件访问权限，您可以通过浏览器或系统设置进行管理。</p>
            <p>如果您对本产品处理您的个人信息有疑问，或希望查阅、更正、删除相关信息，可以通过本产品或官网公布的客服渠道联系我们。</p>
            <p>如果您需要管理或注销坚果云账号，或管理由第三方模型服务商处理的信息，请通过相应服务方提供的方式进行操作。</p>
          </>
        ),
      },
      {
        id: 'minors',
        title: '未成年人保护',
        body: <p>未成年人应在监护人的指导下使用本产品。我们会依照适用法律保护未成年人的个人信息；监护人如对相关信息处理有疑问，可通过下述渠道联系我们。</p>,
      },
      {
        id: 'contact',
        title: '政策更新与联系我们',
        body: (
          <>
            <p>我们可能因产品功能或法律要求变化而更新本政策。重大变更将通过产品提示、网站公告或其他适当方式告知；依法需要重新取得同意的，我们会在相关处理前完成。</p>
            <p>您可通过本产品或官网公布的客服渠道联系我们，提出隐私问题或行使个人信息相关权利。</p>
          </>
        ),
      },
    ],
    backToProduct: '打开怡氧®AI',
    contactLabel: '发送隐私问题邮件',
  },
}

function Icon({ name }: { name: 'device' | 'choice' | 'shield' }) {
  if (name === 'device') {
    return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M9 17h6" /></svg>
  }
  if (name === 'choice') {
    return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m9 12 2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>
  }
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3 5 6v5c0 4.8 2.8 8.2 7 10 4.2-1.8 7-5.2 7-10V6l-7-3Z" /><path d="m9.5 12 1.6 1.6 3.5-3.6" /></svg>
}

export function PrivacyPage({ locale }: { locale: Locale }) {
  const text = copy[locale]
  const isChinese = locale === 'zh'

  return (
    <div className={styles.page} lang={isChinese ? 'zh-CN' : 'en'}>
      <a className={styles.skipLink} href="#privacy-content">{isChinese ? '跳到主要内容' : 'Skip to main content'}</a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/" aria-label={isChinese ? '怡氧®AI 首页' : 'EO2Weave home'}>
            <span className={styles.brandMark} aria-hidden="true">✦</span>
            <span>{isChinese ? '怡氧®AI' : 'EO2Weave'}</span>
          </Link>
          <div className={styles.headerActions}>
            <Link className={styles.productLink} href="/">{text.backToProduct} <span aria-hidden="true">↗</span></Link>
          </div>
        </div>
      </header>

      <main id="privacy-content">
        <section className={styles.hero} aria-labelledby="privacy-title">
          <p className={styles.eyebrow}><span aria-hidden="true">●</span>{text.documentLabel}</p>
          <h1 id="privacy-title">{text.title}</h1>
          <p className={styles.heroLead}>{text.lead}</p>
          <div className={styles.metaRow}>
            <span className={styles.metaPill}>{text.appliesTo}</span>
            <span className={styles.metaPill}>{text.updated}: {text.updatedValue}</span>
            {text.localLabel && text.localValue ? (
              <span className={styles.metaPill}>{text.localLabel}: {text.localValue}</span>
            ) : null}
          </div>
          {text.summary ? (
            <div className={styles.summaryGrid} aria-label={isChinese ? '隐私摘要' : 'Privacy summary'}>
              {text.summary.map((item) => (
                <article className={styles.summaryCard} key={item.title}>
                  <span className={styles.summaryIcon}><Icon name={item.icon} /></span>
                  <h2>{item.title}</h2>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
          ) : null}
        </section>

        <div className={styles.bodyGrid}>
          <nav className={styles.toc} aria-label={text.contents}>
            <p className={styles.tocTitle}>{text.contents}</p>
            {text.sections.map((section, index) => <a href={`#${section.id}`} key={section.id}>{String(index + 1).padStart(2, '0')} · {section.title}</a>)}
          </nav>

          <article className={styles.article}>
            <p className={styles.intro}>{text.intro}</p>
            {text.sections.map((section, index) => (
              <section className={styles.section} id={section.id} key={section.id}>
                <span className={styles.sectionNumber}>{String(index + 1).padStart(2, '0')}</span>
                <h2>{section.title}</h2>
                {section.id === 'contact' ? (
                  <div className={styles.contactCard}>
                    {section.body}
                    <a href="mailto:support@eo2suite.com">{text.contactLabel} →</a>
                  </div>
                ) : section.body}
              </section>
            ))}
          </article>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>{IS_CN_BUILD ? `© 2026 上海奕惟网络科技有限公司 保留所有权利` : `© 2026 Astronet Technology PTE LTD. All rights reserved.`}</span>
        </div>
      </footer>
    </div>
  )
}
