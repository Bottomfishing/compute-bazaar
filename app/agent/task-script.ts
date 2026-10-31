// The supervisor stays root solely to protect records and stop the child's process group.
// The submitted Python code always runs as UID/GID 1000 inside the leased container.
export const taskCommon=String.raw`import os,sys,json,time,fcntl,signal,subprocess,selectors,stat,uuid
STATE='/lease/task.json'
LOG='/lease/task.log'
def load():
 try:
  with open(STATE) as f: return json.load(f)
 except FileNotFoundError: return None
def save(s):
 with open(STATE+'.next','w') as f: json.dump(s,f)
 os.replace(STATE+'.next',STATE)
def stop_group(pid):
 original=os.geteuid()
 try:
  os.seteuid(1000)
  try: os.killpg(pid,signal.SIGKILL)
  except ProcessLookupError: pass
 finally: os.seteuid(original)
def public(s):
 if s is None: return None
 result={k:s[k] for k in ['id','script','state','started_at','ended_at','timeout_seconds','exit_code','truncated']}
 try:
  with open(LOG,'rb') as f: result['log']=f.read(16384).decode('utf-8',errors='replace')
 except FileNotFoundError: result['log']=''
 return result
`;
export const taskWorker=taskCommon+String.raw`
lock=open('/lease/task.lock','a')
p=None
try:
 source=sys.argv[1]
 fcntl.flock(lock,fcntl.LOCK_EX)
 s=load()
 if not s or s['state']!='running': sys.exit(1)
 p=subprocess.Popen(['python','-u','-c',source],cwd='/workspace',stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,user=1000,group=1000,extra_groups=[],start_new_session=True,close_fds=True)
 s['worker_pid']=p.pid
 save(s)
 fcntl.flock(lock,fcntl.LOCK_UN)
 begin=time.monotonic()
 sel=selectors.DefaultSelector()
 sel.register(p.stdout,selectors.EVENT_READ)
 written=0
 with open(LOG,'wb',buffering=0) as log:
  while True:
   reason=None
   if os.path.exists('/lease/task-stop'): reason='stopped'
   elif time.monotonic()-begin>=s['timeout_seconds']: reason='timed_out'
   if reason: stop_group(p.pid)
   for key,_ in sel.select(.1):
    chunk=os.read(key.fileobj.fileno(),65536)
    if chunk:
     keep=chunk[:max(0,16384-written)]
     log.write(keep)
     written+=len(keep)
     if len(keep)<len(chunk) and not s['truncated']:
      s['truncated']=True
      fcntl.flock(lock,fcntl.LOCK_EX);save(s);fcntl.flock(lock,fcntl.LOCK_UN)
    else: sel.unregister(key.fileobj)
   if reason or p.poll() is not None:
    stop_group(p.pid)
    p.wait()
    # Drain the bounded remaining pipe data before recording completion.
    os.set_blocking(p.stdout.fileno(),False)
    while True:
     try: chunk=os.read(p.stdout.fileno(),65536)
     except BlockingIOError: break
     if not chunk: break
     keep=chunk[:max(0,16384-written)];log.write(keep);written+=len(keep)
     if len(keep)<len(chunk): s['truncated']=True
    s['state']=reason or ('succeeded' if p.returncode==0 else 'failed')
    s['exit_code']=p.returncode
    break
except BaseException:
 if p is not None: stop_group(p.pid)
 s=load()
 if s: s['state']='interrupted'
finally:
 if 's' in locals() and s:
  s['ended_at']=int(time.time()*1000)
  fcntl.flock(lock,fcntl.LOCK_EX);save(s);fcntl.flock(lock,fcntl.LOCK_UN)
`;
export const taskManager=taskCommon+String.raw`
lock=open('/lease/task.lock','a')
fcntl.flock(lock,fcntl.LOCK_EX)
try:
 a=json.loads(sys.argv[1]);s=load()
 if s and s['state']=='running':
  try:
   with open('/proc/'+str(s['supervisor_pid'])+'/stat') as f: alive=f.read().split(') ')[1][0]!='Z'
  except (FileNotFoundError,KeyError): alive=False
  if not alive:
   if s.get('worker_pid'): stop_group(s['worker_pid'])
   s['state']='interrupted';s['ended_at']=int(time.time()*1000);save(s)
 if a['kind']=='task_start':
  task_id=str(uuid.UUID(a['id']))
  if task_id!=a['id'] or not isinstance(a['timeout_seconds'],int) or not 1<=a['timeout_seconds']<=600: raise ValueError('任务参数无效')
  if s and s['id']==task_id:
   if s['script']!=a['script'] or s['timeout_seconds']!=a['timeout_seconds']: raise ValueError('同一请求不能更改任务参数')
  else:
   if s and s['state']=='running': raise ValueError('本单已有任务正在运行，请先停止')
   try:
    with open('/lease/task-ids.json') as f: ids=json.load(f)
   except FileNotFoundError: ids=[]
   if task_id in ids: raise ValueError('该任务已执行，请刷新查看当前任务')
   if len(ids)>=20: raise ValueError('每单最多提交 20 次任务')
   n=a['script']
   if not isinstance(n,str) or not 1<=len(n)<=180 or n.startswith('.') or n.strip()!=n or n.endswith('.') or any(c in '/\\:' or ord(c)<32 or ord(c)==127 for c in n) or not n.endswith('.py'): raise ValueError('请选择顶层 Python 脚本')
   reader="import os,sys,stat;f=os.open('/workspace/'+sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK);s=os.fstat(f);assert stat.S_ISREG(s.st_mode) and s.st_size<=8192;b=os.read(f,8193);assert len(b)<=8192;sys.stdout.buffer.write(b)"
   result=subprocess.run(['python','-I','-c',reader,n],user=1000,group=1000,extra_groups=[],capture_output=True,timeout=2,close_fds=True)
   if result.returncode!=0: raise ValueError('脚本须为最多 8 KiB 的普通 UTF-8 文件；旧容器请结束后新建订单')
   source=result.stdout.decode('utf-8-sig');compile(source,n,'exec')
   code='exec(compile('+repr(source)+','+repr('/workspace/'+n)+',"exec"),{"__name__":"__main__","__file__":'+repr('/workspace/'+n)+'})'
   try: os.unlink('/lease/task-stop')
   except FileNotFoundError: pass
   open(LOG,'wb').close()
   s={'id':task_id,'script':n,'state':'running','started_at':int(time.time()*1000),'ended_at':None,'timeout_seconds':a['timeout_seconds'],'exit_code':None,'truncated':False}
   save(s)
   p=subprocess.Popen(['python','-I','-c',sys.argv[2],code],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,close_fds=True)
   s['supervisor_pid']=p.pid;save(s)
   ids.append(task_id)
   with open('/lease/task-ids.json','w') as f: json.dump(ids,f)
 elif a['kind']=='task_stop':
  if not s or s['id']!=a['id']: raise ValueError('任务已变化，请刷新后重试')
  if s['state']=='running': open('/lease/task-stop','w').close()
 elif a['kind']!='task_status': raise ValueError('未知任务操作')
 print(json.dumps({'output':'','exit_code':0,'task':public(s)},ensure_ascii=False))
except Exception as e:
 print(json.dumps({'output':str(e)[:300],'exit_code':1,'task':public(load())},ensure_ascii=False))
finally: fcntl.flock(lock,fcntl.LOCK_UN)
`;
