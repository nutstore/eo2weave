import { ExtensionMenu } from '../../chrome/ExtensionMenu'
import { chromeCopy } from '../../chrome/copy'
import type { CSSProperties } from 'react'

export function HomeCnMarkup() {
  return (
    <>


<main className="page">
<section className="hero shell" id="top" aria-labelledby="hero-title">
<div className="hero-copy">
<h1 id="hero-title">知你所想&ensp;<em>成你所愿</em>
</h1>
<p className="description">怡氧知知是一款运行在浏览器中的 AI 工作空间，无需安装桌面客户端。你可以在侧边栏选用不同的 AI 模型，让怡氧知知在授权范围内理解网页、完成网站操作，并处理本地文件，帮你完成复杂任务。</p>
<div className="actions">
<ExtensionMenu variant="hero" copy={chromeCopy.cn.header} />
<a className="button primary" href="/projects" data-extension-not-detected target="_blank" rel="noopener noreferrer">在线使用</a>
</div>
<p className="extension-entry-note" data-extension-not-detected>插件提供网页侧边栏、WebMCP 和联网搜索。</p>
</div>
</section>
<section className="primary-work-section" aria-labelledby="primary-work-title">
<div className="section-shell">
<h2 className="section-title primary-work-title" id="primary-work-title">不止回答，更能执行</h2>
<div className="primary-work-grid">
<article className="primary-work-card primary-work-card--web">
<h3>让 AI 替你<span className="primary-work-accent">操作网站</span>
</h3>
<p>在网站中查找信息、填写表单并执行相应操作，给你实际处理结果，而不只是一份操作建议。</p>
<div className="primary-work-visual work-preview" role="img" aria-label="邮件网页与怡氧知知协作流程：查询项目进度、起草进度汇报邮件并经确认后发送">
<div className="work-preview-web-body">
<div className="work-preview-page">
<div className="work-preview-email-list">
<div className="work-preview-email-row is-unread">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">本周项目进度确认</span>
<span className="work-preview-email-snippet">— 方便同步下当前进度及待解决事项吗？</span>
</div>
<span className="work-preview-email-time">10:42</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">本周任务进展更新</span>
<span className="work-preview-email-snippet">— 需求评审已完成，整理结果见附件</span>
</div>
<span className="work-preview-email-time">09:18</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">联调测试进度</span>
<span className="work-preview-email-snippet">— 主要接口已完成联调，还有两项待确认</span>
</div>
<span className="work-preview-email-time">昨天</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">确认本周发布排期</span>
<span className="work-preview-email-snippet">— 请大家确认最终上线时间和待办事项</span>
</div>
<span className="work-preview-email-time">10/19</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">需求评审结论</span>
<span className="work-preview-email-snippet">— 本周评审事项和负责人已更新</span>
</div>
<span className="work-preview-email-time">10/18</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">任务分工调整</span>
<span className="work-preview-email-snippet">— 新的负责人和截止时间已同步</span>
</div>
<span className="work-preview-email-time">10/17</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">项目例会安排</span>
<span className="work-preview-email-snippet">— 会议时间：周五 14:00，线上参会</span>
</div>
<span className="work-preview-email-time">10/16</span>
</div>
</div>
</div>
<div className="work-preview-assistant">
<div className="work-preview-assistant-name">怡氧知知</div>
<div className="local-files-query work-preview-question work-preview-question--one">
<span className="local-files-query-label" aria-hidden="true">
</span>
<span className="work-preview-question-text">搜索之前的项目邮件，<br />总结进度并起草邮件回复</span>
</div>
<div className="local-files-query work-preview-question work-preview-question--three">
<span className="local-files-query-label" aria-hidden="true">
</span>没问题，发送吧</div>
</div>
</div>
</div>
</article>
<article className="primary-work-card primary-work-card--files">
<h3>让 AI 替你<span className="primary-work-accent">处理本地文件</span>
</h3>
<p>在关联的文件夹中查找所需文件、整理资料并修改内容，省去逐个翻找、打开和手动处理的时间。</p>
<div className="primary-work-visual local-files-scene" role="img" aria-label="关联会议资料文件夹，内有汇报 PPT、任务跟进表和多份会议纪要，周围展示三个可以向 AI 提出的问题">
<div className="local-files-art">
<svg className="local-files-defs" aria-hidden="true" width="0" height="0">
<symbol id="local-folder-shape" viewBox="0 0 24 24">
<path d="M3.5 7.5V6a2 2 0 0 1 2-2h4.1l2 2.3h6.9a2 2 0 0 1 2 2v9.2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
</symbol>
</svg>
<div className="local-files-query local-files-query--ppt">
<span className="local-files-query-label" aria-hidden="true">
</span>根据最新进度生成汇报 PPT</div>
<div className="local-files-query local-files-query--one">
<span className="local-files-query-label" aria-hidden="true">
</span>这两次会议有哪些事还没跟进？</div>
<div className="local-files-query local-files-query--two">
<span className="local-files-query-label" aria-hidden="true">
</span>把最新分工更新到任务跟进表</div>
<div className="local-files-panel">
<div className="local-files-tabs">
<span className="local-files-tab is-active">
<svg className="local-files-icon" aria-hidden="true">
<use href="#local-folder-shape" />
</svg>文件</span>
<span className="local-files-tab">
<svg className="local-files-icon" viewBox="0 0 24 24" aria-hidden="true">
<circle cx="12" cy="12" r="9" />
<path d="m8 12 2.5 2.5L16 9" />
</svg>待确认</span>
<span className="local-files-tab">
<svg className="local-files-icon" viewBox="0 0 24 24" aria-hidden="true">
<circle cx="12" cy="12" r="9" />
<path d="M12 7v5l3 2" />
</svg>保存记录</span>
</div>
<div className="local-files-tree">
<div className="local-files-caption">关联本地文件夹</div>
<div className="local-files-root">
<svg className="local-files-icon" aria-hidden="true">
<use href="#local-folder-shape" />
</svg>会议资料</div>
<div className="local-files-folder">
<svg className="local-files-chevron" viewBox="0 0 14 14" aria-hidden="true">
<path d="m3.5 5.5 3.5 3.5 3.5-3.5" />
</svg>
<svg className="local-files-icon" aria-hidden="true">
<use href="#local-folder-shape" />
</svg>汇报PPT</div>
<div className="local-files-document">2026-10-13_部门进度汇报.pptx</div>
<div className="local-files-document">2026-10-20_部门进度汇报.pptx</div>
<div className="local-files-folder">
<svg className="local-files-chevron" viewBox="0 0 14 14" aria-hidden="true">
<path d="m3.5 5.5 3.5 3.5 3.5-3.5" />
</svg>
<svg className="local-files-icon" aria-hidden="true">
<use href="#local-folder-shape" />
</svg>任务跟进</div>
<div className="local-files-document">任务跟进表.xlsx</div>
<div className="local-files-folder">
<svg className="local-files-chevron" viewBox="0 0 14 14" aria-hidden="true">
<path d="m3.5 5.5 3.5 3.5 3.5-3.5" />
</svg>
<svg className="local-files-icon" aria-hidden="true">
<use href="#local-folder-shape" />
</svg>会议纪要</div>
<div className="local-files-document">2026-10-13_部门周会纪要.docx</div>
<div className="local-files-document">2026-10-15_项目评审会纪要.docx</div>
<div className="local-files-document">2026-10-19_阶段复盘会纪要.docx</div>
<div className="local-files-document">2026-10-20_部门周会纪要.docx</div>
</div>
</div>
</div>
</div>
</article>
</div>
</div>
<div className="capabilities-section" id="features">
<div className="section-shell">
<article className="capability-story capability-story--sidebar">
<div className="capability-copy">
<h3>在侧边栏，工作不断线</h3>
<ul className="capability-points">
<li className="capability-point">
<h4>随时打开</h4>
<p>在当前网页调用 AI，省去页面间切换。</p>
</li>
<li className="capability-point">
<h4>跨页接续</h4>
<p>打开新标签页，对话与任务仍会保留。</p>
</li>
<li className="capability-point">
<h4>多模型选择</h4>
<p>按任务需要，在侧边栏切换 AI 模型。</p>
</li>
</ul>
</div>
<div className="sidebar-demo" role="img" aria-label="演示：在网站上打开怡氧知知侧边栏，询问网站摘要和类似产品；AI 打开相关网站后，切换标签页仍保留同一段对话" data-step="idle">
<div className="sidebar-art" aria-hidden="true">
<div className="sidebar-browser">
<div className="sidebar-browser-top">
<span className="sidebar-browser-dots">
<i>
</i>
<i>
</i>
<i>
</i>
</span>
<span className="sidebar-browser-tab sidebar-browser-tab--current">当前网站</span>
<span className="sidebar-browser-tab sidebar-browser-tab--one">类似产品 A<svg className="sidebar-tab-cursor" viewBox="0 0 18 20" aria-hidden="true">
<path d="M2 1v15l4-3 2.7 5 2.8-1.4-2.6-5.1 5.2-.1z" />
</svg>
</span>
<span className="sidebar-browser-tab sidebar-browser-tab--two">类似产品 B<svg className="sidebar-tab-cursor" viewBox="0 0 18 20" aria-hidden="true">
<path d="M2 1v15l4-3 2.7 5 2.8-1.4-2.6-5.1 5.2-.1z" />
</svg>
</span>
</div>
<div className="sidebar-browser-address">
<span className="sidebar-address-pill">
<span>当前网页</span>
<span>类似产品 A</span>
<span>类似产品 B</span>
</span>
</div>
<div className="sidebar-browser-view">
<div className="sidebar-site sidebar-site--current">
<div className="sidebar-home-header">
<span className="sidebar-home-brand">
<i className="sidebar-home-brand-mark">
</i>
</span>
<span className="sidebar-home-nav">
<i>
</i>
<i>
</i>
<i>
</i>
</span>
<span className="sidebar-home-header-cta">
</span>
</div>
<div className="sidebar-home-hero">
<span className="sidebar-home-title">
</span>
<span className="sidebar-home-subtitle">
<i>
</i>
<i>
</i>
</span>
<span className="sidebar-home-button">
</span>
</div>
<div className="sidebar-home-cards">
<div className="sidebar-home-card sidebar-home-card--green">
<span className="sidebar-home-card-mark">✦</span>
<i className="sidebar-home-card-title">
</i>
<span className="sidebar-home-card-copy">
<i>
</i>
<i>
</i>
</span>
</div>
<div className="sidebar-home-card sidebar-home-card--blue">
<span className="sidebar-home-card-mark">↗</span>
<i className="sidebar-home-card-title">
</i>
<span className="sidebar-home-card-copy">
<i>
</i>
<i>
</i>
</span>
</div>
<div className="sidebar-home-card sidebar-home-card--gold">
<span className="sidebar-home-card-mark">◌</span>
<i className="sidebar-home-card-title">
</i>
<span className="sidebar-home-card-copy">
<i>
</i>
<i>
</i>
</span>
</div>
</div>
</div>
<div className="sidebar-site sidebar-site--product">
<div className="sidebar-site-header">
<span className="sidebar-site-logo">
</span>
<span className="sidebar-site-nav">
<i>
</i>
<i>
</i>
<i>
</i>
</span>
</div>
<div className="sidebar-site-hero">
<div className="sidebar-site-copy">
<i>
</i>
<i>
</i>
<i>
</i>
<i>
</i>
</div>
<div className="sidebar-site-image">
</div>
</div>
<div className="sidebar-site-tiles">
<i>
</i>
<i>
</i>
<i>
</i>
</div>
</div>
<div className="sidebar-site sidebar-site--product-b">
<div className="sidebar-site-header">
<span className="sidebar-site-logo">
</span>
<span className="sidebar-site-nav">
<i>
</i>
<i>
</i>
<i>
</i>
</span>
</div>
<div className="sidebar-site-hero">
<div>
<div className="sidebar-product-b-title">
</div>
<div className="sidebar-product-b-lead">
<span className="sidebar-product-b-thumb">
</span>
<span className="sidebar-product-b-lines">
<i>
</i>
<i>
</i>
<i>
</i>
</span>
</div>
<div className="sidebar-product-b-section">
<strong>
</strong>
<i>
</i>
<i>
</i>
<i>
</i>
</div>
<div className="sidebar-product-b-section sidebar-product-b-section--last">
<strong>
</strong>
<i>
</i>
<i>
</i>
<i>
</i>
</div>
</div>
</div>
</div>
<span className="sidebar-float">
<img src="/marketing/logo.svg" alt="" />
</span>
<div className="sidebar-pane">
<div className="sidebar-pane-head">
<img src="/marketing/logo.svg" alt="" />怡氧知知</div>
<div className="sidebar-pane-chat">
<div className="sidebar-user-message">总结当前网站，并找出类似产品，打开相关网站。</div>
<div className="sidebar-ai-message">
<span className="sidebar-ai-icon">
</span>
<div className="sidebar-ai-text">
<strong>已总结当前网站</strong>找到 2 个相关产品，已在新标签页打开。<span className="sidebar-ai-link">类似产品 A</span>
<span className="sidebar-ai-link">类似产品 B</span>
</div>
</div>
</div>
<div className="sidebar-input is-empty">
<span className="sidebar-input-text">
</span>
<span className="sidebar-input-caret">
</span>
<span className="sidebar-input-send">
</span>
</div>
</div>
</div>
</div>
<svg className="sidebar-demo-cursor" viewBox="0 0 18 20">
<path d="M2 1v15l4-3 2.7 5 2.8-1.4-2.6-5.1 5.2-.1z" />
</svg>
</div>
</div>
</article>
<article className="capability-story capability-story--workflow">
<div className="capability-copy">
<h3>重复工作，不必从头来</h3>
<ul className="capability-points">
<li className="capability-point">
<h4>保存固定步骤</h4>
<p>将重复的操作整理成工作流，减少每次重新说明。</p>
</li>
<li className="capability-point">
<h4>复用常用方法</h4>
<p>把有效做法沉淀为技能，遇到同类工作继续使用。</p>
</li>
<li className="capability-point">
<h4>处理复杂目标</h4>
<p>需要灵活判断的任务，可交给 Agent 分步处理。</p>
</li>
</ul>
</div>
<div className="workflow-demo" aria-label="按工作流整理周报并发送演示" data-progress="0">
<div className="workflow-art" aria-hidden="true">
<div className="workflow-board">
<div className="workflow-board-head">
<div className="workflow-board-title">
<span className="workflow-title-icon-box">
<img className="workflow-title-icon" src="/marketing/sparkle.svg" alt="" />
</span>按工作流整理周报并发送</div>
</div>
<div className="workflow-content">
<div className="workflow-steps">
<div className="workflow-step">
<span className="workflow-step-name">01 输入关键词</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">02 搜索邮件</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">03 查找本地文件</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">04 生成周报</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">05 生成邮件草稿</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">06 审核</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">07 保存并发送</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
</div>
<div className="workflow-assistant">
<div className="workflow-assistant-head">
<img src="/marketing/logo.svg" alt="" />怡氧知知</div>
<div className="workflow-chat">
<div className="workflow-thread">
<div className="workflow-user-message">
<span className="workflow-prompt-text">
</span>
<span className="workflow-prompt-caret">
</span>
</div>
<div className="workflow-chat-reply workflow-reply-mail">正在搜索上周邮件内容…</div>
<div className="workflow-chat-reply workflow-reply-local">正在整理本地更新文件…</div>
<div className="workflow-chat-reply workflow-reply-reporting">正在整理周报内容，梳理本周进展与待跟进事项…</div>
<div className="workflow-chat-reply workflow-reply-report-ready">周报初稿已整理好：</div>
<div className="workflow-report-card">
<div className="workflow-report-title">
<span>上周工作周报</span>
<span>10.12 – 10.16</span>
</div>
<p className="workflow-report-summary">本周完成商品资料校验与上新，库存差异已同步仓库复核，双 11 活动素材进入确认阶段。</p>
<div className="workflow-report-line">
<strong>商品上新</strong>
<span>18 款资料完成校验，12 款已上架</span>
</div>
<div className="workflow-report-line">
<strong>库存协同</strong>
<span>SKU-1042 出入库差异已提交复核</span>
</div>
<div className="workflow-report-line">
<strong>活动准备</strong>
<span>双 11 会场素材初稿待负责人确认</span>
</div>
<div className="workflow-report-chart">
<div className="workflow-report-chart-title">每日完成事项 · 示意</div>
<div className="workflow-report-bars">
<i className="workflow-report-bar" style={{ '--bar-height': '17px' } as CSSProperties}>
</i>
<i className="workflow-report-bar" style={{ '--bar-height': '25px' } as CSSProperties}>
</i>
<i className="workflow-report-bar" style={{ '--bar-height': '21px' } as CSSProperties}>
</i>
<i className="workflow-report-bar" style={{ '--bar-height': '32px' } as CSSProperties}>
</i>
<i className="workflow-report-bar" style={{ '--bar-height': '27px' } as CSSProperties}>
</i>
</div>
<div className="workflow-report-days">
<span>一</span>
<span>二</span>
<span>三</span>
<span>四</span>
<span>五</span>
</div>
</div>
</div>
<div className="workflow-chat-reply workflow-reply-email">邮件草稿：</div>
<div className="workflow-email-card">
<div className="workflow-email-heading">邮件草稿</div>
<div className="workflow-email-meta">收件人　Leader</div>
<div className="workflow-email-meta">主题　　上周工作周报（10.12–10.16）</div>
<div className="workflow-email-body">Leader，您好：上周工作已整理成周报，详见附件。重点进展包括完成 12 款商品上架、提交 SKU-1042 库存差异复核，以及推进双 11 会场素材确认。</div>
<div className="workflow-email-attachment">
<span className="workflow-email-attachment-type">PDF</span>
<span className="workflow-email-attachment-name">上周工作周报_10.12-10.16.pdf</span>
</div>
</div>
<div className="workflow-review-divider">
</div>
<div className="workflow-review-note">周报和邮件内容已生成，请审核。审核通过后，周报将保存到本地，邮件将发送给 Leader。</div>
<div className="workflow-user-message workflow-user-confirmation">
<span className="workflow-confirmation-text">
</span>
</div>
<div className="workflow-chat-reply workflow-reply-done">已为您发送邮件，并保存周报到本地</div>
</div>
</div>
<div className="workflow-composer">
<input className="workflow-input" type="text" value="" readOnly aria-label="输入关键词" />
<button className="workflow-send" type="button" aria-label="发送消息" title="发送消息">{/* Hugeicons Arrow Up 01, Stroke Rounded: https://hugeicons.com/icon/arrow-up-01 */}<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M12 19V5m0 0L5 12m7-7 7 7" />
</svg>
</button>
</div>
</div>
</div>
</div>
</div>
</div>
</article>
<section className="results-section" aria-labelledby="results-title">
<div className="results-copy">
<h3 id="results-title">完成任务，交付成果</h3>
<ul className="capability-points">
<li className="capability-point">
<h4>内容创作</h4>
<p>起草邮件、文案和报告，制作演示文稿。</p>
</li>
<li className="capability-point">
<h4>数据分析</h4>
<p>整理表格、分析数据，生成图表和结论。</p>
</li>
<li className="capability-point">
<h4>文件管理</h4>
<p>批量重命名、分类文件，整理文件夹结构。</p>
</li>
<li className="capability-point">
<h4>网页与工具</h4>
<p>制作可预览的 HTML 页面和实用小工具。</p>
</li>
<li className="capability-point capability-more">更多能力，等你来发现...</li>
</ul>
</div>
<div className="result-panel" role="img" aria-label="成果展示：文稿创作、按项目阶段调整文件夹结构，以及电商商品出入库表和变化趋势图">
<div className="result-art" aria-hidden="true">
<div className="result-output result-report">
<div className="result-document">
<div className="result-document-meta">
<span>2026.10</span>
</div>
<strong className="result-document-title">项目进展简报</strong>
<div className="result-document-rule">
</div>
<div className="result-document-lines">
<span>
</span>
<span>
</span>
<span>
</span>
<span>
</span>
<span>
</span>
</div>
</div>
</div>
<div className="result-output result-analysis">
<h4 className="result-folder-heading">
<span className="result-folder-heading-icon" aria-hidden="true">
<img src="/marketing/sparkle.svg" alt="" />
</span>
<span className="result-folder-heading-text">自动整理文件夹结构</span>
</h4>
<div className="result-folder-pane result-folder-pane--before">
<div className="result-folder-label">BEFORE</div>
<div className="result-folder-before-files">
<span>
</span>
<span>
</span>
<span>
</span>
<span>
</span>
<span>
</span>
</div>
</div>
<div className="result-folder-pane result-folder-pane--after">
<div className="result-folder-label">AFTER</div>
<div className="result-folder-groups">
<div className="result-folder-group">
<div className="result-folder-group-title">
<i className="hgi-stroke hgi-folder-01 result-folder-icon" aria-hidden="true">
</i>策划准备</div>
<div className="result-folder-group-files">
<span>
</span>
<span>
</span>
</div>
</div>
<div className="result-folder-group">
<div className="result-folder-group-title">
<i className="hgi-stroke hgi-folder-01 result-folder-icon" aria-hidden="true">
</i>上线执行</div>
<div className="result-folder-group-files">
<span>
</span>
<span>
</span>
</div>
</div>
<div className="result-folder-group">
<div className="result-folder-group-title">
<i className="hgi-stroke hgi-folder-01 result-folder-icon" aria-hidden="true">
</i>复盘交付</div>
<div className="result-folder-group-files">
<span>
</span>
</div>
</div>
</div>
</div>
</div>
<div className="result-output result-trend">
<div className="result-sheet">
<table className="result-table">
<colgroup>
<col />
<col />
<col />
<col />
<col />
<col />
</colgroup>
<thead>
<tr>
<th>
</th>
<th>A</th>
<th>B</th>
<th>C</th>
<th>D</th>
<th>E</th>
</tr>
</thead>
<tbody>
<tr>
<th>1</th>
<td>SKU</td>
<td>入库</td>
<td>出库</td>
<td>现存</td>
<td>周转</td>
</tr>
<tr>
<th>2</th>
<td>SKU-1042</td>
<td>170</td>
<td>115</td>
<td>74</td>
<td>6.2</td>
</tr>
<tr>
<th>3</th>
<td>SKU-1087</td>
<td>245</td>
<td>165</td>
<td>86</td>
<td>8.1</td>
</tr>
<tr>
<th>4</th>
<td>SKU-1124</td>
<td>205</td>
<td>155</td>
<td className="result-stock-low">58</td>
<td>2.4</td>
</tr>
<tr>
<th>5</th>
<td>SKU-1260</td>
<td>285</td>
<td>190</td>
<td>149</td>
<td>10.3</td>
</tr>
<tr>
<th>6</th>
<td>SKU-1308</td>
<td>340</td>
<td>225</td>
<td>125</td>
<td>7.4</td>
</tr>
<tr>
<th>7</th>
<td>SKU-1356</td>
<td>285</td>
<td>205</td>
<td>82</td>
<td>4.6</td>
</tr>
</tbody>
</table>
</div>
<div className="result-chart">
<div className="result-chart-head">
<div className="result-chart-caption">根据表格自动生成分析报告和图表</div>
<div className="result-chart-insight">净入库 <strong data-result-net>
</strong>
</div>
</div>
<svg viewBox="0 0 350 165" aria-hidden="true">
</svg>
</div>
</div>
</div>
</div>
</section>
</div>
</div>
</section>
<section className="webmcp-section" id="webmcp" aria-labelledby="webmcp-title">
<div className="section-shell">
<div className="webmcp-panel">
<div className="webmcp-ambient" aria-hidden="true">
</div>
<div className="webmcp-content">
<h2 id="webmcp-title">怡氧知知操作网站，更快更稳</h2>
<p className="webmcp-lead">怡氧知知能通过 WebMCP 直接使用网站开放的操作。WebMCP 会把网站能做什么、操作需要哪些信息告诉 AI，减少反复查找和尝试。对于尚未接入 WebMCP 的网站，怡氧知知仍可通过页面理解和常规交互继续处理任务。<a className="webmcp-more" href="#webmcp" aria-label="了解 WebMCP">了解 WebMCP <span aria-hidden="true">→</span>
</a>
</p>
</div>
<div className="webmcp-benefits">
<div className="webmcp-benefit">
<h3>
<i className="hgi-stroke hgi-plug" aria-hidden="true">
</i>无需额外配置</h3>
<p>打开已支持的网站，即可识别其开放的能力。</p>
</div>
<div className="webmcp-benefit">
<h3>
<i className="hgi-stroke hgi-flash" aria-hidden="true">
</i>更快完成</h3>
<p>减少寻找入口与重复点击，直接使用可用操作。</p>
</div>
<div className="webmcp-benefit">
<h3>
<i className="hgi-stroke hgi-cpu" aria-hidden="true">
</i>降低消耗</h3>
<p>减少反复解析页面，节省 Token，让任务处理更高效。</p>
</div>
<div className="webmcp-benefit">
<h3>
<i className="hgi-stroke hgi-shield-01" aria-hidden="true">
</i>执行更稳定</h3>
<p>按明确的操作信息执行，降低页面变化的影响。</p>
</div>
</div>
</div>
</div>
</section>
<section className="scenario-section" aria-labelledby="scenario-title">
<div className="section-shell">
<div className="section-head scenario-head">
<h2 className="section-title" id="scenario-title">让不同工作更顺手</h2>
</div>
<div className="scenario-tabs" role="tablist" aria-label="选择工作领域">
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-management" aria-controls="scenario-panel-management" aria-selected="true">团队管理</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-admin" aria-controls="scenario-panel-admin" aria-selected="false" tabIndex={-1}>行政办公</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-product" aria-controls="scenario-panel-product" aria-selected="false" tabIndex={-1}>产品运营</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-market" aria-controls="scenario-panel-market" aria-selected="false" tabIndex={-1}>市场营销</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-education" aria-controls="scenario-panel-education" aria-selected="false" tabIndex={-1}>教育科研</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-legal" aria-controls="scenario-panel-legal" aria-selected="false" tabIndex={-1}>法律实务</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-development" aria-controls="scenario-panel-development" aria-selected="false" tabIndex={-1}>技术开发</button>
</div>
<div className="scenario-panel" id="scenario-panel-management" role="tabpanel" aria-labelledby="scenario-tab-management">
<div className="scenario-items">
<div className="scenario-item">
<i className="hgi-stroke hgi-chart-increase" aria-hidden="true">
</i>
<div>
<h3>进度汇总并更新</h3>
<p>结合任务网页与关联周报汇总进展，标出变化并更新项目状态。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-task-01" aria-hidden="true">
</i>
<div>
<h3>纪要变待办</h3>
<p>从会议纪要提取负责人和截止时间，再到项目网站创建任务。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-folder-management" aria-hidden="true">
</i>
<div>
<h3>项目文件归档</h3>
<p>按项目整理周报、会议纪要和交付文件，保持资料清楚好找。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-mail-01" aria-hidden="true">
</i>
<div>
<h3>进度邮件填写</h3>
<p>依据最新任务进展整理邮件内容，并填入当前网页的编辑框。</p>
</div>
</div>
</div>
</div>
<div className="scenario-panel" id="scenario-panel-admin" role="tabpanel" aria-labelledby="scenario-tab-admin" hidden>
<div className="scenario-items">
<div className="scenario-item">
<i className="hgi-stroke hgi-folder-management" aria-hidden="true">
</i>
<div>
<h3>批量整理文件</h3>
<p>按命名和分类规则批量重命名文件，并归档到对应文件夹。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-task-01" aria-hidden="true">
</i>
<div>
<h3>网页表单填写</h3>
<p>从关联文件提取表单所需信息，核对后填写，减少来回复制。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>资料汇总落盘</h3>
<p>从多份关联文件提取关键信息，整理成清单并保存到指定位置。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-mail-01" aria-hidden="true">
</i>
<div>
<h3>通知邮件填写</h3>
<p>结合文件内容和网页上下文起草通知，再填入邮件编辑框待确认。</p>
</div>
</div>
</div>
</div>
<div className="scenario-panel" id="scenario-panel-product" role="tabpanel" aria-labelledby="scenario-tab-product" hidden>
<div className="scenario-items">
<div className="scenario-item">
<i className="hgi-stroke hgi-search-01" aria-hidden="true">
</i>
<div>
<h3>反馈归纳</h3>
<p>结合网页反馈和本地截图归纳高频问题，区分现象与实际需求。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-task-01" aria-hidden="true">
</i>
<div>
<h3>反馈变待办</h3>
<p>把确认后的问题补充背景和优先级，再到任务网站创建待办。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-chart-increase" aria-hidden="true">
</i>
<div>
<h3>产品数据跟进</h3>
<p>对照网页展示和本地数据文件，找出变化并补充跟进记录。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>处理流程复用</h3>
<p>保存反馈收集、分类和记录步骤，下次遇到同类工作继续复用。</p>
</div>
</div>
</div>
</div>
<div className="scenario-panel" id="scenario-panel-market" role="tabpanel" aria-labelledby="scenario-tab-market" hidden>
<div className="scenario-items">
<div className="scenario-item">
<i className="hgi-stroke hgi-search-01" aria-hidden="true">
</i>
<div>
<h3>竞品信息汇总</h3>
<p>结合网页信息与关联资料整理竞品差异，标注来源并保存结论。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>活动素材成稿</h3>
<p>读取产品资料和已有文稿，按活动渠道生成便于修改的推广内容。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-mail-01" aria-hidden="true">
</i>
<div>
<h3>推广邮件填写</h3>
<p>根据产品卖点和目标对象起草邮件，并填入当前网站编辑框。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-chart-increase" aria-hidden="true">
</i>
<div>
<h3>活动结果复盘</h3>
<p>读取活动页面和数据文件，对比关键指标并整理成复盘文稿。</p>
</div>
</div>
</div>
</div>
<div className="scenario-panel" id="scenario-panel-education" role="tabpanel" aria-labelledby="scenario-tab-education" hidden>
<div className="scenario-items">
<div className="scenario-item">
<i className="hgi-stroke hgi-search-01" aria-hidden="true">
</i>
<div>
<h3>文献资料归集</h3>
<p>结合网页检索结果和本地文献，按研究主题归类并整理出处。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>阅读笔记保存</h3>
<p>从多份材料提取核心观点，整理成笔记并保存到关联文件夹。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-folder-management" aria-hidden="true">
</i>
<div>
<h3>课程文件整理</h3>
<p>按课程和日期分类讲义、作业及课堂记录，让资料更容易查找。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-task-01" aria-hidden="true">
</i>
<div>
<h3>课前流程复用</h3>
<p>保存资料整理和提纲准备步骤，下一次备课时按流程快速执行。</p>
</div>
</div>
</div>
</div>
<div className="scenario-panel" id="scenario-panel-legal" role="tabpanel" aria-labelledby="scenario-tab-legal" hidden>
<div className="scenario-items">
<div className="scenario-item">
<i className="hgi-stroke hgi-folder-management" aria-hidden="true">
</i>
<div>
<h3>案件材料归档</h3>
<p>按案件和材料类型分类、重命名关联文件，并保留清晰的归档结构。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-chart-increase" aria-hidden="true">
</i>
<div>
<h3>事实时间线</h3>
<p>从多份材料提取关键日期和事件，按时间排序生成待核对的线索。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>文书草稿落盘</h3>
<p>依据指定资料整理文书初稿并保存，方便专业人员逐项审核修改。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-search-01" aria-hidden="true">
</i>
<div>
<h3>网页材料摘录</h3>
<p>查找网页信息并与本地材料交叉核对，同时保存出处和相关摘录。</p>
</div>
</div>
</div>
</div>
<div className="scenario-panel" id="scenario-panel-development" role="tabpanel" aria-labelledby="scenario-tab-development" hidden>
<div className="scenario-items">
<div className="scenario-item">
<i className="hgi-stroke hgi-code" aria-hidden="true">
</i>
<div>
<h3>报错到修改</h3>
<p>读取项目代码和报错信息，定位问题、修改相关文件并运行检查。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-search-01" aria-hidden="true">
</i>
<div>
<h3>页面问题定位</h3>
<p>对照浏览器中的异常表现与关联代码，缩小排查范围并定位问题。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>项目文档更新</h3>
<p>根据代码改动补充功能说明、配置变化或使用步骤，并写回文档。</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-task-01" aria-hidden="true">
</i>
<div>
<h3>检查流程复用</h3>
<p>保存常用检查步骤，代码更新后按同一流程验证，减少重复排查。</p>
</div>
</div>
</div>
</div>
</div>
</section>
<section className="closing-section" id="browser-extension" aria-labelledby="closing-title">
<div className="closing-panel">
<div className="closing-content">
<h2 id="closing-title">
<span data-extension-not-detected>把怡氧知知<br />添加到你的浏览器</span>
<span data-extension-connected hidden>开始使用怡氧知知</span>
</h2>
<p data-extension-not-detected>安装浏览器插件后，在支持的网站中随时唤起怡氧知知；也可以选择在线使用。</p>
<p data-extension-connected hidden>已检测到浏览器插件，可以直接使用怡氧知知。</p>
<div className="closing-actions">
<ExtensionMenu variant="hero" copy={chromeCopy.cn.header} />
<a className="button secondary" id="web-app" data-extension-not-detected href="https://weave.eo2suite.cn/projects" target="_blank" rel="noopener noreferrer">在线使用</a>
</div>
</div>
</div>
</section>
</main>
    </>
  )
}
