# PyTorch CUDA 终端

这个模板用于受邀的单卡 GPU 计算实验，提供 PyTorch 2.10.0 + CUDA 12.8、NumPy 2.3.5。它使用命令工作台；现有 JupyterLab + NumPy 模板继续独立提供，不自动带上 PyTorch。

## 接入与使用

在 app 目录执行：

```powershell
npm run image:pytorch
npm run gpu:check
```

首次构建下载约 4 GB 的官方 wheel，还需为安装后的镜像和 Docker 构建缓存预留额外磁盘空间。构建工具读取已记录的版本与 SHA-256，分段下载并校验完整文件，再在镜像内通过 `pip --no-index --require-hashes` 离线安装；重复运行会重新核对并复用缓存。下载缓存位于 `images/pytorch/wheels`、`numpy-wheels`，本轮验收日志位于 `data/pytorch-build`，均不提交到仓库；请勿将这些缓存和租客成果混为一谈。

`images/pytorch/requirements.lock`、`numpy.lock` 与 `wheels.lock.json` 一同固定 29 个发行包及来源，面向当前 Linux amd64 / CPython 3.12 镜像，不是任意平台通用锁。NumPy 单独锁定安装层，避免补齐数组依赖时重复解压完整 CUDA 环境。使用 PyTorch、NVIDIA、Python 官方分发源；Triton 固定为 PyTorch 官方 CUDA 分发的 wheel，同版本同文件名的 PyPI wheel 不能直接替代，SHA-256 不同必须拒绝。锁文件必须完整且相互一致，构建不自动解析新版本或改写锁文件，不能因镜像下载失败自动放宽校验。

首次安装解压大文件会增加 Docker/WSL 内存占用。若出现 `EOF` 且 Windows 日志同时报告虚拟内存不足，应先降低构建环境内存上限或释放内存，再复用缓存重试；无需清空镜像、卷或业务数据库。本机验收使用临时 WSL 4 GB 内存上限，结束后恢复原配置。WSL 配置影响全部发行版，修改前须核对其他任务，参考 [Microsoft WSL 配置说明](https://learn.microsoft.com/windows/wsl/wsl-config)。

1. “我的机器”选择 Docker NVIDIA GPU 模式，单卡，环境选择 PyTorch 2.10 + CUDA 12.8 终端；已有单卡 GPU 机器可在订单结束且清理完成后点击“切换为 PyTorch CUDA”。
2. 使用新凭据弹窗的命令启动 agent，其中 `AGENT_EXECUTOR=docker-gpu`、`AGENT_TEMPLATE=pytorch`。模板切换会撤销旧凭据，需要重启 agent。
3. 机主邀请已注册租客，再发布挂牌。租客下单后环境先准备，校验成功才 ready 并开始计费；镜像、驱动或 CUDA 校验失败沿用准备失败重试与全额退款流程。
4. 工作台中点击“填入 GPU 示例命令”，再执行 `python gpu_check.py`。结果写入 `gpu_result.json`，可在文件面板打开，也可保存成果快照，结束订单后从历史订单下载 ZIP。

## 校验了什么

容器内的只读检查脚本要求 PyTorch 2.10.0+cu128、CUDA 12.8、CUDA 实际可用、且只看到一个分配的设备。它在 GPU 上做以下很小的计算并核对结果，随后调用 CUDA 同步确认执行完成：

- `[[1,2],[3,4]] @ [[5,6],[7,8]]` → `[[19,22],[43,50]]`。
- 对 `[1,2,3]` 的平方和求梯度 → `[2,4,6]`。

`gpu_result.json` 包含版本、设备名称、计算能力、设备数、张量所在设备、矩阵和梯度结果。不允许 CUDA 不可用时回退 CPU 后宣称成功。

每个新订单在报 ready 前运行该检查。通过标记写入租约目录，普通用户不能伪造；重复启动已校验的订单不重建容器。校验失败会清理当前容器，防止重试跳过失败的准备步骤。CUDA 准备检查在容器内限时 30 秒，宿主调用限时 35 秒；此模板启动任务的未回报重投间隔为 45 秒，避免原有 20 秒重投提前使回报失效。整体仍受 60 秒准备截止时间约束，最多尝试两次；失败或取消不收取准备等待费用。用户目录中的示例和 JSON 可编辑，代表本次实验文件；它们不是防篡改审计证明。

## 边界

- 单卡独占调度，1 CPU、2 GiB 容器主内存、128 进程；2 GiB 不是 GPU 显存额度。当前没有显存配额或 MIG 分区能力。
- 运行容器无外网、只读根目录、命令 UID 1000、无宿主挂载和端口、租约看门狗仍生效。镜像构建下载官方依赖时会联网，安装步骤只读挂载已校验的构建缓存；租客容器不挂载宿主目录。
- 工作目录 64 MiB，临时目录 32 MiB；单条命令 15 秒。适合小实验，不是长时训练入口。
- 不预装模型权重、torchvision、torchaudio、数据集或完整训练平台。单卡校验不证明所有模型、所有显卡、多卡通信、GPU 性能或生产隔离都已验收。
- 结果归档沿用 7 天、每单 3 份、每文件 1 MiB、每份 4 MiB / 100 个顶层普通文件、每账户 64 MiB 规则。结束前必须手动保存成功。
- 未增加收费或修改结算。PyTorch 模板本身无需迁移；随后加入的跨单成果恢复使当前数据库升级至 schema v5，见[恢复指南](restore-guide.md)。旧机器默认 Python。

官方版本依据：[PyTorch 历史版本安装说明](https://pytorch.org/get-started/previous-versions/)、[NVIDIA GPU 计算能力表](https://developer.nvidia.com/cuda/gpus)。实际是否可用仍以本机容器 CUDA 测试结果为准。
