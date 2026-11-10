'use client'

import './site-footer.css'

export type FooterCopy = {
  brand: string
  copyright: string
  privacyHref: string
  privacy: string
  helpHref: string
  help: string
  filings?: {
    icpHref: string
    icp: string
    policeHref: string
    policeIcon: string
    police: string
  }
}

export function SiteFooter({ copy }: { copy: FooterCopy }) {
  return (
    <div className="site-footer">
      <footer>
        <div className="inner">
          <div className="top">
            <div className="brand">
              <img src="/marketing/logo.svg" alt="" />
              <span>{copy.brand}</span>
            </div>
          </div>
          <div className="links">
            <span className="copyright">{copy.copyright}</span>
            {copy.filings && (
              <span className="filings">
                <a href={copy.filings.icpHref} target="_blank" rel="noopener noreferrer">
                  {copy.filings.icp}
                </a>
                <a className="filing" href={copy.filings.policeHref} target="_blank" rel="noopener noreferrer">
                  <img src={copy.filings.policeIcon} alt="" />
                  <span>{copy.filings.police}</span>
                </a>
              </span>
            )}
            <a className="privacy" href={copy.privacyHref} target="_blank" rel="noopener noreferrer">
              {copy.privacy}
            </a>
            <a className="help" href={copy.helpHref} target="_blank" rel="noopener noreferrer">
              {copy.help}
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
