# PyTorch CUDA 终端 · 开发与验收记录

日期：2026-10-29（Asia/Shanghai）

本轮交付受邀单卡 GPU 的最小实际计算闭环：选择模板 → 接入机器 → 租用 → 校验 CUDA → 就绪计费 → 网页执行 → 手动归档 → 结束清理 → 历史订单下载。计算使用本机显卡，原有交易和存储规则保留。

## 已交付

- 新增 PyTorch 2.10.0+cu128 / CUDA 12.8 / NumPy 2.3.5 终端模板，Python 与 JupyterLab + NumPy 模板继续独立提供。
- “我的机器”可创建该模板，或将无运行订单且已清理的单卡 Docker GPU 机器切换为 PyTorch。切换撤销旧凭据，需按新命令重启 agent。接口与 agent 均校验模板和执行模式一致，拒绝 CPU、mock 和多卡登记使用此模板。
- 使用固定 Python 基础镜像及全部 29 个发行包的版本、官方来源和 SHA-256。构建读取三个锁文件，不自动更新版本；下载完整校验后，分层执行 pip --no-index --require-hashes 离线安装。启动时使用本地镜像不可变 ID。
- 每个新环境在 ready 前执行只读 GPU 检查脚本：版本、CUDA 实际可用、设备数为一、GPU 矩阵乘法、GPU 自动求导及同步完成。失败清理容器，不回退 CPU。成功标记位于用户不可写的租约目录；重复启动已验证环境保留原容器和文件。
- PyTorch start 未回报重投间隔由默认 20 秒改为 45 秒，以容纳容器内 30 秒 / 宿主 35 秒的检查上限。总准备截止仍为 60 秒、最多两次；沿用 ready 后计费及准备失败全退。stop 仍按 20 秒重投。
- GPU 工作台增加模板说明和示例命令入口，生成 gpu_check.py 与 gpu_result.json。可直接查看/下载文本，也可保存成果快照。归档提示适用于终端与 Notebook，不再对所有模板都要求 Notebook 快捷键。
- GPU 容器为 1 CPU、2 GiB 主内存、128 进程；保留无网络、只读根目录、UID 1000 命令、无宿主挂载和端口、租约看门狗及原有文件/输出限制。
- 新增 npm run image:pytorch、npm run gpu:check，agent:doctor 支持按模板检查镜像。agent 版本更新为 0.4.0，需要重启已有进程加载新功能。

## 实际设备与结果

设备：NVIDIA GeForce RTX 5050 Laptop GPU，8151 MiB；本轮 NVIDIA 驱动 616.56，Docker Engine 29.4.0。单卡检查返回：

```json
{
  "torch": "2.10.0+cu128",
  "numpy": "2.3.5",
  "cuda": "12.8",
  "device": "NVIDIA GeForce RTX 5050 Laptop GPU",
  "capability": [12, 0],
  "device_count": 1,
  "tensor_device": "cuda:0",
  "product": [[19.0, 22.0], [43.0, 50.0]],
  "gradient": [2.0, 4.0, 6.0],
  "passed": true
}
```

矩阵输入为 [[1,2],[3,4]] 与 [[5,6],[7,8]]，梯度来自 [1,2,3] 的平方和。检查显式要求张量在 CUDA 上执行并同步、核对预期值。结果 JSON 位于用户可编辑目录，是实验文件，不是防篡改审计凭证。

最终验收镜像：bazaar-pytorch:2.10.0-cu128，ID 为 sha256:12a73d28f822897c3afd5fa08cae1895e2c80def8d6d386abb1c5c85538b4fb3。Docker 重建可能因构建证明而产生不同索引 ID；包版本和摘要由锁文件固定，运行时按实际本地 ID 启动。

## 验证

```powershell
cd C:\Users\wb198\Desktop\算力集市开发\app
npm run image:pytorch
npm run build
npm run gpu:check
$env:RUN_DOCKER_TESTS='1'
$env:RUN_NOTEBOOK_TESTS='1'
$env:RUN_GPU_TESTS='1'
$env:RUN_PYTORCH_TESTS='1'
npm test -- --maxWorkers=1 --no-file-parallelism
npm run test:e2e
```

- TypeScript 严格检查与 Vite 构建通过。
- 9 个测试文件、60 项测试全部通过，无跳过；包含真实 Docker、原生 Notebook 及 CUDA 运算。验证 PyTorch 单卡限制、模板切换与凭据匹配、45 秒重投、就绪前不计费、实际矩阵/梯度、重复启动保留容器、普通用户不能写通过标记、归档与最终销毁。
- 6 条浏览器流程全部通过：mock CLI、交易钱包、mock 工作台、真实 CPU 工作台、真实 GPU/PyTorch 工作台和原生 JupyterLab。
- GPU 网页流程实际运行 python gpu_check.py，检查 passed=true、cuda:0 和无 NumPy 初始化警告，再运行普通脚本与 nvidia-smi。保存快照后结束订单、等待 cleaned，从历史订单下载 ZIP，检查 gpu_check.py、gpu_result.json、cuda:0、passed=true 与普通结果 answer=42 均存在，最后删除快照。
- 桌面与 390px 手机视口通过，普通工作台流程没有页面整体横向溢出或浏览器控制台错误。
- 核心 CUDA 层和已校验 wheel 缓存可复用；补齐 NumPy 时复用了 CUDA 安装层。

证据日志保留于 app/data/pytorch-build/gpu-check.log、unit-tests.log、browser-tests.log、final-image-build.log。截图为 shots/10-pytorch-workspace.png、shots/mobile-workspace-docker-gpu.png、shots/09-archives-docker-gpu.png。

## 数据与构建问题处理

数据库仍为 schema v4，无新迁移。主库 5 个账户、5 台机器、5 张挂牌、1 个订单、8 笔流水，当前没有运行订单；SQLite quick_check 为 ok，主 API 健康检查为 status=ok / schema_version=4。开发前在线备份为 app/data/backups/market-1793259230700.sqlite；端到端测试使用独立数据库，没有写入主库。

首次官方依赖下载较慢，改用有限并发分段下载并逐包核对完整摘要。Triton 在 PyPI 与 PyTorch 官方源同版本同文件名的包摘要不同，第一次校验正确拒绝了不匹配文件；对照 PyTorch 官方索引后明确选定并锁定其 CUDA 分发包，没有关闭校验或用实际下载摘要替代来源验证。最终构建只消费固定清单，不依赖 pip 私有解析接口。

两次安装期间 Docker/WSL 中断，Windows Resource-Exhaustion-Detector 明确报告虚拟内存不足，vmmemWSL 约占 11–12 GB。本机原无 .wslconfig，在确认仅 Docker Desktop 发行版且无运行容器后，临时设置 4 GB 内存 / 1 GB swap 完成构建。原配置文件状态在验收后恢复；当前会话的内存上限需下次 Docker/WSL 重启才恢复默认。没有修改 Windows 页面文件配置、恢复 Docker 出厂、删除用户镜像/卷或清空业务数据。

Docker 启动时还出现残留零字节运行时套接字。仅核对后重命名 Docker/run 和 docker-secrets-engine 两个运行时目录并保留 stale 时间后缀，让程序重建；没有移动其配置或业务目录。初次页面复查发现缺少 NumPy 的警告，已按官方发行包和摘要补齐 NumPy，并重新执行最终验证。

## 边界与后续

本轮验证的是单卡主机上的小型 CUDA 正确性实验，不等同多卡隔离、模型训练性能或所有显卡兼容性。2 GiB 限制针对主内存，当前没有 GPU 显存配额或 MIG。工作目录 64 MiB、临时目录 32 MiB，单条命令 15 秒，不预装模型权重、数据集、torchvision 或 torchaudio。

Notebook 模板仍使用独立环境，没有新增 GPU Notebook；没有长时任务队列、断点训练、自动成果保存或跨订单导入。成果继续免费保留 7 天，必须结束前手动保存成功，数量与容量规则不变。真实资源只向受邀账号开放，尚无真实支付或公网运营验收。

后续优先从已保存成果恢复到新订单，并对独立机主验证断网、agent 强杀、控制面重启与租约清理；长任务应另建持久化任务状态和日志流程，不能直接取消当前命令超时限制。

使用步骤见 [PyTorch 使用指南](../app/docs/pytorch-guide.md)。版本依据见 [PyTorch 官方历史版本说明](https://pytorch.org/get-started/previous-versions/)、[官方 Triton 索引](https://download.pytorch.org/whl/cu128/triton/)、[NumPy 官方发行记录](https://pypi.org/project/numpy/2.3.5/)；WSL 内存配置依据见 [Microsoft 文档](https://learn.microsoft.com/windows/wsl/wsl-config)。
