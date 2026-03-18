# Wispbyte Watchdog - Deployment Makefile
# 使用 Docker (node:22-alpine) 运行 wrangler，兼容 Docker-in-Docker 环境
#
# 用法：
#   make deploy                          # 生成 wrangler.toml 并部署 Worker
#   make set-cookie COOKIE='connect.sid=s%3A...'  # 写入 session cookie
#   make logs                            # 实时查看 Worker 日志
#   make check                           # 手动触发 Worker 并查看结果
#
# 凭据配置：复制 .env.example 为 .env 并填入对应值

-include .env
export

# 获取项目目录的宿主机真实路径
# DinD 环境：通过 docker inspect 找到 /work 的宿主机挂载路径
# 宿主机环境：直接使用当前目录 $(CURDIR)
HOST_WORK := $(shell docker inspect $$(hostname) --format '{{ range .Mounts }}{{ if eq .Destination "/work" }}{{ .Source }}{{ end }}{{ end }}' 2>/dev/null)
HOST_APP  := $(if $(HOST_WORK),$(HOST_WORK),$(CURDIR))

DOCKER_RUN := docker run --rm \
	-e CLOUDFLARE_API_TOKEN=$(CLOUDFLARE_API_TOKEN) \
	-v $(HOST_APP):/app \
	-w /app \
	node:22-alpine

WRANGLER_INSTALL := npm install -g wrangler 2>/dev/null

.PHONY: deploy set-cookie logs check wrangler.toml

## 从模板生成 wrangler.toml（由 deploy 自动调用）
wrangler.toml: wrangler.toml.example
	@test -n "$(KV_NAMESPACE_ID)" || (echo "Error: KV_NAMESPACE_ID is not set. Copy .env.example to .env and fill in the values."; exit 1)
	@test -n "$(SERVER_ID)" || (echo "Error: SERVER_ID is not set. Copy .env.example to .env and fill in the values."; exit 1)
	@sed -e "s|__KV_NAMESPACE_ID__|$(KV_NAMESPACE_ID)|g" \
	     -e "s|__SERVER_ID__|$(SERVER_ID)|g" \
	     wrangler.toml.example > wrangler.toml
	@echo "Generated wrangler.toml"

## 部署 Worker 到 Cloudflare
deploy: wrangler.toml
	@test -n "$(CLOUDFLARE_API_TOKEN)" || (echo "Error: CLOUDFLARE_API_TOKEN is not set. Copy .env.example to .env and fill in the values."; exit 1)
	$(DOCKER_RUN) sh -c '$(WRANGLER_INSTALL) && wrangler deploy'

## 写入 session cookie 到 KV
set-cookie:
	@test -n "$(COOKIE)" || (echo "Error: Usage: make set-cookie COOKIE='connect.sid=s%3A...'"; exit 1)
	@test -n "$(CLOUDFLARE_API_TOKEN)" || (echo "Error: CLOUDFLARE_API_TOKEN is not set. Copy .env.example to .env and fill in the values."; exit 1)
	@test -n "$(KV_NAMESPACE_ID)" || (echo "Error: KV_NAMESPACE_ID is not set. Copy .env.example to .env and fill in the values."; exit 1)
	$(DOCKER_RUN) sh -c '$(WRANGLER_INSTALL) && wrangler kv key put --namespace-id=$(KV_NAMESPACE_ID) "cookie" "$(COOKIE)"'

## 实时查看 Worker 日志
logs:
	@test -n "$(CLOUDFLARE_API_TOKEN)" || (echo "Error: CLOUDFLARE_API_TOKEN is not set. Copy .env.example to .env and fill in the values."; exit 1)
	$(DOCKER_RUN) sh -c '$(WRANGLER_INSTALL) && wrangler tail --format pretty'

## 手动触发 Worker（通过 HTTP fetch）
check:
	@test -n "$(WORKER_URL)" || (echo "Error: WORKER_URL is not set. Copy .env.example to .env and fill in the values."; exit 1)
	curl -s --max-time 90 $(WORKER_URL) | python3 -m json.tool
