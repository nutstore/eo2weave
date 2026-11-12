import { ExtensionMenu } from '../../chrome/ExtensionMenu'
import { chromeCopy } from '../../chrome/copy'
import type { CSSProperties } from 'react'

export function HomeGlobalMarkup() {
  return (
    <>


<main className="page">
<section className="hero hero--global shell" id="top" aria-labelledby="hero-title">
<div className="hero-copy">
<h1 id="hero-title"><span>Understand your goals</span><em>Get things done</em>
</h1>
<p className="description">EO2Weave is an AI workspace in your browser, with no desktop app required. Choose an AI model in the sidebar and let EO2Weave work with websites and local files, within the permissions you grant, to help complete complex tasks.</p>
<div className="actions">
<ExtensionMenu variant="hero" copy={chromeCopy.global.header} />
<a className="button primary" href="/projects" data-extension-not-detected target="_blank" rel="noopener noreferrer">Use online</a>
</div>
<p className="extension-entry-note" data-extension-not-detected>The extension adds a browser sidebar, WebMCP, and web search.</p>
</div>
</section>
<section className="primary-work-section" aria-labelledby="primary-work-title">
<div className="section-shell">
<h2 className="section-title primary-work-title" id="primary-work-title">More than answers. Action.</h2>
<div className="primary-work-grid">
<article className="primary-work-card primary-work-card--web">
<h3>Let AI work for you<span className="primary-work-accent">Work with websites</span>
</h3>
<p>Find information, fill in forms, and take action on websites to get real results.</p>
<div className="primary-work-visual work-preview" role="img" aria-label="Email workflow: check project progress, draft an update, and send it after review">
<div className="work-preview-web-body">
<div className="work-preview-page">
<div className="work-preview-email-list">
<div className="work-preview-email-row is-unread">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">This week's project status</span>
<span className="work-preview-email-snippet">— Could you share the current status and open issues?</span>
</div>
<span className="work-preview-email-time">10:42</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">This week's task updates</span>
<span className="work-preview-email-snippet">— Requirements review is complete; see the attachment.</span>
</div>
<span className="work-preview-email-time">09:18</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">Integration testing update</span>
<span className="work-preview-email-snippet">— Main interfaces tested; two items remain open.</span>
</div>
<span className="work-preview-email-time">Yesterday</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">Confirm this week's release schedule</span>
<span className="work-preview-email-snippet">— Please confirm the release time and remaining tasks.</span>
</div>
<span className="work-preview-email-time">10/19</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">Requirements review conclusions</span>
<span className="work-preview-email-snippet">— Review items and owners have been updated.</span>
</div>
<span className="work-preview-email-time">10/18</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">Task assignment changes</span>
<span className="work-preview-email-snippet">— New owners and deadlines have been shared.</span>
</div>
<span className="work-preview-email-time">10/17</span>
</div>
<div className="work-preview-email-row is-read">
<span className="work-preview-email-check">
</span>
<div className="work-preview-email-content">
<span className="work-preview-email-subject">Project meeting schedule</span>
<span className="work-preview-email-snippet">— Friday at 2:00 PM, online.</span>
</div>
<span className="work-preview-email-time">10/16</span>
</div>
</div>
</div>
<div className="work-preview-assistant">
<div className="work-preview-assistant-name">EO2Weave</div>
<div className="local-files-query work-preview-question work-preview-question--one">
<span className="local-files-query-label" aria-hidden="true">
</span>
<span className="work-preview-question-text">Search earlier project emails,<br />summarize progress, and draft a reply</span>
</div>
<div className="local-files-query work-preview-question work-preview-question--three">
<span className="local-files-query-label" aria-hidden="true">
</span>Looks good. Send it.</div>
</div>
</div>
</div>
</article>
<article className="primary-work-card primary-work-card--files">
<h3>Let AI work for you<span className="primary-work-accent">Work with local files</span>
</h3>
<p>Find files, organize materials, and edit content in connected folders without opening each file manually.</p>
<div className="primary-work-visual local-files-scene" role="img" aria-label="A connected meeting folder with presentations, a task tracker, meeting notes, and example questions for AI">
<div className="local-files-art">
<svg className="local-files-defs" aria-hidden="true" width="0" height="0">
<symbol id="local-folder-shape" viewBox="0 0 24 24">
<path d="M3.5 7.5V6a2 2 0 0 1 2-2h4.1l2 2.3h6.9a2 2 0 0 1 2 2v9.2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
</symbol>
</svg>
<div className="local-files-query local-files-query--ppt">
<span className="local-files-query-label" aria-hidden="true">
</span>Create a presentation from the latest updates</div>
<div className="local-files-query local-files-query--one">
<span className="local-files-query-label" aria-hidden="true">
</span>What follow-ups remain from these meetings?</div>
<div className="local-files-query local-files-query--two">
<span className="local-files-query-label" aria-hidden="true">
</span>Update the task tracker with the latest assignments</div>
<div className="local-files-panel">
<div className="local-files-tabs">
<span className="local-files-tab is-active">
<svg className="local-files-icon" aria-hidden="true">
<use href="#local-folder-shape" />
</svg>Files</span>
<span className="local-files-tab">
<svg className="local-files-icon" viewBox="0 0 24 24" aria-hidden="true">
<circle cx="12" cy="12" r="9" />
<path d="m8 12 2.5 2.5L16 9" />
</svg>Pending review</span>
<span className="local-files-tab">
<svg className="local-files-icon" viewBox="0 0 24 24" aria-hidden="true">
<circle cx="12" cy="12" r="9" />
<path d="M12 7v5l3 2" />
</svg>Saved activity</span>
</div>
<div className="local-files-tree">
<div className="local-files-caption">Connect a local folder</div>
<div className="local-files-root">
<svg className="local-files-icon" aria-hidden="true">
<use href="#local-folder-shape" />
</svg>Meeting materials</div>
<div className="local-files-folder">
<svg className="local-files-chevron" viewBox="0 0 14 14" aria-hidden="true">
<path d="m3.5 5.5 3.5 3.5 3.5-3.5" />
</svg>
<svg className="local-files-icon" aria-hidden="true">
<use href="#local-folder-shape" />
</svg>Presentations</div>
<div className="local-files-document">2026-10-13_team-update.pptx</div>
<div className="local-files-document">2026-10-20_team-update.pptx</div>
<div className="local-files-folder">
<svg className="local-files-chevron" viewBox="0 0 14 14" aria-hidden="true">
<path d="m3.5 5.5 3.5 3.5 3.5-3.5" />
</svg>
<svg className="local-files-icon" aria-hidden="true">
<use href="#local-folder-shape" />
</svg>Task tracking</div>
<div className="local-files-document">task-tracker.xlsx</div>
<div className="local-files-folder">
<svg className="local-files-chevron" viewBox="0 0 14 14" aria-hidden="true">
<path d="m3.5 5.5 3.5 3.5 3.5-3.5" />
</svg>
<svg className="local-files-icon" aria-hidden="true">
<use href="#local-folder-shape" />
</svg>Meeting notes</div>
<div className="local-files-document">2026-10-13_team-meeting.docx</div>
<div className="local-files-document">2026-10-15_project-review.docx</div>
<div className="local-files-document">2026-10-19_retrospective.docx</div>
<div className="local-files-document">2026-10-20_team-meeting.docx</div>
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
<h3>Keep work moving in the sidebar</h3>
<ul className="capability-points">
<li className="capability-point">
<h4>Always at hand</h4>
<p>Use AI on the current page without switching away.</p>
</li>
<li className="capability-point">
<h4>Continue across tabs</h4>
<p>Keep your conversation and tasks when opening a new tab.</p>
</li>
<li className="capability-point">
<h4>Choose your model</h4>
<p>Switch AI models in the sidebar to suit the task.</p>
</li>
</ul>
</div>
<div className="sidebar-demo" role="img" aria-label="Demo: ask the sidebar to summarize a site and find similar products, then continue the conversation in another tab" data-step="idle">
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
<span className="sidebar-browser-tab sidebar-browser-tab--current">Current site</span>
<span className="sidebar-browser-tab sidebar-browser-tab--one">Similar product A<svg className="sidebar-tab-cursor" viewBox="0 0 18 20" aria-hidden="true">
<path d="M2 1v15l4-3 2.7 5 2.8-1.4-2.6-5.1 5.2-.1z" />
</svg>
</span>
<span className="sidebar-browser-tab sidebar-browser-tab--two">Similar product B<svg className="sidebar-tab-cursor" viewBox="0 0 18 20" aria-hidden="true">
<path d="M2 1v15l4-3 2.7 5 2.8-1.4-2.6-5.1 5.2-.1z" />
</svg>
</span>
</div>
<div className="sidebar-browser-address">
<span className="sidebar-address-pill">
<span>Current page</span>
<span>Similar product A</span>
<span>Similar product B</span>
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
<img src="/marketing/logo.svg" alt="" />EO2Weave</div>
<div className="sidebar-pane-chat">
<div className="sidebar-user-message">Summarize this site, find similar products, and open their websites.</div>
<div className="sidebar-ai-message">
<span className="sidebar-ai-icon">
</span>
<div className="sidebar-ai-text">
<strong>Summarized the current site.</strong>Found two related products and opened them in new tabs.<span className="sidebar-ai-link">Similar product A</span>
<span className="sidebar-ai-link">Similar product B</span>
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
<h3>Don't start repetitive work from scratch</h3>
<ul className="capability-points">
<li className="capability-point">
<h4>Save repeatable steps</h4>
<p>Turn repeatable actions into a workflow you can reuse.</p>
</li>
<li className="capability-point">
<h4>Reuse what works</h4>
<p>Save effective methods as skills for similar tasks.</p>
</li>
<li className="capability-point">
<h4>Handle complex goals</h4>
<p>Let an agent work through tasks that require judgment step by step.</p>
</li>
</ul>
</div>
<div className="workflow-demo" aria-label="Demo: prepare and send a weekly report with a workflow" data-progress="0">
<div className="workflow-art" aria-hidden="true">
<div className="workflow-board">
<div className="workflow-board-head">
<div className="workflow-board-title">
<span className="workflow-title-icon-box">
<img className="workflow-title-icon" src="/marketing/sparkle.svg" alt="" />
</span>Prepare and send a weekly report</div>
</div>
<div className="workflow-content">
<div className="workflow-steps">
<div className="workflow-step">
<span className="workflow-step-name">01 Enter keywords</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">02 Search emails</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">03 Find local files</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">04 Create report</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">05 Draft email</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">06 Review</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
<div className="workflow-step">
<span className="workflow-step-name">07 Save and send</span>
<span className="workflow-step-check">
<img src="/marketing/check.svg" alt="" />
</span>
</div>
</div>
<div className="workflow-assistant">
<div className="workflow-assistant-head">
<img src="/marketing/logo.svg" alt="" />EO2Weave</div>
<div className="workflow-chat">
<div className="workflow-thread">
<div className="workflow-user-message">
<span className="workflow-prompt-text">
</span>
<span className="workflow-prompt-caret">
</span>
</div>
<div className="workflow-chat-reply workflow-reply-mail">Searching last week's emails…</div>
<div className="workflow-chat-reply workflow-reply-local">Organizing local updates…</div>
<div className="workflow-chat-reply workflow-reply-reporting">Preparing the report and identifying progress and follow-ups…</div>
<div className="workflow-chat-reply workflow-reply-report-ready">The report draft is ready:</div>
<div className="workflow-report-card">
<div className="workflow-report-title">
<span>Last week's report</span>
<span>10.12 – 10.16</span>
</div>
<p className="workflow-report-summary">Product data was checked and listings published. Inventory discrepancies were sent for review, and campaign assets are awaiting approval.</p>
<div className="workflow-report-line">
<strong>Product launches</strong>
<span>18 products checked; 12 published</span>
</div>
<div className="workflow-report-line">
<strong>Inventory review</strong>
<span>SKU-1042 inventory discrepancy submitted for review</span>
</div>
<div className="workflow-report-line">
<strong>Campaign preparation</strong>
<span>Campaign assets awaiting approval</span>
</div>
<div className="workflow-report-chart">
<div className="workflow-report-chart-title">Daily completed tasks · illustration</div>
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
<span>Mon</span>
<span>Tue</span>
<span>Wed</span>
<span>Thu</span>
<span>Fri</span>
</div>
</div>
</div>
<div className="workflow-chat-reply workflow-reply-email">Email draft:</div>
<div className="workflow-email-card">
<div className="workflow-email-heading">Email draft</div>
<div className="workflow-email-meta">To: Team lead</div>
<div className="workflow-email-meta">Subject: Weekly report (Oct 12–16)</div>
<div className="workflow-email-body">Hello, the weekly report is attached. Highlights include 12 product launches, an inventory review for SKU-1042, and progress on campaign assets.</div>
<div className="workflow-email-attachment">
<span className="workflow-email-attachment-type">PDF</span>
<span className="workflow-email-attachment-name">weekly-report_10.12-10.16.pdf</span>
</div>
</div>
<div className="workflow-review-divider">
</div>
<div className="workflow-review-note">The report and email are ready for review. Once approved, the report will be saved locally and the email sent to your team lead.</div>
<div className="workflow-user-message workflow-user-confirmation">
<span className="workflow-confirmation-text">
</span>
</div>
<div className="workflow-chat-reply workflow-reply-done">Email sent and report saved locally.</div>
</div>
</div>
<div className="workflow-composer">
<input className="workflow-input" type="text" value="" readOnly aria-label="Enter keywords" />
<button className="workflow-send" type="button" aria-label="Send message" title="Send message">{/* Hugeicons Arrow Up 01, Stroke Rounded: https://hugeicons.com/icon/arrow-up-01 */}<svg viewBox="0 0 24 24" aria-hidden="true">
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
<h3 id="results-title">Complete tasks and deliver results</h3>
<ul className="capability-points">
<li className="capability-point">
<h4>Content creation</h4>
<p>Draft emails, copy, and reports; create presentations.</p>
</li>
<li className="capability-point">
<h4>Data analysis</h4>
<p>Organize spreadsheets, analyze data, and create charts and insights.</p>
</li>
<li className="capability-point">
<h4>File management</h4>
<p>Rename and classify files in batches and organize folders.</p>
</li>
<li className="capability-point">
<h4>Web pages and tools</h4>
<p>Create HTML pages and useful tools you can preview.</p>
</li>
<li className="capability-point capability-more">Discover more possibilities...</li>
</ul>
</div>
<div className="result-panel" role="img" aria-label="Examples: document creation, project folder organization, and an inventory spreadsheet with a trend chart">
<div className="result-art" aria-hidden="true">
<div className="result-output result-report">
<div className="result-document">
<div className="result-document-meta">
<span>2026.10</span>
</div>
<strong className="result-document-title">Project progress brief</strong>
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
<span className="result-folder-heading-text">Organize folders automatically</span>
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
</i>Planning</div>
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
</i>Launch</div>
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
</i>Review and delivery</div>
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
<td>Received</td>
<td>Shipped</td>
<td>On hand</td>
<td>Turnover</td>
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
<div className="result-chart-caption">Generate reports and charts from spreadsheets</div>
<div className="result-chart-insight">Net received <strong data-result-net>
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
<h2 id="webmcp-title">Work with websites faster and more reliably</h2>
<p className="webmcp-lead">With WebMCP, EO2Weave can use actions exposed by websites directly. Websites tell AI what they can do and what information each action needs, reducing repeated searching and trial and error. For sites without WebMCP, EO2Weave can still work through page understanding and standard interactions.<a className="webmcp-more" href="#webmcp" aria-label="Explore WebMCP">Explore WebMCP <span aria-hidden="true">→</span>
</a>
</p>
</div>
<div className="webmcp-benefits">
<div className="webmcp-benefit">
<h3>
<i className="hgi-stroke hgi-plug" aria-hidden="true">
</i>No extra setup</h3>
<p>Open a supported site to discover its available tools.</p>
</div>
<div className="webmcp-benefit">
<h3>
<i className="hgi-stroke hgi-flash" aria-hidden="true">
</i>Finish faster</h3>
<p>Use available actions directly with fewer searches and clicks.</p>
</div>
<div className="webmcp-benefit">
<h3>
<i className="hgi-stroke hgi-cpu" aria-hidden="true">
</i>Use fewer tokens</h3>
<p>Reduce repeated page analysis and save tokens.</p>
</div>
<div className="webmcp-benefit">
<h3>
<i className="hgi-stroke hgi-shield-01" aria-hidden="true">
</i>More reliable execution</h3>
<p>Use clearly defined actions that are less affected by page changes.</p>
</div>
</div>
</div>
</div>
</section>
<section className="scenario-section" aria-labelledby="scenario-title">
<div className="section-shell">
<div className="section-head scenario-head">
<h2 className="section-title" id="scenario-title">Make everyday work easier</h2>
</div>
<div className="scenario-tabs" role="tablist" aria-label="Choose a field">
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-management" aria-controls="scenario-panel-management" aria-selected="true">Team management</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-admin" aria-controls="scenario-panel-admin" aria-selected="false" tabIndex={-1}>Administration</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-product" aria-controls="scenario-panel-product" aria-selected="false" tabIndex={-1}>Product operations</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-market" aria-controls="scenario-panel-market" aria-selected="false" tabIndex={-1}>Marketing</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-education" aria-controls="scenario-panel-education" aria-selected="false" tabIndex={-1}>Education and research</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-legal" aria-controls="scenario-panel-legal" aria-selected="false" tabIndex={-1}>Legal practice</button>
<button className="scenario-tab" type="button" role="tab" id="scenario-tab-development" aria-controls="scenario-panel-development" aria-selected="false" tabIndex={-1}>Software development</button>
</div>
<div className="scenario-panel" id="scenario-panel-management" role="tabpanel" aria-labelledby="scenario-tab-management">
<div className="scenario-items">
<div className="scenario-item">
<i className="hgi-stroke hgi-chart-increase" aria-hidden="true">
</i>
<div>
<h3>Summarize and update progress</h3>
<p>Combine task pages and weekly reports to highlight changes and update project status.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-task-01" aria-hidden="true">
</i>
<div>
<h3>Turn notes into tasks</h3>
<p>Extract owners and deadlines from meeting notes and create tasks on your project site.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-folder-management" aria-hidden="true">
</i>
<div>
<h3>Archive project files</h3>
<p>Organize reports, meeting notes, and deliverables by project.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-mail-01" aria-hidden="true">
</i>
<div>
<h3>Draft progress emails</h3>
<p>Draft an update from the latest task progress and fill it into the current page.</p>
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
<h3>Organize files in batches</h3>
<p>Rename and sort files into folders according to your rules.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-task-01" aria-hidden="true">
</i>
<div>
<h3>Fill in web forms</h3>
<p>Extract information from connected files and fill in forms after review.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>Save summaries</h3>
<p>Extract key information from files, make a list, and save it where you choose.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-mail-01" aria-hidden="true">
</i>
<div>
<h3>Draft notification emails</h3>
<p>Use files and page context to draft a notification for review.</p>
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
<h3>Summarize feedback</h3>
<p>Combine web feedback and screenshots to identify common issues and underlying needs.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-task-01" aria-hidden="true">
</i>
<div>
<h3>Turn feedback into tasks</h3>
<p>Add context and priority to confirmed issues and create tasks.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-chart-increase" aria-hidden="true">
</i>
<div>
<h3>Follow up on product data</h3>
<p>Compare website information with local data and record changes.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>Reuse a process</h3>
<p>Save feedback collection and classification steps for next time.</p>
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
<h3>Research competitors</h3>
<p>Compare competitors using web pages and connected files, with sources included.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>Draft campaign content</h3>
<p>Create editable campaign copy from product information and existing documents.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-mail-01" aria-hidden="true">
</i>
<div>
<h3>Draft outreach emails</h3>
<p>Draft an email for your audience and fill it into the current page.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-chart-increase" aria-hidden="true">
</i>
<div>
<h3>Review campaign results</h3>
<p>Compare key metrics from campaign pages and data files in a review.</p>
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
<h3>Collect research materials</h3>
<p>Organize web results and local literature by topic with source references.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>Save reading notes</h3>
<p>Extract key ideas from materials and save notes to a connected folder.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-folder-management" aria-hidden="true">
</i>
<div>
<h3>Organize course files</h3>
<p>Sort handouts, assignments, and class notes by course and date.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-task-01" aria-hidden="true">
</i>
<div>
<h3>Reuse lesson preparation</h3>
<p>Save material and outline preparation steps for your next lesson.</p>
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
<h3>Organize case files</h3>
<p>Sort and rename files by case and document type in a clear folder structure.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-chart-increase" aria-hidden="true">
</i>
<div>
<h3>Build a timeline</h3>
<p>Extract dates and events from documents and arrange them for review.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>Save document drafts</h3>
<p>Draft and save documents from selected materials for professional review.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-search-01" aria-hidden="true">
</i>
<div>
<h3>Collect web excerpts</h3>
<p>Find web information, compare it with local files, and save sources and excerpts.</p>
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
<h3>Fix errors</h3>
<p>Read code and error messages, find the issue, edit files, and run checks.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-search-01" aria-hidden="true">
</i>
<div>
<h3>Investigate page issues</h3>
<p>Compare browser behavior with the relevant code to find the issue.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-book-open-01" aria-hidden="true">
</i>
<div>
<h3>Update project documentation</h3>
<p>Update documentation with feature, configuration, or usage changes.</p>
</div>
</div>
<div className="scenario-item">
<i className="hgi-stroke hgi-task-01" aria-hidden="true">
</i>
<div>
<h3>Reuse verification steps</h3>
<p>Save common checks and run the same process after code changes.</p>
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
<span data-extension-not-detected>Add EO2Weave<br />to your browser</span>
<span data-extension-connected hidden>Start using EO2Weave</span>
</h2>
<p data-extension-not-detected>Install the browser extension to use EO2Weave on supported sites, or use it online.</p>
<p data-extension-connected hidden>Your browser extension is ready. Open EO2Weave to get started.</p>
<div className="closing-actions">
<ExtensionMenu variant="hero" copy={chromeCopy.global.header} />
<a className="button secondary" id="web-app" data-extension-not-detected href="https://weave.eo2suite.com/projects" target="_blank" rel="noopener noreferrer">Use online</a>
</div>
</div>
</div>
</section>
</main>
    </>
  )
}
