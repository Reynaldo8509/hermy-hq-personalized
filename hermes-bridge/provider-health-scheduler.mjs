export function createProviderHealthInFlight() {
  const activeRoutes = new Set();
  return Object.freeze({
    begin(routeKey) {
      const key = String(routeKey || "");
      if (!key || activeRoutes.has(key)) return false;
      activeRoutes.add(key);
      return true;
    },
    end(routeKey) {
      return activeRoutes.delete(String(routeKey || ""));
    },
    has(routeKey) {
      return activeRoutes.has(String(routeKey || ""));
    },
  });
}

export function providerHealthRoutePatch(state, routeKey, health, primaryRouteKey) {
  const current = state?.healthByRoute;
  const healthByRoute = current && typeof current === "object" && !Array.isArray(current)
    ? { ...current } : {};
  healthByRoute[String(routeKey)] = health;
  return {
    healthByRoute,
    ...(String(routeKey) === String(primaryRouteKey) ? { health } : {}),
  };
}
