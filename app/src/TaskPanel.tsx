import {useEffect,useRef,useState} from 'react';
import type {TaskInfo} from '../shared/tasks';
import {message} from './api';
const labels:Record<TaskInfo['state'],string>={running:'正在运行',succeeded:'运行完成',failed:'运行失败',stopped:'已停止',timed_out:'已超时',interrupted:'执行中断'};
type Result={output:string;exit_code:number;task?:TaskInfo|null};
export default function TaskPanel({orderId,disabled,closed,currentFile,action,onRunning}:{orderId:number;disabled:boolean;closed:boolean;currentFile:string;action:(data:unknown)=>Promise<Result>;onRunning:(v:boolean)=>void}){
  const [task,setTask]=useState<TaskInfo|null>(null),[script,setScript]=useState('example.py'),[limit,setLimit]=useState(120),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const current=useRef({action,disabled,closed,onRunning});current.current={action,disabled,closed,onRunning};const inflight=useRef(false),poll=useRef(true),request=useRef<{id:string;script:string;timeout_seconds:number}|null>(null);
  async function send(data:unknown){if(inflight.current)return;inflight.current=true;setBusy(true);try{const r=await current.current.action(data);if(r.task!==undefined){setTask(r.task);poll.current=r.task?.state==='running';current.current.onRunning(poll.current);}if(r.exit_code!==0)throw new Error(r.output||'任务操作失败');setError('');}catch(e){setError(message(e));}finally{inflight.current=false;setBusy(false);}}
  useEffect(()=>{setTask(null);request.current=null;poll.current=true;current.current.onRunning(false);const timer=setInterval(()=>{if(poll.current&&!current.current.disabled&&!current.current.closed)void send({kind:'task_status'});},2000);return()=>clearInterval(timer);},[orderId]);
  function start(){if(task&&task.state!=='running'&&request.current?.id===task.id)request.current=null;if(!request.current||request.current.script!==script||request.current.timeout_seconds!==limit)request.current={id:crypto.randomUUID(),script,timeout_seconds:limit};void send({kind:'task_start',...request.current});}
  const running=task?.state==='running';
  function download(){if(!task)return;const url=URL.createObjectURL(new Blob([`${task.script} · ${labels[task.state]}\n${task.log}`],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`task-${task.id.slice(0,8)}.log`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return <section className="task-panel" aria-label="长时任务"><div className="section-heading"><div><div className="eyebrow">RUN & FOLLOW / 任务运行</div><h2>让脚本跑一会儿。</h2></div><span className="status">{closed?'订单访问已关闭':task?labels[task.state]:'等待提交'}</span></div>
    <p className="small-muted">先保存 Python 脚本，再提交运行。每单同时运行一个任务，最长 10 分钟；关闭页面后继续运行，订单结束即销毁。日志仅保留本单最近一次任务的前 16 KiB，请提前下载。</p>
    <div className="task-inputs"><label>脚本文件<input aria-label="任务脚本" value={script} maxLength={180} disabled={disabled||busy||running} onChange={e=>setScript(e.target.value)}/></label><label>超时秒数<input aria-label="任务超时秒数" type="number" min={1} max={600} value={limit} disabled={disabled||busy||running} onChange={e=>setLimit(Number(e.target.value))}/></label><button disabled={disabled||busy||running} onClick={()=>setScript(currentFile)}>使用当前文件</button><button className="red" disabled={disabled||busy||running||!script.endsWith('.py')||!Number.isInteger(limit)||limit<1||limit>600} onClick={start}>提交任务</button></div>
    {error&&<p role="alert" className="form-error">{error}；可刷新状态核对，连接异常不代表任务已经停止。</p>}
    {task&&<><p className="task-caption">{task.script} · {new Date(task.started_at).toLocaleTimeString('zh-CN')} 开始 · 上限 {task.timeout_seconds} 秒{task.exit_code!==null&&` · 退出码 ${task.exit_code}`}</p><pre className="task-log" aria-label="任务日志">{task.log||'等待脚本输出…'}</pre>{task.truncated&&<p className="archive-hint">日志已达到 16 KiB，只保留开头部分；任务仍按时限运行。</p>}<div className="task-actions"><button disabled={disabled||busy||!running} onClick={()=>void send({kind:'task_stop',id:task.id})}>停止任务</button><button onClick={download}>下载任务日志</button></div></>}
    <button className="text-button" disabled={disabled||busy} onClick={()=>void send({kind:'task_status'})}>刷新任务状态</button>{running&&<p className="archive-hint">任务运行中，请先停止或等待完成，再保存成果快照或恢复历史文件。</p>}
  </section>;
}

