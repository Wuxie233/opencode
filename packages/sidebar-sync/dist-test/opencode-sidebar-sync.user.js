// src/api-client.ts
function createSidebarSyncClient(options) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetcher = options.fetch ?? fetch;
  async function request(method, path, body, token) {
    const response = await fetcher(`${baseUrl}${path}`, {
      method,
      headers: {
        ...body === undefined ? {} : { "content-type": "application/json" },
        ...token ? { authorization: `Bearer ${token}` } : {}
      },
      ...body === undefined ? {} : { body: JSON.stringify(body) }
    });
    if (!response.ok) {
      if (response.status === 409)
        throw await response.json();
      throw new Error(`Sidebar sync request failed: ${method} ${path} ${response.status}`);
    }
    if (method === "GET" && response.status === 204)
      return;
    return response.json();
  }
  return {
    createPairing(body = {}) {
      return request("POST", "/sidebar-sync/pairing", body);
    },
    claimPairing(code, body = {}) {
      return request("POST", `/sidebar-sync/pairing/${encodeURIComponent(code)}/claim`, body);
    },
    getState(namespace, scope) {
      return request("GET", `/sidebar-sync/state/${encodeURIComponent(namespace)}/${encodeURIComponent(scope)}`, undefined, options.token);
    },
    putState(namespace, scope, body) {
      return request("PUT", `/sidebar-sync/state/${encodeURIComponent(namespace)}/${encodeURIComponent(scope)}`, body, options.token);
    }
  };
}

// src/contract.ts
var SIDEBAR_SCHEMA_VERSION = 1;
var CURRENT_SERVER_STORAGE_KEY = "opencode.global.dat:server";
var LEGACY_SERVER_STORAGE_KEY = "server.v3";
var forbiddenKeys = new Set([
  "password",
  "token",
  "credential",
  "secret",
  "authorization",
  "provider_auth",
  "session",
  "prompt",
  "model",
  "list"
]);

// src/sync-controller.ts
function parsePersistedServer(value) {
  if (!value)
    return;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed;
    return;
  } catch {
    return;
  }
}
function readPersistedServer(storage) {
  return parsePersistedServer(storage.getItem(CURRENT_SERVER_STORAGE_KEY)) ?? parsePersistedServer(storage.getItem(LEGACY_SERVER_STORAGE_KEY));
}
function isSidebarProjectState(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.worktree === "string" && typeof value.expanded === "boolean";
}
function extractScopedPayload(persisted, scope) {
  const projects = typeof persisted?.projects === "object" && persisted.projects !== null && !Array.isArray(persisted.projects) ? persisted.projects : undefined;
  const scopedProjects = projects && scope in projects && Array.isArray(projects[scope]) ? projects[scope].filter(isSidebarProjectState) : undefined;
  if (!scopedProjects)
    return;
  const lastProject = typeof persisted?.lastProject === "object" && persisted.lastProject !== null && !Array.isArray(persisted.lastProject) && typeof persisted.lastProject[scope] === "string" ? persisted.lastProject[scope] : undefined;
  return {
    schemaVersion: SIDEBAR_SCHEMA_VERSION,
    projects: scopedProjects.map((project) => ({ worktree: project.worktree, expanded: project.expanded })),
    ...lastProject ? { lastProject } : {}
  };
}
function writeScopedPayload(storage, scope, payload) {
  const persisted = parsePersistedServer(storage.getItem(CURRENT_SERVER_STORAGE_KEY)) ?? readPersistedServer(storage) ?? {};
  const projects = typeof persisted.projects === "object" && persisted.projects !== null && !Array.isArray(persisted.projects) ? persisted.projects : {};
  const lastProject = typeof persisted.lastProject === "object" && persisted.lastProject !== null && !Array.isArray(persisted.lastProject) ? persisted.lastProject : {};
  storage.setItem(CURRENT_SERVER_STORAGE_KEY, JSON.stringify({
    ...persisted,
    projects: { ...projects, [scope]: payload.projects },
    lastProject: payload.lastProject ? { ...lastProject, [scope]: payload.lastProject } : lastProject
  }));
}
function mergePayload(local, remote) {
  if (!local)
    return remote;
  return {
    schemaVersion: SIDEBAR_SCHEMA_VERSION,
    projects: local.projects,
    ...local.lastProject ? { lastProject: local.lastProject } : remote.lastProject ? { lastProject: remote.lastProject } : {}
  };
}
function restoreFromCache(storage, scope) {
  const payload = extractScopedPayload(readPersistedServer(storage), scope);
  if (payload)
    writeScopedPayload(storage, scope, payload);
}
function createSidebarSyncController(options) {
  let stopped = true;
  let timer;
  let unsubscribe;
  let baseVersion = 0;
  const upload = async (retryConflict = true) => {
    const payload = extractScopedPayload(readPersistedServer(options.storage), options.scope);
    if (!payload)
      return;
    try {
      const envelope = await options.apiClient.uploadState(options.scope, baseVersion, payload);
      baseVersion = envelope.version;
    } catch (error) {
      if (!retryConflict || typeof error !== "object" || error === null || !("current" in error))
        return;
      const current = error.current;
      if (!current)
        return;
      baseVersion = current.version;
      writeScopedPayload(options.storage, options.scope, mergePayload(extractScopedPayload(readPersistedServer(options.storage), options.scope), current.payload));
      await upload(false);
    }
  };
  const scheduleUpload = () => {
    if (stopped)
      return;
    if (timer)
      clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      upload();
    }, options.debounceMs ?? 500);
  };
  return {
    start() {
      if (!stopped)
        return;
      stopped = false;
      restoreFromCache(options.storage, options.scope);
      unsubscribe = options.subscribe?.(scheduleUpload);
      options.apiClient.fetchState(options.scope).then((envelope) => {
        if (!envelope || stopped)
          return;
        baseVersion = envelope.version;
        writeScopedPayload(options.storage, options.scope, envelope.payload);
      }).catch(() => {
        return;
      });
    },
    stop() {
      stopped = true;
      if (timer)
        clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}

// src/userscript.ts
var USERSCRIPT_VERSION = "0.0.0";
var CONFIG_STORAGE_KEY = "opencode.sidebarSync.config";
var defaultBaseUrl = "https://api.opencode.wuxie233.com";
var fallbackDiagnostics = ["GM storage unavailable; using localStorage fallback", "GM_xmlhttpRequest unavailable; using fetch fallback"];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isConfig(value) {
  return isRecord(value) && typeof value.namespace === "string" && typeof value.token === "string";
}
function parseConfig(value) {
  if (!value)
    return;
  try {
    const config = JSON.parse(value);
    if (!isConfig(config))
      return;
    return {
      baseUrl: typeof config.baseUrl === "string" && config.baseUrl.length > 0 ? config.baseUrl : defaultBaseUrl,
      namespace: config.namespace,
      token: config.token,
      ...typeof config.syncIntervalMs === "number" ? { syncIntervalMs: config.syncIntervalMs } : {}
    };
  } catch {
    return;
  }
}
function getGlobalRuntime() {
  if (typeof window === "undefined" || !window.localStorage)
    return;
  return {
    window,
    fetch,
    ..."GM_getValue" in globalThis && typeof globalThis.GM_getValue === "function" ? { GM_getValue: globalThis.GM_getValue } : {},
    ..."GM_setValue" in globalThis && typeof globalThis.GM_setValue === "function" ? { GM_setValue: globalThis.GM_setValue } : {},
    ..."GM_xmlhttpRequest" in globalThis && typeof globalThis.GM_xmlhttpRequest === "function" ? { GM_xmlhttpRequest: globalThis.GM_xmlhttpRequest } : {}
  };
}
function readStoredValue(key, runtime, localStorage) {
  if (runtime.GM_getValue) {
    const value = runtime.GM_getValue(key, null);
    return typeof value === "string" ? value : null;
  }
  return localStorage?.getItem(key) ?? null;
}
function getResponseHeaders(headers) {
  return Object.fromEntries(new Headers(headers).entries());
}
function parseResponseHeaders(headers) {
  if (!headers)
    return;
  return Object.fromEntries(headers.split(/\r?\n/).map((line) => line.split(":")).filter((parts) => parts.length >= 2).map((parts) => [parts[0].trim(), parts.slice(1).join(":").trim()]));
}
function createDiagnostic(config, scope, lastError) {
  return {
    enabled: true,
    lastError,
    lastSyncAt: undefined,
    baseUrl: config.baseUrl,
    namespace: config.namespace,
    scope,
    version: USERSCRIPT_VERSION
  };
}
function readUserscriptConfig(runtime) {
  return parseConfig(readStoredValue(CONFIG_STORAGE_KEY, runtime, runtime.localStorage));
}
function saveUserscriptConfig(config, runtime) {
  const value = JSON.stringify(config);
  if (runtime.GM_setValue) {
    runtime.GM_setValue(CONFIG_STORAGE_KEY, value);
    return;
  }
  runtime.localStorage?.setItem(CONFIG_STORAGE_KEY, value);
}
function createUserscriptFetch(runtime) {
  if (!runtime.GM_xmlhttpRequest)
    return runtime.fetch ?? fetch;
  return async (input, init) => new Promise((resolve, reject) => {
    runtime.GM_xmlhttpRequest?.({
      method: init?.method ?? "GET",
      url: String(input),
      headers: getResponseHeaders(init?.headers),
      ...init?.body === undefined ? {} : { data: String(init.body) },
      onload(response) {
        resolve(new Response(response.responseText, { status: response.status, statusText: response.statusText, headers: parseResponseHeaders(response.responseHeaders) }));
      },
      onerror(error) {
        reject(error);
      }
    });
  });
}
function getUserscriptScope(target) {
  if (target.location.protocol === "http:" && (target.location.hostname === "localhost" || target.location.hostname === "127.0.0.1"))
    return "local";
  return target.location.origin || target.location.host;
}
function createLocalStorageAdapter(storage) {
  return {
    getItem(key) {
      return storage.getItem(key);
    },
    setItem(key, value) {
      storage.setItem(key, value);
    }
  };
}
function subscribeToCurrentServerStorage(listener, target, intervalMs = 1000) {
  const onStorage = (event) => {
    if (event.key === CURRENT_SERVER_STORAGE_KEY)
      listener();
  };
  const timer = setInterval(listener, intervalMs);
  target.addEventListener("storage", onStorage);
  return () => {
    clearInterval(timer);
    target.removeEventListener("storage", onStorage);
  };
}
function startUserscriptSync(options = {}) {
  const runtime = options.runtime ?? getGlobalRuntime();
  if (!runtime)
    return { start() {}, stop() {} };
  const config = options.config ?? readUserscriptConfig({ ...runtime, localStorage: runtime.window.localStorage });
  if (!config)
    return { start() {}, stop() {} };
  const scope = getUserscriptScope(runtime.window);
  const diagnostic = createDiagnostic(config, scope, [
    ...runtime.GM_getValue && runtime.GM_setValue ? [] : [fallbackDiagnostics[0]],
    ...runtime.GM_xmlhttpRequest ? [] : [fallbackDiagnostics[1]]
  ].join("; ") || undefined);
  const client = createSidebarSyncClient({ baseUrl: config.baseUrl, token: config.token, fetch: createUserscriptFetch(runtime) });
  const controller = createSidebarSyncController({
    storage: createLocalStorageAdapter(runtime.window.localStorage),
    scope,
    ...config.syncIntervalMs === undefined ? {} : { debounceMs: config.syncIntervalMs },
    subscribe: (listener) => subscribeToCurrentServerStorage(listener, runtime.window, config.syncIntervalMs),
    apiClient: {
      async fetchState(scope2) {
        const envelope = await client.getState(config.namespace, scope2);
        if (envelope)
          runtime.window.__OPENCODE_SIDEBAR_SYNC__ = { ...diagnostic, lastSyncAt: new Date().toISOString() };
        return envelope;
      },
      async uploadState(scope2, baseVersion, payload) {
        const envelope = await client.putState(config.namespace, scope2, { baseVersion, payload });
        runtime.window.__OPENCODE_SIDEBAR_SYNC__ = { ...diagnostic, lastSyncAt: new Date().toISOString() };
        return envelope;
      }
    }
  });
  runtime.window.__OPENCODE_SIDEBAR_SYNC__ = diagnostic;
  controller.start();
  return controller;
}
startUserscriptSync();
export {
  subscribeToCurrentServerStorage,
  startUserscriptSync,
  saveUserscriptConfig,
  readUserscriptConfig,
  getUserscriptScope,
  createUserscriptFetch,
  createLocalStorageAdapter,
  USERSCRIPT_VERSION,
  CONFIG_STORAGE_KEY
};
