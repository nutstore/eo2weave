/**
 * Deployment-region feature gates — build-time inlined.
 *
 * The domestic (weave.eo2suite.cn) and international (weave.eo2suite.com)
 * sites are BUILT separately (NEXT_PUBLIC_DEPLOY_REGION, see next.config.mjs).
 * Region-specific product decisions live here so they are evaluated once:
 *
 *   - IS_CN_BUILD       → true on the domestic build
 *   - ENABLE_LLM_GATEWAY → Nutstore AI (Jianguoyun AI) gateway is offered.
 *     The gateway is a CN-only service for now; international builds must
 *     never show it (welcome screen, settings provider card, model lists)
 *     even if the client-id env var leaks into the wrong build pipeline.
 *     If the gateway later ships internationally, flip this constant.
 *
 * Mirrors: lib/currency.ts and lib/site-footer-config.ts define their own
 * IS_CN_BUILD copies (kept local so their env-stub tests stay isolated).
 */

export const IS_CN_BUILD = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn'

/** Nutstore AI (Jianguoyun AI) gateway is a domestic-only offering. */
export const ENABLE_LLM_GATEWAY = IS_CN_BUILD
