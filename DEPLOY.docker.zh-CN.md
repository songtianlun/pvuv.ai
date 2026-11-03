# Docker + SQLite 部署

此部署复用原有 SDK、控制台、OAuth、查询 API、评分、广告防护、消费者和定时分析代码。
SQL 和 `migrations/*.sql` 原样执行，没有 PostgreSQL/MySQL 转换，也不依赖 Cloudflare Workers、D1、KV 或 Queues 托管服务。
原有 Cloudflare 部署工作流已暂停，包含手动触发的运行也会跳过部署任务；Docker 构建发布使用独立工作流。

## 运行方式

- Node.js 22.16+，官方镜像使用 Node 22。
- 一个应用容器，一个本地持久卷 `/data`。SQLite 使用 WAL 和 `synchronous=FULL`。
- 数据库在专门的 worker thread 中执行，HTTP 事件循环不直接执行 SQLite 扫描。
- KV 缓存、过期时间、持久队列、重试/死信和调度记录都保存在同一个 SQLite 文件。
- 队列消费的业务写入与删除队列消息处于同一事务，失败会整体回滚；最多重试 3 次，然后保留为死信。
- 每小时 UTC `:05` 聚合；每天 UTC `03:30` 执行群体分析、异动检测、保留清理与可选边缘统计。
  启动后先消费积压，再补跑最近一个未完成的周期；待重试消息未处理完时暂停推进分析水位。
  日分析留出 15 分钟接收窗口，画像累计和水位更新在同一短事务内提交；其余任务可幂等重跑。
  外部边缘 API 请求在数据库事务外执行，并有 10 秒超时，不阻塞上报和查询。
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
| `PROXY_TOKEN`                               | 使用 `x-pv-*` 协议的代理共享密钥（如下面的 nginx 示例） |
| `TRUSTED_PROXY_CIDRS`                        | Traefik 等标准反向代理的实际来源 IP/CIDR，逗号分隔；用于验证 `X-Forwarded-For` |

可选：`API_TOKEN`、`AI_API_KEY`、`DEFAULT_LANG`、`PORT`（默认 3000）、`SQLITE_PATH`（Docker 中为 `/data/pvuv.sqlite`）。
AI 配置、爬虫目录、Cloudflare 只读边缘统计令牌仍可以从原有控制台设置。
不需要 Cloudflare 部署令牌。密钥只写 `.env` 或部署平台 Secret，不写仓库和镜像。

默认仅绑定主机 `127.0.0.1:3000`。用已有 HTTPS 反向代理/Ingress 转发控制台、api、ingest、js 域名到同一容器。
参考 `deploy/nginx.conf.example`，务必覆盖客户端传入的 `x-pv-*` 请求头。
OAuth 应用回调地址仍为 `https://<PUBLIC_URL域名>/api/auth/google/callback` 或 `/api/auth/github/callback`。
`GET /healthz` 用于就绪检查，内部 HTTP 请求验证即可。

如果需要自定义首页，将 `home.html` / `home.<lang>.html` 通过只读挂载放入 `/app/workers/console/public/`，无需改业务代码。
评分配置仍通过 `config.example.toml` 生成；私有 `config.local.toml` 不会被默认 Docker 上下文打包。可通过下面的命令提供：

```bash
docker buildx build --load \
  --build-arg SCORING_CONFIG_VERSION="$(sha256sum config.local.toml | cut -d ' ' -f 1)" \
  --secret id=scoring_config,src=config.local.toml -t pvuv:local .
```

GitHub Actions 支持可选的 `CONFIG_LOCAL_TOML` Secret。构建参数 `SCORING_CONFIG_VERSION` 用于使编译缓存失效；本地使用配置摘要，CI 自动使用运行 ID 和重试次数，每次发布重新编译，依赖安装层仍可缓存。源配置文件不会留在镜像层里。

## Docker Hub 与 Keel 发布（沿用 rivulet）

GitHub 仓库 Settings → Secrets and variables → Actions 配置：

| 类型             | 名称                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| Secret           | `DOCKERHUB_USERNAME`                                                  |
| Secret           | `DOCKERHUB_TOKEN`                                                     |
| Secret           | `KEEL_USER`                                                           |
| Secret           | `KEEL_PASSWORD`                                                       |
| Variable（可选） | `KEEL_WEBHOOK_URL`，默认 `https://keel.skybyte.me/v1/webhooks/native` |

`.github/workflows/checks.yml` 在 PR 上使用原生 amd64/arm64 runner 执行 `make check`（含导入器测试）、评分 Secret 更新后的镜像回归测试、Docker 构建和 `make smoke`，无需发布凭证。
`.github/workflows/docker-publish.yml` 复用同一检查作为发布门禁，再构建并合并 manifest：

- `my` / `main` 分支推送：`<DockerHub用户名>/pvuv.ai:devel`。
- `v*` 标签：对应版本标签与 `latest`。
- manifest 发布成功且配置 `KEEL_USER` / `KEEL_PASSWORD` 后，发送 `{name, tag}` 到 Keel native webhook，HTTP 失败会让工作流失败。未配置 Keel 凭据时跳过通知，不影响镜像发布。

本次实现不会主动上传镜像或调用你的 Keel。配置密钥并推送后，GitHub Actions 才会执行。
Keel 管理 Kubernetes 的 Deployment 更新；Docker Compose 使用 `docker compose pull && docker compose up -d --no-build` 更新。
Kubernetes 工作负载示例见 `deploy/kubernetes.yaml`。清单仅供参考，请按自己的集群、部署工具和已有资源配置，不需要直接应用仓库中的文件。
镜像私有时另外配置 `imagePullSecrets`。

### Kubernetes + Traefik 的域名、Ingress 与 TLS

原 Workers 配置实际绑定了以下三个域名；迁移后它们共用 `Service/pvuv`，不需要启动三个应用 Pod：

| 域名 | Traefik 转发路径 | 用途 |
| --- | --- | --- |
| `analytics.oskyla.com` | `/`，保留原路径 | 控制台、OAuth `/api/auth/*`、同源 `/api/*`、SDK `/f.js` |
| `in.oskyla.com` | `/in`、`/v`，精确匹配 | 事件上报、广告判定，包含 OPTIONS 预检 |
| `api.oskyla.com` | `/v1` 前缀，保留原路径 | CLI、MCP 和外部查询 API |

`deploy/ingress.traefik.yaml` 展示了这三个域名的路由方法：`ingressClassName: traefik`、`websecure` 入口及 TLS Secret `pvuv-tls`。
将对应规则合并到自己的 Ingress/Helm/GitOps 配置中；如使用其他域名或 IngressClass 名称，同步修改路由和 TLS 证书。
当前 SDK 由控制台域名提供；如果旧嵌入代码还使用独立的 `js.*` 域名，请额外增加该域名的 `/f.js` 精确匹配规则，并将域名加入 `tls.hosts` 和证书。

Pod 的环境变量（通过自己的 Secret、ConfigMap 或部署工具设置）应包含：

```dotenv
PUBLIC_URL=https://analytics.oskyla.com
INGEST_HOST=in.oskyla.com
# 填实际 Traefik 来源地址/网段，不要照抄其他集群的 Pod CIDR：
TRUSTED_PROXY_CIDRS=
```

`PUBLIC_URL` 始终是控制台地址，OAuth 回调仍为 `https://analytics.oskyla.com/api/auth/google/callback` 或 `/api/auth/github/callback`。
三个域名的 DNS A/AAAA/CNAME 要指向 Traefik 的外部负载均衡入口；原 Cloudflare Worker Custom Domain 路由也需要解除或切换，否则请求仍可能被旧 Worker 接走。

Ingress 的 `spec.tls.secretName` 指向应用所在 namespace 的 TLS Secret。证书必须覆盖三个域名；`*.oskyla.com` 通配符也能覆盖它们。
已有证书 Secret 时直接引用它；也可由 cert-manager 管理，或用自己的证书创建，例如：

```bash
kubectl -n YOUR_NAMESPACE create secret tls pvuv-tls \
  --cert=/path/fullchain.pem --key=/path/privkey.pem
```

Ingress、Service、`pvuv-env` 和 `pvuv-tls` 必须在同一个 namespace。
这个清单使用标准 Ingress，不要求额外安装 Traefik Middleware/IngressRoute CRD；HTTP 到 HTTPS 的跳转沿用 Traefik 的全局 `web` → `websecure` 配置。

**真实访客 IP：** Traefik 自动产生 `X-Forwarded-For`，应用只接受 `TRUSTED_PROXY_CIDRS` 中代理来源的转发链，从右向左定位第一个不受信任的客户端。
空配置时使用 TCP 对端 IP；不要将其设为 `0.0.0.0/0` 或 `::/0`。
可先用 `kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o wide` 查看 Traefik 地址，并结合实际 Pod/Node 网段配置。
若信任整个 Pod 网段，应配合 NetworkPolicy 将应用入口限制到 Traefik。`deploy/networkpolicy.traefik.yaml` 仅展示选择器的写法；按实际 Traefik namespace、Pod 标签和 CNI 能力，将对应规则加入自己的网络访问控制配置。
通过网段验证的普通代理仍会剥离客户端传入的 `x-pv-*`、`cf-connecting-ip`，只解析标准转发链。现有 `PROXY_TOKEN` 模式仍可用于需要转发额外元数据的自建代理。

如果 Traefik 前还有 CDN/L7 负载均衡，需要同时按它们的真实来源范围配置 Traefik `forwardedHeaders.trustedIPs` 和应用的代理链；L4 负载均衡还要保留客户端源 IP（按集群使用 `externalTrafficPolicy: Local` 或受信任的 PROXY protocol）。不要开启全网 `forwardedHeaders.insecure`。

切换前可将 `INGRESS_IP` 替换为入口地址逐域名验证；下面不跳过 TLS 验证：

```bash
curl --resolve analytics.oskyla.com:443:INGRESS_IP https://analytics.oskyla.com/f.js
curl --resolve in.oskyla.com:443:INGRESS_IP -X OPTIONS https://in.oskyla.com/in
curl --resolve api.oskyla.com:443:INGRESS_IP https://api.oskyla.com/v1/sites
# 最后一条匿名请求应返回 401；随后登录控制台运行 Self-check。
```

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

安装 Make、Node.js 22.16+ 和 Docker Compose 后，可以直接运行：

```bash
make dev          # 构建并在后台启动，等待健康检查通过
make smoke        # 验证 HTTP、鉴权、上报 → 队列 → SQLite → 统计查询
make dev-session  # 输出浏览器控制台登录命令，便于本地查看看板
make dev-logs     # 查看日志，Ctrl-C 退出日志跟随
make dev-down     # 停止容器，保留开发数据
```

默认地址为 `http://localhost:3000`。首次运行生成独立的 `.env.local`（随机 HMAC 密钥，权限 0600），后续运行保留已有配置。
开发容器使用独立的 `pvuv-dev` Compose 项目与 `dev-data` 卷，不读取生产 `.env`。
需要其他端口时，首次执行 `PVUV_DEV_PORT=3100 make dev-init`；已有配置需同时修改 `.env.local` 的 `PORT`、`PUBLIC_URL` 和 `INGEST_HOST`。
代码修改后重新执行 `make dev` 构建并重启；此入口没有自动热重载。

`make smoke` 会在内置 Self-check 站点写入一条测试事件，该站点不会显示在普通站点列表中。
`make dev-session` 只在本机生成短期签名 Cookie，没有添加服务端免鉴权入口；关闭浏览器会话可在控制台退出登录。
真实 OAuth 登录仍需在 `.env.local` 配置提供商。验证本地 HTTP 页面嵌入 SDK 时，手工将代码中的 `data-api` 设为 `http://localhost:3000`（或所选端口）；现有控制台生成的代码默认使用 HTTPS。

只导入原 D1 的网站清单（`--table sites --no-schema` 导出）时：

```bash
make dev
make import-sites FILE=/absolute/path/pvuv-sites.sql
# 路径含空格时：
make import-sites FILE="/absolute/path/sites export.sql"
```

入口将 SQL 通过标准输入传入运行中的开发容器，不需要重建镜像或复制文件到容器。
脚本 `scripts/import-sites.mjs` 先在临时数据库中检查导出，然后在 `/data/` 创建 `pvuv.sqlite.before-sites-*.sqlite` 在线备份，事务导入并清理站点配置缓存。
任何站点 ID 冲突都会整体回滚，不覆盖已有站点；原 `owner_id` 保持不变（当前控制台以 `admin` 为所有者）。
此命令只恢复站点配置，不包含历史统计。完整 D1 数据库恢复仍使用前面的整库迁移流程。

也可直接使用本机 Node 运行，SQLite 文件为 `data/dev.sqlite`：

```bash
make install
make dev-native   # 前台运行，Ctrl-C 停止；不要和同端口的容器同时运行
make check        # 类型检查与集成测试
```

原生 Node 环境也可以执行 `node --env-file=.env.local scripts/import-sites.mjs /path/pvuv-sites.sql`，导入 `.env.local` 中 `SQLITE_PATH` 指定的现有数据库。

原有 npm 命令仍可使用（`dev:server` 读取 `.env`，Make 开发入口使用 `.env.local`）：

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
