export interface ProviderTransformer {
  use: (string | (string | Record<string, unknown> | { max_tokens: number })[])[];
  [key: string]: any; // Allow for model-specific transformers
}

export interface Provider {
  name: string;
  api_base_url: string;
  api_key: string;
  models: string[];
  transformer?: ProviderTransformer;
}

export interface RouterConfig {
    default: string;
    background: string;
    think: string;
    longContext: string;
    longContextThreshold: number;
    webSearch: string;
    image: string;
    custom?: any;
}

export interface Transformer {
    name?: string;
    path: string;
    options?: Record<string, any>;
}

export interface StatusLineModuleConfig {
  type: string;
  icon?: string;
  text: string;
  color?: string;
  background?: string;
  scriptPath?: string; // 用于script类型的模块，指定要执行的Node.js脚本文件路径
}

export interface StatusLineThemeConfig {
  modules: StatusLineModuleConfig[];
}

export interface StatusLineConfig {
  enabled: boolean;
  currentStyle: string;
  default: StatusLineThemeConfig;
  powerline: StatusLineThemeConfig;
  fontFamily?: string;
}

export interface Config {
  Providers: Provider[];
  Router: RouterConfig;
  transformers: Transformer[];
  StatusLine?: StatusLineConfig;
  forceUseImageAgent?: boolean;
  // Top-level settings
  LOG: boolean;
  LOG_LEVEL: string;
  CLAUDE_PATH: string;
  HOST: string;
  PORT: number;
  APIKEY: string;
  API_TIMEOUT_MS: string;
  PROXY_URL: string;
  CUSTOM_ROUTER_PATH?: string;
}

export type AccessLevel = 'restricted' | 'full';

export interface A2GPathStatus {
  label: string;
  path: string;
  exists: boolean;
}

export interface A2GControlPlaneData {
  status: string;
  mode: string;
  sourceOfTruth: string;
  runtime: {
    host: string;
    port: number;
    providerCount: number;
    transformerCount: number;
    routeCount: number;
    routerTargets: string[];
  };
  specSummary: {
    providerDiscoveryEnabled: boolean;
    providerDiscoveryPrefix: string | null;
    declaredProviderCount: number;
    modelTierCount: number;
    scenarioCount: number;
    scenarios: string[];
  } | null;
  paths: A2GPathStatus[];
  poolSummary: {
    status: string;
    coolingRouteCount: number;
    routesWithRecentFailures: number;
    activeScenarios: number;
    stats: Record<string, number>;
    overview: Record<string, unknown>;
    recentEvents: Array<Record<string, unknown>>;
  };
  releaseSummary: {
    draftRevision: string;
    activeVersion: string | null;
    latestSnapshotVersion: string | null;
    hasUnpublishedChanges: boolean;
    snapshotCount: number;
    auditCount: number;
    validation: {
      ok: boolean;
      message: string;
    };
  };
  notes: string[];
}

export interface A2GDraftPayload {
  ok: boolean;
  draftId: string;
  source: string;
  spec: Record<string, unknown>;
}

export interface A2GGeneratePayload {
  ok: boolean;
  generatedConfig: Record<string, unknown>;
  summary: {
    providerCount: number;
    scenarioCount: number;
    fallbackScenarioCount: number;
  };
}

export interface A2GValidatePayload extends A2GGeneratePayload {
  inSyncWithRepoConfig: boolean;
  message: string;
}

export interface A2GDiffPayload {
  ok: boolean;
  draftId: string;
  draftRevision: string;
  hasUnpublishedChanges: boolean;
  specDiff: {
    hasChanges: boolean;
    summary: { total: number; added: number; removed: number; changed: number };
    changes: Array<{ path: string; type: "added" | "removed" | "changed"; before?: string; after?: string }>;
  };
  generatedDiff: {
    hasChanges: boolean;
    summary: { total: number; added: number; removed: number; changed: number };
    changes: Array<{ path: string; type: "added" | "removed" | "changed"; before?: string; after?: string }>;
  };
}

export interface A2GSnapshotMeta {
  releaseVersion: string;
  draftRevision: string;
  createdAt: string;
  publishedAt: string | null;
  publishedBy: string;
  active: boolean;
  validation: {
    ok: boolean;
    message: string;
  };
}

export interface A2GReleaseContextPayload {
  ok: boolean;
  draftId: string;
  draftSource: string;
  draftRevision: string;
  activeVersion: string | null;
  latestSnapshotVersion: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  hasUnpublishedChanges: boolean;
  validation: {
    ok: boolean;
    message: string;
  };
  specDiff: A2GDiffPayload["specDiff"];
  generatedDiff: A2GDiffPayload["generatedDiff"];
  auditEvents: A2GAuditEvent[];
  snapshots: A2GSnapshotMeta[];
}

export interface A2GAuditEvent {
  id: string;
  timestamp: string;
  type: string;
  releaseVersion?: string;
  draftRevision?: string;
  draftId?: string;
  publishedBy?: string;
  validationOk?: boolean;
}
