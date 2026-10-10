export const CHROME_WEB_STORE_EXTENSION_ID = 'canpcddlognjbengiodekfbbfnjafeml'
export const EDGE_ADDONS_EXTENSION_ID = 'hnndljbngdmcldojkaedhpehlghkljdm'
export const SELF_HOSTED_EXTENSION_ID = 'kdnnhmagmghdhfinoipgbcddnpmffbkp'

export type ExtensionInstallType = 'admin' | 'development' | 'normal' | 'sideload' | 'other' | 'unknown'
export type ExtensionDistribution =
  | 'chrome_web_store'
  | 'edge_addons'
  | 'self_hosted'
  | 'manual'
  | 'enterprise'
  | 'development'
  | 'unknown'

export function classifyExtensionDistribution(
  extensionId: string,
  installType: ExtensionInstallType,
): ExtensionDistribution {
  // Policy-managed installs remain enterprise-managed even when they use an
  // official store ID. Users should not be prompted to override the policy.
  if (installType === 'admin') return 'enterprise'

  if (installType === 'development') return 'development'

  if (extensionId === CHROME_WEB_STORE_EXTENSION_ID) return 'chrome_web_store'
  if (extensionId === EDGE_ADDONS_EXTENSION_ID) return 'edge_addons'
  if (extensionId === SELF_HOSTED_EXTENSION_ID) return 'self_hosted'
  if (installType === 'sideload') return 'manual'
  return 'unknown'
}
