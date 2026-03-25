import Server, { calculateTokenCount, TokenizerService } from "@musistudio/llms";
import { readConfigFile, writeConfigFile, backupConfigFile } from "./utils";
import { join } from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fastifyStatic from "@fastify/static";
import {
  chmodSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  rmSync,
} from "fs";
import { homedir } from "os";
import {
  getPresetDir,
  readManifestFromDir,
  manifestToPresetFile,
  saveManifest,
  isPresetInstalled,
  extractPreset,
  HOME_DIR,
  extractMetadata,
  loadConfigFromManifest,
  downloadPresetToTemp,
  getTempDir,
  findMarketPresetByName,
  getMarketPresets,
  type PresetFile,
  type ManifestFile,
  type PresetMetadata,
} from "@CCR/shared";
import fastifyMultipart from "@fastify/multipart";
import AdmZip from "adm-zip";

const execFileAsync = promisify(execFile);

export const createServer = async (config: any): Promise<any> => {
  const server = new Server(config);
  const app = server.app;

  const getA2GPaths = () => {
    const homeA2GDir = join(HOME_DIR, "a2g");
    return {
      specPath: process.env.A2G_CONFIG_SPEC_PATH || "",
      generatorPath: process.env.A2G_GENERATOR_SCRIPT_PATH || "",
      validatorPath: process.env.A2G_VALIDATOR_SCRIPT_PATH || "",
      generatedConfigPath:
        process.env.A2G_GENERATED_CONFIG_PATH || join(HOME_DIR, "config.json"),
      sourceOfTruth:
        process.env.A2G_SOURCE_OF_TRUTH ||
        "config.spec.json -> generate -> config.json -> Git",
      pythonBin: process.env.A2G_PYTHON_BIN || "python3",
      pythonPath: process.env.A2G_PYTHONPATH || "",
      draftsDir:
        process.env.A2G_DRAFTS_DIR || join(HOME_DIR, "state", "a2g-drafts"),
      controlPlaneStateDir:
        process.env.A2G_CONTROL_PLANE_STATE_DIR ||
        join(HOME_DIR, "state", "a2g-control-plane"),
      authStateDir:
        process.env.A2G_AUTH_STATE_DIR ||
        join(HOME_DIR, "state", "a2g-auth"),
      tmpDir: join(homeA2GDir, "tmp"),
    };
  };

  const resolveAdminApiKey = (configuredValue?: string) => {
    if (!configuredValue) {
      return "";
    }
    if (configuredValue.startsWith("$")) {
      return process.env[configuredValue.slice(1)] || "";
    }
    return configuredValue;
  };

  const ensureA2GDir = (dirPath: string) => {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  };

  const readJsonFile = (filePath: string) =>
    JSON.parse(readFileSync(filePath, "utf-8"));

  const getDraftFilePath = (draftId = "default") => {
    const { draftsDir } = getA2GPaths();
    ensureA2GDir(draftsDir);
    return join(draftsDir, `${draftId}.spec.json`);
  };

  const getControlPlaneMetadataPath = () => {
    const { controlPlaneStateDir } = getA2GPaths();
    ensureA2GDir(controlPlaneStateDir);
    return join(controlPlaneStateDir, "metadata.v1.json");
  };

  const getSnapshotDir = () => {
    const { controlPlaneStateDir } = getA2GPaths();
    const snapshotsDir = join(controlPlaneStateDir, "snapshots");
    ensureA2GDir(snapshotsDir);
    return snapshotsDir;
  };

  const getAuditLogPath = () => {
    const { controlPlaneStateDir } = getA2GPaths();
    ensureA2GDir(controlPlaneStateDir);
    return join(controlPlaneStateDir, "audit.v1.jsonl");
  };

  const getAuthProfilesPath = () => {
    const { authStateDir } = getA2GPaths();
    ensureA2GDir(authStateDir);
    return join(authStateDir, "auth-profiles.v1.json");
  };

  const getAuthSecretsDir = () => {
    const { authStateDir } = getA2GPaths();
    const secretsDir = join(authStateDir, "secrets");
    ensureA2GDir(secretsDir);
    return secretsDir;
  };

  const defaultAuthStore = () => ({
    profiles: [] as Array<Record<string, unknown>>,
    secretRefs: [] as Array<Record<string, unknown>>,
  });

  const loadDraftSpec = (draftId = "default") => {
    const draftPath = getDraftFilePath(draftId);
    const { specPath } = getA2GPaths();
    if (existsSync(draftPath)) {
      return { draftId, source: "draft", spec: readJsonFile(draftPath) };
    }
    if (specPath && existsSync(specPath)) {
      return { draftId, source: "spec", spec: readJsonFile(specPath) };
    }
    return { draftId, source: "empty", spec: {} };
  };

  const saveDraftSpec = (draftId: string, spec: Record<string, unknown>) => {
    const draftPath = getDraftFilePath(draftId);
    writeFileSync(draftPath, `${JSON.stringify(spec, null, 2)}\n`, "utf-8");
    return draftPath;
  };

  const loadAuthProfilesStore = () => {
    const authProfilesPath = getAuthProfilesPath();
    if (!existsSync(authProfilesPath)) {
      return defaultAuthStore();
    }
    const store = readJsonFile(authProfilesPath);
    return {
      ...defaultAuthStore(),
      ...(store && typeof store === "object" ? store : {}),
      profiles: Array.isArray(store?.profiles) ? store.profiles : [],
      secretRefs: Array.isArray(store?.secretRefs) ? store.secretRefs : [],
    };
  };

  const saveAuthProfilesStore = (store: Record<string, unknown>) => {
    const authProfilesPath = getAuthProfilesPath();
    writeFileSync(authProfilesPath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
    return store;
  };

  const createOpaqueId = (prefix: string) =>
    `${prefix}_${createHash("sha256")
      .update(`${Date.now()}-${Math.random()}-${prefix}`)
      .digest("hex")
      .slice(0, 10)}`;

  const maskSecret = (secret: string) => {
    const trimmed = secret.trim();
    if (!trimmed) {
      return "••••";
    }
    const suffix = trimmed.slice(-4);
    return `••••${suffix}`;
  };

  const toAuthProfileView = (
    profile: Record<string, any>,
    secretRef?: Record<string, any>,
  ) => ({
    id: profile.id,
    type: profile.type,
    displayName: profile.displayName,
    status: profile.status,
    provider: profile.provider,
    secretRefId: profile.secretRefId,
    slot: profile.slot ?? null,
    enabled: profile.enabled !== false,
    maskedSecret: secretRef?.maskedValue,
    fingerprint: secretRef?.fingerprint,
    envVarName: secretRef?.envVarName,
    updatedAt: profile.updatedAt,
    lastHealthCheckAt: profile.lastHealthCheckAt,
    health: profile.health,
  });

  const getSecretRefById = (store: Record<string, any>, secretRefId?: string) =>
    Array.isArray(store.secretRefs)
      ? store.secretRefs.find((item: any) => item?.id === secretRefId)
      : undefined;

  const buildAuthProfileViewList = (store: Record<string, any>) => {
    const profiles = Array.isArray(store.profiles) ? store.profiles : [];
    return profiles.map((profile: any) =>
      toAuthProfileView(profile, getSecretRefById(store, profile.secretRefId)),
    );
  };

  const normalizeProviderName = (provider?: string) =>
    typeof provider === "string" && provider.trim() ? provider.trim() : "gemini";

  const buildImpactSummary = (
    specDiff: {
      hasChanges: boolean;
      changes: Array<{ path: string }>;
    },
    generatedDiff: {
      hasChanges: boolean;
      changes: Array<{ path: string }>;
    },
  ) => {
    const changedScenarioNames = new Set<string>();
    const changedProviderIndexes = new Set<string>();
    let authRelatedChangeCount = 0;

    for (const change of generatedDiff.changes) {
      const routerMatch = /^Router\.([^.\[]+)/.exec(change.path);
      if (routerMatch && routerMatch[1] !== "longContextThreshold") {
        changedScenarioNames.add(routerMatch[1]);
      }
      const providerMatch = /^Providers\[(\d+)\]/.exec(change.path);
      if (providerMatch) {
        changedProviderIndexes.add(providerMatch[1]);
      }
    }

    for (const change of specDiff.changes) {
      if (
        change.path.includes("api_key") ||
        change.path.includes("auth_profile") ||
        change.path.includes("secret")
      ) {
        authRelatedChangeCount += 1;
      }
    }

    const riskLevel = authRelatedChangeCount > 0
      ? "high"
      : generatedDiff.changes.length > 10
        ? "medium"
        : generatedDiff.hasChanges || specDiff.hasChanges
          ? "low"
          : "none";

    return {
      hasChanges: specDiff.hasChanges || generatedDiff.hasChanges,
      changedScenarioCount: changedScenarioNames.size,
      changedScenarios: Array.from(changedScenarioNames).slice(0, 10),
      changedProviderCount: changedProviderIndexes.size,
      authRelatedChangeCount,
      riskLevel,
    };
  };

  const validateApiKeyOnboarding = (payload: any) => {
    const fieldErrors: Array<Record<string, string>> = [];
    if (!payload || typeof payload !== "object") {
      fieldErrors.push({
        path: "$",
        code: "type",
        message: "request body must be an object",
        hint: "Provide displayName, provider, and apiKey.",
      });
      return fieldErrors;
    }
    if (
      typeof payload.displayName !== "string" ||
      !payload.displayName.trim()
    ) {
      fieldErrors.push({
        path: "displayName",
        code: "required",
        message: "displayName is required",
        hint: "Use a short readable name such as 'Gemini Main Account'.",
      });
    }
    if (typeof payload.apiKey !== "string" || !payload.apiKey.trim()) {
      fieldErrors.push({
        path: "apiKey",
        code: "required",
        message: "apiKey is required",
        hint: "Paste the upstream API key; it will be masked after save.",
      });
    }
    return fieldErrors;
  };

  const buildApiKeySecretRef = (apiKey: string, slot: number, provider: string) => {
    const normalizedProvider = normalizeProviderName(provider);
    const secretRefId = createOpaqueId("sec");
    const fingerprint = createHash("sha256")
      .update(apiKey.trim())
      .digest("hex")
      .slice(0, 12);
    return {
      id: secretRefId,
      kind: "api_key",
      provider: normalizedProvider,
      backend: "file",
      path: join("secrets", `${secretRefId}.key`),
      envVarName: `A2G_CCR_${normalizedProvider.toUpperCase()}_API_KEY_${slot}`,
      maskedValue: maskSecret(apiKey),
      fingerprint: `sha256:${fingerprint}`,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  };

  const writeSecretRefFile = (secretRef: Record<string, any>, secret: string) => {
    const secretFilePath = join(getAuthSecretsDir(), `${secretRef.id}.key`);
    writeFileSync(secretFilePath, `${secret.trim()}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    chmodSync(secretFilePath, 0o600);
    return secretFilePath;
  };

  const readSecretRefValue = (secretRef: Record<string, any>) => {
    const secretPath = join(getAuthSecretsDir(), `${secretRef.id}.key`);
    if (!existsSync(secretPath)) {
      throw new Error(`secret file missing for ${secretRef.id}`);
    }
    return readFileSync(secretPath, "utf-8").trim();
  };

  const getDefaultGeminiHealthTarget = () => {
    const draft = loadDraftSpec("default");
    const spec = draft.spec || {};
    const apiBaseUrl =
      typeof (spec as any).api_base_url === "string"
        ? (spec as any).api_base_url
        : "";
    const models =
      spec && typeof spec === "object" && (spec as any).models && typeof (spec as any).models === "object"
        ? ((spec as any).models as Record<string, string>)
        : {};
    const modelName =
      typeof models.customtools === "string" && models.customtools.trim()
        ? models.customtools
        : Object.values(models).find(
            (value) => typeof value === "string" && value.trim(),
          ) || "";
    return {
      apiBaseUrl,
      modelName,
    };
  };

  const runGeminiApiKeyHealthCheck = async (apiKey: string) => {
    const { apiBaseUrl, modelName } = getDefaultGeminiHealthTarget();
    if (!apiBaseUrl || !modelName) {
      return {
        status: "unknown",
        message: "health target unavailable",
        httpStatus: null,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const baseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
      const response = await fetch(
        `${baseUrl}${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: "ping" }],
              },
            ],
            generationConfig: {
              maxOutputTokens: 4,
              temperature: 0,
            },
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        let message = response.statusText || "health check failed";
        try {
          const payload = await response.json();
          message =
            payload?.error?.message ||
            payload?.message ||
            message;
        } catch {
          // ignore
        }
        return {
          status: "error",
          message,
          httpStatus: response.status,
        };
      }
      return {
        status: "ok",
        message: "generateContent 200",
        httpStatus: response.status,
      };
    } catch (error: any) {
      return {
        status: "error",
        message: error?.name === "AbortError" ? "health check timeout" : error?.message || "network error",
        httpStatus: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  const stableSerialize = (value: unknown): string => {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      return `{${entries
        .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };

  const computeRevision = (payload: Record<string, unknown>) =>
    createHash("sha256").update(stableSerialize(payload)).digest("hex").slice(0, 12);

  const flattenJson = (
    value: unknown,
    prefix = "",
    output: Record<string, string> = {},
  ) => {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        output[prefix || "$"] = "[]";
        return output;
      }
      value.forEach((item, index) => {
        flattenJson(item, prefix ? `${prefix}[${index}]` : `$[${index}]`, output);
      });
      return output;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        output[prefix || "$"] = "{}";
        return output;
      }
      entries.forEach(([key, entryValue]) => {
        flattenJson(entryValue, prefix ? `${prefix}.${key}` : key, output);
      });
      return output;
    }
    output[prefix || "$"] = JSON.stringify(value);
    return output;
  };

  const buildJsonDiff = (before: Record<string, unknown>, after: Record<string, unknown>) => {
    const beforeFlat = flattenJson(before);
    const afterFlat = flattenJson(after);
    const paths = Array.from(
      new Set([...Object.keys(beforeFlat), ...Object.keys(afterFlat)]),
    ).sort();
    const changes: Array<{
      path: string;
      type: "added" | "removed" | "changed";
      before?: string;
      after?: string;
    }> = [];

    for (const path of paths) {
      if (!(path in beforeFlat)) {
        changes.push({ path, type: "added", after: afterFlat[path] });
        continue;
      }
      if (!(path in afterFlat)) {
        changes.push({ path, type: "removed", before: beforeFlat[path] });
        continue;
      }
      if (beforeFlat[path] !== afterFlat[path]) {
        changes.push({
          path,
          type: "changed",
          before: beforeFlat[path],
          after: afterFlat[path],
        });
      }
    }

    const summary = {
      total: changes.length,
      added: changes.filter((item) => item.type === "added").length,
      removed: changes.filter((item) => item.type === "removed").length,
      changed: changes.filter((item) => item.type === "changed").length,
    };

    return {
      hasChanges: changes.length > 0,
      summary,
      changes: changes.slice(0, 100),
    };
  };

  const loadControlPlaneMetadata = () => {
    const metadataPath = getControlPlaneMetadataPath();
    if (!existsSync(metadataPath)) {
      return {
        activeVersion: null,
        snapshots: [] as Array<Record<string, unknown>>,
      };
    }
    return readJsonFile(metadataPath);
  };

  const saveControlPlaneMetadata = (metadata: Record<string, unknown>) => {
    const metadataPath = getControlPlaneMetadataPath();
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
    return metadata;
  };

  const createSnapshotVersion = (revision: string) => {
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `draft-${timestamp}-${revision.slice(0, 6)}`;
  };

  const saveSnapshot = ({
    releaseVersion,
    spec,
    generatedConfig,
    validation,
    publishedBy,
  }: {
    releaseVersion: string;
    spec: Record<string, unknown>;
    generatedConfig: Record<string, unknown>;
    validation: { ok: boolean; message: string };
    publishedBy: string;
  }) => {
    const snapshotsDir = getSnapshotDir();
    const snapshotPath = join(snapshotsDir, `${releaseVersion}.json`);
    const snapshot = {
      releaseVersion,
      draftRevision: computeRevision(spec),
      createdAt: new Date().toISOString(),
      publishedAt: null,
      publishedBy,
      active: false,
      validation,
      spec,
      generatedConfig,
    };
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
    return snapshot;
  };

  const loadSnapshot = (releaseVersion: string) => {
    const snapshotPath = join(getSnapshotDir(), `${releaseVersion}.json`);
    if (!existsSync(snapshotPath)) {
      throw new Error(`snapshot not found: ${releaseVersion}`);
    }
    return readJsonFile(snapshotPath);
  };

  const updateSnapshot = (snapshot: Record<string, unknown>) => {
    const releaseVersion = snapshot.releaseVersion as string;
    const snapshotPath = join(getSnapshotDir(), `${releaseVersion}.json`);
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
    return snapshot;
  };

  const appendAuditEvent = (event: Record<string, unknown>) => {
    const auditPath = getAuditLogPath();
    const record = {
      id: createHash("sha256")
        .update(`${Date.now()}-${Math.random()}-${JSON.stringify(event)}`)
        .digest("hex")
        .slice(0, 12),
      timestamp: new Date().toISOString(),
      ...event,
    };
    writeFileSync(auditPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf-8",
      flag: "a",
    });
    return record;
  };

  const readAuditEvents = ({
    limit = 50,
    type,
    releaseVersion,
    since,
    until,
    draftId,
  }: {
    limit?: number;
    type?: string;
    releaseVersion?: string;
    since?: string;
    until?: string;
    draftId?: string;
  } = {}) => {
    const auditPath = getAuditLogPath();
    if (!existsSync(auditPath)) {
      return [];
    }
    const lines = readFileSync(auditPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const events = lines
      .map((line) => JSON.parse(line))
      .filter((event) => {
        if (type && event.type !== type) {
          return false;
        }
        if (
          releaseVersion &&
          event.releaseVersion !== releaseVersion &&
          event.targetVersion !== releaseVersion &&
          event.sourceVersion !== releaseVersion
        ) {
          return false;
        }
        if (draftId && event.draftId !== draftId) {
          return false;
        }
        if (since && event.timestamp < since) {
          return false;
        }
        if (until && event.timestamp > until) {
          return false;
        }
        return true;
      });

    return events.slice(-limit).reverse();
  };

  const updateMetadataSnapshots = (
    metadata: any,
    updater: (snapshot: any) => any,
  ) => {
    const snapshots = Array.isArray(metadata.snapshots) ? metadata.snapshots : [];
    metadata.snapshots = snapshots.map((snapshot: any) => updater({ ...snapshot }));
    return metadata;
  };

  const getReleaseContext = async (draftId = "default") => {
    const metadata = loadControlPlaneMetadata();
    const draft = loadDraftSpec(draftId);
    const generatedConfig = await runA2GGenerate(draft.spec);
    const validation = await runA2GValidate(draft.spec, generatedConfig);
    const draftRevision = computeRevision(draft.spec);
    const currentConfig = await readConfigFile();
    const specPath = getA2GPaths().specPath;
    const sourceSpec =
      specPath && existsSync(specPath)
        ? (readJsonFile(specPath) as Record<string, unknown>)
        : {};
    const specDiff = buildJsonDiff(sourceSpec, draft.spec);
    const generatedDiff = buildJsonDiff(currentConfig, generatedConfig);
    const impactSummary = buildImpactSummary(specDiff, generatedDiff);

    return {
      draftId,
      draftSource: draft.source,
      draftRevision,
      activeVersion: metadata.activeVersion || null,
      latestSnapshotVersion:
        Array.isArray(metadata.snapshots) && metadata.snapshots.length > 0
          ? (metadata.snapshots[0] as any).releaseVersion || null
          : null,
      publishedAt:
        Array.isArray(metadata.snapshots) && metadata.snapshots.length > 0
          ? (metadata.snapshots[0] as any).publishedAt || null
          : null,
      publishedBy:
        Array.isArray(metadata.snapshots) && metadata.snapshots.length > 0
          ? (metadata.snapshots[0] as any).publishedBy || null
          : null,
      hasUnpublishedChanges: specDiff.hasChanges || generatedDiff.hasChanges,
      validation,
      specDiff,
      generatedDiff,
      impactSummary,
      auditEvents: readAuditEvents({ limit: 20 }),
      snapshots: Array.isArray(metadata.snapshots) ? metadata.snapshots.slice(0, 10) : [],
    };
  };

  const summarizeGeneratedConfig = (generatedConfig: Record<string, any>) => {
    const router = generatedConfig.Router || {};
    const fallback = generatedConfig.fallback || {};
    return {
      providerCount: Array.isArray(generatedConfig.Providers)
        ? generatedConfig.Providers.length
        : 0,
      scenarioCount: Object.keys(router).filter(
        (key) => key !== "longContextThreshold",
      ).length,
      fallbackScenarioCount:
        fallback && typeof fallback === "object" ? Object.keys(fallback).length : 0,
    };
  };

  const runA2GScript = async (scriptPath: string, args: string[]) => {
    const { pythonBin, pythonPath } = getA2GPaths();
    return execFileAsync(pythonBin, [scriptPath, ...args], {
      env: {
        ...process.env,
        ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
      },
    });
  };

  const formatA2GScriptError = (error: any) => {
    const rawMessage =
      error?.stderr || error?.stdout || error?.message || "unknown error";
    try {
      const parsed = JSON.parse(rawMessage);
      if (parsed && typeof parsed === "object" && parsed.error && parsed.message) {
        return {
          statusCode: 400,
          error: parsed.error,
          message: parsed.message,
          details: rawMessage,
          fieldErrors: Array.isArray(parsed.fieldErrors) ? parsed.fieldErrors : [],
        };
      }
    } catch {
      // ignore JSON parse errors and continue
    }
    const missingFieldMatch = /KeyError: '([^']+)'/.exec(rawMessage);
    if (missingFieldMatch) {
      return {
        statusCode: 400,
        error: "Invalid draft payload",
        message: `Missing required field: ${missingFieldMatch[1]}`,
        details: rawMessage,
        fieldErrors: [],
      };
    }
    const valueErrorMatch = /ValueError\((?:[^)]*)\):?(.+)|ValueError:\s+(.+)/s.exec(
      rawMessage,
    );
    if (valueErrorMatch) {
      return {
        statusCode: 400,
        error: "Invalid draft payload",
        message: (valueErrorMatch[1] || valueErrorMatch[2] || rawMessage).trim(),
        details: rawMessage,
        fieldErrors: [],
      };
    }
    return {
      statusCode: 500,
      error: "A2G script execution failed",
      message: rawMessage,
      details: rawMessage,
      fieldErrors: [],
    };
  };

  const runA2GGenerate = async (spec: Record<string, unknown>) => {
    const { generatorPath, tmpDir } = getA2GPaths();
    if (!generatorPath || !existsSync(generatorPath)) {
      throw new Error("A2G generator script is not available");
    }
    ensureA2GDir(tmpDir);
    const runDir = join(
      tmpDir,
      `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    );
    ensureA2GDir(runDir);
    const specFile = join(runDir, "draft.spec.json");
    const outputFile = join(runDir, "generated.config.json");
    try {
      writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`, "utf-8");
      await runA2GScript(generatorPath, [
        "--spec",
        specFile,
        "--output",
        outputFile,
      ]);
      return readJsonFile(outputFile);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  };

  const runA2GValidate = async (
    spec: Record<string, unknown>,
    generatedConfigOverride?: Record<string, unknown>,
  ) => {
    const { validatorPath, tmpDir } = getA2GPaths();
    if (!validatorPath || !existsSync(validatorPath)) {
      throw new Error("A2G validator script is not available");
    }
    ensureA2GDir(tmpDir);
    const runDir = join(
      tmpDir,
      `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    );
    ensureA2GDir(runDir);
    const specFile = join(runDir, "draft.spec.json");
    const generatedConfigFile = join(runDir, "generated.config.json");
    const generatedConfig =
      generatedConfigOverride || (await runA2GGenerate(spec));
    try {
      writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`, "utf-8");
      writeFileSync(
        generatedConfigFile,
        `${JSON.stringify(generatedConfig, null, 2)}\n`,
        "utf-8",
      );
      await runA2GScript(validatorPath, [
        "--spec",
        specFile,
        "--config",
        generatedConfigFile,
      ]);
      const currentConfig = await readConfigFile();
      const inSyncWithRepoConfig =
        stableSerialize(currentConfig) === stableSerialize(generatedConfig);
      return {
        ok: true,
        inSyncWithRepoConfig,
        message: inSyncWithRepoConfig
          ? "router config is in sync"
          : "candidate config is valid but differs from current runtime config",
        fieldErrors: [] as Array<Record<string, string>>,
      };
    } catch (error: any) {
      const formatted = formatA2GScriptError(error);
      return {
        ok: false,
        inSyncWithRepoConfig: false,
        message: formatted.message,
        fieldErrors: formatted.fieldErrors || [],
      };
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  };

  app.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB
    },
  });

  app.post("/v1/messages/count_tokens", async (req: any, reply: any) => {
    const {messages, tools, system, model} = req.body;
    const tokenizerService = (app as any)._server!.tokenizerService as TokenizerService;

    // If model is specified in "providerName,modelName" format, use the configured tokenizer
    if (model && model.includes(",") && tokenizerService) {
      try {
        const [provider, modelName] = model.split(",");
        req.log?.info(`Looking up tokenizer for provider: ${provider}, model: ${modelName}`);

        const tokenizerConfig = tokenizerService.getTokenizerConfigForModel(provider, modelName);

        if (!tokenizerConfig) {
          req.log?.warn(`No tokenizer config found for ${provider},${modelName}, using default tiktoken`);
        } else {
          req.log?.info(`Using tokenizer config: ${JSON.stringify(tokenizerConfig)}`);
        }

        const result = await tokenizerService.countTokens(
          { messages, system, tools },
          tokenizerConfig
        );

        return {
          "input_tokens": result.tokenCount,
          "tokenizer": result.tokenizerUsed,
        };
      } catch (error: any) {
        req.log?.error(`Error using configured tokenizer: ${error.message}`);
        req.log?.error(error.stack);
        // Fall back to default calculation
      }
    } else {
      if (!model) {
        req.log?.info(`No model specified, using default tiktoken`);
      } else if (!model.includes(",")) {
        req.log?.info(`Model "${model}" does not contain comma, using default tiktoken`);
      } else if (!tokenizerService) {
        req.log?.warn(`TokenizerService not available, using default tiktoken`);
      }
    }

    // Default to tiktoken calculation
    const tokenCount = calculateTokenCount(messages, system, tools);
    return { "input_tokens": tokenCount }
  });

  // Add endpoint to read config.json with access control
  app.get("/api/config", async (req: any, reply: any) => {
    return await readConfigFile();
  });

  app.get("/api/transformers", async (req: any, reply: any) => {
    const transformers =
      (app as any)._server!.transformerService.getAllTransformers();
    const transformerList = Array.from(transformers.entries()).map(
      ([name, transformer]: any) => ({
        name,
        endpoint: transformer.endPoint || null,
      })
    );
    return { transformers: transformerList };
  });

  // Add endpoint to save config.json with access control
  app.post("/api/config", async (req: any, reply: any) => {
    const newConfig = req.body;

    // Backup existing config file if it exists
    const backupPath = await backupConfigFile();
    if (backupPath) {
      console.log(`Backed up existing configuration file to ${backupPath}`);
    }

    await writeConfigFile(newConfig);
    return { success: true, message: "Config saved successfully" };
  });

  app.get("/api/a2g/control-plane", async (_req: any, reply: any) => {
    try {
      const config = await readConfigFile();
      const {
        specPath,
        generatorPath,
        validatorPath,
        generatedConfigPath,
        sourceOfTruth,
      } = getA2GPaths();

      const poolResponse = await app.inject({
        method: "GET",
        url: "/health/pool",
        headers: {
          "x-api-key": resolveAdminApiKey(config.APIKEY),
        },
      });

      const poolData = poolResponse.statusCode === 200
        ? JSON.parse(poolResponse.payload || "{}")
        : {
            status: "unavailable",
            stats: {},
            overview: {},
            recentEvents: [],
            pool: [],
            failures: [],
          };

      let specSummary: any = null;
      if (specPath && existsSync(specPath)) {
        const spec = JSON.parse(readFileSync(specPath, "utf-8"));
        specSummary = {
          providerDiscoveryEnabled: !!spec.provider_discovery?.enabled,
          providerDiscoveryPrefix: spec.provider_discovery?.env_prefix || null,
          declaredProviderCount: Array.isArray(spec.providers) ? spec.providers.length : 0,
          modelTierCount:
            spec.models && typeof spec.models === "object" ? Object.keys(spec.models).length : 0,
          scenarioCount:
            spec.router?.scenarios && typeof spec.router.scenarios === "object"
              ? Object.keys(spec.router.scenarios).length
              : 0,
          scenarios:
            spec.router?.scenarios && typeof spec.router.scenarios === "object"
              ? Object.keys(spec.router.scenarios)
              : [],
        };
      }

      const routerTargets = config.Router
        ? [
            config.Router.default,
            config.Router.background,
            config.Router.think,
            config.Router.longContext,
            config.Router.webSearch,
            config.Router.image,
          ].filter(Boolean)
        : [];

      const releaseContext = await getReleaseContext("default");
      const authProfilesStore = loadAuthProfilesStore();
      const authProfiles = Array.isArray(authProfilesStore.profiles)
        ? authProfilesStore.profiles
        : [];

      return {
        status: "ok",
        mode: "a2g_control_plane_preview",
        sourceOfTruth,
        runtime: {
          host: config.HOST || "127.0.0.1",
          port: config.PORT || 3456,
          providerCount: Array.isArray(config.Providers) ? config.Providers.length : 0,
          transformerCount: Array.isArray(config.transformers) ? config.transformers.length : 0,
          routeCount: routerTargets.length,
          routerTargets,
        },
        specSummary,
        paths: [
          { label: "config.spec.json", path: specPath, exists: !!specPath && existsSync(specPath) },
          { label: "generate_config.py", path: generatorPath, exists: !!generatorPath && existsSync(generatorPath) },
          { label: "validate_config.py", path: validatorPath, exists: !!validatorPath && existsSync(validatorPath) },
          { label: "config.json", path: generatedConfigPath, exists: !!generatedConfigPath && existsSync(generatedConfigPath) },
        ],
        poolSummary: {
          status: poolData.status || "unknown",
          coolingRouteCount: Array.isArray(poolData.pool) ? poolData.pool.length : 0,
          routesWithRecentFailures: Array.isArray(poolData.failures) ? poolData.failures.length : 0,
          activeScenarios: poolData.overview?.activeScenarios || 0,
          stats: poolData.stats || {},
          overview: poolData.overview || {},
          recentEvents: Array.isArray(poolData.recentEvents) ? poolData.recentEvents.slice(0, 5) : [],
        },
        releaseSummary: {
          draftRevision: releaseContext.draftRevision,
          activeVersion: releaseContext.activeVersion,
          latestSnapshotVersion: releaseContext.latestSnapshotVersion,
          hasUnpublishedChanges: releaseContext.hasUnpublishedChanges,
          snapshotCount: Array.isArray(releaseContext.snapshots)
            ? releaseContext.snapshots.length
            : 0,
          auditCount: Array.isArray(releaseContext.auditEvents)
            ? releaseContext.auditEvents.length
            : 0,
          validation: releaseContext.validation,
        },
        authProfileSummary: {
          count: authProfiles.length,
          source: "file_auth_profile_store_preview",
        },
        notes: [
          "Control plane supports draft editing, generate/validate, publish, rollback, and audit preview.",
          "Source of truth remains config.spec.json -> generate -> config.json -> Git.",
          "UI publish writes the generated config and records release metadata plus audit events.",
          "Current prototype still stops short of full release governance such as approvals and rollback policies.",
        ],
      };
    } catch (error: any) {
      reply.status(500).send({
        error: "Failed to build A2G control plane payload",
        message: error?.message || "unknown error",
      });
    }
  });

  app.get("/api/a2g/draft", async (req: any, reply: any) => {
    try {
      const draftId = ((req.query as any)?.draftId as string) || "default";
      return {
        ok: true,
        ...loadDraftSpec(draftId),
      };
    } catch (error: any) {
      reply.status(500).send({
        error: "Failed to load A2G draft",
        message: error?.message || "unknown error",
      });
    }
  });

  app.post("/api/a2g/draft", async (req: any, reply: any) => {
    try {
      const draftId = req.body?.draftId || "default";
      const spec = req.body?.spec;
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        reply.status(400).send({
          error: "Invalid draft payload",
          message: "spec must be a JSON object",
        });
        return;
      }
      saveDraftSpec(draftId, spec);
      appendAuditEvent({
        type: "draft_saved",
        draftId,
        draftRevision: computeRevision(spec),
      });
      return {
        ok: true,
        draftId,
        source: "draft",
        spec,
      };
    } catch (error: any) {
      reply.status(500).send({
        error: "Failed to save A2G draft",
        message: error?.message || "unknown error",
      });
    }
  });

  app.delete("/api/a2g/draft", async (req: any, reply: any) => {
    try {
      const draftId = req.body?.draftId || "default";
      const draftPath = getDraftFilePath(draftId);
      if (existsSync(draftPath)) {
        unlinkSync(draftPath);
      }
      return {
        ok: true,
        draftId,
      };
    } catch (error: any) {
      reply.status(500).send({
        error: "Failed to reset A2G draft",
        message: error?.message || "unknown error",
      });
    }
  });

  app.post("/api/a2g/generate", async (req: any, reply: any) => {
    try {
      const draftId = req.body?.draftId || "default";
      const spec =
        req.body?.spec && typeof req.body.spec === "object" && !Array.isArray(req.body.spec)
          ? req.body.spec
          : loadDraftSpec(draftId).spec;
      const generatedConfig = await runA2GGenerate(spec);
      return {
        ok: true,
        generatedConfig,
        summary: summarizeGeneratedConfig(generatedConfig),
      };
    } catch (error: any) {
      const formatted = formatA2GScriptError(error);
      reply.status(formatted.statusCode).send({
        error: "Failed to generate candidate config",
        message: formatted.message,
        details: formatted.details,
        fieldErrors: formatted.fieldErrors || [],
      });
    }
  });

  app.post("/api/a2g/validate", async (req: any, reply: any) => {
    try {
      const draftId = req.body?.draftId || "default";
      const spec =
        req.body?.spec && typeof req.body.spec === "object" && !Array.isArray(req.body.spec)
          ? req.body.spec
          : loadDraftSpec(draftId).spec;
      const generatedConfig = await runA2GGenerate(spec);
      const validation = await runA2GValidate(spec, generatedConfig);
      if (!validation.ok) {
        appendAuditEvent({
          type: "validate_failed",
          draftId,
          draftRevision: computeRevision(spec),
          validationOk: false,
          message: validation.message,
        });
      }
      return {
        ok: validation.ok,
        inSyncWithRepoConfig: validation.inSyncWithRepoConfig,
        message: validation.message,
        generatedConfig,
        summary: summarizeGeneratedConfig(generatedConfig),
        fieldErrors: validation.fieldErrors || [],
      };
    } catch (error: any) {
      const formatted = formatA2GScriptError(error);
      reply.status(formatted.statusCode).send({
        error: "Failed to validate candidate config",
        message: formatted.message,
        details: formatted.details,
        fieldErrors: formatted.fieldErrors || [],
      });
    }
  });

  app.get("/api/a2g/release-context", async (req: any, reply: any) => {
    try {
      const draftId = ((req.query as any)?.draftId as string) || "default";
      return {
        ok: true,
        ...(await getReleaseContext(draftId)),
      };
    } catch (error: any) {
      reply.status(500).send({
        error: "Failed to load release context",
        message: error?.message || "unknown error",
      });
    }
  });

  app.get("/api/a2g/diff", async (req: any, reply: any) => {
    try {
      const draftId = ((req.query as any)?.draftId as string) || "default";
      const releaseContext = await getReleaseContext(draftId);
      return {
        ok: true,
        draftId,
        draftRevision: releaseContext.draftRevision,
        hasUnpublishedChanges: releaseContext.hasUnpublishedChanges,
        specDiff: releaseContext.specDiff,
        generatedDiff: releaseContext.generatedDiff,
        impactSummary: releaseContext.impactSummary,
      };
    } catch (error: any) {
      reply.status(500).send({
        error: "Failed to build diff preview",
        message: error?.message || "unknown error",
      });
    }
  });

  app.post("/api/a2g/snapshots", async (req: any, reply: any) => {
    try {
      const draftId = req.body?.draftId || "default";
      const publishedBy = req.body?.publishedBy || "ui-preview";
      const draft =
        req.body?.spec && typeof req.body.spec === "object" && !Array.isArray(req.body.spec)
          ? { spec: req.body.spec as Record<string, unknown>, source: "request" }
          : loadDraftSpec(draftId);
      const generatedConfig = await runA2GGenerate(draft.spec);
      const validation = await runA2GValidate(draft.spec, generatedConfig);
      const releaseVersion = createSnapshotVersion(computeRevision(draft.spec));
      const snapshot = saveSnapshot({
        releaseVersion,
        spec: draft.spec,
        generatedConfig,
        validation,
        publishedBy,
      });

      const metadata = loadControlPlaneMetadata();
      const existingSnapshots = Array.isArray(metadata.snapshots)
        ? metadata.snapshots.filter(
            (item: any) => item?.releaseVersion !== snapshot.releaseVersion,
          )
        : [];
      metadata.snapshots = [
        {
          releaseVersion: snapshot.releaseVersion,
          draftRevision: snapshot.draftRevision,
          createdAt: snapshot.createdAt,
          publishedAt: snapshot.publishedAt,
          publishedBy: snapshot.publishedBy,
          active: snapshot.active,
          validation: snapshot.validation,
        },
        ...existingSnapshots,
      ];
      if (!("activeVersion" in metadata)) {
        metadata.activeVersion = null;
      }
      saveControlPlaneMetadata(metadata);
      appendAuditEvent({
        type: "snapshot_created",
        releaseVersion: snapshot.releaseVersion,
        draftRevision: snapshot.draftRevision,
        publishedBy,
        validationOk: snapshot.validation.ok,
      });

      return {
        ok: true,
        snapshot: metadata.snapshots[0],
      };
    } catch (error: any) {
      const formatted = formatA2GScriptError(error);
      reply.status(formatted.statusCode).send({
        error: "Failed to create snapshot",
        message: formatted.message,
        details: formatted.details,
      });
    }
  });

  app.post("/api/a2g/publish", async (req: any, reply: any) => {
    const draftId = req.body?.draftId || "default";
    const publishedBy = req.body?.publishedBy || "ui-publish";
    const metadataBefore = loadControlPlaneMetadata();
    const currentConfig = await readConfigFile();
    const previousActiveVersion = metadataBefore.activeVersion || null;
    try {
      const draft =
        req.body?.spec && typeof req.body.spec === "object" && !Array.isArray(req.body.spec)
          ? { spec: req.body.spec as Record<string, unknown>, source: "request" }
          : loadDraftSpec(draftId);
      const generatedConfig = await runA2GGenerate(draft.spec);
      const validation = await runA2GValidate(draft.spec, generatedConfig);
      if (!validation.ok) {
        reply.status(400).send({
          error: "Publish blocked by validation",
          message: validation.message,
          fieldErrors: validation.fieldErrors || [],
        });
        return;
      }

      const releaseVersion = createSnapshotVersion(computeRevision(draft.spec));
      const snapshot = saveSnapshot({
        releaseVersion,
        spec: draft.spec,
        generatedConfig,
        validation,
        publishedBy,
      });

      await backupConfigFile();
      try {
        await writeConfigFile(generatedConfig);
        const metadata = loadControlPlaneMetadata();
        updateMetadataSnapshots(metadata, (item) => ({
          ...item,
          active: item.releaseVersion === releaseVersion,
          publishedAt:
            item.releaseVersion === releaseVersion
              ? new Date().toISOString()
              : item.publishedAt || null,
          publishedBy:
            item.releaseVersion === releaseVersion
              ? publishedBy
              : item.publishedBy || null,
        }));
        const existing = Array.isArray(metadata.snapshots)
          ? metadata.snapshots.filter((item: any) => item?.releaseVersion !== snapshot.releaseVersion)
          : [];
        metadata.snapshots = [
          {
            releaseVersion: snapshot.releaseVersion,
            draftRevision: snapshot.draftRevision,
            createdAt: snapshot.createdAt,
            publishedAt: new Date().toISOString(),
            publishedBy,
            active: true,
            validation: snapshot.validation,
          },
          ...existing.map((item: any) => ({ ...item, active: false })),
        ];
        metadata.activeVersion = releaseVersion;
        saveControlPlaneMetadata(metadata);
        updateSnapshot({
          ...snapshot,
          active: true,
          publishedAt: new Date().toISOString(),
          publishedBy,
        });
        appendAuditEvent({
          type: "publish",
          draftId,
          releaseVersion,
          sourceVersion: previousActiveVersion,
          targetVersion: releaseVersion,
          draftRevision: snapshot.draftRevision,
          publishedBy,
        });
      } catch (error) {
        await writeConfigFile(currentConfig);
        saveControlPlaneMetadata(metadataBefore);
        throw error;
      }

      return {
        ok: true,
        activeVersion: releaseVersion,
        restartRequired: true,
      };
    } catch (error: any) {
      const formatted = formatA2GScriptError(error);
      reply.status(formatted.statusCode).send({
        error: "Failed to publish draft",
        message: formatted.message,
        details: formatted.details,
        fieldErrors: formatted.fieldErrors || [],
      });
    }
  });

  app.post("/api/a2g/rollback", async (req: any, reply: any) => {
    const releaseVersion = req.body?.releaseVersion;
    const publishedBy = req.body?.publishedBy || "ui-rollback";
    if (!releaseVersion || typeof releaseVersion !== "string") {
      reply.status(400).send({
        error: "Invalid rollback request",
        message: "releaseVersion is required",
      });
      return;
    }

    const metadataBefore = loadControlPlaneMetadata();
    const currentConfig = await readConfigFile();
    const previousActiveVersion = metadataBefore.activeVersion || null;
    try {
      const snapshot = loadSnapshot(releaseVersion);
      await backupConfigFile();
      try {
        await writeConfigFile(snapshot.generatedConfig);
        const metadata = loadControlPlaneMetadata();
        updateMetadataSnapshots(metadata, (item) => ({
          ...item,
          active: item.releaseVersion === releaseVersion,
        }));
        metadata.activeVersion = releaseVersion;
        saveControlPlaneMetadata(metadata);
        updateSnapshot({
          ...snapshot,
          active: true,
          publishedAt: snapshot.publishedAt || new Date().toISOString(),
          publishedBy,
        });
        appendAuditEvent({
          type: "rollback",
          releaseVersion,
          sourceVersion: previousActiveVersion,
          targetVersion: releaseVersion,
          publishedBy,
        });
      } catch (error) {
        await writeConfigFile(currentConfig);
        saveControlPlaneMetadata(metadataBefore);
        throw error;
      }

      return {
        ok: true,
        activeVersion: releaseVersion,
      };
    } catch (error: any) {
      reply.status(500).send({
        error: "Failed to rollback snapshot",
        message: error?.message || "unknown error",
      });
    }
  });

  app.get("/api/a2g/audit", async (req: any, reply: any) => {
    try {
      const limit = Number((req.query as any)?.limit || 50);
      const type = (req.query as any)?.type;
      const releaseVersion = (req.query as any)?.releaseVersion;
      const since = (req.query as any)?.since;
      const until = (req.query as any)?.until;
      const draftId = (req.query as any)?.draftId;
      return {
        ok: true,
        events: readAuditEvents({
          limit: Number.isFinite(limit) ? limit : 50,
          type: typeof type === "string" && type ? type : undefined,
          releaseVersion:
            typeof releaseVersion === "string" && releaseVersion
              ? releaseVersion
              : undefined,
          since: typeof since === "string" && since ? since : undefined,
          until: typeof until === "string" && until ? until : undefined,
          draftId: typeof draftId === "string" && draftId ? draftId : undefined,
        }),
      };
    } catch (error: any) {
      reply.status(500).send({
        error: "Failed to load audit events",
        message: error?.message || "unknown error",
      });
    }
  });

  app.get("/api/a2g/auth-profiles", async (_req: any, reply: any) => {
    try {
      const store = loadAuthProfilesStore();
      const profiles = buildAuthProfileViewList(store);
      return {
        ok: true,
        source: "file_auth_profile_store_preview",
        count: profiles.length,
        profiles,
      };
    } catch (error: any) {
      reply.status(500).send({
        error: "Failed to load auth profiles",
        message: error?.message || "unknown error",
      });
    }
  });

  app.post("/api/a2g/auth-profiles/api-key", async (req: any, reply: any) => {
    try {
      const payload = req.body;
      const fieldErrors = validateApiKeyOnboarding(payload);
      if (fieldErrors.length > 0) {
        reply.status(400).send({
          error: "Invalid auth profile payload",
          message: fieldErrors[0]?.message || "invalid payload",
          fieldErrors,
        });
        return;
      }

      const store = loadAuthProfilesStore();
      const profiles = Array.isArray(store.profiles) ? store.profiles : [];
      const requestedSlot = Number.isFinite(Number(payload.slot)) ? Number(payload.slot) : null;
      const usedSlots = new Set(
        profiles
          .map((profile: any) => Number(profile.slot))
          .filter((slot: number) => Number.isFinite(slot) && slot > 0),
      );
      const nextFreeSlot = requestedSlot && requestedSlot > 0
        ? requestedSlot
        : (() => {
            let slot = 1;
            while (usedSlots.has(slot)) {
              slot += 1;
            }
            return slot;
          })();

      if (usedSlots.has(nextFreeSlot)) {
        reply.status(400).send({
          error: "Invalid auth profile payload",
          message: `slot ${nextFreeSlot} is already bound to another auth profile`,
          fieldErrors: [
            {
              path: "slot",
              code: "duplicate",
              message: `slot ${nextFreeSlot} is already in use`,
              hint: "Choose a free pool slot or rotate the existing profile.",
            },
          ],
        });
        return;
      }

      const normalizedProvider = normalizeProviderName(payload.provider);
      const secretRef = buildApiKeySecretRef(payload.apiKey, nextFreeSlot, normalizedProvider);
      writeSecretRefFile(secretRef, payload.apiKey);

      const now = new Date().toISOString();
      const shouldTest = payload.test !== false;
      const health = shouldTest
        ? await runGeminiApiKeyHealthCheck(payload.apiKey)
        : { status: "unknown", message: "health check skipped", httpStatus: null };

      const profile = {
        id: createOpaqueId("auth"),
        provider: normalizedProvider,
        type: "api_key",
        displayName: payload.displayName.trim(),
        status: health.status === "ok" ? "active" : "created",
        secretRefId: secretRef.id,
        slot: nextFreeSlot,
        enabled: payload.enabled !== false,
        health,
        lastHealthCheckAt: shouldTest ? now : null,
        createdAt: now,
        updatedAt: now,
      };

      saveAuthProfilesStore({
        ...store,
        profiles: [profile, ...profiles],
        secretRefs: [secretRef, ...(Array.isArray(store.secretRefs) ? store.secretRefs : [])],
      });
      appendAuditEvent({
        type: "auth_profile_created",
        authProfileId: profile.id,
        provider: normalizedProvider,
        message: `created ${profile.displayName} on slot ${nextFreeSlot}`,
      });

      return {
        ok: true,
        profile: toAuthProfileView(profile, secretRef),
        restartRequired: true,
      };
    } catch (error: any) {
      reply.status(500).send({
        error: "Failed to create auth profile",
        message: error?.message || "unknown error",
      });
    }
  });

  app.post("/api/a2g/auth-profiles/:id/test", async (req: any, reply: any) => {
    try {
      const profileId = req.params?.id;
      const store = loadAuthProfilesStore();
      const profiles = Array.isArray(store.profiles) ? store.profiles : [];
      const profile = profiles.find((item: any) => item?.id === profileId);
      if (!profile) {
        reply.status(404).send({
          error: "Auth profile not found",
          message: `unknown auth profile: ${profileId}`,
        });
        return;
      }
      const secretRef = getSecretRefById(store, profile.secretRefId);
      if (!secretRef) {
        reply.status(404).send({
          error: "Secret reference not found",
          message: `missing secret reference for ${profileId}`,
        });
        return;
      }
      const apiKey = readSecretRefValue(secretRef);
      const health = await runGeminiApiKeyHealthCheck(apiKey);
      const now = new Date().toISOString();
      const updatedProfile = {
        ...profile,
        status: health.status === "ok" ? "active" : "failed",
        health,
        lastHealthCheckAt: now,
        updatedAt: now,
      };
      saveAuthProfilesStore({
        ...store,
        profiles: profiles.map((item: any) => (item?.id === profileId ? updatedProfile : item)),
        secretRefs: store.secretRefs,
      });
      appendAuditEvent({
        type: "auth_profile_tested",
        authProfileId: profileId,
        provider: updatedProfile.provider,
        validationOk: health.status === "ok",
        message: health.message,
      });
      return {
        ok: true,
        profile: toAuthProfileView(updatedProfile, secretRef),
      };
    } catch (error: any) {
      reply.status(500).send({
        error: "Failed to test auth profile",
        message: error?.message || "unknown error",
      });
    }
  });

  // Register static file serving with caching
  app.register(fastifyStatic, {
    root: join(__dirname, "..", "dist"),
    prefix: "/ui/",
    maxAge: "1h",
  });

  // Redirect /ui to /ui/ for proper static file serving
  app.get("/ui", async (_: any, reply: any) => {
    return reply.redirect("/ui/");
  });

  // Get log file list endpoint
  app.get("/api/logs/files", async (req: any, reply: any) => {
    try {
      const logDir = join(homedir(), ".claude-code-router", "logs");
      const logFiles: Array<{ name: string; path: string; size: number; lastModified: string }> = [];

      if (existsSync(logDir)) {
        const files = readdirSync(logDir);

        for (const file of files) {
          if (file.endsWith('.log')) {
            const filePath = join(logDir, file);
            const stats = statSync(filePath);

            logFiles.push({
              name: file,
              path: filePath,
              size: stats.size,
              lastModified: stats.mtime.toISOString()
            });
          }
        }

        // Sort by modification time in descending order
        logFiles.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      }

      return logFiles;
    } catch (error) {
      console.error("Failed to get log files:", error);
      reply.status(500).send({ error: "Failed to get log files" });
    }
  });

  // Get log content endpoint
  app.get("/api/logs", async (req: any, reply: any) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        // If file path is specified, use the specified path
        logFilePath = filePath;
      } else {
        // If file path is not specified, use default log file path
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (!existsSync(logFilePath)) {
        return [];
      }

      const logContent = readFileSync(logFilePath, 'utf8');
      const logLines = logContent.split('\n').filter(line => line.trim())

      return logLines;
    } catch (error) {
      console.error("Failed to get logs:", error);
      reply.status(500).send({ error: "Failed to get logs" });
    }
  });

  // Clear log content endpoint
  app.delete("/api/logs", async (req: any, reply: any) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        // If file path is specified, use the specified path
        logFilePath = filePath;
      } else {
        // If file path is not specified, use default log file path
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (existsSync(logFilePath)) {
        writeFileSync(logFilePath, '', 'utf8');
      }

      return { success: true, message: "Logs cleared successfully" };
    } catch (error) {
      console.error("Failed to clear logs:", error);
      reply.status(500).send({ error: "Failed to clear logs" });
    }
  });

  // Get presets list
  app.get("/api/presets", async (req: any, reply: any) => {
    try {
      const presetsDir = join(HOME_DIR, "presets");

      if (!existsSync(presetsDir)) {
        return { presets: [] };
      }

      const entries = readdirSync(presetsDir, { withFileTypes: true });
      const presetDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);

      const presets: Array<PresetMetadata & { installed: boolean; id: string }> = [];

      for (const dirName of presetDirs) {
        const presetDir = join(presetsDir, dirName);
        try {
          const manifestPath = join(presetDir, "manifest.json");
          const content = readFileSync(manifestPath, 'utf-8');
          const manifest = JSON.parse(content);

          // Extract metadata fields
          const { Providers, Router, PORT, HOST, API_TIMEOUT_MS, PROXY_URL, LOG, LOG_LEVEL, StatusLine, NON_INTERACTIVE_MODE, ...metadata } = manifest;

          presets.push({
            id: dirName,  // Use directory name as unique identifier
            name: metadata.name || dirName,
            version: metadata.version || '1.0.0',
            description: metadata.description,
            author: metadata.author,
            homepage: metadata.homepage,
            repository: metadata.repository,
            license: metadata.license,
            keywords: metadata.keywords,
            ccrVersion: metadata.ccrVersion,
            source: metadata.source,
            sourceType: metadata.sourceType,
            checksum: metadata.checksum,
            installed: true,
          });
        } catch (error) {
          console.error(`Failed to read preset ${dirName}:`, error);
        }
      }

      return { presets };
    } catch (error) {
      console.error("Failed to get presets:", error);
      reply.status(500).send({ error: "Failed to get presets" });
    }
  });

  // Get preset details
  app.get("/api/presets/:name", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      const manifest = await readManifestFromDir(presetDir);
      const presetFile = manifestToPresetFile(manifest);

      // Return preset info, config uses the applied userValues configuration
      return {
        ...presetFile,
        config: loadConfigFromManifest(manifest, presetDir),
        userValues: manifest.userValues || {},
      };
    } catch (error: any) {
      console.error("Failed to get preset:", error);
      reply.status(500).send({ error: error.message || "Failed to get preset" });
    }
  });

  // Apply preset (configure sensitive information)
  app.post("/api/presets/:name/apply", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const { secrets } = req.body;

      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      // Read existing manifest
      const manifest = await readManifestFromDir(presetDir);

      // Save user input to userValues (keep original config unchanged)
      const updatedManifest: ManifestFile = { ...manifest };

      // Save or update userValues
      if (secrets && Object.keys(secrets).length > 0) {
        updatedManifest.userValues = {
          ...updatedManifest.userValues,
          ...secrets,
        };
      }

      // Save updated manifest
      await saveManifest(name, updatedManifest);

      return { success: true, message: "Preset applied successfully" };
    } catch (error: any) {
      console.error("Failed to apply preset:", error);
      reply.status(500).send({ error: error.message || "Failed to apply preset" });
    }
  });

  // Delete preset
  app.delete("/api/presets/:name", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      // Recursively delete entire directory
      rmSync(presetDir, { recursive: true, force: true });

      return { success: true, message: "Preset deleted successfully" };
    } catch (error: any) {
      console.error("Failed to delete preset:", error);
      reply.status(500).send({ error: error.message || "Failed to delete preset" });
    }
  });

  // Get preset market list
  app.get("/api/presets/market", async (req: any, reply: any) => {
    try {
      // Use market presets function
      const marketPresets = await getMarketPresets();
      return { presets: marketPresets };
    } catch (error: any) {
      console.error("Failed to get market presets:", error);
      reply.status(500).send({ error: error.message || "Failed to get market presets" });
    }
  });

  // Install preset from GitHub repository by preset name
  app.post("/api/presets/install/github", async (req: any, reply: any) => {
    try {
      const { presetName } = req.body;

      if (!presetName) {
        reply.status(400).send({ error: "Preset name is required" });
        return;
      }

      // Check if preset is in the marketplace
      const marketPreset = await findMarketPresetByName(presetName);
      if (!marketPreset) {
        reply.status(400).send({
          error: "Preset not found in marketplace",
          message: `Preset '${presetName}' is not available in the official marketplace. Please check the available presets.`
        });
        return;
      }

      // Get repository from market preset
      if (!marketPreset.repo) {
        reply.status(400).send({
          error: "Invalid preset data",
          message: `Preset '${presetName}' does not have repository information`
        });
        return;
      }

      // Parse GitHub repository URL
      const githubRepoMatch = marketPreset.repo.match(/(?:github\.com[:/]|^)([^/]+)\/([^/\s#]+?)(?:\.git)?$/);
      if (!githubRepoMatch) {
        reply.status(400).send({ error: "Invalid GitHub repository URL" });
        return;
      }

      const [, owner, repoName] = githubRepoMatch;

      // Use preset name from market
      const installedPresetName = marketPreset.name || presetName;

      // Check if already installed BEFORE downloading
      if (await isPresetInstalled(installedPresetName)) {
        reply.status(409).send({
          error: "Preset already installed",
          message: `Preset '${installedPresetName}' is already installed. To update or reconfigure, please delete it first using the delete button.`,
          presetName: installedPresetName
        });
        return;
      }

      // Download GitHub repository ZIP file
      const downloadUrl = `https://github.com/${owner}/${repoName}/archive/refs/heads/main.zip`;
      const tempFile = await downloadPresetToTemp(downloadUrl);

      // Load preset to validate structure
      const preset = await loadPresetFromZip(tempFile);

      // Double-check if already installed (in case of race condition)
      if (await isPresetInstalled(installedPresetName)) {
        unlinkSync(tempFile);
        reply.status(409).send({
          error: "Preset already installed",
          message: `Preset '${installedPresetName}' was installed while downloading. Please try again.`,
          presetName: installedPresetName
        });
        return;
      }

      // Extract to target directory
      const targetDir = getPresetDir(installedPresetName);
      await extractPreset(tempFile, targetDir);

      // Read manifest and add repo information
      const manifest = await readManifestFromDir(targetDir);

      // Add repo information to manifest from market data
      manifest.repository = marketPreset.repo;
      if (marketPreset.url) {
        manifest.source = marketPreset.url;
      }

      // Save updated manifest
      await saveManifest(installedPresetName, manifest);

      // Clean up temp file
      unlinkSync(tempFile);

      return {
        success: true,
        presetName: installedPresetName,
        preset: {
          ...preset.metadata,
          installed: true,
        }
      };
    } catch (error: any) {
      console.error("Failed to install preset from GitHub:", error);
      reply.status(500).send({ error: error.message || "Failed to install preset from GitHub" });
    }
  });

  // Helper function: Load preset from ZIP
  async function loadPresetFromZip(zipFile: string): Promise<PresetFile> {
    const zip = new AdmZip(zipFile);

    // First try to find manifest.json in root directory
    let entry = zip.getEntry('manifest.json');

    // If not in root, try to find in subdirectories (handle GitHub repo archive structure)
    if (!entry) {
      const entries = zip.getEntries();
      // Find any manifest.json file
      entry = entries.find(e => e.entryName.includes('manifest.json')) || null;
    }

    if (!entry) {
      throw new Error('Invalid preset file: manifest.json not found');
    }

    const manifest = JSON.parse(entry.getData().toString('utf-8')) as ManifestFile;
    return manifestToPresetFile(manifest);
  }

  return server;
};
