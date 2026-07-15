import type { ClientConfig, DiscoverOptions, TaskRequest } from "./types.js";

/** Canonical prompt-free projection used by ticketed and legacy discovery. */
export function projectRouteOptions(req: TaskRequest, cfg: ClientConfig): DiscoverOptions {
  const route = req.route_constraints ?? {};
  return {
    region: route.region ?? req.constraints?.region ?? cfg.region,
    qos: route.qos ?? req.constraints?.qos,
    model: route.model ?? req.constraints?.model,
    min_reputation: route.min_reputation ?? req.constraints?.min_reputation,
    browser_usable_only: route.browser_usable_only ?? false,
    profile_request: route.profile_request ?? cfg.profile_request,
    limit: route.limit ?? 10,
  };
}

/** Provider-facing constraints; route-only fields never cross the data plane. */
export function projectExecutionConstraints(req: TaskRequest): Record<string, unknown> {
  const source = req.constraints ?? {};
  return {
    ...(source.timeout_ms !== undefined ? { timeout_ms: source.timeout_ms } : {}),
    ...(source.qos !== undefined ? { qos: source.qos } : {}),
    ...(source.model !== undefined ? { model: source.model } : {}),
  };
}
