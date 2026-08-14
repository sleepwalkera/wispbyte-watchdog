# Wispbyte Watchdog

> ⚠️ Wispbyte 近期增加了 Turnstile 验证、浏览器指纹检测等风控手段，多数 Worker 方案已失效。  
> 本方案通过**会话维持 + API 调用**绕开浏览器渲染路径，是目前少数仍能正常工作的纯 Workers 方案。
>
> 纯 Cloudflare Workers 方案，无需浏览器、无需模拟器、无需代理。  
> 每 5 分钟自动检测，掉线即重启，长期运行零维护。

---

## 对比

| 特性 | 本方案（Workers） | 浏览器模拟方案（Selenium / Actions） |
|------|-------------------|--------------------------------------|
| 运行环境 | Cloudflare Workers 边缘节点 | GitHub Actions |
| 运行耗时 | 单次 ~秒级（纯 API 请求） | 单次 ~分钟级（浏览器渲染 + 广告流程） |
| 检测方式 | REST API + Socket.IO 回退 | 完整浏览器模拟 |
| 验证码 | 会话维持，无需处理 Turnstile | 需处理 Turnstile 弹窗 |
| 广告流程 | 无需处理 | 需自动观看奖励广告 |
| 环境依赖 | 无（仅 Workers 运行时） | 需完整浏览器环境 |
| 会话维护 | 设置一次 cookie，自动续期 | 每次运行自动登录账号 |
| 通知方式 | Discord | Telegram（含界面截图） |
| 费用 | 免费 | 免费 |

---

## 原理

本方案利用 Wispbyte 的 **REST API** 和 **Socket.IO** 检测服务器状态，不依赖浏览器渲染。

1. 从 KV 读取已保存的 `connect.sid` cookie
2. 通过 REST API 获取服务器状态（`/status`）
3. 若掉线，调用 start API 重启
4. 每次请求自动续期 cookie，会话长期有效
5. Cron 每 5 分钟触发一次，循环往复

---

## 快速开始

### 1. 准备

```bash
# 创建 KV 命名空间
npx wrangler kv:namespace create MONITOR_KV
# 复制输出的 ID，下一步需要
```

### 2. 配置

```bash
cp .env.example .env
```

编辑 `.env`：

```env
CLOUDFLARE_API_TOKEN=你的_API_令牌
KV_NAMESPACE_ID=上一步创建的_命名空间_ID
SERVER_ID=你的服务器_8位_ID
WORKER_URL=https://wispbyte-watchdog.你的子域名.workers.dev
```

> `SERVER_ID` 可从 Wispbyte 控制台 URL 中获取，即 `wispbyte.com/client/servers/xxxxxxxx` 中的 8 位 ID。

### 3. 部署

```bash
make deploy
```

### 4. 写入会话 cookie

登录 wispbyte.com，从浏览器 DevTools → Application → Cookies 复制 `connect.sid` 的值：

```bash
make set-cookie COOKIE='connect.sid=s%3AbA1vpBk...'
```

> Worker 会自动续期会话，正常情况下只需设置这一次。

### 5. 验证

```bash
make check
```

正常输出：

```json
{ "ok": true, "state": "running", "log": ["REST status: running"] }
```

---

## 可选：Discord 通知

在 `.env` 中取消注释并填入 Webhook URL：

```env
NOTIFY_WEBHOOK=https://discord.com/api/webhooks/...
```

重新 `make deploy` 即可。服务器掉线恢复时会收到通知。

---

## 命令

| 命令 | 作用 |
|------|------|
| `make deploy` | 部署 Worker 到 Cloudflare |
| `make set-cookie COOKIE=...` | 写入初始 session cookie |
| `make check` | 手动触发一次检查 |
| `make logs` | 实时查看 Worker 日志 |

---

## 文件结构

```
wispbyte-watchdog/
├── src/worker.js           # 核心逻辑
├── Makefile                # 部署脚本（Docker 中运行 wrangler）
├── .env                    # 本地凭据（不提交）
├── wrangler.toml.example   # Cloudflare 配置模板
└── .gitignore
```

---

## 常见问题

**Q：Cookie 会过期吗？**  
Worker 每次请求时都会从响应头中捕获新的 `Set-Cookie` 并存入 KV，会话会自动续期。若长时间未登录导致彻底失效，重新执行 `make set-cookie` 即可。

**Q：为什么不用浏览器？**  
Wispbyte 的控制面板提供了 REST API 和 Socket.IO 接口，直接调用即可获取服务器状态，无需浏览器渲染、无需处理 Turnstile 验证码、无需切换 IP。Worker 环境完全够用。

**Q：检测频率能调整吗？**  
修改 `wrangler.toml.example` 中的 `crons` 表达式，然后重新部署即可。

