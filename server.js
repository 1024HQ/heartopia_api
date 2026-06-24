const fs = require("fs");
const https = require("https");
const http = require("http");
const net = require("net");
const path = require("path");
const tls = require("tls");
const { URL } = require("url");

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3010);
const XD_BASE = "https://xdsdk-intnl-6.xd.com";
const DEFAULT_APP_ID = "2085001";
const PUBLIC_DIR = path.join(__dirname, "public");
const SERVER_LIST = new Set(["fra-prod", "sgp-prod", "va-prod", "jp-prod", "hk-prod"]);
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 OPR/127.0.0.0";
const WEBPAY_HEADERS = {
  Origin: "https://webpay.xd.com",
  Referer: "https://webpay.xd.com/"
};

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function cleanText(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

function appError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function requireField(value, name, max = 120) {
  const text = cleanText(value, max);
  if (!text) throw appError(`missing ${name}`);
  return text;
}

function validateRegion(region) {
  const text = requireField(region, "region").toUpperCase();
  if (!/^[A-Z0-9_-]{2,16}$/.test(text)) throw appError(`invalid region: ${text}`);
  return text;
}

function validateServerId(serverId) {
  const text = requireField(serverId, "serverId");
  if (!SERVER_LIST.has(text)) throw appError(`invalid serverId: ${text}`);
  return text;
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function normalizeXdResponse(response) {
  return response && typeof response === "object" && "data" in response ? response.data : response;
}

function flattenChannelGroups(channelResponse) {
  const wrapped = normalizeXdResponse(channelResponse);
  const data = normalizeXdResponse(wrapped);
  const groups = Array.isArray(data) ? data : [];
  const channels = groups.flatMap((group) =>
    (group.channels || []).map((channel) => ({
      ...channel,
      paymentGroup: group.type,
      paymentGroupWeight: group.weight
    }))
  );

  return { groups, channels };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw appError("request body too large", 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw appError("invalid json body");
  }
}

function getProxyUrl(targetUrl) {
  if (targetUrl.protocol !== "https:") return null;
  const rawProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!rawProxy) return null;

  const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (noProxy.includes(targetUrl.hostname)) return null;

  return new URL(rawProxy);
}

function createHttpsProxyConnection(targetUrl, proxyUrl) {
  return (options, callback) => {
    const proxyPort = Number(proxyUrl.port || 80);
    const socket = net.connect(proxyPort, proxyUrl.hostname);
    let settled = false;
    let headerBuffer = Buffer.alloc(0);

    function finishWithError(err) {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(err);
    }

    socket.setTimeout(20000, () => finishWithError(appError("proxy connection timeout", 504)));
    socket.once("error", finishWithError);
    socket.once("connect", () => {
      const auth =
        proxyUrl.username || proxyUrl.password
          ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}\r\n`
          : "";
      socket.write(
        `CONNECT ${targetUrl.hostname}:443 HTTP/1.1\r\n` +
          `Host: ${targetUrl.hostname}:443\r\n` +
          "Proxy-Connection: Keep-Alive\r\n" +
          auth +
          "\r\n"
      );
    });

    socket.on("data", function onData(chunk) {
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const headerEnd = headerBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      socket.off("data", onData);
      const header = headerBuffer.slice(0, headerEnd).toString("latin1");
      const statusCode = Number(header.match(/^HTTP\/\d\.\d\s+(\d+)/)?.[1] || 0);
      if (statusCode !== 200) {
        finishWithError(appError(`proxy CONNECT failed: ${statusCode}`, 502));
        return;
      }

      const tlsSocket = tls.connect(
        {
          socket,
          servername: targetUrl.hostname,
          ALPNProtocols: ["http/1.1"]
        },
        () => {
          if (settled) return;
          settled = true;
          callback(null, tlsSocket);
        }
      );
      tlsSocket.once("error", finishWithError);
    });
  };
}

function requestText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const targetUrl = url instanceof URL ? url : new URL(url);
    const body = options.body || "";
    const headers = {
      Accept: "application/json, text/plain, */*",
      "User-Agent": USER_AGENT,
      ...(options.headers || {})
    };

    if (body && !headers["Content-Length"]) {
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const proxyUrl = getProxyUrl(targetUrl);
    const requestOptions = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      method: options.method || "GET",
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers
    };

    if (proxyUrl) {
      requestOptions.createConnection = createHttpsProxyConnection(targetUrl, proxyUrl);
    }

    const client = targetUrl.protocol === "https:" ? https : http;
    const req = client.request(requestOptions, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: response.statusCode || 0, text });
      });
    });

    req.setTimeout(20000, () => req.destroy(appError("XD request timeout", 504)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJson(url, options = {}) {
  const response = await requestText(url, options);
  let data = response.text;
  try {
    data = response.text ? JSON.parse(response.text) : null;
  } catch {
    data = response.text;
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const err = appError("XD request failed", response.statusCode);
    err.data = data;
    throw err;
  }
  return data;
}

async function mapLimit(items, limit, iterator) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await iterator(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchProducts({ appId, region, serverId, userId, roleId }) {
  const url = new URL("/payment/product/v2/query/game/products", XD_BASE);
  url.searchParams.set("source", "webpay");
  url.searchParams.set("pt", "Windows");
  url.searchParams.set("appId", appId);
  url.searchParams.set("region", region);
  url.searchParams.set("lang", region === "TH" ? "th_TH" : "en_US");
  url.searchParams.set("userId", userId);
  url.searchParams.set("serverId", serverId);
  url.searchParams.set("roleId", roleId);
  return fetchJson(url, {
    headers: WEBPAY_HEADERS
  });
}

async function fetchChannels({ appId, region, productSkuCode, userId, roleId }) {
  const url = new URL("/payment/product/v2/query/game/product/channels", XD_BASE);
  url.searchParams.set("source", "webpay");
  url.searchParams.set("pt", "Windows");
  url.searchParams.set("appId", appId);
  url.searchParams.set("region", region);
  url.searchParams.set("productSkuCode", productSkuCode);
  url.searchParams.set("roleId", roleId);
  url.searchParams.set("userId", userId);
  return fetchJson(url, {
    headers: WEBPAY_HEADERS
  });
}

async function handleProducts(reqUrl, res) {
  const appId = cleanText(reqUrl.searchParams.get("appId")) || DEFAULT_APP_ID;
  const userId = requireField(reqUrl.searchParams.get("userId"), "userId");
  const roleId = requireField(reqUrl.searchParams.get("roleId"), "roleId");
  const serverId = validateServerId(reqUrl.searchParams.get("serverId"));
  const region = validateRegion(reqUrl.searchParams.get("region"));

  const productResponse = await fetchProducts({ appId, region, serverId, userId, roleId });
  const productPayload = normalizeXdResponse(productResponse);
  const groups = Array.isArray(productPayload) ? productPayload : [];

  const allSkus = groups.flatMap((group) =>
    (group.products || []).map((product) => ({
      productSkuCode: product.productSkuCode
    }))
  );

  const channelRows = await mapLimit(allSkus, 4, async (row) => {
    try {
      const channelResponse = await fetchChannels({
        appId,
        region,
        productSkuCode: row.productSkuCode,
        userId,
        roleId
      });
      const { groups: channelGroups, channels } = flattenChannelGroups(channelResponse);
      return {
        productSkuCode: row.productSkuCode,
        channelGroups,
        channels,
        channelError: ""
      };
    } catch (err) {
      return {
        productSkuCode: row.productSkuCode,
        channelGroups: [],
        channels: [],
        channelError: err.data || err.message
      };
    }
  });

  const channelsBySku = Object.fromEntries(channelRows.map((row) => [row.productSkuCode, row]));
  const enrichedGroups = groups.map((group) => ({
    ...group,
    products: (group.products || []).map((product) => ({
      ...product,
      channels: channelsBySku[product.productSkuCode]?.channels || [],
      channelGroups: channelsBySku[product.productSkuCode]?.channelGroups || [],
      channelError: channelsBySku[product.productSkuCode]?.channelError || ""
    }))
  }));

  sendJson(res, 200, {
    success: true,
    meta: { appId, region, serverId, userId, roleId },
    data: enrichedGroups
  });
}

async function handleCreatePaylink(req, res) {
  const body = await readBody(req);
  const appId = cleanText(body.appId) || DEFAULT_APP_ID;
  const userId = requireField(body.userId, "userId");
  const roleId = requireField(body.roleId, "roleId");
  const serverId = validateServerId(body.serverId);
  const region = validateRegion(body.region);
  const productSkuCode = requireField(body.productSkuCode, "productSkuCode");
  const subChannelCode = requireField(body.subChannelCode, "subChannelCode");
  const currency = requireField(body.currency, "currency", 16).toUpperCase();
  const channelType = Number(body.channelType);
  const quantity = Math.max(1, Math.min(99, Number(body.quantity || 1)));
  const authorization = cleanText(process.env.XD_AUTHORIZATION, 2000);

  if (!Number.isFinite(channelType)) throw appError("invalid channelType");
  if (!authorization) {
    throw appError("missing XD_AUTHORIZATION in .env");
  }

  const payload = {
    appId,
    appRoleId: roleId,
    appServerId: serverId,
    channelType,
    currency,
    orderType: 0,
    paymentType: 1,
    region,
    productSkuCode,
    quantity,
    subChannelCode,
    creatorCode: cleanText(body.creatorCode || process.env.XD_CREATOR_CODE || "", 80),
    userId,
    source: "webpay"
  };

  if (body.promotionId !== undefined && body.promotionId !== null && body.promotionId !== "") {
    payload.promotionId = Number(body.promotionId);
  }

  const url = new URL("/trade/v1/web/createOrder", XD_BASE);
  url.searchParams.set("source", "webpay");
  url.searchParams.set("pt", "Windows");

  const data = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      ...WEBPAY_HEADERS
    },
    body: JSON.stringify(payload)
  });

  sendJson(res, 200, {
    success: true,
    data
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    }[ext] || "application/octet-stream"
  );
}

function serveStatic(reqUrl, res) {
  const requestedPath = decodeURIComponent(reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { success: false, error: "forbidden" });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { success: false, error: "not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Content-Length": data.length
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && reqUrl.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, app: "xd-paylink-generator" });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/products") {
      await handleProducts(reqUrl, res);
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/api/create-paylink") {
      await handleCreatePaylink(req, res);
      return;
    }
    if (req.method === "GET") {
      serveStatic(reqUrl, res);
      return;
    }
    sendJson(res, 405, { success: false, error: "method not allowed" });
  } catch (err) {
    sendJson(res, err.statusCode || 500, {
      success: false,
      error: err.data || err.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`XD Paylink Generator running at http://localhost:${PORT}`);
});
