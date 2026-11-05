/**
 * Pure model-selection rules shared by settings and model-picker UI.
 *
 * The provider list is intentionally a small structural type so this module
 * does not depend on React, Zustand, or provider loading implementations.
 */

export type ModelCatalogStatus = 'loading' | 'ready' | 'empty' | 'failed'
export type ModelSelectionStatus = 'empty' | 'valid' | 'invalid'
export type ModelCredentialStatus =
  | 'unknown'
  | 'valid'
  | 'expired'
  | 'unauthorized'
  | 'missing'

export interface AvailableModelLike {
  id: string
  name?: string
  /** A model can be present in a pin list but absent from the authority list. */
  stale?: boolean
}

export interface AvailableProviderLike {
  providerType: string
  models: ReadonlyArray<AvailableModelLike>
  /** The provider's trusted catalog. Pins alone are never authoritative. */
  authoritativeIds?: ReadonlyArray<string>
  /** Omitted means the provider result is ready (legacy callers). */
  catalogStatus?: ModelCatalogStatus
}

export interface ModelSelectionResolution {
  action: 'keep' | 'switch' | 'none' | 'defer'
  providerType: string
  modelName: string
  reason:
    | 'current-valid'
    | 'current-provider-fallback'
    | 'first-available'
    | 'no-models'
    | 'catalog-loading'
    | 'catalog-failed'
}

function isCatalogReady(provider: AvailableProviderLike): boolean {
  return (provider.catalogStatus ?? 'ready') === 'ready'
}

function authoritativeModelIds(provider: AvailableProviderLike): Set<string> {
  const ids = provider.authoritativeIds
  if (ids) return new Set(ids)
  return new Set(provider.models.filter((model) => !model.stale).map((model) => model.id))
}

function usableModels(provider: AvailableProviderLike): AvailableModelLike[] {
  if (!isCatalogReady(provider)) return []
  const ids = authoritativeModelIds(provider)
  return provider.models.filter((model) => !model.stale && ids.has(model.id))
}

function firstPendingProvider(providers: ReadonlyArray<AvailableProviderLike>): AvailableProviderLike | undefined {
  return providers.find((provider) => provider.catalogStatus === 'loading')
}

/** Return whether provider/model is present in the provider's authoritative catalog. */
export function isValidModelSelection(
  providers: ReadonlyArray<AvailableProviderLike>,
  providerType: string,
  modelName: string,
): boolean {
  if (!providerType.trim() || !modelName.trim()) return false
  const provider = providers.find((candidate) => candidate.providerType === providerType)
  if (!provider || !isCatalogReady(provider)) return false

  // The authoritative catalog decides validity. A non-empty pin list is only
  // a display preference and must not invalidate a currently selected model
  // that remains available but is not pinned.
  return authoritativeModelIds(provider).has(modelName)
}

/**
 * Resolve the next stable provider/model pair.
 *
 * Loading/failed catalogs defer rather than pretending that no model exists.
 * A credential failure is handled by the caller because it must preserve the
 * selected gateway provider instead of falling back to another provider.
 */
export function resolveDefaultModelSelection(
  providers: ReadonlyArray<AvailableProviderLike>,
  current: { providerType: string; modelName: string },
): ModelSelectionResolution {
  const currentProvider = providers.find((provider) => provider.providerType === current.providerType)
  // Defer only while the CURRENT selection's own catalog is still loading —
  // an unrelated provider's in-flight catalog must not freeze reconciliation
  // of an invalid selection (Sourcery: "Unrelated selection stays invalid").
  if (currentProvider?.catalogStatus === 'loading' ||
      (!currentProvider && providers.some((provider) => provider.catalogStatus === 'loading'))) {
    return {
      action: 'defer',
      providerType: current.providerType,
      modelName: current.modelName,
      reason: 'catalog-loading',
    }
  }

  if (isValidModelSelection(providers, current.providerType, current.modelName)) {
    return {
      action: 'keep',
      providerType: current.providerType,
      modelName: current.modelName,
      reason: 'current-valid',
    }
  }

  // A failed or empty gateway catalog cannot prove that the persisted
  // selection is invalid. Preserve it until a later usable refresh.
  if ((currentProvider?.catalogStatus === 'failed' ||
       (currentProvider?.providerType === 'llm-gateway' && currentProvider.catalogStatus === 'empty')) &&
      current.providerType && current.modelName) {
    return {
      action: 'defer',
      providerType: current.providerType,
      modelName: current.modelName,
      reason: 'catalog-failed',
    }
  }
  const currentModels = currentProvider ? usableModels(currentProvider) : []
  if (currentModels.length > 0) {
    return {
      action: 'switch',
      providerType: currentProvider!.providerType,
      modelName: currentModels[0].id,
      reason: 'current-provider-fallback',
    }
  }

  const available = providers.find((provider) => usableModels(provider).length > 0)
  if (available) {
    return {
      action: 'switch',
      providerType: available.providerType,
      modelName: usableModels(available)[0].id,
      reason: 'first-available',
    }
  }

  const pending = firstPendingProvider(providers)
  if (pending) {
    return {
      action: 'defer',
      providerType: current.providerType,
      modelName: current.modelName,
      reason: 'catalog-loading',
    }
  }

  if (providers.some((provider) => provider.catalogStatus === 'failed' ||
      (provider.providerType === 'llm-gateway' && provider.catalogStatus === 'empty'))) {
    return {
      action: 'defer',
      providerType: current.providerType,
      modelName: current.modelName,
      reason: 'catalog-failed',
    }
  }

  return {
    action: 'none',
    providerType: current.providerType,
    modelName: current.modelName,
    reason: 'no-models',
  }
}

export function getModelRuntimeStatus(
  providers: ReadonlyArray<AvailableProviderLike>,
  current: { providerType: string; modelName: string },
  credential: ModelCredentialStatus = 'unknown',
): {
  catalog: ModelCatalogStatus
  selection: ModelSelectionStatus
  credential: ModelCredentialStatus
  canSend: boolean
} {
  const catalog: ModelCatalogStatus = providers.some((provider) => provider.catalogStatus === 'loading')
    ? 'loading'
    : providers.some((provider) => (provider.catalogStatus ?? 'ready') === 'ready' && usableModels(provider).length > 0)
      ? 'ready'
      : providers.some((provider) => provider.catalogStatus === 'failed')
        ? 'failed'
        : 'empty'
  const selection = !current.providerType || !current.modelName
    ? 'empty'
    : isValidModelSelection(providers, current.providerType, current.modelName)
      ? 'valid'
      : 'invalid'

  return {
    catalog,
    selection,
    credential,
    canSend: catalog === 'ready' && selection === 'valid' && credential === 'valid',
  }
}
