# Docker + SQLite 部署

此部署复用原有 SDK、控制台、OAuth、查询 API、评分、广告防护、消费者和定时分析代码。
SQL 和 `migrations/*.sql` 原样执行，没有 PostgreSQL/MySQL 转换，也不依赖 Cloudflare Workers、D1、KV 或 Queues 托管服务。
原有 Cloudflare 发布保留为手动触发。

## 运行方式

- Node.js 22.16+，官方镜像使用 Node 22。
- 一个应用容器，一个本地持久卷 `/data`。SQLite 使用 WAL 和 `synchronous=FULL`。
- 数据库在专门的 worker thread 中执行，HTTP 事件循环不直接执行 SQLite 扫描。
- KV 缓存、过期时间、持久队列、重试/死信和调度记录都保存在同一个 SQLite 文件。
- 队列消费的业务写入与删除队列消息处于同一事务，失败会整体回滚；最多重试 3 次，然后保留为死信。
- 每小时 UTC `:05` 聚合；每天 UTC `03:30` 执行群体分析、异动检测、保留清理与可选边缘统计。
  启动时补跑最近一个未完成的周期。调度记录与任务更新一起提交，重启不会遗失队列或已完成的调度记录。
- **单实例部署，使用支持 SQLite 文件锁的本地块存储。不要把 WAL 数据库放在 NFS/对象存储，也不要横向扩容多个 Pod。**
  Kubernetes 示例使用 `replicas: 1` 和 `Recreate`，升级会有短暂中断。

## 配置与启动

```bash
cp .env.example .env
# 编辑 .env 后：
docker compose up -d --build
docker compose logs -f app
```

必要配置：

| 名称                                        | 用途                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `HMAC_KEY`                                  | 至少 32 字符。全新部署可用 `openssl rand -hex 32` 生成；迁移必须复用旧值 |
| `PUBLIC_URL`                                | 控制台外部 HTTPS 地址，用于 OAuth 回调、公开链接及重定向                 |
| `ADMIN_EMAILS`                              | 管理员邮箱列表，逗号分隔                                                 |
| `INGEST_HOST`                               | 上报域名，不含协议；保持旧值即可保留现有嵌入代码                         |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth，或改配 GitHub                                              |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth，至少启用一个登录提供商                                     |
| `PROXY_TOKEN`                               | 部署在反向代理后时，验证转发的真实访客 IP/元数据；代理和应用使用同一个值 |

可选：`API_TOKEN`、`AI_API_KEY`、`DEFAULT_LANG`、`PORT`（默认 3000）、`SQLITE_PATH`（Docker 中为 `/data/pvuv.sqlite`）。
AI 配置、爬虫目录、Cloudflare 只读边缘统计令牌仍可以从原有控制台设置。
不需要 Cloudflare 部署令牌。密钥只写 `.env` 或部署平台 Secret，不写仓库和镜像。

默认仅绑定主机 `127.0.0.1:3000`。用已有 HTTPS 反向代理/Ingress 转发控制台、api、ingest、js 域名到同一容器。
参考 `deploy/nginx.conf.example`，务必覆盖客户端传入的 `x-pv-*` 请求头。
OAuth 应用回调地址仍为 `https://<PUBLIC_URL域名>/api/auth/google/callback` 或 `/api/auth/github/callback`。
`GET /healthz` 用于就绪检查，内部 HTTP 请求验证即可。

如果需要自定义首页，将 `home.html` / `home.<lang>.html` 通过只读挂载放入 `/app/workers/console/public/`，无需改业务代码。
评分配置仍通过 `config.example.toml` 生成；私有 `config.local.toml` 不会被默认 Docker 上下文打包。可通过 `docker build --secret id=scoring_config,src=config.local.toml -t pvuv:local .` 提供；GitHub Actions 支持可选的 `CONFIG_LOCAL_TOML` Secret。构建时使用同样的评分权重，不把源配置文件留在镜像层里。

## Docker Hub 与 Keel 发布（沿用 rivulet）

GitHub 仓库 Settings → Secrets and variables → Actions 配置：

| 类型             | 名称                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| Secret           | `DOCKERHUB_USERNAME`                                                  |
| Secret           | `DOCKERHUB_TOKEN`                                                     |
| Secret           | `KEEL_USER`                                                           |
| Secret           | `KEEL_PASSWORD`                                                       |
| Variable（可选） | `KEEL_WEBHOOK_URL`，默认 `https://keel.skybyte.me/v1/webhooks/native` |

`.github/workflows/docker-publish.yml` 先运行类型检查与业务测试，再在原生 amd64/arm64 runner 上构建，最后合并 manifest：

- `my` / `main` 分支推送：`<DockerHub用户名>/pvuv.ai:devel`。
- `v*` 标签：对应版本标签与 `latest`。
- manifest 发布成功后，发送 `{name, tag}` 到 Keel native webhook，HTTP 失败会让工作流失败。

本次实现不会主动上传镜像或调用你的 Keel。配置密钥并推送后，GitHub Actions 才会执行。
Keel 管理 Kubernetes 的 Deployment 更新；Docker Compose 使用 `docker compose pull && docker compose up -d --no-build` 更新。
Kubernetes 示例见 `deploy/kubernetes.yaml`，修改镜像名称后，用安全环境文件创建配置：

```bash
kubectl create secret generic pvuv-env --from-env-file=.env
kubectl apply -f deploy/kubernetes.yaml
```

镜像私有时另外配置 `imagePullSecrets`；Ingress/TLS 沿用你的集群配置。

## 从现有 D1 切换（可选，不转换数据库方言）

先备份，保持当前 Workers 服务可回退。选择维护窗口：停止新上报，等待 Cloudflare Queue 排空，再导出，避免导出期间的数据缺口。
在具有现有 Cloudflare 权限的机器运行：

```bash
npx wrangler d1 export pvuv-db --remote --output=d1-export.sql
```

创建新目标卷后，在**应用未启动**且 `/data/pvuv.sqlite` 尚不存在时导入：

```bash
docker compose build
docker compose run --rm --no-deps \
  -v "$PWD/d1-export.sql:/restore/d1.sql:ro" \
  app node dist/server/import.mjs /restore/d1.sql
```

导入器原样执行 SQLite SQL，复用已有迁移记录。没有导出迁移记录时，只有包含当前完整结构的导出才会被接纳。
导入后执行 `integrity_check`，恢复爬虫目录和未过期的集群黑名单缓存，不覆盖已有数据库。
旧导出缺失结构时先在 D1 应用最新迁移后重新导出；不要手工伪造迁移版本。

**复用原 HMAC_KEY**，保留站点 ID、上报/脚本域名、OAuth 回调及 API 令牌，随后将域名指向 Docker 服务。
先用控制台 Self-check 验证上报 → 队列 → 消费 → 数据可见，再恢复流量。
旧 Workers 保留至验证完成；Docker 已接收新数据后，直接回退到旧 D1 会丢失这部分新数据，需要另行同步，不能自动无损回滚。

## 备份与恢复

不要在运行时只复制 `.sqlite` 文件并丢掉 WAL。使用 SQLite 在线备份，或停容器后备份整个持久卷。
在线备份示例：

```bash
docker compose exec app node --input-type=module -e \
  "import { DatabaseSync, backup } from 'node:sqlite'; const db=new DatabaseSync('/data/pvuv.sqlite'); await backup(db,'/data/backup.sqlite'); db.close();"
```

将备份复制到异机存储。恢复时停止应用，将备份放回 `/data/pvuv.sqlite`（保留旧文件备份，清理对应旧 WAL/SHM），再启动并检查日志与 Self-check。
死信保存在 `pvuv_queue` 的 `dead_at IS NOT NULL` 行；修复原因后可在停服维护时将选定消息的 `dead_at=NULL, attempts=0, available_at=0` 后重试，避免无条件重复投递。

## 保持的业务能力与平台差异

统计、归因、访客画像、评分引擎、广告渐进判定/影子模式、公开看板、个人令牌、CLI/MCP、AI 报告、爬虫目录、漏斗和保留策略复用同一份业务代码。

Cloudflare 的 `request.cf` 包含 ASN、地理位置、时区、TLS 指纹、边缘 RTT、已验证爬虫等平台数据，普通 Docker HTTP 服务不能自动提供这些数据。
可信代理可用 `x-pv-ip`、`x-pv-asn`、`x-pv-asorg`、`x-pv-country`、`x-pv-region`、`x-pv-city`、`x-pv-tz` 转发已有信息；
若代理确有完整边缘元数据，可通过带 `PROXY_TOKEN` 的 `x-pv-cf` JSON 传递（限 8 KiB）。
没有可信来源时保留缺失值，不伪造 ASN/TLS 信息。因此**同样输入使用同样业务规则，但缺失这些平台信号时不能承诺评分结果与 Workers 完全相同**。
普通 Cloudflare CDN 可继续放在源站前，不要求 Workers 付费订阅；CDN 常规头本身不等于完整 `request.cf`。

真实 OAuth、AI 和 Cloudflare 边缘 API 需要你自己的配置；测试不会调用这些外部服务，也不声称已验证你的生产凭证。
SQLite 消除了 Workers 请求计费，但容量仍取决于机器 CPU、磁盘和查询负载；上线前应用实际流量压测。

## 本地开发

```bash
npm ci
npm run typecheck
npm run typecheck:server
npm run test:server
# 设置本地 .env 后：
npm run dev:server
```

当前测试覆盖原有 API/统计维度、队列事务与失败重试、调度重复执行、令牌吊销、SQLite 备份、D1 SQL 恢复和实际 HTTP 请求。
测试使用临时数据库，不触碰 `data/` 或生产数据库。
