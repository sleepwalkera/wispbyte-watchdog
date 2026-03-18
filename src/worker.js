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

  // 2. 通过 Socket.IO 长轮询获取实时服务器状态
  const { state, cookie: updatedCookie } = await getServerStateViaSocketIO(serverId, cookie, log, env);

  // 更新 cookie（如果续期了）
  if (updatedCookie && updatedCookie !== cookie) {
    env.MONITOR_KV.put('cookie', updatedCookie);
    cookie = updatedCookie;
    log.push('Cookie renewed');
  }

  if (!state) {
    return { ok: false, error: 'Could not determine server state via Socket.IO', log };
  }

  log.push(`Server ${serverId} state: ${state}`);
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
 * 通过 Socket.IO 长轮询获取实时服务器状态
 * 协议：Engine.IO v4 长轮询 + Socket.IO v4
 */
async function getServerStateViaSocketIO(serverId, cookie, log, env) {
  const headers = {
    'Cookie': cookie,
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Origin': 'https://wispbyte.com',
    'Referer': `${BASE}/servers/${serverId}/console`,
  };

  let updatedCookie = cookie;

  try {
    // Step 1: 从控制台页面获取 auth token
    const consoleResp = await fetch(`${BASE}/servers/${serverId}/console`, {
      headers: { ...headers, 'Accept': 'text/html' },
      redirect: 'follow',
    });

    const setCookie = consoleResp.headers.get('set-cookie');
    if (setCookie) {
      const renewed = setCookie.split(';')[0].trim();
      if (renewed) updatedCookie = renewed;
    }

    // session 失效检查
    const consoleHtml = await consoleResp.text();
    if (consoleHtml.includes('Log In') && consoleHtml.includes('Email or Username')) {
      await notify(env, '⚠️ Wispbyte session expired! Please log in again and update the cookie in KV.');
      return { state: null, cookie: updatedCookie };
    }

    const tokenMatch = consoleHtml.match(/data-token-div" data-token="([^"]+)"/) ||
      consoleHtml.match(/data-token="([a-f0-9]{64})"/i);
    if (!tokenMatch) {
      const idx = consoleHtml.indexOf('data-token');
      const snippet = idx >= 0 ? consoleHtml.substring(idx, idx + 150) : 'not found';
      log.push(`Socket.IO: auth token not found. Snippet: ${snippet}`);
      return { state: null, cookie: updatedCookie };
    }
    const token = tokenMatch[1];

    // Step 2: EIO4 握手
    const handshakeResp = await fetch(`${SOCKET_BASE}/socket.io/?EIO=4&transport=polling`, { headers });
    const handshakeText = await handshakeResp.text();
    const sidMatch = handshakeText.match(/"sid":"([^"]+)"/);
    if (!sidMatch) {
      log.push(`Socket.IO: handshake failed: ${handshakeText.substring(0, 80)}`);
      return { state: null, cookie: updatedCookie };
    }
    const sid = sidMatch[1];

    const pollUrl = `${SOCKET_BASE}/socket.io/?EIO=4&transport=polling&sid=${sid}`;
    const postHeaders = { ...headers, 'Content-Type': 'text/plain;charset=UTF-8' };

    // Step 3: POST Socket.IO namespace connect(40)
    // 浏览器实测：握手后直接发 namespace connect，无需等待 server ping
    const connectResp = await fetch(pollUrl, {
      method: 'POST',
      headers: postHeaders,
      body: '40',
    });
    await connectResp.text();

    // Step 4: GET namespace connect ack
    const poll2Resp = await fetch(pollUrl, { headers });
    await poll2Resp.text();

    // Step 5: POST joinServer 事件
    const joinPayload = `42${JSON.stringify(['joinServer', serverId, token])}`;
    const joinResp = await fetch(pollUrl, {
      method: 'POST',
      headers: postHeaders,
      body: joinPayload,
    });
    await joinResp.text();

    // Step 7: 轮询等待 serverStatus（最多 3 次，每次 3s 超时）
    // 服务端事件顺序固定：第1次 poll 返回 auth success，第2次才返回 serverStatus
    // 收到任何非目标消息后立即发起下一次 poll，无需等满超时
    let state = null;
    for (let attempt = 1; attempt <= 3 && !state; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      try {
        const pollResp = await fetch(pollUrl, { headers, signal: controller.signal });
        clearTimeout(timeoutId);
        const pollText = await pollResp.text();
        log.push(`Socket.IO: poll${attempt}=${pollText.substring(0, 120)}`);
        state = parseSocketPackets(pollText, log);
      } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
          log.push(`Socket.IO: poll${attempt} timeout (3s)`);
        } else {
          log.push(`Socket.IO: poll${attempt} error: ${e.message}`);
        }
      }
    }

    return { state, cookie: updatedCookie };
  } catch (e) {
    log.push(`Socket.IO: error: ${e.message}`);
    return { state: null, cookie: updatedCookie };
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

  const startResp = await fetch(`${BASE}/api/server/start`, {
    method: 'POST',
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': USER_AGENT,
      'Referer': `${BASE}/servers/${serverId}/console`,
    },
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
