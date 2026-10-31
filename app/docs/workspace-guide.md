# Docker 与订单工作台 · 内测接入

更新：2026-10-29。本轮完成命令与文本文件工作台，包含 mock、Docker CPU、Docker NVIDIA GPU 三种执行模式。未包含 JupyterLab、交互式 PTY、SSH、联网下载模型或真实支付。

## 已验证环境

本机实际检测到 NVIDIA GeForce RTX 5050 Laptop GPU，nvidia-smi 报告 8151 MiB；登记名称使用 RTX 5050 8G。Docker Desktop 的 Linux 引擎已启动，指定 UUID 的容器内 nvidia-smi 可以识别该卡。

原交接包中的“无 GPU”描述已不符合当前实测。本轮只进行硬件识别、短时间 Python 与文件测试，没有运行模型训练、GPU 压力测试或验证多卡隔离。

## 准备

1. 启动 Docker Desktop，确认 `docker version` 包含 Server。
2. 拉取固定工作台镜像：

```powershell
docker pull python@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159
npm run agent:doctor
```

镜像摘要为本轮实际拉取的 python:3.12-slim 对应摘要；执行器固定使用该摘要，不允许租客指定镜像或自行挂载宿主目录。真实 GPU 还需宿主 NVIDIA 驱动与 Docker GPU 支持；Windows 使用 WSL2 后端，Linux 按 NVIDIA Container Toolkit 官方安装流程配置。

## 机主接入

1. 启动 `npm run dev`，登录后进入“我的机器”。
2. 选择执行模式：模拟调度、Docker CPU 沙箱或 Docker NVIDIA GPU 内测。
3. CPU 沙箱：卡型选 CPU 沙箱，逻辑计算位 1。GPU：卡型和卡数必须与探测结果匹配；本机选 RTX 5050 8G、1 卡。
4. 登记后按弹窗命令设置 AGENT_EXECUTOR、AGENT_MACHINE_ID、MOCK_GPU_MODEL、MOCK_GPU_COUNT，再运行 `npm run agent`，在提示时粘贴凭据。MOCK_ 前缀变量保留为兼容配置，Docker 硬件清单来自实际探测，不伪造。
5. 机器在线后设置单价并发布挂牌。新模型没有添加市场定价结论，仍由机主在原范围内设置。
6. Docker 资源必须填写已注册租客昵称并点击“授权容器测试”，未受邀账号下单返回 403。演示赠送额度不会自动获得真实资源租用权。

仅限本机/受控内测。平台 API 默认监听 loopback，不代表已支持公网部署或陌生用户共享宿主机。

## 租客使用

1. 受邀账号租用对应挂牌，准备好后在“我的订单”点击“打开工作台”。
2. 工作台通过 agent 主动发起的认证 WebSocket 转发操作，机主不需要开放工作台端口。
3. 编辑默认 example.py，保存到工作目录，输入 `python example.py` 执行。容器内 Python 可使用标准库，未安装 PyTorch、CUDA Python 库等模型依赖。
4. 可以通过本地文件选择器导入文本脚本，保存后执行；生成的文本结果可下载。
5. GPU 环境可运行 `nvidia-smi --query-gpu=name --format=csv,noheader` 验证识别。mock 终端明确标为模拟，只有 help/pwd/ls/nvidia-smi 等演示命令，不执行宿主代码。
6. 结束租用即失去访问权限；容器删除后工作目录也删除，需提前下载结果。

## 当前资源限制

- 每单 1 CPU、512 MiB 内存、64 个进程；工作目录 tmpfs 64 MiB、临时目录 32 MiB。
- 容器无外网、只读根文件系统、no-new-privileges，不挂载宿主目录或 Docker socket，不映射宿主端口。当前在丢弃全部 capabilities 后，仅为 root 任务监督器增加 SETUID/SETGID；实际租客代码有效 capabilities 为 0，详见[任务指南](task-guide.md)。
- 浏览器命令以容器内 UID/GID 1000 执行。宿主只通过参数数组调用 Docker CLI，不将用户命令传给宿主 shell。
- 命令逐条执行，容器内 timeout 15 秒；不是交互式 shell 会话，cd 不跨命令保存，建议直接使用 /workspace 下的相对路径。
- 单次输出上限 120KB。支持普通 UTF-8 文本文件，单文件 8KB；文件名仅字母、数字、下划线、点和横线，不支持子目录。读写禁止跟随符号链接。
- 容器内 PID 1 是租约看门狗；租约存放于 root 专属目录，普通终端用户不能修改。更新采用原子替换，agent 退出后容器仍会按最后的租约到期退出。
- 目录大小与内存限制不是恶意多租户场景的完整安全保证；本轮只向已邀请账号开放本机测试。

## 访问与接口

- `GET /api/orders/:id/workspace`：只允许租客；返回模式、连接状态与是否关闭，不暴露内部地址和 agent 凭据。
- `POST /api/orders/:id/workspace/tickets`：产生 30 秒有效、仅当前用户/订单可用的票据。
- `POST /api/orders/:id/workspace/sessions`：一次性兑换票据为最多 15 分钟的访问会话，不超过订单到期时间。
- `POST /api/orders/:id/workspace/actions`：session 和 action；action 为 command/list/read/write。
- `/api/agent/tunnel`：agent 发起的 WebSocket Upgrade，Bearer 凭据认证；拒绝浏览器 Origin，不把接入凭据交给租客。
- 所有访问票据、会话和 agent 凭据在数据库只保存哈希。每次操作重新检查登录、订单、会话；订单结束后在途结果也不再返回。
- CPU/GPU 资源邀请：`POST /api/machines/:id/invitations`，机主传已注册 nickname。当前仅提供授权，撤销可先停用机器或轮换凭据；细粒度邀请管理留后续。

## 自动化验证

```powershell
npm run build
npm test
$env:RUN_DOCKER_TESTS='1'
npm test
$env:RUN_GPU_TESTS='1'
npm run test:e2e
```

普通 npm test 不要求 Docker，会跳过 Docker 真实执行用例；RUN_DOCKER_TESTS 启用真实沙箱测试，RUN_GPU_TESTS 启用本机 RTX 5050 的浏览器验收。其他机器需调整 GPU 端到端测试的预期型号后再运行，不要把跳过用例计为通过。

测试每轮生成独立 e2e-进程号-时间.sqlite 数据库；容器带 bazaar.scope、bazaar.machine、bazaar.order 标签，控制面地址生成的命名空间避免同号冲突。请保持 agent 控制面地址稳定，更换地址前先结束旧订单。结束后按标签核验并删除这些容器，不触碰其他容器。

## 后续

已加入 JupyterLab + NumPy、PyTorch CUDA 终端、成果快照和[跨单文件恢复](restore-guide.md)。下一步完善任务运行体验，验证断网/强杀 agent 的真机恢复、多卡可见性和独立机主网络访问。公网内测前还需完善凭据实例隔离、审计、邀请撤销和部署运维，不将当前受控本机验收当作开放运营验收。

官方参考：[Docker 运行资源限制](https://docs.docker.com/engine/containers/run/)、[Docker Desktop GPU](https://docs.docker.com/desktop/features/gpu/)、[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)、[xterm.js addons](https://xtermjs.org/docs/guides/using-addons/)。
