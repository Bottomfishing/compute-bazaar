// Payload travels over stdin: a 4 MiB snapshot exceeds Windows' command-line limit.
export const restoreScript=String.raw`import os,sys,json,stat,hashlib,base64,tempfile,unicodedata
MAX_FILE=1048576
MAX_TOTAL=4194304
root=None
stage=None
stage_name=None
created=[]
reused=[]
conflicts=[]
def key(n): return unicodedata.normalize('NFC',n).lower()
def name_ok(n):
 return isinstance(n,str) and 0<len(n)<=180 and not n.startswith('.') and n.strip()==n and not n.endswith('.') and not any(c in '/\\:' or ord(c)<32 or ord(c)==127 for c in n)
def entries():
 out={}
 with os.scandir(root) as scan:
  for i,e in enumerate(scan):
   if i>=10000: raise ValueError('工作目录文件过多，请清理后重试')
   out.setdefault(key(e.name),[]).append(e.name)
 return out
def identical(n,data):
 try:
  f=os.open(n,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=root)
  try:
   s=os.fstat(f)
   if not stat.S_ISREG(s.st_mode) or s.st_size!=len(data): return False
   b=bytearray()
   while len(b)<=MAX_FILE:
    chunk=os.read(f,min(65536,MAX_FILE+1-len(b)))
    if not chunk: break
    b.extend(chunk)
   end=os.fstat(f)
   return bytes(b)==data and (s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(end.st_size,end.st_mtime_ns,end.st_ctime_ns)
  finally: os.close(f)
 except OSError: return False
try:
 raw=sys.stdin.buffer.read(6000001)
 if len(raw)>6000000: raise ValueError('恢复内容超过上限')
 p=json.loads(raw)
 root=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 current=entries()
 if p['kind']=='restore_probe':
  names=p['names']
  if not isinstance(names,list) or not 1<=len(names)<=200 or not all(name_ok(n) for n in names): raise ValueError('文件名无效')
  print(json.dumps({'output':'','exit_code':0,'existing':[n for n in names if key(n) in current]}))
 elif p['kind']=='restore':
  files=p['payload']['files']
  if not isinstance(files,list) or not 1<=len(files)<=100: raise ValueError('文件数量无效')
  decoded=[]
  seen=set()
  total=0
  for item in files:
   n=item['name']
   if not name_ok(n) or key(n) in seen: raise ValueError('文件名无效或重复')
   seen.add(key(n))
   b=base64.b64decode(item['body'],validate=True)
   total+=len(b)
   if len(b)>MAX_FILE or total>MAX_TOTAL or hashlib.sha256(b).hexdigest()!=item['sha256'] or base64.b64encode(b).decode()!=item['body']: raise ValueError('文件校验失败或容量超限')
   decoded.append((n,b))
  missing=[]
  for n,b in decoded:
   matches=current.get(key(n),[])
   if matches:
    if matches==[n] and identical(n,b): reused.append(n)
    else: conflicts.append(n)
   else: missing.append((n,b))
  if conflicts: raise ValueError('目标文件已变化；未写入新文件，请重新预览恢复')
  if missing:
   stage_path=tempfile.mkdtemp(prefix='.bazaar-restore-',dir='/workspace')
   stage_name=os.path.basename(stage_path)
   stage=os.open(stage_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
   for i,(n,b) in enumerate(missing):
    f=os.open(str(i),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=stage)
    try:
     view=memoryview(b)
     while view:
      count=os.write(f,view)
      if count<=0: raise OSError('无法写入暂存文件')
      view=view[count:]
     os.fsync(f)
    finally: os.close(f)
   for i,(n,b) in enumerate(missing):
    # Recheck normalized aliases; hard-link publication never overwrites a destination.
    matches=entries().get(key(n),[])
    if matches:
     if matches==[n] and identical(n,b): reused.append(n); continue
     conflicts.append(n); raise ValueError('恢复过程中目标文件发生变化，已停止；请核对结果')
    try: os.link(str(i),n,src_dir_fd=stage,dst_dir_fd=root,follow_symlinks=False)
    except FileExistsError:
     if identical(n,b): reused.append(n); continue
     conflicts.append(n); raise ValueError('恢复过程中目标文件发生变化，已停止；请核对结果')
    created.append(n)
  print(json.dumps({'output':'文件恢复完成；未执行代码','exit_code':0,'restored':{'created':created,'reused':reused,'conflicts':conflicts}}))
 else: raise ValueError('未知恢复操作')
except Exception as e:
 print(json.dumps({'output':str(e)[:300],'exit_code':1,'restored':{'created':created,'reused':reused,'conflicts':conflicts}}))
finally:
 if stage is not None:
  try:
   for n in os.listdir(stage): os.unlink(n,dir_fd=stage)
  finally: os.close(stage)
 if stage_name is not None:
  try: os.rmdir(stage_name,dir_fd=root)
  except OSError: pass
 if root is not None: os.close(root)
`;
