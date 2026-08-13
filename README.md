# Wispbyte Watchdog

基于 **Cloudflare Workers + KV** 的 Wispbyte 服务器监控工具。每 5 分钟自动检查服务器状态，掉线时自动重启，并提供 Discord 通知。部署一次即可长期自动运行，无需手动维护。

## 功能

- **自动重启** — 服务器掉线后自动调用 start API 恢复运行
- **会话保活** — 自动续期登录会话，无需反复手动刷新 cookie
- **多通道检测** — 优先使用轻量 REST API 获取状态，失败时自动回退 Socket.IO
- **掉线通知** — 可配置 Discord Webhook，掉线/恢复时推送消息
- **零成本** — 完全运行在 Cloudflare Workers 免费套餐

## 快速开始

### 1. 配置凭据

复制 `.env.example` 为 `.env`，填入：

```env
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token_here
KV_NAMESPACE_ID=your_kv_namespace_id_here
SERVER_ID=your_server_id_here
WORKER_URL=https://wispbyte-watchdog.your-subdomain.workers.dev
```

- `SERVER_ID`：服务器控制台 URL 中的 8 位 ID
- 需要先创建 KV 命名空间：`wrangler kv:namespace create MONITOR_KV`，把输出的 ID 填入

### 2. 部署

```bash
make deploy
```

### 3. 写入会话 cookie

登录 wispbyte.com，从浏览器 DevTools → Application → Cookies 复制 `connect.sid` 的值：

```bash
make set-cookie COOKIE='connect.sid=s%3AbA1vpBk...'
```

> Worker 会自动续期会话，正常情况只需设置这一次。

### 4. (可选) 配置 Discord 通知

在 `.env` 中取消注释并填入 Webhook URL，然后重新 `make deploy`。

### 5. 手动测试

```bash
make check
```

正常输出示例：
```json
{
  "ok": true,
  "state": "running",
  "log": ["REST status: running"]
}
```

重启输出示例：
```json
{
  "ok": true,
  "action": "started",
  "state": "offline",
  "startStatus": 200
}
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `make deploy` | 部署 Worker |
| `make set-cookie COOKIE=...` | 写入会话 cookie |
| `make check` | 手动触发一次检查 |
| `make logs` | 实时查看 Worker 日志 |

## 文件结构

```
wispbyte-watchdog/
├── src/worker.js           # 核心逻辑
├── Makefile                # 部署/管理命令
├── .env                    # 本地凭据（不提交）
├── wrangler.toml.example   # Cloudflare 配置模板
└── .gitignore
```

## 说明

- Worker 部署后通过 Cron 每 5 分钟自动运行，无需手动干预
- 基于 Cloudflare Workers 免费套餐，零成本运行
- 若长时间未登录导致会话失效，重新执行 `make set-cookie` 即可