# 算力集市 · 阶段 2b（容器工作台内测）

闲置 GPU 撮合市场的本地内测应用。支持模拟交易、受邀 Docker CPU/GPU 租用、Notebook、PyTorch CUDA 终端、成果归档和跨订单文件恢复。**没有充值或真实支付。**

## 当前新增：长时 Python 任务

已进一步增加[长时 Python 任务](docs/task-guide.md)：提交脚本后查看状态、实时日志、手动停止，默认 120 秒、最多 600 秒；页面关闭后继续，订单结束销毁。日志保留最近一次任务的前 16 KiB，可下载。现有机主端需重启加载 agent 0.6.0，并在新订单使用；镜像不用重建，数据库仍为 v5。

## 当前新增：把历史成果恢复到新订单

在新的真实订单工作台选择“历史成果”，预览文件去向后确认恢复。重名文件另存副本，不覆盖现有文件；连接中断保留恢复记录，同计划重试复用相同内容。支持脚本、Notebook 和二进制文件，只恢复文件，不自动执行或恢复内核状态。规则见 [成果恢复指南](docs/restore-guide.md)，验收见 [本轮记录](../docs/成果恢复-开发与验收记录.md)。

数据库升级为 v5，升级前自动备份；已接入机器需要重启 agent 加载 0.5.0 协议，无需重建镜像。新订单仍按原规则计费，归档和恢复内测免费。

## 当前新增：PyTorch CUDA 实际计算

新增单卡 PyTorch 2.10.0+cu128 终端模板，已在本机 RTX 5050 Laptop 完成 CUDA 矩阵乘法和自动求导校验。先运行 `npm run image:pytorch`、`npm run gpu:check`，在“我的机器”选择该环境，或将空闲且清理完成的单卡 GPU 机器切换为 PyTorch CUDA，再按新凭据弹窗重启 agent。

环境在实际计算校验通过后才就绪计费。工作台提供 `python gpu_check.py` 示例，生成 `gpu_result.json`，可在结束前保存成果快照。固定版本和全部依赖摘要，沿用受邀内测规则；单条命令仍限 15 秒，不是长时训练入口，Notebook 仍为独立模板。详见 [PyTorch 使用指南](docs/pytorch-guide.md) 与 [本轮验收记录](../docs/GPU计算-开发与验收记录.md)。

## 当前新增：计算成果归档

租用期间在工作台点击“保存成果快照”，订单结束后从“我的订单→查看成果”下载 ZIP。内测免费，保留 7 天；每单最多 3 份、单文件 1 MiB、每份 4 MiB / 100 个顶层普通文件、每账户 64 MiB。隐藏文件忽略，目录或链接会使保存失败。必须在租用结束前手动保存成功，详见 [成果归档指南](docs/archive-guide.md)。归档由 v4 引入，当前数据库为 v5，旧数据自动备份；现有 agent 需重启加载恢复协议。

## 当前新增：JupyterLab Notebook

已增加 JupyterLab + NumPy 模板：`npm run image:notebook` 构建后，在“我的机器”选择 Notebook 环境，或将已空闲清理的 Docker 机器切换为 Notebook。按新凭据弹窗重启 agent，租客从工作台打开。

支持原生 Notebook 运行、保存和下载；页面会等待真正的计算内核就绪。订单结束后容器文件删除，已保存的成果快照可继续下载，也可在新订单预览后恢复。详见 [Notebook 使用指南](docs/notebook-guide.md)。交互式 PTY、长时模型训练、多卡隔离与公网运营仍未验证。

## 前序交付：容器工作台

已加入 Docker CPU/GPU 执行器、反向 WebSocket、一次性访问票据、xterm 命令终端、文本脚本上传与结果下载。真实容器资源需要机主邀请测试账号；本机已识别并验证 RTX 5050 Laptop GPU。以下旧阶段说明中的“仅模拟”仅适用于 mock 模式，旧演示挂牌没有工作台。

完整操作和限制见 [Docker 与工作台指南](docs/workspace-guide.md)。Python 轻量模板默认使用标准库；Notebook 与 PyTorch 使用各自镜像。尚无交互式 PTY，仍不涉及真实资金。

## 保留：模拟机器接入

本节说明 mock 接入演示。mock 模式不启动真实 GPU 或容器；旧的四页交易演示保留。

1. 登录后打开 `/machines`，登记机器名、模拟卡型/卡数及位置。
2. 弹窗只展示一次凭据，并给出不含凭据的 PowerShell 命令。打开第二个终端，进入 app 目录，按弹窗设置 AGENT_MACHINE_ID、MOCK_GPU_MODEL、MOCK_GPU_COUNT，执行 `npm run agent:mock`（仅模拟），在提示后粘贴凭据。
3. 页面显示在线后，设置价格并发布机器挂牌。使用另一隔离浏览器账户租用。
4. 准备中不计费，ready 后开始计费并获得完整租用时长；准备中取消全退。旧演示挂牌立即 ready，不必启动 agent。
5. 提前结束：先结算，agent 确认停止后释放卡位；断开 agent 超过 30 秒后订单失败全退，卡位在清理确认前隔离。重新运行 agent 后自动对账。
6. 停用/轮换凭据会终止该机进行中的订单并全退。旧凭据立即失效；重新生成凭据和注册后才能恢复接单。

故障注入可在启动 CLI 前设置：MOCK_FAIL_START=once（首轮失败后重试成功）、always（两次均失败，退款）；MOCK_START_DELAY_MS=8000（观察准备过程）。AGENT_SERVER 默认 http://127.0.0.1:3001 。令牌可来自 AGENT_TOKEN 环境变量，勿写入脚本或仓库。

注册、任务轮询与心跳使用 HTTP，工作台另走认证反向 WebSocket。mock 模式只接受 MOCK- 前缀的模拟 GPU；真实硬件需按工作台指南选择 Docker 执行器，不能伪造为 mock 接入。

## 启动

环境：Node.js 20.19+（推荐本机 Node 24）、npm。首次进入本目录运行：

```powershell
npm install
npm run dev
```

打开 http://127.0.0.1:5173 。前端端口 5173，API 端口 3001，均只监听本机。前端通过 Vite 代理访问 API。首次启动自动生成四张模拟挂牌。Windows 若无法使用 better-sqlite3 预构建包，需安装 Visual Studio C++ 构建工具与受支持的 Python，再重新 npm install；本次本机安装成功，无需降级。

## 演示

1. 普通窗口登记“城南新机主”，密码至少 8 字符，赠送 ¥100 虚拟额度。
2. “我要出租”：RTX 4090 / 2 卡 / ¥2.00 / 江苏 · 南京，发布。
3. 隐身窗口登记另一个昵称，或点“一键体验”。一键体验每次创建独立访客账户，不能用于重新登录旧访客。
4. 市场找到新挂牌，租用 1 卡 2 小时，预付 ¥4.00。
5. 订单中点击“提前结束并结算”，确认；不足一分钟按一分钟计费，按本项目的舍入规则扣 ¥0.03，退 ¥3.97。
6. 租客钱包显示 ¥99.97；机主钱包显示 ¥100.03，实际扣费的 85% 舍入后为 3 分，平台余数为 0 分。极小金额会出现比例舍入效应。
7. 机主下架挂牌，不影响进行中租用；重新上架恢复可租。

## 计费规则

数据库金额为整数分，时间为 UTC 毫秒。预付=单价分×卡数×整数小时（1–72）。实际计费秒数=向上取整实际耗时秒，最低 60 秒，结束时间最多取计划到期时间。费用=单价分×卡数×计费秒数÷3600，整体四舍五入到分且不超预付。机主收入按扣费×85% 四舍五入到分；平台费取差额以保证分账守恒。

文档中的 2 卡×¥2×65 秒：实际费用 7 分，机主 6 分，平台 1 分。“85%”是机主收入分成，不是租客折扣。没有逐秒先舍入单价。详情见 DECISIONS.md。

## 迁移、备份与恢复

启动时按 schema_migrations/user_version 升级至版本 5（成果恢复记录，升级前生成 before-v5.bak）；版本 4 增加成果归档并生成 before-v4.bak，版本 3 增加环境模板，版本 2 增加工作台访问与邀请。旧库首次升级前通过 SQLite VACUUM INTO 生成包含已提交 WAL 数据的 `data/market.sqlite.before-v1.bak`；迁移失败回滚并停止启动。既有账户、订单、归档与账本保留。

`npm run backup` 使用 SQLite backup API 在线生成一致备份，也可 `npm run backup -- ./data/backups/manual.sqlite`。恢复时先停止服务，将备份还原到一个全新的数据库路径，以 DB_PATH 指向该文件再启动，确认余额、订单和流水后切换；不要把旧 WAL 文件与恢复后的主库混用。备份包含账户哈希和余额，不应公开。

`GET /api/health` 检查数据库可读性及 schema_version；每个 API 响应含 X-Request-Id。订单执行记录为持久化事件，不包含接入凭据。

## 数据与重置

- 数据文件 `data/market.sqlite`（WAL 模式），重启保留账户、余额、订单、流水。
- `npm run seed` 只在没有账户时生成示例，不覆盖已有数据。
- 开发环境登录后，页脚“重置演示数据”→二次确认，将删除所有本机演示数据并恢复四张挂牌。
- 备份数据库时先停止服务，或使用 SQLite backup API；不要只复制仍在写入的主文件而遗漏 WAL。
- 未设置 JWT_SECRET 时每次进程重启生成临时签名密钥，需要重新登录；业务数据不受影响。生产必须通过环境变量配置 JWT_SECRET。
- `.env.example` 为变量说明；程序读取系统环境变量，不自动加载 `.env`。

## 验证

```powershell
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Vitest 验证计费、认证、边界参数、越权、余额不足、并发占位、下架、幂等、到期扫描、数据库关闭重开。Playwright 使用两个隔离浏览器会话完成挂牌→租用→结算→双方钱包，并检查四个页面的手机横向溢出与控制台。截图保存在上级 `docs/shots/`。端到端测试单独使用端口 5183/3011 和 每轮独立的 `data/e2e-进程号-时间.sqlite`，不会写入演示应用的数据库。Windows 自动优先使用已安装的 Chrome，无需下载；其他环境使用安装的 Playwright Chromium，也可设置 PLAYWRIGHT_CHANNEL。

完整硬件回归要求 Docker、NVIDIA GPU 和两个场景镜像就绪，再设置以下标志；未设置时对应硬件测试会跳过，不能计作通过：

```powershell
$env:RUN_DOCKER_TESTS='1'
$env:RUN_NOTEBOOK_TESTS='1'
$env:RUN_GPU_TESTS='1'
$env:RUN_PYTORCH_TESTS='1'
npm test -- --maxWorkers=1 --no-file-parallelism
npm run test:e2e
```

## 目录

- `server/db.ts`：建表、整数计费、账本、事务结算。
- `server/app.ts`：认证与业务 API、入参校验、种子数据。
- `server/index.ts`：服务入口、每 1 秒扫描到期订单、启动时补结算。
- `src/main.tsx`、`src/style.css`：四页 React 应用及票据视觉。
- `tests/trading.test.ts`、`tests/e2e/trade.spec.ts`：自动化验证。

新增实现见 `server/orders.ts`、`server/machines.ts`、`server/migrations.ts`、`agent/mock.ts`、`src/MachinesPage.tsx` 和 `src/OrdersPage.tsx`。机器与 agent API 详见 [协议](docs/agent-protocol.md)。

## API

所有写请求需 `Content-Type: application/json`，接口错误统一 `{code,message}`；参数错误另含 details。

- `GET /api/me` 当前账户、服务端时间和开发模式。
- `POST /api/auth/register`、`POST /api/auth/login`：nickname/password。
- `POST /api/auth/logout`、开发专用 `POST /api/auth/demo`：空对象。
- `GET /api/market`：挂牌及市场汇总。
- `GET /api/listings/mine`、`POST /api/listings`：我的挂牌、创建。
- `PATCH /api/listings/:id`：status=active/paused，仅机主。
- `GET /api/orders`、`POST /api/orders`：自己的租用订单、创建（listing_id/gpus/hours），支持 Idempotency-Key 请求头，前端已使用。
- `POST /api/orders/:id/finish`：空对象，仅租客，重复调用返回原结算。
- `GET /api/wallet`：余额、累计净支出、供给收入与流水。
- 开发专用 `POST /api/dev/reset`：登录且传 confirm=RESET。

## 部署及限制

当前交付本地内测应用。`npm run build` 后设置 NODE_ENV=production 和 JWT_SECRET，再 `npm start`，由 Express 在 3001 同时提供页面与 API；生产 Cookie 为 Secure，必须经本机 HTTPS 反向代理使用，代理应传递原始 Host 和 X-Forwarded-Proto，Express 仅信任 loopback 代理。演示登录与重置接口在生产禁用。上线前还需完成服务运维、账户恢复、监控、外部来源配置、规模化分页、独立 Notebook 域隔离与陌生用户隔离。真实 GPU 工作台仅向受邀账号开放，尚未完成公网部署验收。

服务端每 1 秒结算到期订单；请求市场、订单、钱包时也补扫描，进程关闭期间无法执行，重启后按原到期时间补结算。前端倒计时只是服务端时间偏移的展示，最终费用只由服务端计算。SQLite 使用 BEGIN IMMEDIATE 数据库写锁，适用于单机阶段 1，不声称具有行级锁。
