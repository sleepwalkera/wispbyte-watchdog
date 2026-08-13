/**
 * Wispbyte Server Auto-Restart Worker
 *
 * 每 5 分钟检查一次服务器状态，若掉线则自动调用 start API。
 * 通过 Socket.IO 长轮询获取实时服务器状态（比 HTML 嵌入数据更准确）。
 * Session cookie 每次请求后自动续期，存入 KV，无需手动刷新。
 *
 * 所需配置：
 *   环境变量 SERVER_ID      - 服务器标识符
 *   环境变量 NOTIFY_WEBHOOK - (可选) Discord webhook URL
 *   KV 绑定  MONITOR_KV    - 存储 session cookie
 *
 * 初始化 cookie（部署后执行一次）：
 *   wrangler kv:key put --binding=MONITOR_KV "cookie" "connect.sid=s%3A..."
 */

const BASE = 'https://wispbyte.com/client';
const SOCKET_BASE = 'https://wispbyte.com';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 15000;
// 主路径（REST）成功时也定期刷新缓存的 Socket.IO token，避免降级时用上过期 token
const TOKEN_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/** 带超时的 fetch，自动创建 AbortController + setTimeout */
async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

/** 构造公共请求头（Cookie + 基础字段） */
function reqHeaders(cookie, extra = {}) {
  return {
    'Cookie': cookie,
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': USER_AGENT,
    'Referer': `${BASE}/servers`,
    ...extra,
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  async fetch(request, env, ctx) {
    const result = await run(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

async function run(env) {
  const serverId = env.SERVER_ID;
  const log = [];

  // 1. 读取存储的 cookie
  let cookie = await env.MONITOR_KV.get('cookie');
  if (!cookie) {
    return { ok: false, error: 'Cookie not set. Run: wrangler kv:key put --binding=MONITOR_KV "cookie" "connect.sid=..."' };
  }

  // 2. 保活：通过 adblocker 页面获取 Set-Cookie 续期
  //    adblocker 页面由 Express 服务器返回，响应中包含 Set-Cookie: connect.sid=...
  //    确认 rolling: true，session middleware 每次请求都重置 _expires
  const lastKeepalive = await env.MONITOR_KV.get('keepalive');
  const lastKeepaliveTs = parseInt(lastKeepalive, 10);
  if (!lastKeepalive || isNaN(lastKeepaliveTs) || Date.now() - lastKeepaliveTs > 86400000) {
    log.push('Keepalive: refreshing session...');
    try {
      // 优先：访问 adblocker 页面获取 Set-Cookie（HTML 响应才续期 connect.sid）
      const adblockResp = await fetchWithTimeout(`${BASE}/disable-adblocker`, {
        headers: reqHeaders(cookie, { 'Accept': 'text/html' }),
      });
      const renewed = renewCookieIfNeeded(adblockResp, cookie);
      const hasConnectSid = getAllSetCookieHeaders(adblockResp).some(sc => sc.startsWith('connect.sid='));
      if (renewed !== cookie) {
        // connect.sid Set-Cookie 值变化 → 保存新 cookie
        cookie = renewed;
        await env.MONITOR_KV.put('cookie', cookie);
        log.push('Keepalive: cookie renewed');
        await markKeepalive(env, log);
      } else if (hasConnectSid) {
        // connect.sid Set-Cookie 值相同 → session 已被 touch，保活成功
        await markKeepalive(env, log);
      } else {
        // 无 connect.sid Set-Cookie → 尝试 rewarded 降级
        log.push('Keepalive: no connect.sid Set-Cookie, calling rewarded...');
        const resp = await fetchWithTimeout(`${BASE}/api/server/start-captcha/rewarded`, {
          method: 'POST',
          headers: reqHeaders(cookie, { 'Content-Type': 'application/json' }),
          body: '{}',
        });
        if (!resp.ok) {
          log.push(`Keepalive: rewarded failed: ${resp.status}`);
        } else {
          const data = await resp.json().catch(() => ({}));
          const renewed2 = renewCookieIfNeeded(resp, cookie);
          if (renewed2 !== cookie) {
            cookie = renewed2;
            await env.MONITOR_KV.put('cookie', cookie);
          }
          log.push(`Keepalive: session valid until ${formatDate(data.expiresAt) || 'ok'}`);
          await markKeepalive(env, log);
        }
      }
    } catch (e) {
      log.push(`Keepalive: error: ${e.message}`);
    }
  }

  // 3. 定期刷新缓存的 Socket.IO token（独立于状态检测，失败不影响主路径）
  await refreshTokenIfStale(serverId, cookie, log, env);

  // 4. 获取服务器状态（优先轻量 REST API，失败时回退 Socket.IO 长轮询）
  let { state, cookie: updatedCookie } = await getServerStateViaRestApi(serverId, cookie, log, env);
  if (!state) {
    const fallback = await getServerStateViaSocketIO(serverId, updatedCookie, log, env);
    state = fallback.state;
    updatedCookie = fallback.cookie;
  }

  // 更新 cookie（如果续期了）
  if (updatedCookie && updatedCookie !== cookie) {
    await env.MONITOR_KV.put('cookie', updatedCookie);
    cookie = updatedCookie;
    log.push('Cookie renewed');
  }

  if (!state) {
    return { ok: false, error: 'Could not determine server state (REST + Socket.IO both failed)', log };
  }

  return await handleState(state, serverId, cookie, log, env);
}

/**
 * 解析 Socket.IO EIO4 数据包，返回服务器状态字符串或 null
 */
function parseSocketPackets(text, log) {
  for (const packet of text.split('\u001e')) {
    if (!packet.startsWith('42')) continue;
    try {
      const arr = JSON.parse(packet.slice(2));
      if (arr[0] === 'serverStatus' && typeof arr[1] === 'string') {
        log.push(`Socket.IO: serverStatus=${arr[1]}`);
        return arr[1];
      }
      if (arr[0] === 'newMessage' && typeof arr[1] === 'string' && arr[1].includes('"event":"stats"')) {
        const stats = JSON.parse(JSON.parse(arr[1]).args[0]);
        if (stats.state) {
          log.push(`Socket.IO: stats state=${stats.state}`);
          return stats.state;
        }
      }
    } catch (_) {}
  }
  return null;
}

/**
 * 提取响应中的 Set-Cookie 并更新 cookie（若续期）。
 * 对所有关键 API 调用统一检查，确保任何端点返回的 cookie 续期都能被捕获。
 */
/** 获取响应中的所有 Set-Cookie 头（兼容 Workers 运行时） */
function getAllSetCookieHeaders(response) {
  const getAll = typeof response.headers.getAll === 'function'
    ? response.headers.getAll.bind(response.headers)
    : null;
  return getAll ? getAll('set-cookie') : [response.headers.get('set-cookie')].filter(Boolean);
}

/** 迭代所有 Set-Cookie（响应可能同时携带 cf_clearance 与 connect.sid），
 *  只接受 connect.sid 续期，忽略 cf_clearance 等其他 cookie。 */
function renewCookieIfNeeded(response, currentCookie) {
  for (const setCookie of getAllSetCookieHeaders(response)) {
    if (!setCookie.startsWith('connect.sid=')) continue;
    const renewed = setCookie.split(';')[0].trim();
    if (renewed && renewed !== currentCookie) return renewed;
  }
  return currentCookie;
}

/** 记录保活成功时间戳到 KV */
async function markKeepalive(env, log) {
  await env.MONITOR_KV.put('keepalive', String(Date.now()));
  log.push('Keepalive: session refreshed');
}

/** 安全格式化日期字符串，非法/缺失日期返回空串 */
function formatDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * 定期从控制台页面刷新缓存的 Socket.IO token。
 * REST 成为主路径后，成功状态检查不再访问 console 页，缓存的 token 会随
 * session 续期而失效；这里每隔 TOKEN_REFRESH_INTERVAL_MS 主动重取一次，
 * 保证降级到 Socket.IO（且 console 被拦截）时仍能用上新鲜 token。
 * 任何失败都不影响主路径。
 */
async function refreshTokenIfStale(serverId, cookie, log, env) {
  try {
    const lastRefresh = await env.MONITOR_KV.get('tokenRefreshedAt');
    const lastRefreshTs = parseInt(lastRefresh, 10);
    if (lastRefresh && !isNaN(lastRefreshTs) && Date.now() - lastRefreshTs < TOKEN_REFRESH_INTERVAL_MS) {
      return;
    }
    const resp = await fetchWithTimeout(`${BASE}/servers/${serverId}/console`, {
      headers: { ...reqHeaders(cookie, { 'Accept': 'text/html' }) },
    });
    const html = await resp.text();
    const tokenMatch = html.match(/id="data-token-div"[^>]*data-token="([^"]+)"/) ||
      html.match(/data-token="([a-f0-9]{64})"/i);
    if (tokenMatch) {
      await env.MONITOR_KV.put('token', tokenMatch[1]);
      log.push('Token refreshed (periodic)');
    }
    await env.MONITOR_KV.put('tokenRefreshedAt', String(Date.now()));
  } catch (e) {
    log.push(`Token refresh error: ${e.message}`);
  }
}

/**
 * 轻量 REST API 获取服务器状态（首选）。
 * GET /client/api/servers/status —— 无需 token，只用 connect.sid cookie，
 * 返回所有服务器的 current_state。比 Socket.IO 长轮询简单可靠得多。
 */
async function getServerStateViaRestApi(serverId, cookie, log, env) {
  try {
    const resp = await fetchWithTimeout(`${BASE}/api/servers/status`, {
      headers: reqHeaders(cookie),
    });
    const renewed = renewCookieIfNeeded(resp, cookie);
    if (!resp.ok) {
      log.push(`REST status: ${resp.status}, fallback to Socket.IO`);
      return { state: null, cookie: renewed };
    }
    const data = await resp.json().catch(() => ({}));
    const server = (data.servers || []).find(s => s.identifier === serverId);
    if (!server || typeof server.current_state !== 'string') {
      log.push('REST status: server not found in response, fallback to Socket.IO');
      return { state: null, cookie: renewed };
    }
    log.push(`REST status: ${server.current_state}`);
    return { state: server.current_state, cookie: renewed };
  } catch (e) {
    log.push(`REST status error: ${e.message}, fallback to Socket.IO`);
    return { state: null, cookie };
  }
}

/**
 * 通过 Socket.IO 长轮询获取实时服务器状态
 * 协议：Engine.IO v4 长轮询 + Socket.IO v4（保底方案）
 */
async function getServerStateViaSocketIO(serverId, cookie, log, env) {
  const headers = {
    ...reqHeaders(cookie, { 'Accept': '*/*', 'Origin': 'https://wispbyte.com' }),
    'Referer': `${BASE}/servers/${serverId}/console`,
  };

  let updatedCookie = cookie;

  try {
    // Step 1: 从控制台页面获取 auth token
    // 新版 WispByte 对无 cf_clearance cookie 的请求返回 adblocker 拦截页，
    // 此时降级使用 KV 中缓存的 token（由首次成功提取时写入）。
    const consoleResp = await fetchWithTimeout(`${BASE}/servers/${serverId}/console`, {
      headers: { ...headers, 'Accept': 'text/html' },
      redirect: 'follow',
    });

    updatedCookie = renewCookieIfNeeded(consoleResp, cookie);

    const consoleHtml = await consoleResp.text();

    // 检测是否被拦截（adblocker 页或 Cloudflare JS 挑战页）
    // Cloudflare 挑战页的特征：<script type="<hash>-text/javascript">
    if (consoleHtml.includes('Adblocker detected') || consoleHtml.includes('disable-adblocker') ||
        /type="[a-f0-9]+-text\/javascript"/.test(consoleHtml)) {
      log.push('Socket.IO: console page blocked, using cached token');
      const cachedToken = await env.MONITOR_KV.get('token');
      if (cachedToken) {
        return await connectSocketIO(serverId, cachedToken, updatedCookie, log, env);
      }
      log.push('Socket.IO: no cached token available');
      return { state: null, cookie: updatedCookie };
    }

    // session 失效检查
    if (consoleHtml.includes('Log In') && consoleHtml.includes('Email or Username')) {
      await notify(env, '⚠️ Wispbyte session expired! Please log in again and update the cookie in KV.');
      return { state: null, cookie: updatedCookie };
    }

    // 更新后的正则：匹配新版 HTML 中 id="data-token-div" ... data-token="..."
    const tokenMatch = consoleHtml.match(/id="data-token-div"[^>]*data-token="([^"]+)"/) ||
      consoleHtml.match(/data-token="([a-f0-9]{64})"/i);
    if (!tokenMatch) {
      const idx = consoleHtml.indexOf('data-token');
      const snippet = idx >= 0 ? consoleHtml.substring(idx, idx + 150) : 'not found';
      log.push(`Socket.IO: auth token not found. Snippet: ${snippet}`);
      return { state: null, cookie: updatedCookie };
    }
    const token = tokenMatch[1];

    // 缓存 token 到 KV，供后续被 adblocker 拦截时使用
    await env.MONITOR_KV.put('token', token);

    // 用提取到的 token 建立 Socket.IO 连接
    // 传入 updatedCookie（可能被 console 页面的 Set-Cookie 续期过），
    // 确保续期结果能传回 run() 并写入 KV。
    return await connectSocketIO(serverId, token, updatedCookie, log, env);

  } catch (e) {
    log.push(`Socket.IO: error: ${e.message}`);
    return { state: null, cookie: updatedCookie };
  }
}

/**
 * 建立 Socket.IO EIO4 长轮询连接，获取服务器实时状态。
 * 与 token 提取逻辑分离，可在 console 页面被拦截时复用 KV 缓存的 token。
 */
async function connectSocketIO(serverId, token, cookie, log, env) {
  const headers = {
    ...reqHeaders(cookie, { 'Accept': '*/*', 'Origin': 'https://wispbyte.com' }),
    'Referer': `${BASE}/servers/${serverId}/console`,
  };
  const postHeaders = { ...headers, 'Content-Type': 'text/plain;charset=UTF-8' };

  try {
    // Step 1: EIO4 握手
    const handshakeResp = await fetchWithTimeout(`${SOCKET_BASE}/socket.io/?EIO=4&transport=polling`, { headers });
    cookie = renewCookieIfNeeded(handshakeResp, cookie);
    const handshakeText = await handshakeResp.text();
    const sidMatch = handshakeText.match(/"sid":"([^"]+)"/);
    if (!sidMatch) {
      log.push(`Socket.IO: handshake failed: ${handshakeText.substring(0, 80)}`);
      return { state: null, cookie };
    }
    const sid = sidMatch[1];

    const pollUrl = `${SOCKET_BASE}/socket.io/?EIO=4&transport=polling&sid=${sid}`;

    // Step 3-5: POST connect → GET ack → POST joinServer
    await (await fetchWithTimeout(pollUrl, { method: 'POST', headers: postHeaders, body: '40' })).text();
    await (await fetchWithTimeout(pollUrl, { headers })).text();
    const joinPayload = `42${JSON.stringify(['joinServer', serverId, token, 'free'])}`;
    await (await fetchWithTimeout(pollUrl, { method: 'POST', headers: postHeaders, body: joinPayload })).text();

    // Step 7: 轮询等待 serverStatus（最多 3 次，每次 3s 超时）
    // 服务端事件顺序固定：第1次 poll 返回 auth success，第2次才返回 serverStatus
    let state = null;
    for (let attempt = 1; attempt <= 3 && !state; attempt++) {
      try {
        const pollResp = await fetchWithTimeout(pollUrl, { headers }, 3000);
        const pollText = await pollResp.text();
        const eventHint = pollText.match(/42\["([^"]+)"/);
        if (eventHint) log.push(`Socket.IO: ← ${eventHint[1]}`);
        state = parseSocketPackets(pollText, log);
      } catch (e) {
        log.push(e.name === 'AbortError' ? `Socket.IO: poll${attempt} timeout` : `Socket.IO: poll${attempt} error: ${e.message}`);
      }
    }

    return { state, cookie };
  } catch (e) {
    log.push(`Socket.IO: error: ${e.message}`);
    return { state: null, cookie };
  }
}


/**
 * 根据服务器状态决定是否需要重启
 */
async function handleState(state, serverId, cookie, log, env) {
  if (state === 'running' || state === 'starting') {
    return { ok: true, action: 'none', state, log };
  }

  // 服务器不在线，触发启动
  log.push(`Server ${serverId} is ${state}, sending start command...`);
  await notify(env, `🔄 Server ${serverId} is ${state}, attempting restart...`);

  // 新版 WispByte：启动前需要有效会话（Turnstile/奖励广告，TTL 5 小时）。
  // 先做只读 status 检查，仅当会话失效时才调用 rewarded 续期，避免频繁触发风控。
  const gate = await ensureStartGate(cookie, log, env);
  if (!gate.ok) {
    const msg = `❌ Start gate failed for server ${serverId}: session invalid. Please re-login and run make set-cookie.`;
    log.push(msg);
    await notify(env, msg);
    return { ok: false, action: 'gated', state, log };
  }
  cookie = gate.cookie;

  const startResp = await fetchWithTimeout(`${BASE}/api/server/start`, {
    method: 'POST',
    headers: reqHeaders(cookie, { 'Content-Type': 'application/json', 'Referer': `${BASE}/servers/${serverId}/console` }),
    body: JSON.stringify({ serverId }),
  });

  const startBody = await startResp.text();
  log.push(`Start API: ${startResp.status} ${startBody}`);

  if (startResp.ok) {
    await notify(env, `✅ Server ${serverId} start command sent successfully.`);
  } else {
    await notify(env, `❌ Failed to start server ${serverId}: ${startResp.status} ${startBody}`);
  }

  return { ok: startResp.ok, action: 'started', state, startStatus: startResp.status, startBody, log };
}

/**
 * 新版 WispByte 启动闸门。
 *
 * 自 2026 年升级后，`POST /client/api/server/start` 在缺少有效会话时返回
 * 403 { captchaRequired: true }。会话通过 Cloudflare Turnstile 验证或观看
 * 奖励广告获得，TTL 5 小时，由 `GET /client/api/server/start-captcha/status`
 * 查询。
 *
 * 策略（避免频繁调用 rewarded 端点触发风控）：
 *   1. 仅做只读 status 检查，若会话有效则直接放行；
 *   2. 仅在会话失效时才 POST `/start-captcha/rewarded` 续期，每次启动至多一次。
 */
async function ensureStartGate(cookie, log, env) {
  // 1. 检查会话状态（只读 GET，无副作用）
  try {
    const statusResp = await fetchWithTimeout(`${BASE}/api/server/start-captcha/status`, { headers: reqHeaders(cookie) });
    const statusData = statusResp.ok ? await statusResp.json() : null;
    if (statusData && statusData.valid) {
      log.push(`Start gate: captcha session valid (expires ${formatDate(statusData.expiresAt) || '?'}), skip reward`);
      return { ok: true, cookie };
    }
    log.push(`Start gate: no valid captcha session${statusData ? ` (ttl=${statusData.sessionTtlHours}h)` : ''}`);
  } catch (e) {
    log.push(`Start gate: status check failed: ${e.message}`);
  }

  // 2. 会话失效，POST rewarded 端点续期 5 小时（仅在真正需要启动时调用一次）
  try {
    const rewardResp = await fetchWithTimeout(`${BASE}/api/server/start-captcha/rewarded`, {
      method: 'POST',
      headers: reqHeaders(cookie, { 'Content-Type': 'application/json' }),
      body: '{}',
    });
    if (rewardResp.ok) {
      const rewardText = await rewardResp.text();
      let rewardData = {};
      try { rewardData = JSON.parse(rewardText); } catch (_) {}
      if (rewardData && rewardData.success) {
        const renewed = renewCookieIfNeeded(rewardResp, cookie);
        if (renewed !== cookie) {
          cookie = renewed;
          await env.MONITOR_KV.put('cookie', cookie);
        }
        const expires = formatDate(rewardData.expiresAt) ? ` until ${formatDate(rewardData.expiresAt)}` : '';
        log.push(`Start gate: rewarded session refreshed (5h)${expires}`);
        return { ok: true, cookie };
      }
      log.push(`Start gate: rewarded success=false (body: ${rewardText.substring(0, 100)})`);
    } else {
      log.push(`Start gate: rewarded endpoint failed: ${rewardResp.status} ${await rewardResp.text()}`);
    }
  } catch (e) {
    log.push(`Start gate: rewarded endpoint error: ${e.message}`);
  }

  return { ok: false, cookie };
}

async function notify(env, message) {
  if (!env.NOTIFY_WEBHOOK) return;
  try {
    await fetch(env.NOTIFY_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, text: message }),
    });
  } catch (_) {}
}
