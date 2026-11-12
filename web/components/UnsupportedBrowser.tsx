import { AlertTriangle, ExternalLink } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { useT } from '@/i18n'
import { getRuntimeCapability } from '@/storage/runtime-capability'

// UA detection only tailors advice; AppBootstrap gates on actual capabilities.
function detectBrowser(userAgent: string) {
  const patterns = [
    { name: 'Microsoft Edge', pattern: /(?:Edg|EdgA|EdgiOS)\/([\d.]+)/, guidance: 'chromium' },
    { name: 'Opera', pattern: /OPR\/([\d.]+)/, guidance: 'chromium' },
    { name: 'Firefox', pattern: /(?:Firefox|FxiOS)\/([\d.]+)/, guidance: 'firefox' },
    { name: 'Samsung Internet', pattern: /SamsungBrowser\/([\d.]+)/, guidance: 'chromium' },
    { name: 'Vivaldi', pattern: /Vivaldi\/([\d.]+)/, guidance: 'chromium' },
    { name: 'Yandex Browser', pattern: /YaBrowser\/([\d.]+)/, guidance: 'chromium' },
    { name: 'Google Chrome', pattern: /(?:Chrome|CriOS)\/([\d.]+)/, guidance: 'chromium' },
    { name: 'Safari', pattern: /Version\/([\d.]+).*Safari\//, guidance: 'safari' },
  ]
  for (const browser of patterns) {
    const match = userAgent.match(browser.pattern)
    if (match) return { name: browser.name, version: match[1], guidance: browser.guidance }
  }
  return null
}

const downloads = [
  { name: 'Google Chrome', url: 'https://www.google.com/chrome/' },
  { name: 'Microsoft Edge', url: 'https://www.microsoft.com/edge' },
]

// API availability, not minimum versions for running the whole app.
// https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory
// https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker
const desktopCompatibility = [
  { name: 'Google Chrome', storage: '86+', folders: '86+' },
  { name: 'Microsoft Edge', storage: '86+', folders: '86+' },
  { name: 'Firefox', storage: '111+', folders: null },
  { name: 'Safari', storage: '15.2+', folders: null },
]

export function UnsupportedBrowser() {
  const t = useT()
  const browser = detectBrowser(navigator.userAgent)
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  const insecure = window.isSecureContext === false
  const capability = getRuntimeCapability()
  const guidance = insecure ? 'secureConnection' : isIOS ? 'ios' : (browser?.guidance ?? 'unknown')
  const available = (value: boolean) =>
    t(`unsupportedBrowser.${value ? 'available' : 'unavailable'}`)

  return (
    <div className="container mx-auto px-4 py-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl">
        <Card className="border-warning/30">
          <CardContent className="p-5 sm:p-8">
            <div className="mb-4 flex items-start gap-3">
              <AlertTriangle aria-hidden="true" className="h-7 w-7 shrink-0 text-warning" />
              <h1 className="text-xl font-semibold text-foreground">
                {t(`unsupportedBrowser.${insecure ? 'insecureTitle' : 'title'}`)}
              </h1>
            </div>

            <p className="mb-3 text-muted-foreground">{t('unsupportedBrowser.description')}</p>
            <p className="text-foreground">
              {t(`unsupportedBrowser.guidance.${guidance}`, { browser: browser?.name ?? '' })}
            </p>
            <p className="mt-3 break-words text-sm text-muted-foreground">
              {t('unsupportedBrowser.currentBrowser', {
                browser: browser
                  ? `${browser.name} ${browser.version}`
                  : t('unsupportedBrowser.unknownBrowser'),
              })}
            </p>

            {!insecure && !isIOS && (
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {[...downloads]
                  .sort(
                    (a, b) => Number(b.name === browser?.name) - Number(a.name === browser?.name)
                  )
                  .map((download) => (
                    <a
                      key={download.name}
                      href={download.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-3 rounded-lg border border-border p-4 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {t('unsupportedBrowser.download', { browser: download.name })}
                      <ExternalLink
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                      />
                    </a>
                  ))}
              </div>
            )}

            <details className="mt-6 border-t border-border pt-4 text-sm">
              <summary className="cursor-pointer font-medium text-foreground">
                {t('unsupportedBrowser.technicalDetails')}
              </summary>
              <dl className="my-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-muted-foreground">
                <dt>{t('unsupportedBrowser.secureContext')}</dt>
                <dd>{available(window.isSecureContext === true)}</dd>
                <dt>{t('unsupportedBrowser.browserStorage')}</dt>
                <dd>{available(capability.canUseOPFS)}</dd>
                <dt>{t('unsupportedBrowser.localFolders')}</dt>
                <dd>{available(capability.canPickDirectory)}</dd>
                <dt>{t('unsupportedBrowser.siteIsolation')}</dt>
                <dd>{available(window.crossOriginIsolated === true)}</dd>
              </dl>
              {window.crossOriginIsolated === false && (
                <p className="mb-4 text-muted-foreground">
                  {t('unsupportedBrowser.isolationHelp')}
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-muted-foreground">
                  <caption className="mb-2 text-left font-medium text-foreground">
                    {t('unsupportedBrowser.compatibilityTitle')}
                  </caption>
                  <thead>
                    <tr className="border-b border-border">
                      <th scope="col" className="py-2 pr-3">
                        {t('unsupportedBrowser.browser')}
                      </th>
                      <th scope="col" className="py-2 pr-3">
                        {t('unsupportedBrowser.browserStorage')}
                      </th>
                      <th scope="col" className="py-2">
                        {t('unsupportedBrowser.localFolders')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {desktopCompatibility.map((entry) => (
                      <tr key={entry.name} className="border-b border-border">
                        <th scope="row" className="py-2 pr-3 font-normal">
                          {entry.name}
                        </th>
                        <td className="py-2 pr-3">{entry.storage}</td>
                        <td className="py-2">
                          {entry.folders ?? t('unsupportedBrowser.notSupported')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {t('unsupportedBrowser.compatibilityNote')}
              </p>
            </details>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
