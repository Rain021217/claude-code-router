import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";

type CooldownReason =
  | "http_429"
  | "http_503"
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
    "503": 1,
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
    };
  }

  private importState(
    state: PoolManagerPersistedState,
    rawConfig?: PoolManagerConfig
  ) {
    this.providerStates.clear();
    this.failureCounters.clear();
    this.scenarioCursors.clear();

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
    this.cleanupExpired(rawConfig);
  }

  async hydrateOnce(rawConfig?: PoolManagerConfig, logger?: any) {
    if (this.hasHydrated) {
      return;
    }
    this.hasHydrated = true;
    const stateFile = this.getStateFile(rawConfig);
    if (!stateFile) {
      return;
    }
    try {
      const raw = await readFile(stateFile, "utf8");
      const parsed = JSON.parse(raw) as PoolManagerPersistedState;
      this.importState(parsed, rawConfig);
      logger?.info?.(
        {
          stateFile,
          coolingProviders: this.providerStates.size,
          providersWithRecentFailures: this.failureCounters.size,
          scenarioCursorCount: this.scenarioCursors.size,
        },
        "[PoolManager] hydrated persisted state"
      );
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        logger?.info?.({ stateFile }, "[PoolManager] state file does not exist yet");
        return;
      }
      logger?.warn?.(
        {
          stateFile,
          message: error?.message,
        },
        "[PoolManager] failed to hydrate state file"
      );
    }
  }

  private queuePersist(
    stateFile: string,
    payload: PoolManagerPersistedState,
    logger?: any
  ) {
    this.persistInFlight = this.persistInFlight
      .then(async () => {
        const dir = dirname(stateFile);
        const tmpFile = `${stateFile}.tmp`;
        await mkdir(dir, { recursive: true });
        await writeFile(
          tmpFile,
          JSON.stringify(payload, null, 2) + "\n",
          "utf8"
        );
        await rename(tmpFile, stateFile);
        logger?.debug?.(
          {
            stateFile,
            coolingProviders: payload.providerStates.length,
            providersWithRecentFailures: payload.failureCounters.length,
          },
          "[PoolManager] persisted state to disk"
        );
      })
      .catch((error: any) => {
        logger?.warn?.(
          {
            stateFile,
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
    const stateFile = this.getStateFile(rawConfig);
    if (!stateFile) {
      return;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const payload = this.exportState(rawConfig);
    await this.queuePersist(stateFile, payload, logger);
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
    routeKey: string;
    reason: CooldownReason;
    statusCode?: number;
    message?: string;
    rawConfig?: PoolManagerConfig;
    logger?: any;
  }) {
    const { routeKey, reason, statusCode, message, rawConfig, logger } =
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
      rawConfig
    );

    if (consecutiveFailures < allowedFails) {
      logger?.info?.(
        {
          routeKey,
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
      routeKey,
      cooldownUntil: now + cooldownMs,
      reason,
      statusCode,
      lastError: message,
      consecutiveFailures,
      updatedAt: now,
    };

    this.providerStates.set(routeKey, state);
    logger?.warn?.(
      {
        routeKey,
        reason,
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
    return {
      coolingProviders: pool.length,
      providersWithRecentFailures: failures.length,
      pool,
      failures,
    };
  }
}

export const poolManager = new PoolManager();
