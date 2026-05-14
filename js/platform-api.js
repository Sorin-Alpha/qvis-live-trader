/**
 * QVIS 平台 Client API（REST + WebSocket）。
 * 浏览器 WebSocket 无法设置 Authorization，故使用 query：`api_key=`；
 * 非浏览器客户端可在握手时带 `Authorization: Bearer <qvis_...>`。
 */

export function normalizeApiRoot(root) {
  return String(root || "").trim().replace(/\/+$/, "");
}

export function buildWsUrl(apiRoot) {
  const raw = normalizeApiRoot(apiRoot);
  const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/api/v1/client-api/ws`;
}

/**
 * 校验 QVIS Client API Key：须能访问需鉴权的 REST（与拉任务同一接口）。
 */
export async function verifyClientApiKey(apiRoot, platformApiKey) {
  return fetchRunningSimulated(apiRoot, platformApiKey);
}

export async function fetchRunningSimulated(apiRoot, platformApiKey) {
  const url = `${normalizeApiRoot(apiRoot)}/api/v1/client-api/simulated/live-tasks/running`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${platformApiKey}` },
  });
  const text = await r.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { detail: text };
  }
  if (!r.ok) throw new Error(j.detail || text || `HTTP ${r.status}`);
  return j;
}

export async function fetchTaskDetail(apiRoot, platformApiKey, taskId) {
  const url = `${normalizeApiRoot(apiRoot)}/api/v1/client-api/simulated/live-tasks/${taskId}/detail`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${platformApiKey}` },
  });
  const text = await r.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { detail: text };
  }
  if (!r.ok) throw new Error(j.detail || text || `HTTP ${r.status}`);
  return j;
}

/**
 * @param {string} apiRoot
 * @param {string} platformApiKey
 * @param {{onOpen?:()=>void,onMessage?:(data:object)=>void,onError?:(e:Event)=>void,onClose?:(e:CloseEvent)=>void}} handlers
 */
export function connectClientWs(apiRoot, platformApiKey, handlers) {
  const base = buildWsUrl(apiRoot);
  const url = `${base}?api_key=${encodeURIComponent(platformApiKey)}`;
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => handlers.onOpen?.());
  ws.addEventListener("message", (ev) => {
    try {
      handlers.onMessage?.(JSON.parse(ev.data));
    } catch {
      handlers.onMessage?.({ event: "parse_error", raw: ev.data });
    }
  });
  ws.addEventListener("error", (e) => handlers.onError?.(e));
  ws.addEventListener("close", (e) => handlers.onClose?.(e));

  return {
    ws,
    close: () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    },
  };
}
