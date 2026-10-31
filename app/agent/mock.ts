import {environmentTemplates,type EnvironmentTemplate} from '../shared/environments.js';
import {DockerExecutor,scopeForServer} from './docker-executor.js';
import {NotebookRelays} from './notebook-relay.js';
import {connectTunnel} from './tunnel.js';
import {mockWorkspace} from './mock-workspace.js';
import {setTimeout as delay} from 'node:timers/promises';
import {createInterface} from 'node:readline/promises';
import type {WireJob} from '../server/protocol.js';
const server=process.env.AGENT_SERVER||'http://127.0.0.1:3001';
let token=process.env.AGENT_TOKEN;let registered=false;let stopping=false;
if(!token){const input=createInterface({input:process.stdin,output:process.stdout});token=(await input.question('粘贴接入凭据（仅用于当前进程，请勿录屏或共享终端）：')).trim();input.close();}
if(!token)throw new Error('缺少接入凭据');
const machineId=Number(process.env.AGENT_MACHINE_ID),count=Number(process.env.MOCK_GPU_COUNT||2),model=process.env.MOCK_GPU_MODEL||'RTX 4090';
const memory:Record<string,number>={'RTX 4090':24,'RTX 3090':24,'RTX 5090':32,'A100 80G':80,'RTX 5050 8G':8,'CPU 沙箱':0};
if(!Number.isInteger(machineId)||machineId<=0||!Number.isInteger(count)||count<1||count>64||!(model in memory))throw new Error('请设置有效 AGENT_MACHINE_ID、MOCK_GPU_COUNT、MOCK_GPU_MODEL');
const mode=process.env.AGENT_EXECUTOR||'mock';if(!['mock','docker-cpu','docker-gpu'].includes(mode))throw new Error('无效执行器');const template=process.env.AGENT_TEMPLATE||'python';if(!environmentTemplates.includes(template as EnvironmentTemplate)||mode==='mock'&&template!=='python')throw new Error('无效环境模板或执行模式');const executor=mode==='mock'?null:new DockerExecutor(machineId,mode==='docker-gpu',scopeForServer(server),template as EnvironmentTemplate);
const active=new Map<number,number>();if(executor)for(const id of await executor.running())active.set(id,Date.now()+30000);const inflight=new Set<number>();const cancelled=new Set<number>();const completed=new Map<number,'ready'|'stopped'>();
const startDelay=Number(process.env.MOCK_START_DELAY_MS||1000);if(!Number.isFinite(startDelay)||startDelay<0||startDelay>55000)throw new Error('MOCK_START_DELAY_MS 必须为 0–55000');
class HttpError extends Error {constructor(public status:number,message:string){super(message);}}
async function call<T>(path:string,method='GET',body?:unknown):Promise<T>{const r=await fetch(`${server}/api/agent${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});const data=await r.json() as {message?:string};if(!r.ok)throw new HttpError(r.status,data.message||'请求失败');return data as T;}
function log(text:string){process.stdout.write(`[agent:${mode}] ${text}\n`);}
async function register(){await call('/register','POST',{version:'agent-0.6.0',environment_template:executor?.template||'python',gpus:executor?await executor.inventory():Array.from({length:count},(_,i)=>({uuid:`MOCK-${machineId}-GPU-${i}`,gpu_model:model,vram_gb:memory[model]})),active_orders:[...active.keys()]});registered=true;log(executor?`容器机器已上线，环境模板：${executor.template}`:'模拟机器已上线（无真实 GPU 或容器）');}
async function report(job:WireJob,result:'ready'|'failed'|'stopped',reason='故障注入：模拟启动失败'){await call(`/jobs/${job.id}/report`,'POST',{attempt:job.attempts,result,...(result==='failed'?{message:reason}:{})});}
async function execute(job:WireJob){
  if(inflight.has(job.id))return;inflight.add(job.id);
  try{
    if(job.kind==='stop'){cancelled.add(job.order_id);notebooks.stop(job.order_id);if(executor)await executor.stop(job.order_id);active.delete(job.order_id);await report(job,'stopped');completed.set(job.id,'stopped');log(`订单 ${job.order_id} 已清理`);return;}
    if(cancelled.has(job.order_id))return;
    if(completed.get(job.id)==='ready'){await report(job,'ready');return;}
    await delay(startDelay);if(stopping||cancelled.has(job.order_id))return;
    if(process.env.MOCK_FAIL_START==='always'||(process.env.MOCK_FAIL_START==='once'&&job.attempts===1)){await report(job,'failed');log(`订单 ${job.order_id} 启动失败（故障注入）`);return;}
    if(executor){try{await executor.start(job.order_id,job.gpu_uuids,job.lease_ends_at);}catch{await report(job,'failed','容器环境或 CUDA 校验失败，请机主检查镜像、驱动和 agent:doctor');return;}if(cancelled.has(job.order_id)||stopping){await executor.stop(job.order_id);return;}}
    active.set(job.order_id,job.lease_ends_at);
    try{await report(job,'ready');completed.set(job.id,'ready');await pulse();log(`订单 ${job.order_id} 环境就绪，资源: ${job.gpu_uuids.join(', ')}`);}catch(e){if(e instanceof HttpError&&e.status===409)active.delete(job.order_id);throw e;}
  }finally{inflight.delete(job.id);}
}
async function pulse(){if(executor)for(const id of active.keys()){const state=await executor.inspect(id);if(!state?.State.Running){await executor.stop(id);active.delete(id);}}const r=await call<{leases:{id:number;ends_at:number;preparation_deadline:number|null;execution_status:string}[]}>('/heartbeat','POST',{active_orders:[...active.keys()]});for(const [id]of active){const lease=r.leases.find(l=>l.id===id);if(!lease){if(executor)await executor.stop(id);active.delete(id);cancelled.add(id);}else {const deadline=lease.execution_status==='preparing'?(lease.preparation_deadline??Date.now()):lease.ends_at;if(executor)await executor.updateLease(id,deadline);active.set(id,deadline);}}}
let sweeping=false;const watchdog=setInterval(()=>{if(sweeping)return;sweeping=true;void(async()=>{try{for(const [id,end]of active)if(end<=Date.now()){if(executor)await executor.stop(id);active.delete(id);cancelled.add(id);log(`订单 ${id} 本地租约到期，任务停止`);}}catch{log('本地清理暂未成功，将继续重试');}finally{sweeping=false;}})();},500);
const notebooks=new NotebookRelays(executor,order=>active.has(order)&&!cancelled.has(order));
const mock=mockWorkspace();const closeTunnel=connectTunnel(server,token,async(order,action)=>{if(!active.has(order)||cancelled.has(order))throw new Error('订单未运行或已结束');return executor?executor.execute(order,action):mock(order,action);},notebooks);
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
let heartbeatAt=0;
log(executor?`使用 ${mode} 执行器；仅在受限订单容器内执行命令。`:'使用 mock 执行器；不会执行宿主命令、启动容器或调用 GPU。');
while(!stopping){try{if(!registered)await register();if(Date.now()>=heartbeatAt){await pulse();heartbeatAt=Date.now()+10000;}const jobs=await call<WireJob[]>('/jobs');for(const job of jobs)void execute(job).catch(e=>log(e instanceof Error?e.message:'任务回报失败'));}catch(e){log(e instanceof Error?e.message:'连接失败');if(e instanceof HttpError&&e.status===401){stopping=true;log('凭据已失效，停止模拟任务');}else if(e instanceof HttpError&&e.status===409){registered=false;}}await delay(1000);}
closeTunnel();clearInterval(watchdog);if(executor)for(const id of active.keys())await executor.stop(id).catch(()=>log('退出时清理失败，容器内租约看门狗仍会到期退出'));active.clear();log('agent 已停止；控制面将在心跳阈值后处理掉线订单。');


