import Link from 'next/link'
import styles from '@/app/help/privacy/privacy-page.module.css'

type Locale = 'zh'

type Provider = {
  id: string
  vendor: string
  algorithmName: string
  scenario: string
  registrationNumber: string
}

type Copy = {
  documentLabel: string
  title: string
  lead: string
  updated: string
  updatedValue: string
  contents: string
  intro: string
  algorithmLabel: string
  scenarioLabel: string
  registrationLabel: string
  providers: Provider[]
  processingTitle: string
  processingBody: string
  registryTitle: string
  registryBody: string
  registryLinkLabel: string
  privacyLink: string
}

/**
 * Third-party model and algorithm registration notice.
 *
 * Content is transcribed from the source notice supplied by the operator.
 * Registration numbers and algorithm names must be copied verbatim — never
 * reformatted, reordered, or translated.
 */
const copy: Record<Locale, Copy> = {
  zh: {
    documentLabel: '怡氧®AI',
    title: '第三方大模型及算法备案信息说明',
    lead: '怡氧®AI（英文名 EO2Weave）由上海奕惟网络科技有限公司提供和运营。',
    updated: '最近更新',
    updatedValue: '2026 年 11 月 26 日',
    contents: '本页目录',
    intro:
      '本产品接入第三方大模型，以下是根据公开资料整理的相关算法备案信息。具体可用的模型和服务以产品内实际提供的为准。',
    algorithmLabel: '算法名称：',
    scenarioLabel: '算法应用场景：',
    registrationLabel: '算法备案编号：',
    providers: [
      {
        id: 'deepseek',
        vendor: 'DeepSeek 系列',
        algorithmName: 'DeepSeek 大语言模型算法',
        scenario: '在怡氧®AI 中用于智能问答、深度推理、代码辅助及内容生成。',
        registrationNumber: '网信算备110108970550101240011号',
      },
      {
        id: 'kimi',
        vendor: 'Kimi 系列',
        algorithmName: '月之暗面 Moonshot 语言模型算法-2',
        scenario: '在怡氧®AI 中用于智能对话、长文本阅读、资料总结与分析。',
        registrationNumber: '网信算备110108896786101240023号',
      },
      {
        id: 'zhipu-glm',
        vendor: '智谱 GLM 系列',
        algorithmName: '智谱交互式内容生成算法',
        scenario: '在怡氧®AI 中用于智能问答、代码辅助、内容生成及任务处理。',
        registrationNumber: '网信算备110108105858001230027号',
      },
      {
        id: 'tencent-hunyuan',
        vendor: '腾讯混元系列',
        algorithmName: '腾讯混元助手大模型算法',
        scenario: '在怡氧®AI 中用于智能对话、推理分析、内容生成及复杂任务处理。',
        registrationNumber: '网信算备440305295988701230071号',
      },
      {
        id: 'minimax',
        vendor: 'MiniMax 系列',
        algorithmName: '应事文本信息合成算法-2',
        scenario: '在怡氧®AI 中用于智能对话、长文档分析、代码辅助及多步骤任务。',
        registrationNumber: '网信算备310104297296101230065号',
      },
      {
        id: 'xiaomi-mimo',
        vendor: '小米 MiMo 系列',
        algorithmName: '小米大语言模型算法',
        scenario: '在怡氧®AI 中用于智能对话、内容分析、代码辅助及任务处理。',
        registrationNumber: '网信算备110108916280901240011号',
      },
    ],
    processingTitle: '信息处理',
    processingBody:
      '当您选择模型并发起任务时，完成任务所需的指令、对话上下文以及相关网页或文件内容会发送至所选模型服务方处理，以生成结果。自行配置服务商时，相关内容会发送至您配置的服务方或接口。有关个人信息的处理，请参阅《怡氧®AI 隐私政策》和相关服务方的隐私政策。',
    registryTitle: '备案信息查询',
    registryBody:
      '以上备案信息可通过互联网新技术新应用信息服务备案系统查询。模型服务可能随产品发展调整，我们将根据实际情况更新本说明。',
    registryLinkLabel: '打开备案查询系统',
    privacyLink: '隐私政策',
  },
}

export function ModelsPage({ locale }: { locale: Locale }) {
  const text = copy[locale]
  const isChinese = locale === 'zh'
  const total = text.providers.length

  return (
    <div className={styles.page} lang={isChinese ? 'zh-CN' : 'en'}>
      <a className={styles.skipLink} href="#models-content">
        {isChinese ? '跳到主要内容' : 'Skip to main content'}
      </a>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/" aria-label="怡氧®AI 首页">
            <span className={styles.brandMark} aria-hidden="true">✦</span>
            <span>怡氧®AI</span>
          </Link>
          <div className={styles.headerActions}>
            <Link className={styles.productLink} href="/help/privacy/">
              {text.privacyLink} <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
      </header>

      <main id="models-content">
        <section className={styles.hero} aria-labelledby="models-title">
          <p className={styles.eyebrow}>
            <span aria-hidden="true">●</span>
            {text.documentLabel}
          </p>
          <h1 id="models-title">{text.title}</h1>
          <p className={styles.heroLead}>{text.lead}</p>
          <div className={styles.metaRow}>
            <span className={styles.metaPill}>
              {text.updated}: {text.updatedValue}
            </span>
          </div>
        </section>

        <div className={styles.bodyGrid}>
          <nav className={styles.toc} aria-label={text.contents}>
            <p className={styles.tocTitle}>{text.contents}</p>
            {text.providers.map((provider, index) => (
              <a href={`#${provider.id}`} key={provider.id}>
                {String(index + 1).padStart(2, '0')} · {provider.vendor}
              </a>
            ))}
            <a href="#processing">{String(total + 1).padStart(2, '0')} · {text.processingTitle}</a>
            <a href="#registry">{String(total + 2).padStart(2, '0')} · {text.registryTitle}</a>
          </nav>

          <article className={styles.article}>
            <p className={styles.intro}>{text.intro}</p>

            {text.providers.map((provider, index) => (
              <section className={styles.section} id={provider.id} key={provider.id}>
                <span className={styles.sectionNumber}>{String(index + 1).padStart(2, '0')}</span>
                <h2>{provider.vendor}</h2>
                <ul>
                  <li>
                    <strong>{text.algorithmLabel}</strong>
                    {provider.algorithmName}
                  </li>
                  <li>
                    <strong>{text.scenarioLabel}</strong>
                    {provider.scenario}
                  </li>
                  <li>
                    <strong>{text.registrationLabel}</strong>
                    <span>{provider.registrationNumber}</span>
                  </li>
                </ul>
              </section>
            ))}

            <section className={styles.section} id="processing">
              <span className={styles.sectionNumber}>{String(total + 1).padStart(2, '0')}</span>
              <h2>{text.processingTitle}</h2>
              <p>{text.processingBody}</p>
            </section>

            <section className={styles.section} id="registry">
              <span className={styles.sectionNumber}>{String(total + 2).padStart(2, '0')}</span>
              <h2>{text.registryTitle}</h2>
              <div className={styles.contactCard}>
                <p>{text.registryBody}</p>
                <a href="https://beian.cac.gov.cn/" target="_blank" rel="noreferrer noopener">
                  {text.registryLinkLabel} →
                </a>
              </div>
            </section>
          </article>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>
            {isChinese
              ? '© 2026 上海奕惟网络科技有限公司 保留所有权利'
              : '© 2026 Astronet Technology PTE LTD. All rights reserved.'}
          </span>
        </div>
      </footer>
    </div>
  )
}
