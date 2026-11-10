'use client'

import { useEffect, useRef } from 'react'
import { ExtensionMenu } from '../../chrome/ExtensionMenu'
import { useExtensionStatus } from '../../chrome/useExtensionStatus'
import { webMcpCopy } from './content'
import { chromeCopy } from '../../chrome/copy'
import './webmcp.css'

const oldIcons = [
  <svg viewBox="0 0 24 24" aria-hidden="true" key="a">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m6 16 4-4 3 3 3-5 2 3" />
  </svg>,
  <svg viewBox="0 0 24 24" aria-hidden="true" key="b">
    <path d="M5 3h14M5 21h14M7 3v4a5 5 0 0 0 2 4l3 1 3-1a5 5 0 0 0 2-4V3M7 21v-4a5 5 0 0 1 2-4l3-1 3 1a5 5 0 0 1 2 4v4" />
  </svg>,
  <svg viewBox="0 0 24 24" aria-hidden="true" key="c">
    <path d="M20 7v4h-4M4 17v-4h4M5.5 9A7 7 0 0 1 18 7l2 4M4 13l2 4a7 7 0 0 0 12.5-2" />
  </svg>,
  <svg viewBox="0 0 24 24" aria-hidden="true" key="d">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6m0 4h.01" />
  </svg>,
]

export function WebMcpPage({ region }: { region: 'cn' | 'global' }) {
  const copy = webMcpCopy[region]
  const extensionStatus = useExtensionStatus()
  const whatCardRef = useRef<HTMLDivElement>(null)

  // The static page revealed #what on scroll (IntersectionObserver +
  // .will-reveal); the CSS hooks survived the port, the observer did not, so
  // the card is permanently stuck in its initial state.
  useEffect(() => {
    const card = whatCardRef.current
    if (!card || typeof IntersectionObserver === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    card.classList.add('will-reveal')
    const observer = new IntersectionObserver(
      ([entry], self) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-visible')
        self.unobserve(entry.target)
      },
      { threshold: 0.18 }
    )
    observer.observe(card)
    return () => observer.disconnect()
  }, [])
  const chrome = chromeCopy[region]

  return (
    <>
      <div className="intro-region">
        <section className="hero">
          <div className="hero-content">
            <h1>
              {copy.heroTitleBefore}
              <span className="hl">{copy.heroTitleHighlight}</span>
            </h1>
            <p className="hero-desc">{copy.heroDesc}</p>
            <div className="hero-actions">
              <ExtensionMenu variant="hero" copy={chrome.header} />
              {/* The static page marked this entry data-extension-not-detected:
                  once the extension is installed the CTA above already leads to
                  /projects, so a second entry would be a duplicate. */}
              {extensionStatus !== 'connected' && (
                <a className="btn btn-outline" href="/projects" target="_blank" rel="noopener noreferrer">
                  {copy.online}
                </a>
              )}
            </div>
            {extensionStatus !== 'connected' && (
              <p className="extension-entry-note">{copy.extensionNote}</p>
            )}
          </div>
        </section>

        <section className="section" id="what">
          <div className="what-card" ref={whatCardRef}>
            <h2 className="section-title">{copy.whatTitle}</h2>
            <div className="webmcp-explainer">
              <p>{copy.whatParagraphs[0]}</p>
              <p className="webmcp-summary">{copy.whatParagraphs[1]}</p>
            </div>
          </div>
        </section>
      </div>

      <section className="section" id="compare">
        <h2 className="section-title">{copy.compareTitle}</h2>
        <div className="compare-grid">
          <div className="compare-col">
            <h3>{copy.compareOldTitle}</h3>
            <p>{copy.compareOldDesc}</p>
            <ul className="compare-benefits">
              {copy.compareOld.map((item, index) => (
                <li className="compare-benefit" key={item.title}>
                  <span className="compare-benefit-icon">{oldIcons[index]}</span>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="compare-col good">
            <h3>{copy.compareNewTitle}</h3>
            <p>{copy.compareNewDesc}</p>
            <ul className="compare-benefits">
              {copy.compareNew.map((item) => (
                <li className="compare-benefit" key={item.title}>
                  <span className="compare-benefit-icon">
                    <i className={`hgi-stroke ${item.icon}`} aria-hidden="true" />
                  </span>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <h2 className="section-title">{copy.howTitle}</h2>
        <p className="section-sub">{copy.howSub}</p>
        <div className="steps">
          {copy.steps.map((step, index) => (
            <div className="step" key={step.title}>
              <div className="step-num">{String(index + 1).padStart(2, '0')}</div>
              <h4>{step.title}</h4>
              <p>{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="download">
        <div className="download-card">
          <h2 className="section-title">{copy.ctaTitle}</h2>
          <p className="section-sub">{copy.ctaSub}</p>
          <p className="marketing-mobile-note">
            {copy.mobileNote} <a href="/projects">{copy.mobileNoteLink}</a>
          </p>
          <div className="cta-actions">
            <ExtensionMenu variant="hero" copy={chrome.header} />
            <a href="/experience" className="btn btn-outline">
              {copy.demoLink} <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </section>
    </>
  )
}
