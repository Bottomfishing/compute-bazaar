import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {workspaceResult,type WorkspaceAction,type WorkspaceResult} from '../server/workspace-protocol.js';
import {restoreScript} from './restore-script.js';
import {taskManager,taskWorker} from './task-script.js';
import {archiveScript} from './archive-script.js';
import {archivePayload} from '../server/archive-protocol.js';
import {pytorchImage,type EnvironmentTemplate} from '../shared/environments.js';
const exec=promisify(execFile);
export const scopeForServer=(server:string)=>createHash('sha256').update(server.replace(/\/$/,'')).digest('hex').slice(0,12);
export const image='python@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159';
const watchdog=`import os,time\np='/lease/deadline'\nopen(p,'w').write(os.environ['BAZAAR_DEADLINE'])\nwhile True:\n try:\n  if time.time()*1000>=float(open(p).read()): os._exit(0)\n except (ValueError,OSError): os._exit(1)\n time.sleep(.5)`;
const safeId=z.number().int().positive();
async function docker(args:string[],timeout=15000){return (await exec('docker',args,{timeout,maxBuffer:160*1024,windowsHide:true})).stdout.trim();}
export class DockerExecutor {
  constructor(readonly machine:number,readonly gpu:boolean,readonly scope='local',readonly template:EnvironmentTemplate='python'){safeId.parse(machine);if(!/^[a-z0-9]{1,20}$/.test(scope))throw new Error('无效容器命名空间');if(template==='pytorch'&&!gpu)throw new Error('PyTorch CUDA 模板需要 GPU 执行器');}
  name(order:number){safeId.parse(order);return `bazaar-${this.scope}-m${this.machine}-o${order}`;}
  async inspect(order:number){try{const raw=await docker(['inspect',this.name(order)]);const c=JSON.parse(raw)[0] as {Id:string;State:{Running:boolean};Config:{Labels:Record<string,string>}};if(c.Config.Labels['bazaar.scope']!==this.scope||c.Config.Labels['bazaar.machine']!==String(this.machine)||c.Config.Labels['bazaar.order']!==String(order))throw new Error('容器标签不匹配');return c;}catch(e){if(e instanceof Error&&/no such (object|container)/i.test(e.message))return null;throw e;}}
  async inventory(){if(!this.gpu)return [{uuid:`CPU-${this.machine}-SLOT-0`,gpu_model:'CPU 沙箱',vram_gb:0}];const rows=(await exec('nvidia-smi',['--query-gpu=uuid,name,memory.total','--format=csv,noheader,nounits'],{windowsHide:true,timeout:10000})).stdout.trim().split(/\r?\n/);return rows.map(row=>{const [uuid,name,memory]=row.split(',').map(x=>x.trim());const model=name.includes('5050')?'RTX 5050 8G':name.includes('4090')?'RTX 4090':name.includes('3090')?'RTX 3090':name.includes('5090')?'RTX 5090':name.includes('A100')?'A100 80G':'';if(!model||!/^GPU-[a-zA-Z0-9-]+$/.test(uuid))throw new Error(`暂未支持该 GPU 型号：${name}`);return {uuid,gpu_model:model,vram_gb:Math.ceil(Number(memory)/1024)};});}
  async start(order:number,uuids:string[],deadline:number){const old=await this.inspect(order);if(old?.State.Running){if(this.template!=='pytorch')return;try{await docker(['exec','--user','0',this.name(order),'test','-f','/lease/pytorch-ready']);return;}catch{/* An interrupted preparation is retried from a clean container. */}}if(old)await this.stop(order);if(!Number.isSafeInteger(deadline))throw new Error('无效租约');
    if(this.template==='pytorch'&&uuids.length!==1)throw new Error('PyTorch 模板仅支持单卡订单');
    let selected=image;if(this.template==='notebook'){selected=await docker(['image','inspect','bazaar-notebook:2026-10-29','--format','{{.Id}}']);if(!/^sha256:[a-f0-9]{64}$/.test(selected))throw new Error('Notebook 镜像未构建');}
    if(this.template==='pytorch'){selected=await docker(['image','inspect',pytorchImage,'--format','{{.Id}}']);if(!/^sha256:[a-f0-9]{64}$/.test(selected))throw new Error('PyTorch 镜像未构建，请运行 npm run image:pytorch');}
    const args=['run','-d','--name',this.name(order),'--label',`bazaar.template=${this.template}`,'--label',`bazaar.scope=${this.scope}`,'--label',`bazaar.machine=${this.machine}`,'--label',`bazaar.order=${order}`,'--pull','never','--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit',this.template==='notebook'?'128':'64','--cpus','1','--memory',this.template==='notebook'?'1g':'512m','--memory-swap',this.template==='notebook'?'1g':'512m','--tmpfs','/workspace:rw,nosuid,nodev,size=64m,mode=1777','--tmpfs','/tmp:rw,nosuid,nodev,size=32m,mode=1777','--tmpfs','/lease:rw,nosuid,nodev,size=1m,mode=700','--env','OPENBLAS_NUM_THREADS=1','--env','OMP_NUM_THREADS=1','--workdir','/workspace','--env',`BAZAAR_ORDER=${order}`,'--env',`BAZAAR_DEADLINE=${deadline}`];
    if(this.gpu){if(!uuids.length||uuids.some(u=>!/^GPU-[a-zA-Z0-9-]+$/.test(u)))throw new Error('无效 GPU UUID');args.push('--gpus',`"device=${uuids.join(',')}"`);}
    if(this.template==='pytorch'){for(const flag of ['--memory','--memory-swap'])args[args.indexOf(flag)+1]='2g';args[args.indexOf('--pids-limit')+1]='128';}
    // Only the root supervisor needs identity switching; submitted code has no capabilities.
    args.push('--cap-add','SETUID','--cap-add','SETGID');
    await docker([...args,selected,'python','-u','-c',watchdog]);
    if(this.template==='pytorch'){
      try{await docker(['exec','--user','1000:1000',this.name(order),'timeout','-k','1','30','python','-c',"import shutil,runpy;shutil.copyfile('/opt/bazaar/gpu-check.py','/workspace/gpu_check.py');runpy.run_path('/opt/bazaar/gpu-check.py',run_name='__main__')"],35000);await docker(['exec','--user','0',this.name(order),'touch','/lease/pytorch-ready']);}
      catch(e){await this.stop(order);throw e;}
    }
    await docker(['exec','--user','1000:1000',this.name(order),'python','-c','print("ready")']);
    if(this.template==='notebook'){
            await docker(['exec','-d','--user','1000:1000',this.name(order),'python','/opt/bazaar/launch.py']);
      let ready=false;for(let i=0;i<30;i++){try{await docker(['exec','--user','1000:1000',this.name(order),'python','-c',`import urllib.request; t=open('/tmp/.notebook-token').read();r=urllib.request.Request('http://127.0.0.1:8888/notebooks/${order}/api/status',headers={'Authorization':'token '+t});urllib.request.urlopen(r,timeout=1).read()`],2500);ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,300));}}
      if(!ready)throw new Error('JupyterLab 准备超时');
    }
  }
  async updateLease(order:number,deadline:number){if(!Number.isSafeInteger(deadline))throw new Error('无效租约');await docker(['exec','--user','0',this.name(order),'python','-c',`import os;open('/lease/next','w').write(${JSON.stringify(String(deadline))});os.replace('/lease/next','/lease/deadline')`]);}
  async stop(order:number){const c=await this.inspect(order);if(c)await docker(['rm','-f',c.Id]);}
  async running(){const ids=await docker(['ps','-a','--filter',`label=bazaar.scope=${this.scope}`,'--filter',`label=bazaar.machine=${this.machine}`,'--format','{{.Names}}']);const result:number[]=[];for(const name of ids.split(/\r?\n/).filter(Boolean)){const match=new RegExp(`^bazaar-${this.scope}-m${this.machine}-o([0-9]+)$`).exec(name);if(!match)continue;const id=Number(match[1]),c=await this.inspect(id);if(c?.State.Running)result.push(id);else if(c)await this.stop(id);}return result;}
  async execute(order:number,action:WorkspaceAction):Promise<WorkspaceResult>{const c=await this.inspect(order);if(!c?.State.Running)throw new Error('订单容器未运行');
    if(action.kind==='task_start'||action.kind==='task_status'||action.kind==='task_stop'){
      return workspaceResult.parse(JSON.parse(await docker(['exec','--user','0',this.name(order),'timeout','-k','1','5','python','-I','-c',taskManager,JSON.stringify(action),taskWorker])));
    }
    if(action.kind==='archive'||action.kind==='restore'||action.kind==='restore_probe'){
      const status=await this.execute(order,{kind:'task_status'});
      if(status.exit_code!==0)throw new Error('无法确认任务状态，请稍后重试');
      if(status.task?.state==='running')throw new Error('请先停止长时任务，再归档或恢复文件');
    }
    if(action.kind==='restore_probe'||action.kind==='restore'){
      const output=await new Promise<string>((resolve,reject)=>{
        const child=spawn('docker',['exec','-i','--user','1000:1000',this.name(order),'timeout','-k','1','12','python','-c',restoreScript],{windowsHide:true,stdio:['pipe','pipe','pipe']});
        const chunks:Buffer[]=[];let bytes=0,done=false;
        const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(Buffer.concat(chunks).toString('utf8'));};
        const timer=setTimeout(()=>finish(new Error('恢复连接超时，请核对恢复记录后重试')),15000);
        const collect=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>160*1024)finish(new Error('恢复响应超过上限'));else chunks.push(chunk);};
        child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('error',finish);child.on('close',code=>finish(code?new Error('恢复进程中断，请核对记录后重试'):undefined));
        child.stdin.on('error',e=>finish(e));child.stdin.end(JSON.stringify(action));
      });
      return workspaceResult.parse(JSON.parse(output));
    }
    if(action.kind==='archive'){
      try{const {stdout}=await exec('docker',['exec','--user','1000:1000',this.name(order),'timeout','-k','1','12','python','-c',archiveScript],{timeout:15000,maxBuffer:7*1024*1024,windowsHide:true});return {output:'',exit_code:0,archive:archivePayload.parse(JSON.parse(stdout))};}
      catch{throw new Error('归档失败：请先保存文件；仅支持顶层普通文件（非隐藏），最多 100 个、每个 1 MiB、合计 4 MiB。不支持目录、链接和特殊文件；请停止写入后重试。');}
    }
    if(action.kind==='command'){
      // timeout runs inside the container so terminating the Docker client cannot leave an unbounded command.
      return new Promise((resolve,reject)=>{const child=spawn('docker',['exec','--user','1000:1000',this.name(order),'timeout','-k','1','15','sh','-lc',action.command],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',bytes=0,settled=false;const timer=setTimeout(()=>{child.kill();finish({output:output+'\n命令超时',exit_code:124});},17000);const finish=(result:WorkspaceResult)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};const collect=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>120*1024){child.kill();finish({output:output+'\n输出超过上限，容器内命令将在超时后结束',exit_code:125});}else output+=chunk.toString();};child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('error',e=>{clearTimeout(timer);if(!settled){settled=true;reject(e);}});child.on('exit',code=>finish({output,exit_code:code??1}));});
    }
    const script=action.kind==='list'?`import os,json,stat\nr=[]\nfor n in os.listdir('/workspace'):\n s=os.lstat('/workspace/'+n)\n if stat.S_ISREG(s.st_mode):r.append({'name':n,'size':s.st_size})\nprint(json.dumps(r))`:
      action.kind==='read'?`import os,stat,base64\np='/workspace/'+${JSON.stringify(action.name)}\nf=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)\ns=os.fstat(f)\nassert stat.S_ISREG(s.st_mode) and s.st_size<=8192,'文件不是普通文件或超过8KB'\nb=os.read(f,8193)\nassert len(b)<=8192,'文件超过8KB'\nprint(base64.b64encode(b).decode())`:
      `import os,stat,base64\np='/workspace/'+${JSON.stringify(action.name)}\nf=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)\nassert stat.S_ISREG(os.fstat(f).st_mode),'只允许普通文件'\nos.write(f,base64.b64decode(${JSON.stringify(Buffer.from(action.content).toString('base64'))}))\nos.close(f)\nprint('已保存')`;
    const output=await docker(['exec','--user','1000:1000',this.name(order),'python','-c',script]);if(action.kind==='list')return {output:'',exit_code:0,files:JSON.parse(output) as {name:string;size:number}[]};if(action.kind==='read')return {output:Buffer.from(output,'base64').toString('utf8'),exit_code:0};return {output,exit_code:0};
  }
}
