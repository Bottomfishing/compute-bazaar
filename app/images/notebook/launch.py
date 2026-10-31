import os
import secrets
import json

os.environ['HOME'] = '/tmp'
os.environ['JUPYTER_CONFIG_DIR'] = '/tmp/jupyter-config'
os.environ['JUPYTER_RUNTIME_DIR'] = '/tmp/jupyter-runtime'
os.environ['IPYTHONDIR'] = '/tmp/ipython'
token = secrets.token_hex(32)
with open('/tmp/.notebook-token', 'w', opener=lambda path, flags: os.open(path, flags, 0o600)) as f:
    f.write(token)
order = int(os.environ['BAZAAR_ORDER'])
welcome = {
    'cells': [
        {'cell_type': 'markdown', 'id': 'intro', 'metadata': {}, 'source': ['# 算力集市 · Notebook 入门\n', '运行下方单元格，得到一个可复现的 NumPy 计算结果。结束租用前请下载此文件。']},
        {'cell_type': 'code', 'id': 'example', 'execution_count': None, 'metadata': {}, 'outputs': [], 'source': ['import numpy as np\n', 'values = np.arange(10)\n', 'print("计算结果：", int(values.sum()))']},
    ],
    'metadata': {'kernelspec': {'display_name': 'Python 3 (ipykernel)', 'language': 'python', 'name': 'python3'}, 'language_info': {'name': 'python'}},
    'nbformat': 4, 'nbformat_minor': 5,
}
if not os.path.exists('/workspace/welcome.ipynb'):
    with open('/workspace/welcome.ipynb', 'w') as f:
        json.dump(welcome, f, ensure_ascii=False)
os.execvp('jupyter', ['jupyter', 'lab', '--no-browser', '--ip=127.0.0.1', '--port=8888',
    '--ServerApp.port_retries=0', '--ServerApp.root_dir=/workspace',
    f'--ServerApp.base_url=/notebooks/{order}/', f'--IdentityProvider.token={token}',
    '--LabApp.expose_app_in_browser=True', '--ServerApp.terminals_enabled=False', '--ServerApp.allow_remote_access=False'])
