# Notebook 工作台 · 本机内测指南

更新：2026-10-29。本轮在轻量终端之外新增原生 JupyterLab，可运行、保存和下载 Notebook；不涉及真实支付。

## 使用方式

1. 在 app 目录运行 `npm run image:notebook`。首次构建会联网安装依赖；租用容器启动后断网，不再在线安装。
2. “我的机器”选择 Docker CPU 或 Docker GPU 模式，环境模板选择“JupyterLab + NumPy Notebook”。
3. 已有 Docker 机器可点击“切换为 Notebook”；必须先结束全部订单并等待卡位清理。切换会撤销旧凭据，按新弹窗设置 AGENT_TEMPLATE=notebook 并重启 agent。
4. 机器上线后挂牌，授权已注册的测试租客。租客下单，环境就绪后开始计费。
5. 租客从订单打开工作台，再点“打开 JupyterLab”。默认打开 welcome.ipynb，其中含中文说明与 NumPy 示例。
6. 等待工作台显示“Notebook 内核已就绪”再操作。页面下载完成和计算内核就绪是不同状态；准备期间页面会阻止误操作。
7. 运行示例单元格会得到“计算结果：45”。JupyterLab 支持编辑、保存、重开 Notebook 与下载；也可使用“独立窗口打开”。原生 JupyterLab 菜单当前为英文，外围产品页面为中文。
8. 容器工作目录在订单结束或失败清理后会删除。请提前下载，或在工作台手动保存成果快照；保存成功后可在历史订单下载，保留 7 天。新订单可预览后恢复这些文件，重名另存副本，不恢复内核或自动断点续训，见[成果恢复指南](restore-guide.md)。

## 模板与资源

- Python 轻量终端：沿用原基础镜像，不强制安装 Notebook。
- Notebook 模板：JupyterLab 4.6.3、ipykernel 6.30.1、NumPy 2.3.5、websocket-client 1.9.0。
- Dockerfile 基于已固定摘要的 Python 3.12 slim；启动时解析本机构建镜像的不可变 ID 并使用该 ID，不使用租客指定镜像。
- 本轮构建 ID：sha256:9a7ef15253d7fff8cc407705d81897beb71035b3b2a56cba2332b265bb4c8c0d。重新构建可能生成不同 ID，应重新验证。
- `images/notebook/requirements.resolved.txt` 是已测试镜像完整依赖版本快照，不等于所有发行包文件都已做哈希锁定。
- Notebook 模板 1 CPU、1GiB 内存、128 进程；NumPy/OMP 默认单线程。工作目录 64MiB、临时目录 32MiB，根文件系统只读，不映射宿主端口、挂载宿主目录或开放外网。
- JupyterLab 以容器 UID 1000 运行，独立租约看门狗仍为 root PID 1，普通用户不能延长租约。禁用 Jupyter 内置终端，保留平台提供的受限逐条命令入口。
- Notebook 代理写入正文上限 1MiB、单次读取结果上限 8MiB、内核单帧上限 1MiB。原轻量文件面板仍是 8KiB 文本文件限制；较大 Notebook 应通过 JupyterLab 保存和下载。

## 访问链路

浏览器 → 平台订单鉴权 → agent 的反向 WebSocket → 容器内本地 Jupyter。HTTP 页面/资源请求与内核 WebSocket 均经过同一受控链路，不要求机主开放公网端口。

- `POST /api/orders/:id/notebook/open` 使用已有工作台访问会话，设置仅该订单路径可用的 HttpOnly、SameSite=Strict Cookie，并返回 Notebook 页面地址。
- Notebook HTTP 与 WebSocket 同时验证平台登录、租客归属、订单状态、模板和访问会话。机主和其他租客不能进入该订单 Notebook。
- Jupyter 内部认证令牌由容器生成，仅内部中继使用；不把 agent 凭据或内部认证令牌交给浏览器。
- HTTP 最多保留 64 个待处理请求，每单同时转发最多 8 个读请求；写操作独占，读取等待写入结束，避免自动保存时读到暂存内容。请求有超时。每单允许最多 8 个内核/事件 WebSocket 连接，超额拒绝。
- 每条内核连接使用独立中继。上游连接就绪前暂存少量帧，防止首次初始化消息提前丢失；二进制 v1 内核协议保留。
- 订单结束、平台退出登录、访问会话到期或 agent 断线，会关闭相应连接。结束后的 HTTP 请求也会被拒绝；计费与资源清理沿用既有规则。
- 会话最长 15 分钟且不超过租用到期时间。会话过期后返回工作台，刷新页面并重新打开 Notebook；本轮未实现静默续期。
- 只在受控本机/受邀内测使用。公网开放前需要将不可信 Notebook 放到独立隔离域，完善来源策略、运维及多租户隔离；当前同源嵌入不是陌生用户共享宿主机的生产方案。

## 验证命令

```powershell
npm run build
npm test
$env:RUN_DOCKER_TESTS='1'
$env:RUN_NOTEBOOK_TESTS='1'
npm test
$env:RUN_GPU_TESTS='1'
npm run test:e2e
```

不启用 Docker/Notebook 标志时，对应真实容器测试会跳过，不能算作通过。Notebook 真实测试运行 CPU NumPy 计算，覆盖 REST、内核连接和原生浏览器界面；GPU 旧工作台测试仍只识别设备，没有验证 CUDA/PyTorch 模型计算。

## 数据升级与后续

数据库版本 3 增加 machines.environment_template，旧机器默认 python。迁移前生成 before-v3.bak，保留旧账户、订单与账本。模板切换不更改卡型、价格和分成。

已增加手动成果归档与新订单文件恢复：先保存 Notebook，再保存快照，7 天内可下载或在新订单预览后恢复；规则与容量见 [成果归档指南](archive-guide.md)和[恢复指南](restore-guide.md)。PyTorch CUDA 已作为独立终端模板验证。下一步在独立机主机器上做断网、强杀与重连演练，长时任务另行设计。当前不承诺模型训练或公网运营。
