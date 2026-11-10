'use client'

import { useEffect, useRef } from 'react'
import { ExtensionMenu } from '../../chrome/ExtensionMenu'
import { chromeCopy } from '../../chrome/copy'
import { useExtensionMarkers } from '../../chrome/useExtensionMarkers'
import { useStoreInstall } from '../../chrome/useStoreInstall'
import './download.css'

/** Download page (global). Markup is ported from the design export; the
 *  install CTA and the copy-address helper are React. */
export function DownloadGlobal() {
  const root = useRef<HTMLDivElement>(null)
  const chrome = chromeCopy.global
  const onStoreInstall = useStoreInstall()
  useExtensionMarkers(root)


  useEffect(() => {
    const ua = navigator.userAgent
    const browser = /EdgA?\//.test(ua) || /EdgiOS\//.test(ua) ? 'edge'
      : /CriOS\//.test(ua) || (/Chrome\//.test(ua) && !/(OPR|Brave|Vivaldi|YaBrowser|SamsungBrowser)\//.test(ua)) ? 'chrome'
      : 'other'
    document.documentElement.dataset.browser = browser
    return () => { delete document.documentElement.dataset.browser }
  }, [])

  useEffect(() => {
    const el = root.current
    if (!el) return
    const button = el.querySelector<HTMLButtonElement>('[data-copy-extensions-url]')
    const status = el.querySelector<HTMLElement>('[data-copy-status]')
    if (!button || !status) return
    const onCopy = async () => {
      const address = 'chrome://extensions/'
      try {
        await navigator.clipboard.writeText(address)
      } catch {
        const input = document.createElement('textarea')
        input.value = address
        input.setAttribute('readonly', '')
        input.style.position = 'fixed'
        input.style.opacity = '0'
        document.body.append(input)
        input.select()
        const ok = document.execCommand('copy')
        input.remove()
        if (!ok) { status.textContent = `Enter ${address} in Chrome's address bar and press Enter.`; return }
      }
      status.textContent = 'Copied. Paste it into the address bar and press Enter.'
    }
    button.addEventListener('click', onCopy)
    return () => button.removeEventListener('click', onCopy)
  }, [])

  return (
    <div ref={root}>

<main>
<div className="intro-region">
<section className="hero">
<div className="shell">
<h1>Bring EO2Weave to your browser</h1>
<p className="hero-copy">Once installed, open EO2Weave whenever you need it on the web.</p>
</div>
</section>
<section className="download-section shell" id="download-options" aria-label="Browser extension installation options">
<p className="marketing-mobile-note">Install and try the extension in a desktop browser. <a href="/projects">Use online →</a>
</p>
<div className="download-actions">
<ExtensionMenu variant="install" copy={chrome.header} />
<a className="install-button" data-browser="edge" data-store-install href="https://microsoftedge.microsoft.com/addons/detail/eo2weave/hnndljbngdmcldojkaedhpehlghkljdm" target="_blank" rel="noreferrer" onClick={onStoreInstall}>
<img src="/marketing/assets/microsoft-edge.svg" alt="" />Install Edge extension</a>
</div>
<div className="extension-connected" data-extension-connected hidden>Extension detected. <a href="/projects">Open EO2Weave</a>.</div>
<p className="extension-refresh" data-extension-not-detected>If this page does not update after installation, refresh it.</p>
</section>
</div>
<section className="manual-section manual-guide" id="manual-install" aria-labelledby="manual-title">
<div className="shell">
<div className="section-head">
<h2 id="manual-title">How do I install the Chrome extension manually?</h2>
<p className="section-copy">If you cannot access the Chrome Web Store, download the package and follow these steps.</p>
</div>
<div className="steps">
<article className="step">
<div className="step-copy">
<h3>1. Download and unzip the package</h3>
<p>Click <a className="text-link" href="/chrome-extension.zip" target="_blank" rel="noopener noreferrer" data-offline-download aria-label="Download the Chrome extension package">the link</a> to download the ZIP file, then extract it to find the extension folder.</p>
</div>
<div className="step-visual" aria-hidden="true">
<svg viewBox="0 40 520 220" fill="none" xmlns="http://www.w3.org/2000/svg">
<g transform="translate(0 11)">
<rect className="file-manager-window" x="54" y="29" width="412" height="220" rx="11" fill="#FFFFFF" stroke="#DCE5E1" />
<path d="M54 82h412" stroke="#E7EFEB" />
<circle cx="78" cy="56" r="4" fill="#E99691" />
<circle cx="93" cy="56" r="4" fill="#EFC779" />
<circle cx="108" cy="56" r="4" fill="#8AC9AA" />
<rect x="128" y="40" width="264" height="34" rx="17" fill="#F2F6F4" />
<text x="260" y="62" textAnchor="middle" fill="#71847B" fontFamily="Arial,sans-serif" fontSize="12">Download</text>
<g transform="translate(0 14)">
<g className="zip-manager-item">
<rect className="zip-manager-hover" x="117" y="81" width="126" height="132" rx="14" fill="#E7F2EC" />
<image className="zip-manager-icon" href="/marketing/assets/manual-zip.svg" x="144" y="87" width="68" height="68" />
<text x="180" y="184" textAnchor="middle" fill="#395B4E" fontFamily="Arial,sans-serif" fontSize="12" fontWeight="600">
<tspan x="180">chrome-</tspan>
<tspan x="180" dy="18">extension.zip</tspan>
</text>
</g>
<g className="zip-flow-arrow" stroke="#A9BEB7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity=".8">
<path d="M246 128h31" strokeDasharray="3 4" />
<path d="m270 120 8 8-8 8" />
</g>
<g className="extension-folder">
<image href="/marketing/assets/manual-folder.svg" x="298" y="95" width="84" height="65" />
<text x="340" y="192" textAnchor="middle" fill="#395B4E" fontFamily="Arial,sans-serif" fontSize="12" fontWeight="600">extension</text>
</g>
<g className="zip-manager-click-one">
<circle cx="260" cy="120" r="11" stroke="#FFFFFF" strokeWidth="5" />
<circle cx="260" cy="120" r="11" stroke="#111111" strokeWidth="2.5" />
</g>
<g className="zip-manager-click-two">
<circle cx="260" cy="120" r="11" stroke="#FFFFFF" strokeWidth="5" />
<circle cx="260" cy="120" r="11" stroke="#111111" strokeWidth="2.5" />
</g>
<image className="zip-manager-cursor" href="/marketing/assets/cursor-arrow.svg" x="267" y="111" width="25" height="27" />
</g>
</g>
</svg>
</div>
</article>
<article className="step">
<div className="step-copy step-copy--wide">
<h3>2. Open Extensions and enable Developer mode</h3>
<p>Copy the address below, paste it into the address bar, and enable Developer mode in the top right.</p>
<div className="step-actions">
<button className="extensions-link" type="button" data-copy-extensions-url>Copy extensions address</button>
<p className="copy-status" data-copy-status aria-live="polite">
</p>
</div>
</div>
<div className="step-visual" aria-hidden="true">
<svg viewBox="0 40 520 220" fill="none" xmlns="http://www.w3.org/2000/svg">
<defs>
<clipPath id="guide-green-clip">
<rect x="54" y="29" width="412" height="220" rx="11" />
</clipPath>
<clipPath id="guide-url-clip">
<rect className="guide-url-reveal" x="137" y="40" width="0" height="34" />
</clipPath>
</defs>
<rect x="24" y="16" width="472" height="268" rx="18" fill="#E7F4EE" />
<g transform="translate(0 11)">
<g clipPath="url(#guide-green-clip)">
<g className="guide-camera">
<rect x="54" y="29" width="412" height="220" rx="11" fill="white" stroke="#D8E8DF" />
<g className="guide-browser-chrome">
<path d="M54 82h412" stroke="#E7EFEB" />
<circle cx="78" cy="56" r="4" fill="#E99691" />
<circle cx="93" cy="56" r="4" fill="#EFC779" />
<circle cx="108" cy="56" r="4" fill="#8AC9AA" />
<g className="guide-address-focus">
<rect x="122" y="40" width="300" height="34" rx="17" fill="#F2F6F4" />
<text className="guide-address-hint" x="137" y="62" fill="#9CAD9F" fontFamily="Arial,sans-serif" fontSize="12">Search or enter address</text>
<g clipPath="url(#guide-url-clip)">
<text className="guide-address-url" x="137" y="62" fill="#315E50" fontFamily="Arial,sans-serif" fontSize="12" fontWeight="700">chrome://extensions/</text>
</g>
</g>
</g>
<g transform="translate(0 14)">
<g className="guide-copy-scene">
<rect x="78" y="65" width="195" height="15" rx="7.5" fill="#C9DBD2" />
<rect x="78" y="98" width="324" height="11" rx="5.5" fill="#E2ECE7" />
<rect x="78" y="120" width="276" height="11" rx="5.5" fill="#E2ECE7" />
<rect x="78" y="151" width="190" height="48" rx="10" fill="#E9F5F0" stroke="#B9DCCF" />
<text x="173" y="182" textAnchor="middle" fill="#176F65" fontFamily="Arial,sans-serif" fontSize="13" fontWeight="700">Copy extensions address</text>
</g>
<text className="guide-copy-confirm" x="284" y="182" fill="#168477" fontFamily="Arial,sans-serif" fontSize="12">✓ Copied</text>
<g className="guide-page-scene">
<text x="78" y="116" fill="#20332F" fontFamily="Arial,sans-serif" fontSize="17" fontWeight="700">Extensions</text>
<text x="305" y="114" fill="#536761" fontFamily="Arial,sans-serif" fontSize="12">Developer mode</text>
<rect className="guide-toggle-track" x="398" y="97" width="44" height="24" rx="12" fill="#DDE9E4" />
<circle className="guide-toggle-knob" cx="410" cy="109" r="9" fill="white" />
<path d="M78 148h364" stroke="#E7EEEB" strokeWidth="1" strokeLinecap="round" />
</g>
<g className="guide-copy-click">
<circle cx="250" cy="166" r="11" stroke="#FFFFFF" strokeWidth="5" />
<circle cx="250" cy="166" r="11" stroke="#111111" strokeWidth="2.5" />
</g>
<image className="guide-cursor-copy" href="/marketing/assets/cursor-arrow.svg" x="250" y="166" width="24" height="26" />
<image className="guide-cursor-toggle" href="/marketing/assets/cursor-arrow.svg" x="414" y="100" width="24" height="26" />
</g>
</g>
</g>
</g>
</svg>
</div>
</article>
<article className="step">
<div className="step-copy">
<h3>3. Load and install the extension</h3>
<p>Drag the extension folder from step 1 onto the Extensions page, then select Add extension in the confirmation dialog.</p>
</div>
<div className="step-visual" aria-hidden="true">
<svg viewBox="0 40 520 220" fill="none" xmlns="http://www.w3.org/2000/svg">
<defs>
<clipPath id="install-green-clip">
<rect x="54" y="29" width="412" height="220" rx="11" />
</clipPath>
</defs>
<rect x="24" y="16" width="472" height="268" rx="18" fill="#E7F4EE" />
<g transform="translate(0 11)">
<rect x="54" y="29" width="412" height="220" rx="11" fill="white" stroke="#D8E8DF" clipPath="url(#install-green-clip)" />
<path d="M54 82h412" stroke="#E7EFEB" />
<circle cx="78" cy="56" r="4" fill="#E99691" />
<circle cx="93" cy="56" r="4" fill="#EFC779" />
<circle cx="108" cy="56" r="4" fill="#8AC9AA" />
<rect x="122" y="40" width="300" height="34" rx="17" fill="#F2F6F4" />
<text x="137" y="62" fill="#315E50" fontFamily="Arial,sans-serif" fontSize="12" fontWeight="700">chrome://extensions/</text>
<g transform="translate(0 14)">
<text x="88" y="105" fill="#20332F" fontFamily="Arial,sans-serif" fontSize="16" fontWeight="700">Extensions</text>
<g className="install-drop-zone">
<rect className="install-drop-outline" x="96" y="127" width="324" height="76" rx="10" fill="#EDF8F2" stroke="#168477" strokeWidth="2.5" strokeDasharray="6 5" />
<text x="258" y="170" textAnchor="middle" fill="#6F9A89" fontFamily="Arial,sans-serif" fontSize="12">Drop to install</text>
</g>
<g className="install-folder-drag">
<image href="/marketing/assets/manual-folder.svg" x="310" y="140" width="70" height="54" />
<text x="345" y="221" textAnchor="middle" fill="#395B4E" fontFamily="Arial,sans-serif" fontSize="12" fontWeight="600">extension</text>
<image href="/marketing/assets/cursor-arrow.svg" x="360" y="164" width="24" height="26" />
</g>
<g className="install-modal">
<rect x="54" y="15" width="412" height="220" rx="11" fill="#20332F" opacity=".2" />
<g transform="translate(0 22)">
<rect x="94" y="48" width="332" height="130" rx="13" fill="white" stroke="#D8E4DE" />
<circle cx="118" cy="72" r="11" fill="#E4F2ED" />
<path d="m113 72 4 4 7-8" stroke="#168477" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
<rect x="139" y="67" width="149" height="9" rx="4.5" fill="#DCE6E1" />
<rect x="115" y="93" width="91" height="7" rx="3.5" fill="#E7EEEA" />
<rect x="115" y="108" width="238" height="6" rx="3" fill="#E7EEEA" />
<rect x="180" y="132" width="75" height="34" rx="17" fill="#EDF3F0" />
<text x="217.5" y="155" textAnchor="middle" fill="#50675C" fontFamily="Arial,sans-serif" fontSize="12">Cancel</text>
<rect className="install-add-button" x="264" y="132" width="143" height="34" rx="17" fill="#D7E8FF" />
<text x="335.5" y="155" textAnchor="middle" fill="#204C7B" fontFamily="Arial,sans-serif" fontSize="12" fontWeight="700">Add extension</text>
<circle className="install-button-click" cx="350" cy="149" r="13" stroke="#609BE4" strokeWidth="2" />
<image className="install-confirm-cursor" href="/marketing/assets/cursor-arrow.svg" x="342" y="141" width="24" height="26" />
</g>
</g>
<g className="install-success">
<rect x="96" y="127" width="324" height="76" rx="10" fill="#F8FCFA" stroke="#D5E8DE" />
<rect x="111" y="144" width="42" height="42" rx="9" fill="#2D9C8C" />
<text x="132" y="172" textAnchor="middle" fill="white" fontFamily="Arial,sans-serif" fontSize="16" fontWeight="700">E</text>
<text x="168" y="158" fill="#20332F" fontFamily="Arial,sans-serif" fontSize="13" fontWeight="700">EO2Weave</text>
<text x="168" y="180" fill="#6D8479" fontFamily="Arial,sans-serif" fontSize="12">Extension loaded</text>
<circle cx="393" cy="165" r="12" fill="#E1F2E8" />
<path d="m387 165 4 4 8-9" stroke="#168477" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
</g>
</g>
</g>
</svg>
</div>
</article>
</div>
</div>
</section>
</main>

    </div>
  )
}
