import type {
  A2GControlPlaneData,
  A2GAuditEvent,
  A2GAuthProfile,
  A2GDiffPayload,
  A2GDraftPayload,
  A2GGeneratePayload,
  A2GReleaseContextPayload,
  A2GSnapshotMeta,
  A2GValidatePayload,
  Config,
  Provider,
  Transformer,
} from '@/types';

// 日志聚合响应类型
interface GroupedLogsResponse {
  grouped: boolean;
  groups: { [reqId: string]: Array<{ timestamp: string; level: string; message: string; source?: string; reqId?: string }> };
  summary: {
    totalRequests: number;
    totalLogs: number;
    requests: Array<{
      reqId: string;
      logCount: number;
      firstLog: string;
      lastLog: string;
    }>;
  };
}

// API Client Class for handling requests with baseUrl and apikey authentication
class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private tempApiKey: string | null;

  constructor(baseUrl: string = '/api', apiKey: string = '') {
    this.baseUrl = baseUrl;
    // Load API key from localStorage if available
    this.apiKey = apiKey || localStorage.getItem('apiKey') || '';
    // Load temp API key from URL if available
    this.tempApiKey = new URLSearchParams(window.location.search).get('tempApiKey');
  }

  // Update base URL
  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  // Update API key
  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
    // Save API key to localStorage
    if (apiKey) {
      localStorage.setItem('apiKey', apiKey);
    } else {
      localStorage.removeItem('apiKey');
    }
  }

  // Update temp API key
  setTempApiKey(tempApiKey: string | null) {
    this.tempApiKey = tempApiKey;
  }

  // Create headers with API key authentication
  private createHeaders(contentType: string = 'application/json'): HeadersInit {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Use temp API key if available, otherwise use regular API key
    if (this.tempApiKey) {
      headers['X-Temp-API-Key'] = this.tempApiKey;
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    return headers;
  }

  // Generic fetch wrapper with base URL and authentication
  private async apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const config: RequestInit = {
      ...options,
      headers: {
        ...this.createHeaders(),
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, config);

      // Handle 401 Unauthorized responses
      if (response.status === 401) {
        // Remove API key when it's invalid
        localStorage.removeItem('apiKey');
        // Redirect to login page if not already there
        // For memory router, we need to use the router instance
        // We'll dispatch a custom event that the app can listen to
        window.dispatchEvent(new CustomEvent('unauthorized'));
        // Return a promise that never resolves to prevent further execution
        return new Promise(() => {}) as Promise<T>;
      }

      if (!response.ok) {
        // Try to get detailed error message from response body
        let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          if (errorData.error || errorData.message) {
            errorMessage = errorData.message || errorData.error || errorMessage;
          }
        } catch {
          // If parsing fails, use default error message
        }
        throw new Error(errorMessage);
      }

      if (response.status === 204) {
        return {} as T;
      }

      const text = await response.text();
      return text ? JSON.parse(text) : ({} as T);

    } catch (error) {
      console.error('API request error:', error);
      throw error;
    }
  }

  // GET request
  async get<T>(endpoint: string): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'GET',
    });
  }

  // POST request
  async post<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // PUT request
  async put<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // DELETE request
  async delete<T>(endpoint: string, body?: any): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'DELETE',
      body: JSON.stringify(body || {}),
    });
  }

  // API methods for configuration
  // Get current configuration
  async getConfig(): Promise<Config> {
    return this.get<Config>('/config');
  }

  // Update entire configuration
  async updateConfig(config: Config): Promise<Config> {
    return this.post<Config>('/config', config);
  }

  // Get providers
  async getProviders(): Promise<Provider[]> {
    return this.get<Provider[]>('/api/providers');
  }

  // Add a new provider
  async addProvider(provider: Provider): Promise<Provider> {
    return this.post<Provider>('/api/providers', provider);
  }

  // Update a provider
  async updateProvider(index: number, provider: Provider): Promise<Provider> {
    return this.post<Provider>(`/api/providers/${index}`, provider);
  }

  // Delete a provider
  async deleteProvider(index: number): Promise<void> {
    return this.delete<void>(`/api/providers/${index}`);
  }

  // Get transformers
  async getTransformers(): Promise<Transformer[]> {
    return this.get<Transformer[]>('/api/transformers');
  }

  // Add a new transformer
  async addTransformer(transformer: Transformer): Promise<Transformer> {
    return this.post<Transformer>('/api/transformers', transformer);
  }

  // Update a transformer
  async updateTransformer(index: number, transformer: Transformer): Promise<Transformer> {
    return this.post<Transformer>(`/api/transformers/${index}`, transformer);
  }

  // Delete a transformer
  async deleteTransformer(index: number): Promise<void> {
    return this.delete<void>(`/api/transformers/${index}`);
  }

  // Get configuration (new endpoint)
  async getConfigNew(): Promise<Config> {
    return this.get<Config>('/config');
  }

  async getA2GControlPlane(): Promise<A2GControlPlaneData> {
    return this.get<A2GControlPlaneData>('/a2g/control-plane');
  }

  async getA2GDraft(): Promise<A2GDraftPayload> {
    return this.get<A2GDraftPayload>('/a2g/draft');
  }

  async saveA2GDraft(spec: Record<string, unknown>, draftId: string = 'default'): Promise<A2GDraftPayload> {
    return this.post<A2GDraftPayload>('/a2g/draft', { draftId, spec });
  }

  async resetA2GDraft(draftId: string = 'default'): Promise<{ ok: boolean; draftId: string }> {
    return this.delete<{ ok: boolean; draftId: string }>('/a2g/draft', { draftId });
  }

  async generateA2GConfig(spec: Record<string, unknown>, draftId: string = 'default'): Promise<A2GGeneratePayload> {
    return this.post<A2GGeneratePayload>('/a2g/generate', { draftId, spec });
  }

  async validateA2GConfig(spec: Record<string, unknown>, draftId: string = 'default'): Promise<A2GValidatePayload> {
    return this.post<A2GValidatePayload>('/a2g/validate', { draftId, spec });
  }

  async getA2GReleaseContext(draftId: string = 'default'): Promise<A2GReleaseContextPayload> {
    return this.get<A2GReleaseContextPayload>(`/a2g/release-context?draftId=${encodeURIComponent(draftId)}`);
  }

  async getA2GDiff(draftId: string = 'default'): Promise<A2GDiffPayload> {
    return this.get<A2GDiffPayload>(`/a2g/diff?draftId=${encodeURIComponent(draftId)}`);
  }

  async createA2GSnapshot(
    spec: Record<string, unknown>,
    draftId: string = 'default',
    publishedBy: string = 'ui-preview',
  ): Promise<{ ok: boolean; snapshot: A2GSnapshotMeta }> {
    return this.post<{ ok: boolean; snapshot: A2GSnapshotMeta }>('/a2g/snapshots', {
      draftId,
      publishedBy,
      spec,
    });
  }

  async publishA2GDraft(
    spec: Record<string, unknown>,
    draftId: string = 'default',
    publishedBy: string = 'ui-publish',
  ): Promise<{ ok: boolean; activeVersion: string }> {
    return this.post<{ ok: boolean; activeVersion: string }>('/a2g/publish', {
      draftId,
      publishedBy,
      spec,
    });
  }

  async rollbackA2GSnapshot(
    releaseVersion: string,
    publishedBy: string = 'ui-rollback',
  ): Promise<{ ok: boolean; activeVersion: string }> {
    return this.post<{ ok: boolean; activeVersion: string }>('/a2g/rollback', {
      releaseVersion,
      publishedBy,
    });
  }

  async getA2GAudit(
    limit: number = 50,
    filters?: {
      type?: string;
      releaseVersion?: string;
      since?: string;
      until?: string;
      draftId?: string;
    },
  ): Promise<{ ok: boolean; events: A2GAuditEvent[] }> {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (filters?.type) params.set('type', filters.type);
    if (filters?.releaseVersion) params.set('releaseVersion', filters.releaseVersion);
    if (filters?.since) params.set('since', filters.since);
    if (filters?.until) params.set('until', filters.until);
    if (filters?.draftId) params.set('draftId', filters.draftId);
    return this.get<{ ok: boolean; events: A2GAuditEvent[] }>(`/a2g/audit?${params.toString()}`);
  }

  async getA2GAuthProfiles(): Promise<{ ok: boolean; source: string; count: number; profiles: A2GAuthProfile[] }> {
    return this.get<{ ok: boolean; source: string; count: number; profiles: A2GAuthProfile[] }>('/a2g/auth-profiles');
  }

  // Save configuration (new endpoint)
  async saveConfig(config: Config): Promise<unknown> {
    return this.post<Config>('/config', config);
  }

  // Restart service
  async restartService(): Promise<unknown> {
    return this.post<void>('/restart', {});
  }

  // Check for updates
  async checkForUpdates(): Promise<{ hasUpdate: boolean; latestVersion?: string; changelog?: string }> {
    return this.get<{ hasUpdate: boolean; latestVersion?: string; changelog?: string }>('/update/check');
  }

  // Perform update
  async performUpdate(): Promise<{ success: boolean; message: string }> {
    return this.post<{ success: boolean; message: string }>('/api/update/perform', {});
  }

  // Get log files list
  async getLogFiles(): Promise<Array<{ name: string; path: string; size: number; lastModified: string }>> {
    return this.get<Array<{ name: string; path: string; size: number; lastModified: string }>>('/logs/files');
  }

  // Get logs from specific file
  async getLogs(filePath: string): Promise<string[]> {
    return this.get<string[]>(`/logs?file=${encodeURIComponent(filePath)}`);
  }

  // Clear logs from specific file
  async clearLogs(filePath: string): Promise<void> {
    return this.delete<void>(`/logs?file=${encodeURIComponent(filePath)}`);
  }

  // ========== Preset API methods ==========

  // Get presets list
  async getPresets(): Promise<{ presets: Array<any> }> {
    return this.get<{ presets: Array<any> }>('/presets');
  }

  // Get preset details
  async getPreset(name: string): Promise<any> {
    return this.get<any>(`/presets/${encodeURIComponent(name)}`);
  }

  // Install preset from URL
  async installPresetFromUrl(url: string, name?: string): Promise<any> {
    return this.post<any>('/presets/install', { url, name });
  }

  // Upload preset file
  async uploadPresetFile(file: File, name?: string): Promise<any> {
    const formData = new FormData();
    formData.append('file', file);
    if (name) {
      formData.append('name', name);
    }

    const url = `${this.baseUrl}/presets/upload`;

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Use temp API key if available, otherwise use regular API key
    if (this.tempApiKey) {
      headers['X-Temp-API-Key'] = this.tempApiKey;
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (response.status === 401) {
      localStorage.removeItem('apiKey');
      window.dispatchEvent(new CustomEvent('unauthorized'));
      return new Promise(() => {}) as any;
    }

    if (!response.ok) {
      throw new Error(`Failed to upload preset: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  // Apply preset (configure sensitive fields)
  async applyPreset(name: string, secrets: Record<string, string>): Promise<any> {
    return this.post<any>(`/presets/${encodeURIComponent(name)}/apply`, { secrets });
  }

  // Delete preset
  async deletePreset(name: string): Promise<any> {
    return this.delete<any>(`/presets/${encodeURIComponent(name)}`, {});
  }

  // Get market presets
  async getMarketPresets(): Promise<{ presets: Array<any> }> {
    return this.get<{ presets: Array<any> }>('/presets/market');
  }

  // Install preset from GitHub repository
  async installPresetFromGitHub(repo: string, name?: string): Promise<any> {
    return this.post<any>('/presets/install/github', { repo, name });
  }
}

// Create a default instance of the API client
export const api = new ApiClient();

// Export the class for creating custom instances
export default ApiClient;
