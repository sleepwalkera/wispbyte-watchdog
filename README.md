# Wispbyte Server Auto-Restart Monitor

利用 **Cloudflare Workers + KV** 每 5 分钟自动检查 wispbyte 服务器状态，掉线时自动调用 start API 重启。

## 工作原理

1. Cron 每 5 分钟触发 Worker
2. 通过 Socket.IO 长轮询获取实时服务器状态
3. 若 `current_state !== 'running'`，调用 `POST /client/api/server/start`
4. 每次成功访问 wispbyte 都会收到新的 `set-cookie`，自动写入 KV 续期（无需手动刷新）
5. 可选：通过 Discord webhook 发送掉线/恢复通知

## 部署步骤

### 1. 配置凭据

复制 `.env.example` 为 `.env` 并填入对应值：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token_here
KV_NAMESPACE_ID=your_kv_namespace_id_here
SERVER_ID=your_server_id_here
WORKER_URL=https://wispbyte-watchdog.your-subdomain.workers.dev
```

- `CLOUDFLARE_API_TOKEN`：在 [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) 创建，需要 Workers 和 KV 的编辑权限
- `SERVER_ID`：wispbyte 控制台 URL 中的 8 位 ID（如 `https://wispbyte.com/client/servers/xxxxxxxx/console` → `xxxxxxxx`）

### 2. 创建 KV 命名空间

```bash
wrangler kv:namespace create MONITOR_KV
```

输出示例：
```
{ binding = "MONITOR_KV", id = "abcd1234abcd1234abcd1234abcd1234" }
```

将输出的 `id` 填入 `.env` 的 `KV_NAMESPACE_ID`。

> `wrangler.toml` 由 `make deploy` 自动从 `wrangler.toml.example` 生成，无需手动编辑。

### 3. 部署

```bash
make deploy
```

### 4. 写入 session cookie

登录 wispbyte.com 后，从浏览器 DevTools → Application → Cookies 复制 `connect.sid` 的值：

```bash
make set-cookie COOKIE='connect.sid=s%3AbA1vpBk...'
```

> **Cookie 自动续期**：Worker 每次运行都会用新 cookie 覆盖 KV，理论上永不过期。
> 若 session 意外失效，重新登录并重新运行 `make set-cookie` 即可。

### 5. (可选) 配置 Discord 通知

在 `.env` 中取消注释并填入 webhook URL：

```env
NOTIFY_WEBHOOK=https://discord.com/api/webhooks/xxx/yyy
```

然后重新部署：`make deploy`

### 6. 手动测试

```bash
make check
```

返回 JSON 示例（正常）：
```json
{
  "ok": true,
  "action": "none",
  "state": "running",
  "log": ["Socket.IO: serverStatus=running", "Server state: running"]
}
```

返回 JSON 示例（已重启）：
```json
{
  "ok": true,
  "action": "started",
  "state": "offline",
  "startStatus": 200,
  "log": ["Cookie renewed", "Server state: offline"]
}
```

## 费用

Cloudflare Workers 免费套餐包含：
- 每天 **100,000 次** 请求（每 5 分钟一次 = 每天 288 次，远低于上限）
- KV 每天 **100,000 次读写**

**完全免费**，零成本运行。

## 文件结构

```
wispbyte-watchdog/
├── src/
│   └── worker.js           # Worker 主逻辑
├── .env                    # 本地凭据（不提交到 git）
├── .env.example            # 凭据模板（可安全提交）
├── .gitignore
├── Makefile                # 常用操作命令
├── wrangler.toml           # 由 make deploy 自动生成（不提交到 git）
└── wrangler.toml.example   # Cloudflare 配置模板（可安全提交）
```
