import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { RegisterProviderRequest, LLMProvider } from "@/types/llm";
import { sendUnifiedRequest } from "@/utils/request";
import { createApiError } from "./middleware";
import { version } from "../../package.json";
import { ConfigService } from "@/services/config";
import { ProviderService } from "@/services/provider";
import { TransformerService } from "@/services/transformer";
import { Transformer } from "@/types/transformer";
import {
  poolManager,
  PoolManagerCooldownReason,
} from "@/utils/poolManager";

// Extend FastifyInstance to include custom services
declare module "fastify" {
  interface FastifyInstance {
    configService: ConfigService;
    providerService: ProviderService;
    transformerService: TransformerService;
  }

  interface FastifyRequest {
    provider?: string;
  }
}

/**
 * Main handler for transformer endpoints
 * Coordinates the entire request processing flow: validate provider, handle request transformers,
 * send request, handle response transformers, format response
 */
function shouldAttemptFallback(error: any) {
  if (!error) return false;
  const statusCode = Number(error.statusCode || error.status || 0);
  return statusCode === 429 || statusCode === 503 || statusCode >= 500;
}

function classifyProviderFailure(statusCode: number, errorText?: string) {
  const normalizedError = String(errorText || "").toLowerCase();
  const isQuotaExhausted =
    normalizedError.includes("resource_exhausted") ||
    normalizedError.includes("quota") ||
    normalizedError.includes("rate limit") ||
    normalizedError.includes("rate_limit") ||
    normalizedError.includes("too many requests");
  const isHighDemand =
    normalizedError.includes("high demand") ||
    normalizedError.includes("currently experiencing high demand") ||
    normalizedError.includes("temporarily overloaded");

  if (statusCode === 429) {
    return {
      code: "provider_retryable_error",
      shouldCooldown: true,
      shouldFallback: true,
      reason: isQuotaExhausted ? ("quota_exhausted" as const) : ("http_429" as const),
    };
  }
  if (isQuotaExhausted) {
    return {
      code: "provider_retryable_error",
      shouldCooldown: true,
      shouldFallback: true,
      reason: "quota_exhausted" as const,
    };
  }
  if (statusCode === 503) {
    return {
      code: "provider_retryable_error",
      shouldCooldown: true,
      shouldFallback: true,
      reason: isHighDemand ? ("high_demand" as const) : ("http_503" as const),
    };
  }
  if (isHighDemand) {
    return {
      code: "provider_retryable_error",
      shouldCooldown: true,
      shouldFallback: true,
      reason: "high_demand" as const,
    };
  }
  if (statusCode >= 500) {
    return {
      code: "provider_retryable_error",
      shouldCooldown: true,
      shouldFallback: true,
      reason: "http_5xx" as const,
    };
  }
  return {
    code: "provider_fail_fast_error",
    shouldCooldown: false,
    shouldFallback: false,
    reason: null,
  };
}

async function handleTransformerEndpoint(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any
) {
  const body = req.body as any;
  const providerName = req.provider!;
  const provider = fastify.providerService.getProvider(providerName);
  const poolManagerConfig = fastify.configService.get<any>("PoolManager");
  const routeKey = `${providerName},${body.model}`;

  // Validate provider exists
  if (!provider) {
    throw createApiError(
      `Provider '${providerName}' not found`,
      404,
      "provider_not_found"
    );
  }

  try {
    if (poolManager.isCooling(routeKey, poolManagerConfig)) {
      const remainingMs = poolManager.getRemainingMs(
        routeKey,
        poolManagerConfig
      );
      req.log.warn(
        {
          routeKey,
          scenarioType: (req as any).scenarioType || "default",
          remainingMs,
        },
        "[PoolManager] primary provider is cooling, falling back"
      );
      throw createApiError(
        `Route ${routeKey} is cooling down for another ${remainingMs}ms`,
        503,
        "provider_response_error"
      );
    }

    // Process request transformer chain
    const { requestBody, config, bypass } = await processRequestTransformers(
      body,
      provider,
      transformer,
      req.headers,
      {
        req,
      }
    );

    // Send request to LLM provider
    const response = await sendRequestToProvider(
      requestBody,
      config,
      provider,
      fastify,
      bypass,
      transformer,
      {
        req,
      }
    );

    // Process response transformer chain
    const finalResponse = await processResponseTransformers(
      requestBody,
      response,
      provider,
      transformer,
      bypass,
      {
        req,
      }
    );

    // Format and return response
    return formatResponse(finalResponse, reply, body);
  } catch (error: any) {
    req.log.warn(
      {
        routeKey,
        scenarioType: (req as any).scenarioType || "default",
        errorCode: error?.code,
        statusCode: error?.statusCode || error?.status,
        message: error?.message,
      },
      "[PoolManager] request failed in primary provider"
    );
    if (shouldAttemptFallback(error)) {
      const fallbackResult = await handleFallback(
        req,
        reply,
        fastify,
        transformer,
        error
      );
      if (fallbackResult) {
        return fallbackResult;
      }
    }
    throw error;
  }
}

/**
 * Handle fallback logic when request fails
 * Tries each fallback model in sequence until one succeeds
 */
async function handleFallback(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any,
  error: any
): Promise<any> {
  const scenarioType = (req as any).scenarioType || 'default';
  const fallbackConfig = fastify.configService.get<any>('fallback');
  const poolManagerConfig = fastify.configService.get<any>("PoolManager");

  if (!fallbackConfig || !fallbackConfig[scenarioType]) {
    req.log.warn(
      { scenarioType, hasFallbackConfig: Boolean(fallbackConfig) },
      "[PoolManager] no fallback configuration for scenario"
    );
    return null;
  }

  const fallbackList = fallbackConfig[scenarioType] as string[];
  if (!Array.isArray(fallbackList) || fallbackList.length === 0) {
    req.log.warn(
      { scenarioType },
      "[PoolManager] fallback list is empty"
    );
    return null;
  }

  req.log.warn(`Request failed for ${(req as any).scenarioType}, trying ${fallbackList.length} fallback models`);

  // Try each fallback model in sequence
  for (const fallbackModel of fallbackList) {
    try {
      req.log.info(`Trying fallback model: ${fallbackModel}`);

      // Update request with fallback model
      const newBody = { ...(req.body as any) };
      const [fallbackProvider, ...fallbackModelName] = fallbackModel.split(',');
      newBody.model = fallbackModelName.join(',');
      const fallbackRouteKey = fallbackModel;

      // Create new request object with updated provider and body
      const newReq = {
        ...req,
        provider: fallbackProvider,
        body: newBody,
      };

      const provider = fastify.providerService.getProvider(fallbackProvider);
      if (!provider) {
        req.log.warn(`Fallback provider '${fallbackProvider}' not found, skipping`);
        continue;
      }

      if (poolManager.isCooling(fallbackRouteKey, poolManagerConfig)) {
        const remainingMs = poolManager.getRemainingMs(
          fallbackRouteKey,
          poolManagerConfig
        );
        req.log.warn(
          {
            fallbackRouteKey,
            fallbackModel,
            remainingMs,
          },
          "[PoolManager] skipping cooling fallback provider"
        );
        continue;
      }

      poolManager.noteFallbackAttempt({
        scenarioType,
        routeKey: fallbackRouteKey,
        rawConfig: poolManagerConfig,
        logger: req.log,
      });

      // Process request transformer chain
      const { requestBody, config, bypass } = await processRequestTransformers(
        newBody,
        provider,
        transformer,
        req.headers,
        { req: newReq }
      );

      // Send request to LLM provider
      const response = await sendRequestToProvider(
        requestBody,
        config,
        provider,
        fastify,
        bypass,
        transformer,
        { req: newReq }
      );

      // Process response transformer chain
      const finalResponse = await processResponseTransformers(
        requestBody,
        response,
        provider,
        transformer,
        bypass,
        { req: newReq }
      );

      poolManager.noteSuccess(fallbackRouteKey, poolManagerConfig, req.log);
      poolManager.noteFallbackSuccess({
        scenarioType,
        routeKey: fallbackRouteKey,
        rawConfig: poolManagerConfig,
        logger: req.log,
      });
      req.log.info(`Fallback model ${fallbackModel} succeeded`);

      // Format and return response
      return formatResponse(finalResponse, reply, newBody);
    } catch (fallbackError: any) {
      req.log.warn(`Fallback model ${fallbackModel} failed: ${fallbackError.message}`);
      continue;
    }
  }

  req.log.error(`All fallback models failed for yichu ${scenarioType}`);
  poolManager.noteFallbackExhausted({
    scenarioType,
    rawConfig: poolManagerConfig,
    logger: req.log,
  });
  return null;
}

/**
 * Process request transformer chain
 * Sequentially execute transformRequestOut, provider transformers, model-specific transformers
 * Returns processed request body, config, and flag indicating whether to skip transformers
 */
async function processRequestTransformers(
  body: any,
  provider: any,
  transformer: any,
  headers: any,
  context: any
) {
  let requestBody = body;
  let config: any = {};
  let bypass = false;

  // Check if transformers should be bypassed (passthrough mode)
  bypass = shouldBypassTransformers(provider, transformer, body);

  if (bypass) {
    if (headers instanceof Headers) {
      headers.delete("content-length");
    } else {
      delete headers["content-length"];
    }
    config.headers = headers;
  }

  // Execute transformer's transformRequestOut method
  if (!bypass && typeof transformer.transformRequestOut === "function") {
    const transformOut = await transformer.transformRequestOut(requestBody);
    if (transformOut.body) {
      requestBody = transformOut.body;
      config = transformOut.config || {};
    } else {
      requestBody = transformOut;
    }
  }

  // Execute provider-level transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of provider.transformer.use) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      const transformIn = await providerTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
      if (transformIn.body) {
        requestBody = transformIn.body;
        config = { ...config, ...transformIn.config };
      } else {
        requestBody = transformIn;
      }
    }
  }

  // Execute model-specific transformers
  if (!bypass && provider.transformer?.[body.model]?.use?.length) {
    for (const modelTransformer of provider.transformer[body.model].use) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      requestBody = await modelTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
    }
  }

  return { requestBody, config, bypass };
}

/**
 * Determine if transformers should be bypassed (passthrough mode)
 * Skip other transformers when provider only uses one transformer and it matches the current one
 */
function shouldBypassTransformers(
  provider: any,
  transformer: any,
  body: any
): boolean {
  return (
    provider.transformer?.use?.length === 1 &&
    provider.transformer.use[0].name === transformer.name &&
    (!provider.transformer?.[body.model]?.use.length ||
      (provider.transformer?.[body.model]?.use.length === 1 &&
        provider.transformer?.[body.model]?.use[0].name === transformer.name))
  );
}

/**
 * Send request to LLM provider
 * Handle authentication, build request config, send request and handle errors
 */
async function sendRequestToProvider(
  requestBody: any,
  config: any,
  provider: any,
  fastify: FastifyInstance,
  bypass: boolean,
  transformer: any,
  context: any
) {
  const url = config.url || new URL(provider.baseUrl);
  const poolManagerConfig = fastify.configService.get<any>("PoolManager");

  // Handle authentication in passthrough mode
  if (bypass && typeof transformer.auth === "function") {
    const auth = await transformer.auth(requestBody, provider);
    if (auth.body) {
      requestBody = auth.body;
      let headers = config.headers || {};
      if (auth.config?.headers) {
        headers = {
          ...headers,
          ...auth.config.headers,
        };
        delete headers.host;
        delete auth.config.headers;
      }
      config = {
        ...config,
        ...auth.config,
        headers,
      };
    } else {
      requestBody = auth;
    }
  }

  // Send HTTP request
  // Prepare headers
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${provider.apiKey}`,
    ...(config?.headers || {}),
  };

  for (const key in requestHeaders) {
    if (requestHeaders[key] === "undefined") {
      delete requestHeaders[key];
    } else if (
      ["authorization", "Authorization"].includes(key) &&
      requestHeaders[key]?.includes("undefined")
    ) {
      delete requestHeaders[key];
    }
  }

  let response: Response;
  try {
    response = await sendUnifiedRequest(
      url,
      requestBody,
      {
        httpsProxy: fastify.configService.getHttpsProxy(),
        ...config,
        headers: JSON.parse(JSON.stringify(requestHeaders)),
      },
      context,
      fastify.log
    );
  } catch (error: any) {
      poolManager.noteRetryableFailure({
        routeKey: `${provider.name},${requestBody.model}`,
        reason: "transport_error",
        details: error?.message,
      rawConfig: poolManagerConfig,
      logger: fastify.log,
    });
      poolManager.markCooldown({
        routeKey: `${provider.name},${requestBody.model}`,
        reason: "transport_error",
        scenarioType: (context?.req as any)?.scenarioType || "default",
        message: error?.message,
      rawConfig: poolManagerConfig,
      logger: fastify.log,
    });
    throw createApiError(
      `Transport error from provider(${provider.name},${requestBody.model}): ${error?.message || error}`,
      503,
      "provider_retryable_error"
    );
  }

  // Handle request errors
  if (!response.ok) {
    const errorText = await response.text();
      const failure = classifyProviderFailure(response.status, errorText);
      if (failure.shouldFallback) {
        poolManager.noteRetryableFailure({
        routeKey: `${provider.name},${requestBody.model}`,
          reason: failure.reason!,
          statusCode: response.status,
          details: errorText,
          rawConfig: poolManagerConfig,
          logger: fastify.log,
        });
      } else {
        poolManager.noteFailFastError({
        routeKey: `${provider.name},${requestBody.model}`,
          statusCode: response.status,
          details: errorText,
          rawConfig: poolManagerConfig,
          logger: fastify.log,
        });
      }
      if (failure.shouldCooldown && failure.reason) {
        poolManager.markCooldown({
        routeKey: `${provider.name},${requestBody.model}`,
          reason: failure.reason,
          scenarioType: (context?.req as any)?.scenarioType || "default",
          statusCode: response.status,
        message: errorText,
        rawConfig: poolManagerConfig,
        logger: fastify.log,
      });
    }
    fastify.log.error(
      `[provider_response_error] Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${errorText}`,
    );
    throw createApiError(
      `Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${errorText}`,
      response.status,
      failure.code
    );
  }

  poolManager.noteSuccess(
    `${provider.name},${requestBody.model}`,
    fastify.configService.get<any>("PoolManager"),
    fastify.log
  );

  return response;
}

/**
 * Process response transformer chain
 * Sequentially execute provider transformers, model-specific transformers, transformer's transformResponseIn
 */
async function processResponseTransformers(
  requestBody: any,
  response: any,
  provider: any,
  transformer: any,
  bypass: boolean,
  context: any
) {
  let finalResponse = response;

  // Execute provider-level response transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of Array.from(
      provider.transformer.use
    ).reverse() as Transformer[]) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await providerTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute model-specific response transformers
  if (!bypass && provider.transformer?.[requestBody.model]?.use?.length) {
    for (const modelTransformer of Array.from(
      provider.transformer[requestBody.model].use
    ).reverse() as Transformer[]) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await modelTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute transformer's transformResponseIn method
  if (!bypass && transformer.transformResponseIn) {
    finalResponse = await transformer.transformResponseIn(
      finalResponse,
      context
    );
  }

  return finalResponse;
}

/**
 * Format and return response
 * Handle HTTP status codes, format streaming and regular responses
 */
function formatResponse(response: any, reply: FastifyReply, body: any) {
  // Set HTTP status code
  if (!response.ok) {
    reply.code(response.status);
  }

  // Handle streaming response
  const isStream = body.stream === true;
  if (isStream) {
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");
    return reply.send(response.body);
  } else {
    // Handle regular JSON response
    return response.json();
  }
}

export const registerApiRoutes = async (
  fastify: FastifyInstance
) => {
  // Health and info endpoints
  fastify.get("/", async () => {
    return { message: "LLMs API", version };
  });

  fastify.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  fastify.get("/health/pool", async () => {
    const poolManagerConfig = fastify.configService.get<any>("PoolManager");
    const summary = poolManager.summary(poolManagerConfig);
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      ...summary,
    };
  });

  fastify.post(
    "/health/pool/cooldown",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            providerName: { type: "string" },
            routeKey: { type: "string" },
            reason: {
              type: "string",
              enum: [
                "http_429",
                "quota_exhausted",
                "http_503",
                "high_demand",
                "http_5xx",
                "transport_error",
                "manual_skip",
              ],
            },
            statusCode: { type: "number" },
            message: { type: "string" },
            cooldownMs: { type: "number" },
          },
          anyOf: [
            { required: ["routeKey"] },
            { required: ["providerName"] }
          ],
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const poolManagerConfig = fastify.configService.get<any>("PoolManager");
      const {
        providerName,
        routeKey,
        reason,
        statusCode,
        message,
        cooldownMs,
      } = (req.body as any) || {};

      const effectiveRouteKey =
        routeKey ||
        (providerName && typeof providerName === "string"
          ? `${providerName},unknown`
          : null);

      if (!effectiveRouteKey) {
        throw createApiError(
          "routeKey or providerName is required",
          400,
          "invalid_request"
        );
      }

      if (providerName && !fastify.providerService.getProvider(providerName)) {
        throw createApiError(
          `Provider '${providerName}' not found`,
          404,
          "provider_not_found"
        );
      }

      poolManager.forceCooldown({
        routeKey: effectiveRouteKey,
        reason: reason as PoolManagerCooldownReason | undefined,
        statusCode,
        message,
        cooldownMs,
        rawConfig: poolManagerConfig,
        logger: req.log,
      });

      reply.code(202);
      return {
        status: "accepted",
        timestamp: new Date().toISOString(),
        routeKey: effectiveRouteKey,
        summary: poolManager.summary(poolManagerConfig),
      };
    }
  );

  fastify.delete(
    "/health/pool",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            providerName: { type: "string" },
            routeKey: { type: "string" },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const poolManagerConfig = fastify.configService.get<any>("PoolManager");
      const providerName = (req.query as any)?.providerName;
      const routeKey = (req.query as any)?.routeKey;
      const effectiveRouteKey = routeKey || providerName;

      if (effectiveRouteKey) {
        poolManager.clearCooldown(
          effectiveRouteKey,
          poolManagerConfig,
          req.log
        );
      } else {
        poolManager.clearAll(poolManagerConfig, req.log);
      }

      reply.code(202);
      return {
        status: "accepted",
        timestamp: new Date().toISOString(),
        routeKey: effectiveRouteKey || null,
        summary: poolManager.summary(poolManagerConfig),
      };
    }
  );

  const transformersWithEndpoint =
    fastify.transformerService.getTransformersWithEndpoint();

  for (const { transformer } of transformersWithEndpoint) {
    if (transformer.endPoint) {
      fastify.post(
        transformer.endPoint,
        async (req: FastifyRequest, reply: FastifyReply) => {
          return handleTransformerEndpoint(req, reply, fastify, transformer);
        }
      );
    }
  }

  fastify.post(
    "/providers",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
          },
          required: ["id", "name", "type", "baseUrl", "apiKey", "models"],
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: RegisterProviderRequest }>,
      reply: FastifyReply
    ) => {
      // Validation
      const { name, baseUrl, apiKey, models } = request.body;

      if (!name?.trim()) {
        throw createApiError(
          "Provider name is required",
          400,
          "invalid_request"
        );
      }

      if (!baseUrl || !isValidUrl(baseUrl)) {
        throw createApiError(
          "Valid base URL is required",
          400,
          "invalid_request"
        );
      }

      if (!apiKey?.trim()) {
        throw createApiError("API key is required", 400, "invalid_request");
      }

      if (!models || !Array.isArray(models) || models.length === 0) {
        throw createApiError(
          "At least one model is required",
          400,
          "invalid_request"
        );
      }

      // Check if provider already exists
      if (fastify.providerService.getProvider(request.body.name)) {
        throw createApiError(
          `Provider with name '${request.body.name}' already exists`,
          400,
          "provider_exists"
        );
      }

      return fastify.providerService.registerProvider(request.body);
    }
  );

  fastify.get("/providers", async () => {
    return fastify.providerService.getProviders();
  });

  fastify.get(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const provider = fastify.providerService.getProvider(
        request.params.id
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.put(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: Partial<LLMProvider>;
      }>,
      reply
    ) => {
      const provider = fastify.providerService.updateProvider(
        request.params.id,
        request.body
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.delete(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const success = fastify.providerService.deleteProvider(
        request.params.id
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return { message: "Provider deleted successfully" };
    }
  );

  fastify.patch(
    "/providers/:id/toggle",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { enabled: boolean };
      }>,
      reply
    ) => {
      const success = fastify.providerService.toggleProvider(
        request.params.id,
        request.body.enabled
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return {
        message: `Provider ${
          request.body.enabled ? "enabled" : "disabled"
        } successfully`,
      };
    }
  );
};

// Helper function
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
