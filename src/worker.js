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
    await env.MONITOR_KV.put('cookie', updatedCookie);
    cookie = updatedCookie;
    log.push('Cookie renewed');
  }

  if (!state) {
    log.push('Could not determine server state via Socket.IO, falling back to HTML');
    // 降级：读取服务器列表页面的嵌入状态
    const fallbackState = await getFallbackState(serverId, cookie, log, env);
    if (!fallbackState) {
      return { ok: false, error: 'Could not determine server state', log };
    }
    return await handleState(fallbackState, serverId, cookie, log, env);
  }

  log.push(`Server ${serverId} state: ${state}`);
  return await handleState(state, serverId, cookie, log, env);
}

/**
 * 通过 Socket.IO 长轮询获取实时服务器状态
 * 协议：Engine.IO v4 长轮询 + Socket.IO v4
 */
async function getServerStateViaSocketIO(serverId, cookie, log, env) {
  const headers = {
    'Cookie': cookie,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

    // Step 3: 初次 GET（接收 server ping）
    const poll1Resp = await fetch(pollUrl, { headers });
    await poll1Resp.text();

    // Step 4: POST pong(3) + Socket.IO namespace connect(40)
    const connectResp = await fetch(pollUrl, {
      method: 'POST',
      headers: postHeaders,
      body: '3\u001e40',
    });
    await connectResp.text();

    // Step 5: GET namespace connect ack
    const poll2Resp = await fetch(pollUrl, { headers });
    await poll2Resp.text();

    // Step 6: POST joinServer 事件
    const joinPayload = `42${JSON.stringify(['joinServer', serverId, token])}`;
    const joinResp = await fetch(pollUrl, {
      method: 'POST',
      headers: postHeaders,
      body: joinPayload,
    });
    await joinResp.text();

    // Step 7: 长轮询等待 stats 事件（15 秒超时）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let state = null;
    try {
      const poll3Resp = await fetch(pollUrl, { headers, signal: controller.signal });
      clearTimeout(timeoutId);
      const poll3Text = await poll3Resp.text();
      log.push(`Socket.IO: poll=${poll3Text.substring(0, 100)}`);

      // EIO4 多包用 \u001e 分隔
      const packets = poll3Text.split('\u001e');
      for (const packet of packets) {
        if (!packet.startsWith('42')) continue;
        try {
          const arr = JSON.parse(packet.slice(2));
          if (arr[0] === 'serverStatus' && typeof arr[1] === 'string') {
            state = arr[1];
            log.push(`Socket.IO: serverStatus=${state}`);
            break;
          }
          if (arr[0] === 'newMessage' && typeof arr[1] === 'string' && arr[1].includes('"event":"stats"')) {
            const msg = JSON.parse(arr[1]);
            const stats = JSON.parse(msg.args[0]);
            if (stats.state) {
              state = stats.state;
              log.push(`Socket.IO: stats state=${state}`);
              break;
            }
          }
        } catch (_) {}
      }

      if (!state) {
        // 如果第一次 poll 没有 stats，再 poll 一次
        const controller2 = new AbortController();
        const timeoutId2 = setTimeout(() => controller2.abort(), 10000);
        try {
          const poll4Resp = await fetch(pollUrl, { headers, signal: controller2.signal });
          clearTimeout(timeoutId2);
          const poll4Text = await poll4Resp.text();
          log.push(`Socket.IO: poll2=${poll4Text.substring(0, 100)}`);
          const packets2 = poll4Text.split('\u001e');
          for (const packet of packets2) {
            if (!packet.startsWith('42')) continue;
            try {
              const arr = JSON.parse(packet.slice(2));
              if (arr[0] === 'serverStatus' && typeof arr[1] === 'string') {
                state = arr[1];
                log.push(`Socket.IO: serverStatus=${state}`);
                break;
              }
              if (arr[0] === 'newMessage' && typeof arr[1] === 'string' && arr[1].includes('"event":"stats"')) {
                const msg = JSON.parse(arr[1]);
                const stats = JSON.parse(msg.args[0]);
                if (stats.state) {
                  state = stats.state;
                  log.push(`Socket.IO: stats state=${state}`);
                  break;
                }
              }
            } catch (_) {}
          }
        } catch (e2) {
          if (e2.name !== 'AbortError') log.push(`Socket.IO: poll2 error: ${e2.message}`);
        }
      }
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        log.push('Socket.IO: poll timeout - no stats received in 15s');
      } else {
        log.push(`Socket.IO: poll error: ${e.message}`);
      }
    }

    return { state, cookie: updatedCookie };
  } catch (e) {
    log.push(`Socket.IO: error: ${e.message}`);
    return { state: null, cookie: updatedCookie };
  }
}

/**
 * 降级方案：从 HTML 嵌入数据读取服务器状态（可能不是实时的）
 */
async function getFallbackState(serverId, cookie, log, env) {
  const serversResp = await fetch(`${BASE}/servers`, {
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  });

  const html = await serversResp.text();

  if (html.includes('Log In') && html.includes('Email or Username') && !html.includes('server-data-debug')) {
    await notify(env, '⚠️ Wispbyte session expired! Please log in again and update the cookie in KV.');
    return null;
  }

  const dataMatch =
    html.match(/id="server-data-debug"[^>]*data-servers="([^"]+)"/) ||
    html.match(/id="server-data-debug"[^>]*data-servers='([^']+)'/) ||
    html.match(/data-servers="([^"]+)"[^>]*id="server-data-debug"/) ||
    html.match(/data-servers='([^']+)'[^>]*id="server-data-debug"/);

  if (!dataMatch) {
    log.push('Fallback: could not find server-data-debug in HTML');
    return null;
  }

  const jsonStr = dataMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
  let servers;
  try {
    servers = JSON.parse(jsonStr);
  } catch (e) {
    log.push(`Fallback: JSON parse error: ${e.message}`);
    return null;
  }

  const server = servers.find(s => s.attributes?.identifier === serverId);
  if (!server) {
    log.push(`Fallback: server ${serverId} not found in list`);
    return null;
  }

  const state = server.attributes?.resources?.current_state;
  log.push(`Fallback HTML state: ${state} (may be stale)`);
  return state;
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
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
