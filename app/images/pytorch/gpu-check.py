"""Small CUDA correctness check; no model download or training load."""
import json
from pathlib import Path
import numpy as np
import torch

assert torch.__version__ == '2.10.0+cu128', 'Unexpected PyTorch build'
assert np.__version__ == '2.3.5', 'Unexpected NumPy build'
assert torch.version.cuda == '12.8', 'Unexpected CUDA runtime'
assert torch.cuda.is_available(), 'CUDA is unavailable; CPU fallback is disabled'
assert torch.cuda.device_count() == 1, 'This template requires one allocated GPU'
torch.set_num_threads(1)
a = torch.tensor([[1., 2.], [3., 4.]], device='cuda')
b = torch.tensor([[5., 6.], [7., 8.]], device='cuda')
product = a @ b
assert product.is_cuda
torch.testing.assert_close(product.cpu(), torch.tensor([[19., 22.], [43., 50.]]))
x = torch.tensor([1., 2., 3.], device='cuda', requires_grad=True)
(x.square().sum()).backward()
torch.cuda.synchronize()
torch.testing.assert_close(x.grad.cpu(), torch.tensor([2., 4., 6.]))
result = dict(torch=torch.__version__, numpy=np.__version__, cuda=torch.version.cuda,
              device=torch.cuda.get_device_name(0), capability=list(torch.cuda.get_device_capability(0)),
              device_count=torch.cuda.device_count(), tensor_device=str(product.device),
              product=product.cpu().tolist(), gradient=x.grad.cpu().tolist(), passed=True)
Path('/workspace/gpu_result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
