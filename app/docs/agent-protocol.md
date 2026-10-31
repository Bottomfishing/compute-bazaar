# Mock agent 协议 v1

本轮仅供本地调度演示，不执行真实 GPU、容器、终端或宿主命令。默认控制面为 http://127.0.0.1:3001。所有写请求 JSON；agent 请求携带 Authorization: Bearer 加接入凭据。不得把实际凭据写进示例、截图、日志或仓库。

## 注册与机器管理

- 用户端 `POST /api/machines`：name、gpu_model、gpu_count、region；只创建 mock 机器，初始 offline。
- 用户端 `GET /api/machines/mine`：本人的机器、GPU、占用、最近心跳和关联挂牌。
- 用户端 `POST /api/machines/:id/credentials`：空对象，返回 token 和 machine_id；旧凭据撤销，运行单全退，机器离线等待新注册。
- 用户端 `POST /api/machines/:id/disable`：空对象，撤销凭据、停用机器、运行单全退。
- `POST /api/listings` 可用 machine_id、price_cents_per_hour、note 绑定已上线机器；卡型、数量和位置从该机器读取，不能伪造。每台 mock 机器仅一张挂牌。

## Agent 请求

### POST /api/agent/register

请求字段：version（版本字符串）、gpus（uuid、gpu_model、vram_gb）、active_orders（本进程实际运行的模拟订单 ID 数组）。

GPU UUID 必须以 MOCK- 开头。CLI 使用 MOCK-机器ID-GPU-序号，重启后保持稳定；数量、型号和显存必须与登记一致。首次注册持久化库存，此后 UUID 不允许替换，且不能重复属于另一台机器。

返回 machine_id、heartbeat_ms=10000、server_now。注册同时对账：已 ready 的任务若不存在，订单失败全退；终态且确认无运行任务时释放隔离卡位。此“清单即确认”策略仅适用于 mock，真实执行器必须提供实际容器盘点和清理证明。

### POST /api/agent/heartbeat

请求 active_orders 数组，每 10 秒发送；返回 leases 与 server_now。leases 含 id、execution_status、ends_at、preparation_deadline。超过最后一次心跳 30 秒视为掉线；控制面每秒扫描，另有运行调度容差。

迟到心跳先执行超时结算，不会通过刷新在线时间跳过退款。CLI 用服务端租约更新本地看门狗，租约过期即停止模拟任务。准备中的租约与实际运行租约不同。

### GET /api/agent/jobs

CLI 每 1 秒轮询，返回最多 20 条任务，停止任务优先。字段：id、order_id、machine_id、kind（start/stop）、attempts、deadline、gpu_uuids、lease_ends_at 等。

任务和投递状态在 SQLite 中持久化。每次领取使 attempts 加一，默认 20 秒未确认可再次投递；新增 PyTorch CUDA 模板的 start 任务为 45 秒，以容纳容器内 30 秒 / 宿主 35 秒的实际计算校验。启动任务最多投递两次，准备总截止时间仍为 60 秒。停止任务在收到确认前持续按 20 秒重投，不因次数耗尽释放资源。

同一逻辑任务的 id 不变，agent 应按任务 ID 幂等执行；每次回报带对应 attempts，旧投递的迟到回报不能改变新状态。CLI 仅维护模拟任务内存；重启后通过注册对账将丢失的运行任务退款，不伪装任务仍在运行。

### POST /api/agent/jobs/:id/report

字段 attempt、result、可选 message（最多 300 字）。start 允许 ready/failed，stop 只允许 stopped。

- ready：订单仍 running/preparing 才能进入 ready，记录 ready_at，ends_at=ready_at+购买时长。准备等待不计费。
- failed：第一次允许再试一次；最后一次失败全额退款，不产生机主收入。
- stopped：资金终态后才允许确认；释放该单的 GPU 分配，执行状态变 cleaned。
- 重复成功回报不再次入账；未领取、过期尝试或取消后的 ready 返回 409。其他机器任务回报 403。

## 订单与资金

交易状态仍是 running → finished/failed；执行状态是 preparing → ready → stopping → cleaned，也允许准备失败/取消直接进入 stopping。

下单在单个立即写事务内校验库存和余额、预留具体 GPU、预付、创建启动任务。前端使用 Idempotency-Key 请求头；相同租客、key 和参数返回同一订单；相同 key 的不同参数返回 409。

准备中主动结束：扣费为零，全退；ready 后结束：最低一分钟，按整数分规则结算。机器掉线、被停用或最终启动失败：当前仍运行的订单全退。已经完成的资金终态不会被迟到消息重新改写。

退款后卡位进入 quarantined，等待 stop 确认或 mock 完整任务清单确认无残留。市场可租数排除所有未 released 分配，也排除离线机器。清理阶段即使余额已退也不重新出租同一张卡。

`GET /api/orders/:id/events` 仅订单租客和机主可访问，返回事件与 GPU UUID/分配状态。旧阶段 1 演示挂牌保持 demo 模式，可立即就绪，不需要 agent。

## 故障演示

- MOCK_FAIL_START=once：第一次启动失败，第二次成功。
- MOCK_FAIL_START=always：两次失败，订单全退。
- MOCK_START_DELAY_MS=8000：观察准备状态和取消行为。
- 退出 CLI 并等待超过 30 秒：控制面判离线、订单失败退款。
- 再启动相同配置的 CLI：注册对账，确认无旧模拟任务后释放卡位。
- 禁用/轮换凭据：旧 CLI 收到 401，停止模拟任务；重新生成凭据并启动后恢复。

## 未包含的能力

本协议不提供 WebSocket 反向隧道、工作台访问票据、真实驱动探测、Docker 执行器、持久化任务计算状态、真实机主/租客隔离。下一阶段需要在受控机器上验证这些能力，不能直接把 mock 凭据接口当作生产接机认证系统。

## 当前扩展：成果恢复（agent 0.5.0）

上方“未包含能力”是 mock 初版记录；真实执行与反向连接见 workspace-guide.md。现在内部工作台协议增加 restore_probe（最多 200 个候选名）和 restore（绑定 request_id 与已验证文件清单）。控制面只经独立恢复路由下发，agent 在订单容器内以 UID 1000、stdin JSON、12 秒上限执行。结果含 existing 或 restored.created/reused/conflicts。旧 agent 需重启，不需重新构建镜像。完整规则见 restore-guide.md。
