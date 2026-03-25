import { FilePoolStateStore, PoolStateStore } from "./poolStateStore";

type CooldownReason =
  | "http_429"
  | "quota_exhausted"
  | "http_503"
  | "high_demand"
  | "http_5xx"
  | "transport_error"
  | "manual_skip";

interface ProviderCooldownState {
  routeKey: string;
  cooldownUntil: number;
  reason: CooldownReason;
  statusCode?: number;
  lastError?: string;
  consecutiveFailures: number;
  updatedAt: number;
}

interface PoolManagerStats {
  selectedRoutes: number;
  coolingSkips: number;
  retryableErrors: number;
  failFastErrors: number;
  cooldownTransitions: number;
  manualCooldowns: number;
  fallbackAttempts: number;
  fallbackSuccesses: number;
  fallbackExhausted: number;
}

interface PoolManagerConfig {
  enabled?: boolean;
  defaultCooldownMs?: number;
  transportCooldownMs?: number;
  statusCooldownMs?: Record<string, number>;
  allowedFails?: number;
  allowedFailsPolicy?: Record<string, number>;
  failureWindowMs?: number;
  persistEnabled?: boolean;
  persistDebounceMs?: number;
  stateFile?: string;
}

const DEFAULT_CONFIG: Required<PoolManagerConfig> = {
  enabled: true,
  defaultCooldownMs: 60_000,
  transportCooldownMs: 15_000,
  allowedFails: 1,
  allowedFailsPolicy: {
    "429": 1,
    quota_exhausted: 1,
    "503": 1,
    high_demand: 1,
    "5xx": 2,
    transport_error: 2,
  },
  failureWindowMs: 300_000,
  persistEnabled: true,
  persistDebounceMs: 300,
  stateFile: "",
  statusCooldownMs: {
    "429": 300_000,
    "503": 60_000,
    "500": 30_000,
    "502": 30_000,
    "504": 30_000,
  },
};

export type PoolManagerCooldownReason = CooldownReason;

interface PoolManagerPersistedState {
  version: number;
  savedAt: number;
  providerStates: ProviderCooldownState[];
  failureCounters: Array<{
    routeKey: string;
    count: number;
    updatedAt: number;
    lastStatusCode?: number;
    lastError?: string;
  }>;
  scenarioCursors: Array<{
    scenarioType: string;
    cursor: number;
  }>;
  stats: PoolManagerStats;
  scenarioSelections: Array<{
    scenarioType: string;
    routeKey: string;
    selectedAt: number;
    count: number;
  }>;
  recentEvents: Array<{
    type: string;
    routeKey?: string;
    scenarioType?: string;
    reason?: string;
    statusCode?: number;
    timestamp: number;
    details?: string;
  }>;
}

interface PoolHealthOverview {
  coolingByReason: Record<string, number>;
  coolingByScenario: Record<string, number>;
  recentEventCounts: Record<string, number>;
  activeScenarios: number;
  selectionCountsByScenario: Record<string, number>;
  lastEventAt: number | null;
}

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
  private stats: PoolManagerStats = {
    selectedRoutes: 0,
    coolingSkips: 0,
    retryableErrors: 0,
    failFastErrors: 0,
    cooldownTransitions: 0,
    manualCooldowns: 0,
    fallbackAttempts: 0,
    fallbackSuccesses: 0,
    fallbackExhausted: 0,
  };
  private readonly scenarioSelections = new Map<
    string,
    {
      routeKey: string;
      selectedAt: number;
      count: number;
    }
  >();
  private recentEvents: Array<{
    type: string;
    routeKey?: string;
    scenarioType?: string;
    reason?: string;
    statusCode?: number;
    timestamp: number;
    details?: string;
  }> = [];
  private readonly stateStores = new Map<string, PoolStateStore<PoolManagerPersistedState>>();
  private hasHydrated = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistInFlight: Promise<void> = Promise.resolve();

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
      persistEnabled:
        rawConfig?.persistEnabled ?? DEFAULT_CONFIG.persistEnabled,
      persistDebounceMs:
        rawConfig?.persistDebounceMs ?? DEFAULT_CONFIG.persistDebounceMs,
      stateFile: rawConfig?.stateFile ?? DEFAULT_CONFIG.stateFile,
      statusCooldownMs: {
        ...DEFAULT_CONFIG.statusCooldownMs,
        ...(rawConfig?.statusCooldownMs || {}),
      },
    };
  }

  private getStateFile(rawConfig?: PoolManagerConfig): string | null {
    const config = this.getConfig(rawConfig);
    if (!config.persistEnabled || !config.stateFile) {
      return null;
    }
    return config.stateFile;
  }

  private getStateStore(
    rawConfig?: PoolManagerConfig
  ): PoolStateStore<PoolManagerPersistedState> | null {
    const stateFile = this.getStateFile(rawConfig);
    if (!stateFile) {
      return null;
    }
    const existing = this.stateStores.get(stateFile);
    if (existing) {
      return existing;
    }
    const store = new FilePoolStateStore<PoolManagerPersistedState>(stateFile);
    this.stateStores.set(stateFile, store);
    return store;
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

  private pushEvent(event: {
    type: string;
    routeKey?: string;
    scenarioType?: string;
    reason?: string;
    statusCode?: number;
    details?: string;
  }) {
    this.recentEvents.push({
      ...event,
      timestamp: Date.now(),
    });
    if (this.recentEvents.length > 50) {
      this.recentEvents = this.recentEvents.slice(-50);
    }
  }

  private exportState(rawConfig?: PoolManagerConfig): PoolManagerPersistedState {
    this.cleanupExpired(rawConfig);
    return {
      version: 1,
      savedAt: Date.now(),
      providerStates: Array.from(this.providerStates.values()),
      failureCounters: Array.from(this.failureCounters.entries()).map(
        ([routeKey, counter]) => ({
          routeKey,
          count: counter.count,
          updatedAt: counter.updatedAt,
          lastStatusCode: counter.lastStatusCode,
          lastError: counter.lastError,
        })
      ),
      scenarioCursors: Array.from(this.scenarioCursors.entries()).map(
        ([scenarioType, cursor]) => ({
          scenarioType,
          cursor,
        })
      ),
      stats: { ...this.stats },
      scenarioSelections: Array.from(this.scenarioSelections.entries()).map(
        ([scenarioType, selection]) => ({
          scenarioType,
          routeKey: selection.routeKey,
          selectedAt: selection.selectedAt,
          count: selection.count,
        })
      ),
      recentEvents: [...this.recentEvents],
    };
  }

  private importState(
    state: PoolManagerPersistedState,
    rawConfig?: PoolManagerConfig
  ) {
    this.providerStates.clear();
    this.failureCounters.clear();
    this.scenarioCursors.clear();
    this.scenarioSelections.clear();
    this.recentEvents = [];
    this.stats = {
      selectedRoutes: 0,
      coolingSkips: 0,
      retryableErrors: 0,
      failFastErrors: 0,
      cooldownTransitions: 0,
      manualCooldowns: 0,
      fallbackAttempts: 0,
      fallbackSuccesses: 0,
      fallbackExhausted: 0,
    };

    for (const providerState of state.providerStates || []) {
      this.providerStates.set(providerState.routeKey, providerState);
    }
    for (const counter of state.failureCounters || []) {
      this.failureCounters.set(counter.routeKey, {
        count: counter.count,
        updatedAt: counter.updatedAt,
        lastStatusCode: counter.lastStatusCode,
        lastError: counter.lastError,
      });
    }
    for (const cursor of state.scenarioCursors || []) {
      this.scenarioCursors.set(cursor.scenarioType, cursor.cursor);
    }
    for (const selection of state.scenarioSelections || []) {
      this.scenarioSelections.set(selection.scenarioType, {
        routeKey: selection.routeKey,
        selectedAt: selection.selectedAt,
        count: selection.count,
      });
    }
    this.stats = {
      ...this.stats,
      ...(state.stats || {}),
    };
    this.recentEvents = [...(state.recentEvents || [])].slice(-50);
    this.cleanupExpired(rawConfig);
  }

  async hydrateOnce(rawConfig?: PoolManagerConfig, logger?: any) {
    if (this.hasHydrated) {
      return;
    }
    this.hasHydrated = true;
    const stateStore = this.getStateStore(rawConfig);
    if (!stateStore) {
      return;
    }
    try {
      const parsed = await stateStore.load(logger);
      if (!parsed) {
        return;
      }
      this.importState(parsed, rawConfig);
      const store = stateStore.describe();
      logger?.info?.(
        {
          stateStore: store.kind,
          stateTarget: store.target,
          coolingProviders: this.providerStates.size,
          providersWithRecentFailures: this.failureCounters.size,
          scenarioCursorCount: this.scenarioCursors.size,
        },
        "[PoolManager] hydrated persisted state"
      );
    } catch (error: any) {
      const store = stateStore.describe();
      logger?.warn?.(
        {
          stateStore: store.kind,
          stateTarget: store.target,
          message: error?.message,
        },
        "[PoolManager] failed to hydrate state store"
      );
    }
  }

  private queuePersist(
    stateStore: PoolStateStore<PoolManagerPersistedState>,
    payload: PoolManagerPersistedState,
    logger?: any
  ) {
    this.persistInFlight = this.persistInFlight
      .then(async () => {
        await stateStore.save(payload, logger);
        const store = stateStore.describe();
        logger?.debug?.(
          {
            stateStore: store.kind,
            stateTarget: store.target,
            coolingProviders: payload.providerStates.length,
            providersWithRecentFailures: payload.failureCounters.length,
          },
          "[PoolManager] persisted state"
        );
      })
      .catch((error: any) => {
        const store = stateStore.describe();
        logger?.warn?.(
          {
            stateStore: store.kind,
            stateTarget: store.target,
            message: error?.message,
          },
          "[PoolManager] failed to persist state"
        );
      });
    return this.persistInFlight;
  }

  schedulePersist(rawConfig?: PoolManagerConfig, logger?: any) {
    const stateFile = this.getStateFile(rawConfig);
    if (!stateFile) {
      return;
    }
    const config = this.getConfig(rawConfig);
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushNow(rawConfig, logger);
    }, config.persistDebounceMs);
  }

  async flushNow(rawConfig?: PoolManagerConfig, logger?: any) {
    const stateStore = this.getStateStore(rawConfig);
    if (!stateStore) {
      return;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const payload = this.exportState(rawConfig);
    await this.queuePersist(stateStore, payload, logger);
  }

  private parseProviderName(route?: string | null): string | null {
    if (!route || !route.includes(",")) {
      return null;
    }
    return route;
  }

  isCooling(routeKey: string, rawConfig?: PoolManagerConfig): boolean {
    const config = this.getConfig(rawConfig);
    if (!config.enabled) {
      return false;
    }
    this.cleanupExpired(rawConfig);
    const state = this.providerStates.get(routeKey);
    return !!state && state.cooldownUntil > Date.now();
  }

  getState(routeKey: string, rawConfig?: PoolManagerConfig) {
    this.cleanupExpired(rawConfig);
    if (!this.isCooling(routeKey, rawConfig)) {
      return null;
    }
    return this.providerStates.get(routeKey) || null;
  }

  getRemainingMs(routeKey: string, rawConfig?: PoolManagerConfig): number {
    const state = this.getState(routeKey, rawConfig);
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
    scenarioType: string | undefined,
    rawConfig?: PoolManagerConfig
  ): number {
    const config = this.getConfig(rawConfig);
    const statusKey =
      typeof statusCode === "number" && statusCode >= 500 ? "5xx" : undefined;
    const scenarioPrefix = scenarioType ? `${scenarioType}.` : "";

    return (
      (scenarioPrefix && config.allowedFailsPolicy[`${scenarioPrefix}${reason}`]) ||
      (scenarioPrefix &&
        typeof statusCode === "number" &&
        config.allowedFailsPolicy[`${scenarioPrefix}${String(statusCode)}`]) ||
      (scenarioPrefix &&
        statusKey &&
        config.allowedFailsPolicy[`${scenarioPrefix}${statusKey}`]) ||
      config.allowedFailsPolicy[reason] ||
      (typeof statusCode === "number" &&
        config.allowedFailsPolicy[String(statusCode)]) ||
      (statusKey && config.allowedFailsPolicy[statusKey]) ||
      config.allowedFails
    );
  }

  markCooldown(params: {
    routeKey: string;
    reason: CooldownReason;
    scenarioType?: string;
    statusCode?: number;
    message?: string;
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }) {
    const { routeKey, reason, scenarioType, statusCode, message, rawConfig, logger } =
      params;
    const config = this.getConfig(rawConfig);
    if (!config.enabled) {
      return;
    }

    const now = Date.now();
    const failureCounter = this.failureCounters.get(routeKey);
    const consecutiveFailures =
      failureCounter &&
      now - failureCounter.updatedAt <= config.failureWindowMs
        ? failureCounter.count + 1
        : 1;

    this.failureCounters.set(routeKey, {
      count: consecutiveFailures,
      updatedAt: now,
        lastStatusCode: statusCode,
        lastError: message,
    });

    const allowedFails = this.getAllowedFailsForReason(
      reason,
      statusCode,
      scenarioType,
      rawConfig
    );

    if (consecutiveFailures < allowedFails) {
      logger?.info?.(
        {
          routeKey,
          reason,
          scenarioType,
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
      routeKey,
      cooldownUntil: now + cooldownMs,
      reason,
      statusCode,
      lastError: message,
      consecutiveFailures,
      updatedAt: now,
    };

    this.providerStates.set(routeKey, state);
    this.stats.cooldownTransitions += 1;
    if (reason === "manual_skip") {
      this.stats.manualCooldowns += 1;
    }
    this.pushEvent({
      type: "cooldown",
      routeKey,
      reason,
      scenarioType,
      statusCode,
      details: message,
    });
    logger?.warn?.(
      {
        routeKey,
        reason,
        scenarioType,
        statusCode,
        cooldownMs,
        cooldownUntil: state.cooldownUntil,
        consecutiveFailures: state.consecutiveFailures,
      },
      "[PoolManager] provider moved to cooldown"
    );
    this.schedulePersist(rawConfig, logger);
  }

  clearCooldown(routeKey: string, rawConfig?: PoolManagerConfig, logger?: any) {
    let changed = false;
    if (this.providerStates.delete(routeKey)) {
      changed = true;
      logger?.info?.({ routeKey }, "[PoolManager] provider cooldown cleared");
    }
    if (this.failureCounters.delete(routeKey)) {
      changed = true;
    }
    if (changed) {
      this.schedulePersist(rawConfig, logger);
    }
  }

  clearAll(rawConfig?: PoolManagerConfig, logger?: any) {
    const cooldownCount = this.providerStates.size;
    const failureCount = this.failureCounters.size;
    this.providerStates.clear();
    this.failureCounters.clear();
    this.scenarioCursors.clear();
    this.scenarioSelections.clear();
    this.recentEvents = [];
    this.stats = {
      selectedRoutes: 0,
      coolingSkips: 0,
      retryableErrors: 0,
      failFastErrors: 0,
      cooldownTransitions: 0,
      manualCooldowns: 0,
      fallbackAttempts: 0,
      fallbackSuccesses: 0,
      fallbackExhausted: 0,
    };
    logger?.info?.(
      { cooldownCount, failureCount },
      "[PoolManager] cleared all cooldown and failure state"
    );
    this.schedulePersist(rawConfig, logger);
  }

  forceCooldown(params: {
    routeKey: string;
    reason?: CooldownReason;
    statusCode?: number;
    message?: string;
    cooldownMs?: number;
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }) {
    const {
      routeKey,
      reason = "manual_skip",
      statusCode,
      message,
      cooldownMs,
      rawConfig,
      logger,
    } = params;
    const config = this.getConfig(rawConfig);
    if (!config.enabled) {
      return;
    }

    const now = Date.now();
    const resolvedCooldownMs =
      typeof cooldownMs === "number" && cooldownMs > 0
        ? cooldownMs
        : reason === "transport_error"
          ? config.transportCooldownMs
          : this.getCooldownMsForStatus(statusCode, rawConfig);

    const previousFailureCount =
      this.failureCounters.get(routeKey)?.count || 0;

    this.failureCounters.set(routeKey, {
      count: Math.max(previousFailureCount, 1),
      updatedAt: now,
      lastStatusCode: statusCode,
      lastError: message || "forced cooldown",
    });

    this.providerStates.set(routeKey, {
      routeKey,
      cooldownUntil: now + resolvedCooldownMs,
      reason,
      statusCode,
      lastError: message || "forced cooldown",
      consecutiveFailures: Math.max(previousFailureCount, 1),
      updatedAt: now,
    });
    this.stats.cooldownTransitions += 1;
    this.stats.manualCooldowns += 1;
    this.pushEvent({
      type: "manual_cooldown",
      routeKey,
      reason,
      statusCode,
      details: message || "forced cooldown",
    });

    logger?.warn?.(
      {
        routeKey,
        reason,
        statusCode,
        cooldownMs: resolvedCooldownMs,
      },
      "[PoolManager] provider manually forced into cooldown"
    );
    this.schedulePersist(rawConfig, logger);
  }

  noteSuccess(routeKey: string, rawConfig?: PoolManagerConfig, logger?: any) {
    let changed = false;
    if (this.failureCounters.delete(routeKey)) {
      changed = true;
    }
    const existing = this.providerStates.get(routeKey);
    if (!existing) {
      if (changed) {
        this.schedulePersist(rawConfig, logger);
      }
      return;
    }
    this.providerStates.delete(routeKey);
    changed = true;
    logger?.info?.(
      { routeKey },
      "[PoolManager] provider removed from cooldown after success"
    );
    if (changed) {
      this.schedulePersist(rawConfig, logger);
    }
  }

  noteSelectedRoute(params: {
    scenarioType: string;
    routeKey: string;
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }) {
    const { scenarioType, routeKey, rawConfig, logger } = params;
    const previous = this.scenarioSelections.get(scenarioType);
    this.scenarioSelections.set(scenarioType, {
      routeKey,
      selectedAt: Date.now(),
      count: previous && previous.routeKey === routeKey ? previous.count + 1 : 1,
    });
    this.stats.selectedRoutes += 1;
    this.pushEvent({
      type: "selected_route",
      scenarioType,
      routeKey,
    });
    this.schedulePersist(rawConfig, logger);
  }

  noteCoolingSkip(params: {
    scenarioType: string;
    routeKey: string;
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }) {
    const { scenarioType, routeKey, rawConfig, logger } = params;
    this.stats.coolingSkips += 1;
    this.pushEvent({
      type: "cooling_skip",
      scenarioType,
      routeKey,
    });
    this.schedulePersist(rawConfig, logger);
  }

  noteRetryableFailure(params: {
    routeKey: string;
    reason: CooldownReason;
    statusCode?: number;
    details?: string;
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }) {
    const { routeKey, reason, statusCode, details, rawConfig, logger } = params;
    this.stats.retryableErrors += 1;
    this.pushEvent({
      type: "retryable_error",
      routeKey,
      reason,
      statusCode,
      details,
    });
    this.schedulePersist(rawConfig, logger);
  }

  noteFailFastError(params: {
    routeKey: string;
    statusCode?: number;
    details?: string;
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }) {
    const { routeKey, statusCode, details, rawConfig, logger } = params;
    this.stats.failFastErrors += 1;
    this.pushEvent({
      type: "fail_fast_error",
      routeKey,
      statusCode,
      details,
    });
    this.schedulePersist(rawConfig, logger);
  }

  noteFallbackAttempt(params: {
    scenarioType: string;
    routeKey: string;
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }) {
    const { scenarioType, routeKey, rawConfig, logger } = params;
    this.stats.fallbackAttempts += 1;
    this.pushEvent({
      type: "fallback_attempt",
      scenarioType,
      routeKey,
    });
    this.schedulePersist(rawConfig, logger);
  }

  noteFallbackSuccess(params: {
    scenarioType: string;
    routeKey: string;
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }) {
    const { scenarioType, routeKey, rawConfig, logger } = params;
    this.stats.fallbackSuccesses += 1;
    this.pushEvent({
      type: "fallback_success",
      scenarioType,
      routeKey,
    });
    this.schedulePersist(rawConfig, logger);
  }

  noteFallbackExhausted(params: {
    scenarioType: string;
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }) {
    const { scenarioType, rawConfig, logger } = params;
    this.stats.fallbackExhausted += 1;
    this.pushEvent({
      type: "fallback_exhausted",
      scenarioType,
    });
    this.schedulePersist(rawConfig, logger);
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
      const routeKey = this.parseProviderName(route);
      if (!routeKey || !this.isCooling(routeKey, rawConfig)) {
        this.scenarioCursors.set(
          scenarioType,
          (index + 1) % uniqueCandidates.length
        );
        this.noteSelectedRoute({
          scenarioType,
          routeKey: route,
          rawConfig,
          logger,
        });
        this.schedulePersist(rawConfig, logger);
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
      this.noteCoolingSkip({
        scenarioType,
        routeKey: route,
        rawConfig,
        logger,
      });
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
    this.noteSelectedRoute({
      scenarioType,
      routeKey: fallbackRoute,
      rawConfig,
      logger,
    });
    this.schedulePersist(rawConfig, logger);
    return fallbackRoute;
  }

  snapshot(rawConfig?: PoolManagerConfig): ProviderCooldownState[] {
    this.cleanupExpired(rawConfig);
    return Array.from(this.providerStates.values()).filter((state) =>
      this.isCooling(state.routeKey, rawConfig)
    );
  }

  failureSnapshot(rawConfig?: PoolManagerConfig) {
    const config = this.getConfig(rawConfig);
    this.cleanupExpired(rawConfig);
    return Array.from(this.failureCounters.entries())
      .filter(([, counter]) => Date.now() - counter.updatedAt <= config.failureWindowMs)
      .map(([routeKey, counter]) => ({
        routeKey,
        count: counter.count,
        updatedAt: counter.updatedAt,
        lastStatusCode: counter.lastStatusCode,
        lastError: counter.lastError,
      }));
  }

  summary(rawConfig?: PoolManagerConfig) {
    const pool = this.snapshot(rawConfig);
    const failures = this.failureSnapshot(rawConfig);
    const scenarioCursors = Array.from(this.scenarioCursors.entries()).map(
      ([scenarioType, cursor]) => ({
        scenarioType,
        cursor,
      })
    );
    const scenarioSelections = Array.from(this.scenarioSelections.entries()).map(
      ([scenarioType, selection]) => ({
        scenarioType,
        routeKey: selection.routeKey,
        selectedAt: selection.selectedAt,
        count: selection.count,
      })
    );
    const coolingByReason = pool.reduce<Record<string, number>>((acc, state) => {
      acc[state.reason] = (acc[state.reason] || 0) + 1;
      return acc;
    }, {});
    const coolingByScenario = this.recentEvents.reduce<Record<string, number>>(
      (acc, event) => {
        if (event.type !== "cooling_skip" || !event.scenarioType) {
          return acc;
        }
        acc[event.scenarioType] = (acc[event.scenarioType] || 0) + 1;
        return acc;
      },
      {}
    );
    const recentEventCounts = this.recentEvents.reduce<Record<string, number>>(
      (acc, event) => {
        acc[event.type] = (acc[event.type] || 0) + 1;
        return acc;
      },
      {}
    );
    const selectionCountsByScenario = scenarioSelections.reduce<
      Record<string, number>
    >((acc, selection) => {
      acc[selection.scenarioType] = selection.count;
      return acc;
    }, {});
    const overview: PoolHealthOverview = {
      coolingByReason,
      coolingByScenario,
      recentEventCounts,
      activeScenarios: scenarioSelections.length,
      selectionCountsByScenario,
      lastEventAt:
        this.recentEvents.length > 0
          ? this.recentEvents[this.recentEvents.length - 1].timestamp
          : null,
    };
    return {
      coolingProviders: pool.length,
      coolingRoutes: pool.length,
      providersWithRecentFailures: failures.length,
      routesWithRecentFailures: failures.length,
      stats: { ...this.stats },
      overview,
      scenarioCursors,
      scenarioSelections,
      recentEvents: [...this.recentEvents],
      pool,
      failures,
    };
  }
}

export const poolManager = new PoolManager();
