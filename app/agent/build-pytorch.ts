import {spawn} from 'node:child_process';
import {mkdir,readFile,open,rename} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,basename} from 'node:path';
import {pytorchImage} from '../shared/environments.js';
type Item={metadata:{name:string;version:string};download_info:{url:string;archive_info:{hashes:{sha256:string}}}};
async function run(args:string[]){await new Promise<void>((done,reject)=>{const c=spawn('docker',args,{stdio:'inherit',windowsHide:true});c.on('error',reject);c.on('exit',code=>code===0?done():reject(new Error(`Docker exited ${code}`)));});}
async function sha(path:string){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
const wheels=resolve('images/pytorch/wheels'),numpyWheels=resolve('images/pytorch/numpy-wheels');await mkdir(wheels,{recursive:true});await mkdir(numpyWheels,{recursive:true});
try{
  // Builds consume the reviewed lock; they never resolve new versions or rewrite it.
  const existingLock=await readFile('images/pytorch/requirements.lock','utf8')+await readFile('images/pytorch/numpy.lock','utf8');
  const pins=new Map<string,{version:string;hash:string}>();for(const line of existingLock.trim().split('\n').filter(Boolean)){const m=/^([A-Za-z0-9_.-]+)==([^ ]+) --hash=sha256:([a-f0-9]{64})$/.exec(line.trim());if(!m||pins.has(m[1].toLowerCase()))throw new Error('Invalid requirements.lock');pins.set(m[1].toLowerCase(),{version:m[2],hash:m[3]});}
  function matches(r:{install:Item[]}){return pins.size>0&&Array.isArray(r.install)&&r.install.length===pins.size&&new Set(r.install.map(i=>i.metadata.name.toLowerCase())).size===pins.size&&r.install.every(i=>{const p=pins.get(i.metadata.name.toLowerCase());return p?.version===i.metadata.version&&p.hash===i.download_info.archive_info.hashes.sha256;});}
  const report=JSON.parse(await readFile('images/pytorch/wheels.lock.json','utf8')) as {install:Item[]};
  if(!matches(report))throw new Error('Official wheel metadata does not match committed requirements.lock');
  if(!report.install.some(i=>i.metadata.name==='torch'&&i.metadata.version==='2.10.0+cu128'))throw new Error('Unexpected dependency plan');
  const allowed=new Set(['files.pythonhosted.org','download.pytorch.org','download-r2.pytorch.org','pypi.nvidia.com']);
  let bytes=0;const progress=setInterval(()=>process.stdout.write(`已下载 ${Math.round(bytes/1048576)} MiB（官方源，8 路分段，逐文件 SHA-256 校验）\n`),15000);
  try{for(const item of report.install){
    let url=new URL(item.download_info.url);const hash=item.download_info.archive_info.hashes.sha256,name=decodeURIComponent(basename(url.pathname));
    if(url.protocol!=='https:'||!allowed.has(url.hostname)||!name.endsWith('.whl')||name.includes('/')||name.includes('\\')||!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid official wheel URL or digest');
    const path=resolve(item.metadata.name==='numpy'?numpyWheels:wheels,name);try{if(await sha(path)===hash){process.stdout.write(`缓存已校验：${name}\n`);continue;}}catch{/* Download a missing wheel. */}
    if(url.hostname==='files.pythonhosted.org'){
      const candidates=[...(item.metadata.name.startsWith('nvidia-')?[`https://pypi.nvidia.com/${item.metadata.name}/${name}`]:[]),`https://download.pytorch.org/whl/cu128/${encodeURIComponent(name)}`,`https://download.pytorch.org/whl/${encodeURIComponent(name)}`];
      for(const candidate of candidates){try{const r=await fetch(candidate,{method:'HEAD',signal:AbortSignal.timeout(10000)});if(r.ok){url=new URL(candidate);break;}}catch{/* Try the next official mirror; every byte still requires the locked digest. */}}
    }
    const response=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`Wheel HEAD ${response.status}`);const size=Number(response.headers.get('content-length'));if(!Number.isSafeInteger(size)||size<1||size>2*1024**3)throw new Error('Invalid wheel size');
    // Small ranges also complete on slower PyPI connections before the timeout.
    const part=`${path}.part`,file=await open(part,'w');await file.truncate(size);let next=0;const chunk=(url.hostname==='files.pythonhosted.org'?1:8)*1048576;
    try{const results=await Promise.allSettled(Array.from({length:8},async()=>{while(true){const start=next;next+=chunk;if(start>=size)return;const end=Math.min(size-1,start+chunk-1);let written=false;for(let retry=0;retry<3&&!written;retry++){try{const r=await fetch(url,{headers:{Range:`bytes=${start}-${end}`},signal:AbortSignal.timeout(60000)});if(r.status!==206||r.headers.get('content-range')!==`bytes ${start}-${end}/${size}`)throw new Error('Invalid range response');const data=Buffer.from(await r.arrayBuffer());if(data.length!==end-start+1)throw new Error('Incomplete range');let offset=0;while(offset<data.length){const result=await file.write(data,offset,data.length-offset,start+offset);if(!result.bytesWritten)throw new Error('Incomplete disk write');offset+=result.bytesWritten;}bytes+=data.length;written=true;}catch(e){if(retry===2)throw e;}}}}));for(const result of results)if(result.status==='rejected')throw result.reason;}finally{await file.close();}
    if(await sha(part)!==hash)throw new Error(`Wheel checksum failed: ${name}`);await rename(part,path);process.stdout.write(`已校验：${name}\n`);
  }}finally{clearInterval(progress);}
  await run(['build','--pull=false','-t',pytorchImage,'images/pytorch']);
  process.stdout.write('PyTorch 镜像已构建，完整依赖已按 SHA-256 锁定。执行 npm run gpu:check 验证真实 CUDA。\n');
}catch(e){process.stderr.write(`PyTorch 构建失败：${e instanceof Error?e.message:'未知错误'}\n`);process.exitCode=1;}
