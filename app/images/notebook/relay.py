"""JSON-lines relay; localhost-only Jupyter target, never a caller-selected host."""
import base64
import concurrent.futures
import http.client
import json
import os
import sys
import threading
import websocket

lock = threading.Lock()
sockets = {}
order = int(os.environ['BAZAAR_ORDER'])
prefix = f'/notebooks/{order}/'
with open('/tmp/.notebook-token') as f:
    token = f.read()

def emit(value):
    with lock:
        print(json.dumps(value, separators=(',', ':')), flush=True)

def target(path):
    if not path.startswith(prefix) or '\\' in path or '\r' in path or '\n' in path:
        raise ValueError('invalid notebook path')
    return path

def run(message):
    ident = message['id']
    try:
        kind = message['kind']
        if kind == 'http':
            connection = http.client.HTTPConnection('127.0.0.1', 8888, timeout=20)
            headers = {k: v for k, v in message.get('headers', {}).items() if k.lower() in ['content-type', 'accept', 'if-none-match', 'if-modified-since']}
            headers['Authorization'] = 'token ' + token
            connection.request(message['method'], target(message['path']), base64.b64decode(message.get('body', '')), headers)
            response = connection.getresponse()
            body = response.read(8 * 1024 * 1024 + 1)
            if len(body) > 8 * 1024 * 1024:
                raise ValueError('notebook response exceeds 8MB')
            allowed = ['content-type', 'cache-control', 'etag', 'last-modified', 'location', 'content-disposition']
            emit({'id': ident, 'kind': 'http', 'status': response.status, 'headers': {k.lower(): v for k, v in response.getheaders() if k.lower() in allowed}, 'body': base64.b64encode(body).decode()})
            connection.close()
        elif kind == 'ws-open':
            ws = websocket.create_connection('ws://127.0.0.1:8888' + target(message['path']),
                header={'Authorization': 'token ' + token}, suppress_origin=True,
                subprotocols=message.get('protocols', []), timeout=10)
            ws.settimeout(None)
            sockets[ident] = ws
            emit({'id': ident, 'kind': 'ws-open', 'protocol': ws.subprotocol or ''})
            while True:
                opcode, data = ws.recv_data()
                if opcode == websocket.ABNF.OPCODE_CLOSE:
                    break
                if isinstance(data, str):
                    data = data.encode()
                if len(data) > 1024 * 1024:
                    raise ValueError('kernel frame exceeds 1MB')
                emit({'id': ident, 'kind': 'ws-data', 'binary': opcode == websocket.ABNF.OPCODE_BINARY, 'body': base64.b64encode(data).decode()})
        elif kind == 'ws-data':
            ws = sockets.get(ident)
            if ws:
                data = base64.b64decode(message['body'])
                ws.send(data if message.get('binary') else data.decode(), opcode=websocket.ABNF.OPCODE_BINARY if message.get('binary') else websocket.ABNF.OPCODE_TEXT)
        elif kind == 'ws-close':
            ws = sockets.pop(ident, None)
            if ws:
                ws.close()
    except Exception as exc:
        emit({'id': ident, 'kind': 'error', 'error': 'Notebook relay: '+type(exc).__name__+' status='+str(getattr(exc, 'status_code', 'n/a'))})
    finally:
        if message.get('kind') == 'ws-open':
            ws = sockets.pop(ident, None)
            if ws:
                ws.close()
            emit({'id': ident, 'kind': 'ws-close'})

pool = concurrent.futures.ThreadPoolExecutor(max_workers=20)
for line in sys.stdin:
    try:
        message = json.loads(line)
        if len(line) > 2 * 1024 * 1024:
            raise ValueError('request too large')
        if message.get('kind') in ['ws-data', 'ws-close']:
            run(message)
        else:
            pool.submit(run, message)
    except Exception:
        continue
for ws in list(sockets.values()):
    ws.close()
pool.shutdown(wait=False, cancel_futures=True)
os._exit(0)
