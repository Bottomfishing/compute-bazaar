// Runs as UID 1000 in the order container; no host filesystem is read.
export const archiveScript=String.raw`import os,stat,json,hashlib,base64
root=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
files=[]
total=0
for name in sorted(os.listdir(root)):
 if name.startswith('.'): continue
 if len(name)>180 or name.strip()!=name or name.endswith('.') or any(c in name for c in '\\/:') or any(ord(c)<32 or ord(c)==127 for c in name):
  raise ValueError('Unsupported filename; use flat visible files')
 info=os.stat(name,dir_fd=root,follow_symlinks=False)
 if not stat.S_ISREG(info.st_mode): raise ValueError('Directories, symlinks and special files cannot be archived')
 if len(files)>=100 or info.st_size>1048576 or total+info.st_size>4194304: raise ValueError('Archive exceeds 100 files / 1 MiB per file / 4 MiB total')
 fd=os.open(name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=root)
 try:
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode) or before.st_size>1048576: raise ValueError('File changed; save and retry')
  chunks=[]
  size=0
  while True:
   chunk=os.read(fd,min(65536,1048577-size))
   if not chunk: break
   chunks.append(chunk)
   size+=len(chunk)
   if size>1048576: raise ValueError('File exceeds 1 MiB')
  after=os.fstat(fd)
  if (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns) or size!=after.st_size: raise ValueError('File changed during snapshot; save and retry')
 finally: os.close(fd)
 body=b''.join(chunks)
 total+=len(body)
 if total>4194304: raise ValueError('Archive exceeds 4 MiB')
 if name.endswith('.ipynb'):
  notebook=json.loads(body)
  if not isinstance(notebook,dict) or not isinstance(notebook.get('cells'),list): raise ValueError('Notebook is not saved completely')
 files.append({'name':name,'body':base64.b64encode(body).decode(),'sha256':hashlib.sha256(body).hexdigest()})
if not files: raise ValueError('No visible regular files to archive')
print(json.dumps({'files':files}))
`;
