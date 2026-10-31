import {useEffect,useState} from 'react';
import {api,message} from './api';
interface Mapping {source:string;name:string;size:number;sha256:string}
interface Plan {id:string;source_order_id:number;state:string;mapping:Mapping[];receipt:null|{created:string[];reused:string[];conflicts:string[]};message:string;expires_at:number;created_at:number}
interface Source {id:string;order_id:number;created_at:number;expires_at:number;manifest:{name:string;size:number}[]}
interface Sources {sources:Source[];next_offset:number|null}
const states:Record<string,string>={planned:'等待确认',running:'结果待核对',uncertain:'结果待核对',succeeded:'恢复完成',partial:'部分完成',failed:'恢复未完成'};
export default function RestorePanel({orderId,disabled,session,onBusy,onRestored,enqueue}:{orderId:number;disabled:boolean;session:()=>string;onBusy:(busy:boolean)=>void;onRestored:()=>Promise<void>;enqueue:<T>(fn:()=>Promise<T>)=>Promise<T>}){
  const [sources,setSources]=useState<Source[]|null>(null),[next,setNext]=useState<number|null>(null),[plan,setPlan]=useState<Plan|null>(null),[history,setHistory]=useState<Plan[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(Date.now());
  const base=`/orders/${orderId}/restores`;
  useEffect(()=>{let cancelled=false;setPlan(null);setSources(null);setError('');void api<{restores:Plan[]}>(base).then(r=>{if(!cancelled){setHistory(r.restores);setPlan(r.restores[0]??null);}}).catch(e=>{if(!cancelled)setError(message(e));});const timer=setInterval(()=>setNow(Date.now()),1000);return()=>{cancelled=true;clearInterval(timer);};},[base]);
  async function perform(fn:()=>Promise<void>){setBusy(true);onBusy(true);setError('');try{await fn();}catch(e){setError(message(e));}finally{setBusy(false);onBusy(false);}}
  async function choose(offset=0){await perform(async()=>{const r=await api<Sources>(`${base}/sources?offset=${offset}`);setSources(old=>offset?[...(old??[]),...r.sources]:r.sources);setNext(r.next_offset);});}
  async function preview(id:string){await perform(async()=>{const r=await enqueue(()=>api<Plan>(`${base}/preview`,'POST',{session:session(),archive_id:id}));setPlan(r);setSources(null);setHistory((await api<{restores:Plan[]}>(base)).restores);});}
  async function confirm(){if(!plan)return;await perform(async()=>{
    let result:Plan|undefined;
    try{result=await enqueue(()=>api<Plan>(`${base}/${plan.id}`,'POST',{session:session()}));setPlan(result);}
    finally{const r=await api<{restores:Plan[]}>(base);setHistory(r.restores);const current=r.restores.find(p=>p.id===plan.id);if(current)setPlan(current);}
    if(result?.receipt)await onRestored();
  });}
  const expired=!!plan&&plan.expires_at<=now,renamed=plan?.mapping.some(f=>f.source!==f.name);
  return <section className="restore-panel" aria-label="历史成果恢复"><div className="section-heading"><div><div className="eyebrow">PICK UP WHERE YOU LEFT OFF / 继续上次的工作</div><h2>把历史成果，接到这一单。</h2></div><button disabled={disabled||busy} onClick={()=>void choose()}>选择历史成果</button></div>
    <p className="small-muted">从自己的其他订单选择未过期的快照。先预览再恢复，重名文件另存副本；只复制文件，不执行代码，也不延长租用时间。</p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {sources&&<div className="restore-sources"><div className="section-heading"><strong>选择一份历史快照</strong><button disabled={busy} onClick={()=>setSources(null)}>收起选择</button></div>{sources.length===0&&<p>暂无可用的历史快照。请先在其他订单结束前保存成果，快照保留 7 天。</p>}{sources.map(s=><article className="restore-source" key={s.id}><div><strong>订单 #{s.order_id}</strong><p>{new Date(s.created_at).toLocaleString('zh-CN')} · {s.manifest.length} 个文件</p><small>有效至 {new Date(s.expires_at).toLocaleString('zh-CN')}</small></div><button disabled={disabled||busy} onClick={()=>void preview(s.id)}>预览恢复</button></article>)}{next!==null&&<button disabled={disabled||busy} onClick={()=>void choose(next)}>加载更多快照</button>}</div>}
    {plan&&<article className="restore-plan"><div className="section-heading"><strong>来自订单 #{plan.source_order_id}</strong><span className="status">{states[plan.state]||plan.state}</span></div>
      <div className="restore-table-wrap"><table className="restore-table"><thead><tr><th>快照中的文件</th><th>本单保存为</th><th>大小</th></tr></thead><tbody>{plan.mapping.map(f=><tr key={f.source}><td>{f.source}</td><td className={f.source!==f.name?'restore-renamed':''}>{f.name}{f.source!==f.name&&<small>重名，另存副本</small>}</td><td>{f.size.toLocaleString()} B</td></tr>)}</tbody></table></div>
      {plan.state!=='succeeded'&&<><p className="archive-hint">请先保存文件，并停止终端、Notebook 与后台程序对工作目录的写入。恢复只包含文件内容，运行环境和内核状态不会恢复。</p>{renamed&&<p className="restore-warning">部分文件将改名保存。脚本引用这些文件时，可能需要手动调整文件名。</p>}<p className="small-muted">{expired?'这份计划已过期，请重新选择快照并预览。':`请于 ${new Date(plan.expires_at).toLocaleTimeString('zh-CN')} 前确认；重试沿用本次文件名，相同内容直接复用。`}</p></>}
      {plan.receipt&&<div className="restore-receipt" role="status"><strong>{states[plan.state]}：新增 {plan.receipt.created.length} 个 · 复用 {plan.receipt.reused.length} 个 · 冲突 {plan.receipt.conflicts.length} 个</strong>{plan.receipt.conflicts.length>0&&<p>冲突文件：{plan.receipt.conflicts.join('、')}</p>}</div>}
      {plan.message&&<p className="small-muted">{plan.message}</p>}
      {plan.state!=='succeeded'&&<button className="red" disabled={disabled||busy||expired} onClick={()=>void confirm()}>{busy?'正在恢复…':plan.state==='planned'?`确认恢复 ${plan.mapping.length} 个文件`:'按原计划重试'}</button>}
    </article>}
    {history.length>0&&<details className="restore-history"><summary>本单恢复记录（{history.length}）</summary>{history.map(p=><button disabled={busy} key={p.id} onClick={()=>{setPlan(p);setError('');}}>{new Date(p.created_at).toLocaleTimeString('zh-CN')} · 订单 #{p.source_order_id} · {states[p.state]}</button>)}</details>}
  </section>;
}
