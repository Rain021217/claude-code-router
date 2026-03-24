type CooldownReason =
  | "http_429"
  | "http_503"
  | "http_5xx"
  | "transport_error"
  | "manual_skip";

interface ProviderCooldownState {
  providerName: string;
  cooldownUntil: number;
  reason: CooldownReason;
  statusCode?: number;
  lastError?: string;
  consecutiveFailures: number;
  updatedAt: number;
}

interface PoolManagerConfig {
  enabled?: boolean;
  defaultCooldownMs?: number;
  transportCooldownMs?: number;
  statusCooldownMs?: Record<string, number>;
  allowedFails?: number;
  allowedFailsPolicy?: Record<string, number>;
  failureWindowMs?: number;
}

const DEFAULT_CONFIG: Required<PoolManagerConfig> = {
  enabled: true,
  defaultCooldownMs: 60_000,
  transportCooldownMs: 15_000,
  allowedFails: 1,
  allowedFailsPolicy: {
    "429": 1,
    "503": 1,
    "5xx": 2,
    transport_error: 2,
  },
  failureWindowMs: 300_000,
  statusCooldownMs: {
    "429": 300_000,
    "503": 60_000,
    "500": 30_000,
    "502": 30_000,
    "504": 30_000,
  },
};

export class PoolManager {
  private readonly providerStates = new Map<string, ProviderCooldownState>();
  private readonly scenarioCursors = new Map<string, number>();
  private readonly failureCounters = new Map<
    string,
    {
      count: number;
      updatedAt: number;
      lastStatusCode?: number;
      lastError?: string;
    }
  >();

  private getConfig(rawConfig?: PoolManagerConfig): Required<PoolManagerConfig> {
    return {
      enabled: rawConfig?.enabled ?? DEFAULT_CONFIG.enabled,
      defaultCooldownMs:
        rawConfig?.defaultCooldownMs ?? DEFAULT_CONFIG.defaultCooldownMs,
      transportCooldownMs:
        rawConfig?.transportCooldownMs ?? DEFAULT_CONFIG.transportCooldownMs,
      allowedFails: rawConfig?.allowedFails ?? DEFAULT_CONFIG.allowedFails,
      allowedFailsPolicy: {
        ...DEFAULT_CONFIG.allowedFailsPolicy,
        ...(rawConfig?.allowedFailsPolicy || {}),
      },
      failureWindowMs:
        rawConfig?.failureWindowMs ?? DEFAULT_CONFIG.failureWindowMs,
      statusCooldownMs: {
        ...DEFAULT_CONFIG.statusCooldownMs,
        ...(rawConfig?.statusCooldownMs || {}),
      },
    };
  }

  private cleanupExpired(rawConfig?: PoolManagerConfig, now = Date.now()) {
    for (const [providerName, state] of this.providerStates.entries()) {
      if (state.cooldownUntil <= now) {
        this.providerStates.delete(providerName);
      }
    }
    const config = this.getConfig(rawConfig);
    for (const [providerName, counter] of this.failureCounters.entries()) {
      if (now - counter.updatedAt > config.failureWindowMs) {
        this.failureCounters.delete(providerName);
      }
    }
  }

  private parseProviderName(route?: string | null): string | null {
    if (!route || !route.includes(",")) {
      return null;
    }
    return route.split(",")[0] || null;
  }

  isCooling(providerName: string, rawConfig?: PoolManagerConfig): boolean {
    const config = this.getConfig(rawConfig);
    if (!config.enabled) {
      return false;
    }
    this.cleanupExpired(rawConfig);
    const state = this.providerStates.get(providerName);
    return !!state && state.cooldownUntil > Date.now();
  }

  getState(providerName: string, rawConfig?: PoolManagerConfig) {
    this.cleanupExpired(rawConfig);
    if (!this.isCooling(providerName, rawConfig)) {
      return null;
    }
    return this.providerStates.get(providerName) || null;
  }

  getRemainingMs(providerName: string, rawConfig?: PoolManagerConfig): number {
    const state = this.getState(providerName, rawConfig);
    if (!state) {
      return 0;
    }
    return Math.max(0, state.cooldownUntil - Date.now());
  }

  shouldCooldownForStatus(statusCode?: number): boolean {
    if (!statusCode) {
      return false;
    }
    if (statusCode === 429 || statusCode === 503) {
      return true;
    }
    return statusCode >= 500;
  }

  getCooldownMsForStatus(
    statusCode: number | undefined,
    rawConfig?: PoolManagerConfig
  ): number {
    const config = this.getConfig(rawConfig);
    if (!statusCode) {
      return config.transportCooldownMs;
    }
    return (
      config.statusCooldownMs[String(statusCode)] ?? config.defaultCooldownMs
    );
  }

  private getAllowedFailsForReason(
    reason: CooldownReason,
    statusCode: number | undefined,
    rawConfig?: PoolManagerConfig
  ): number {
    const config = this.getConfig(rawConfig);
    const statusKey =
      typeof statusCode === "number" && statusCode >= 500 ? "5xx" : undefined;

    return (
      (typeof statusCode === "number" &&
        config.allowedFailsPolicy[String(statusCode)]) ||
      (statusKey && config.allowedFailsPolicy[statusKey]) ||
      config.allowedFailsPolicy[reason] ||
      config.allowedFails
    );
  }

  markCooldown(params: {
    providerName: string;
    reason: CooldownReason;
    statusCode?: number;
    message?: string;
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }) {
    const { providerName, reason, statusCode, message, rawConfig, logger } =
      params;
    const config = this.getConfig(rawConfig);
    if (!config.enabled) {
      return;
    }

    const now = Date.now();
    const failureCounter = this.failureCounters.get(providerName);
    const consecutiveFailures =
      failureCounter &&
      now - failureCounter.updatedAt <= config.failureWindowMs
        ? failureCounter.count + 1
        : 1;

    this.failureCounters.set(providerName, {
      count: consecutiveFailures,
      updatedAt: now,
        lastStatusCode: statusCode,
        lastError: message,
    });

    const allowedFails = this.getAllowedFailsForReason(
      reason,
      statusCode,
      rawConfig
    );

    if (consecutiveFailures < allowedFails) {
      logger?.info?.(
        {
          providerName,
          reason,
          statusCode,
          consecutiveFailures,
          allowedFails,
        },
        "[PoolManager] failure recorded but cooldown threshold not reached"
      );
      return;
    }

    const cooldownMs =
      reason === "transport_error"
        ? config.transportCooldownMs
        : this.getCooldownMsForStatus(statusCode, rawConfig);

    const state: ProviderCooldownState = {
      providerName,
      cooldownUntil: now + cooldownMs,
      reason,
      statusCode,
      lastError: message,
      consecutiveFailures,
      updatedAt: now,
    };

    this.providerStates.set(providerName, state);
    logger?.warn?.(
      {
        providerName,
        reason,
        statusCode,
        cooldownMs,
        cooldownUntil: state.cooldownUntil,
        consecutiveFailures: state.consecutiveFailures,
      },
      "[PoolManager] provider moved to cooldown"
    );
  }

  clearCooldown(providerName: string, logger?: any) {
    if (this.providerStates.delete(providerName)) {
      logger?.info?.({ providerName }, "[PoolManager] provider cooldown cleared");
    }
    this.failureCounters.delete(providerName);
  }

  noteSuccess(providerName: string, logger?: any) {
    this.failureCounters.delete(providerName);
    const existing = this.providerStates.get(providerName);
    if (!existing) {
      return;
    }
    this.providerStates.delete(providerName);
    logger?.info?.(
      { providerName },
      "[PoolManager] provider removed from cooldown after success"
    );
  }

  pickRoute(params: {
    scenarioType: string;
    primaryRoute?: string;
    fallbackRoutes?: string[];
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }): string | null {
    const {
      scenarioType,
      primaryRoute,
      fallbackRoutes = [],
      rawConfig,
      logger,
    } = params;
    const config = this.getConfig(rawConfig);
    const candidates = [primaryRoute, ...fallbackRoutes].filter(
      (route): route is string => typeof route === "string" && route.length > 0
    );
    const uniqueCandidates = Array.from(new Set(candidates));

    if (uniqueCandidates.length === 0) {
      return null;
    }

    if (!config.enabled) {
      return uniqueCandidates[0];
    }

    this.cleanupExpired(rawConfig);
    const startIndex = this.scenarioCursors.get(scenarioType) ?? 0;

    for (let offset = 0; offset < uniqueCandidates.length; offset += 1) {
      const index = (startIndex + offset) % uniqueCandidates.length;
      const route = uniqueCandidates[index];
      const providerName = this.parseProviderName(route);
      if (!providerName || !this.isCooling(providerName, rawConfig)) {
        this.scenarioCursors.set(
          scenarioType,
          (index + 1) % uniqueCandidates.length
        );
        logger?.info?.(
          {
            scenarioType,
            selectedRoute: route,
            candidateCount: uniqueCandidates.length,
            strategy: "round_robin_with_cooldown_skip",
          },
          "[PoolManager] selected route from scenario pool"
        );
        return route;
      }
    }

    const fallbackRoute = uniqueCandidates[startIndex % uniqueCandidates.length];
    logger?.warn?.(
      {
        scenarioType,
        selectedRoute: fallbackRoute,
        candidateCount: uniqueCandidates.length,
      },
      "[PoolManager] all scenario pool routes are cooling, falling back to original rotation"
    );
    this.scenarioCursors.set(
      scenarioType,
      (startIndex + 1) % uniqueCandidates.length
    );
    return fallbackRoute;
  }

  snapshot(rawConfig?: PoolManagerConfig): ProviderCooldownState[] {
    this.cleanupExpired(rawConfig);
    return Array.from(this.providerStates.values()).filter((state) =>
      this.isCooling(state.providerName, rawConfig)
    );
  }

  failureSnapshot(rawConfig?: PoolManagerConfig) {
    const config = this.getConfig(rawConfig);
    this.cleanupExpired();
    return Array.from(this.failureCounters.entries())
      .filter(([, counter]) => Date.now() - counter.updatedAt <= config.failureWindowMs)
      .map(([providerName, counter]) => ({
        providerName,
        count: counter.count,
        updatedAt: counter.updatedAt,
        lastStatusCode: counter.lastStatusCode,
        lastError: counter.lastError,
      }));
  }
}

export const poolManager = new PoolManager();
