import type {Express,Request} from 'express';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ApiError} from './errors.js';
import {event,settleDue,type Db,type Order,type User} from './db.js';
import type {WorkspaceBridge} from './workspaces.js';
import {readArchive} from './archive-zip.js';
import {restoreReceipt} from './workspace-protocol.js';

type Mapping={source:string;name:string;size:number;sha256:string};
type Plan={id:string;order_id:number;source_order_id:number;archive_id:string;user_id:number;state:string;source_sha256:string;mapping:string;receipt:string|null;message:string;created_at:number;expires_at:number;updated_at:number};
type Source={id:string;order_id:number;expires_at:number;sha256:string;manifest:string;content:Buffer};
const key=(name:string)=>name.normalize('NFC').toLocaleLowerCase('en-US');
const sessionBody=z.object({session:z.string().length(64)}).strict();
function publicPlan(p:Plan){return {...p,mapping:JSON.parse(p.mapping) as Mapping[],receipt:p.receipt?JSON.parse(p.receipt) as unknown:null};}
function trimName(text:string,bytes:number,units:number){let result='';for(const char of text){if(Buffer.byteLength(result+char)>bytes||result.length+char.length>units)break;result+=char;}return result;}
function copyName(name:string,id:string){
  const dot=name.lastIndexOf('.'),stem=dot>0?name.slice(0,dot):name,extension=dot>0?trimName(name.slice(dot),60,40):'',suffix=`-restored-${id.slice(0,8)}${extension}`;
  // Both the API's UTF-16 length and Linux's 255-byte filename limit apply.
  return trimName(stem,255-Buffer.byteLength(suffix),180-suffix.length)+suffix;
}

export function mountRestores(app:Express,db:Db,auth:(req:Request)=>User,bridge:WorkspaceBridge){
  const busy=new Set<number>();
  function owned(req:Request,live=false){
    if(live)settleDue(db);
    const u=auth(req),id=z.coerce.number().int().positive().parse(req.params.id);
    const o=db.prepare('SELECT o.*,l.machine_id,m.mode FROM orders o JOIN listings l ON l.id=o.listing_id JOIN machines m ON m.id=l.machine_id WHERE o.id=?').get(id) as (Order&{machine_id:number;mode:string})|undefined;
    if(!o)throw new ApiError(404,'NOT_FOUND','订单不存在');
    if(o.renter_id!==u.id)throw new ApiError(403,'FORBIDDEN','只能向自己的订单恢复成果');
    if(live&&(o.status!=='running'||o.execution_status!=='ready'||o.ends_at<=Date.now()))throw new ApiError(410,'ORDER_ENDED','请在环境就绪且租用结束前恢复成果');
    if(live&&!['docker-cpu','docker-gpu'].includes(o.mode))throw new ApiError(409,'RESTORE_UNSUPPORTED','成果恢复仅支持真实容器工作台');
    return {u,o};
  }
  function access(req:Request,session:string){const result=owned(req,true),{u,o}=result;if(!db.prepare('SELECT token_hash FROM access_sessions WHERE token_hash=? AND user_id=? AND order_id=? AND expires_at>?').get(createHash('sha256').update(session).digest('hex'),u.id,o.id,Date.now()))throw new ApiError(403,'ACCESS_EXPIRED','工作台会话已过期，请重新打开');return result;}
  function source(id:string,user:number,target:number){const s=db.prepare('SELECT id,order_id,expires_at,sha256,manifest,content FROM order_archives WHERE id=? AND user_id=? AND expires_at>? AND order_id<>?').get(id,user,Date.now(),target) as Source|undefined;if(!s)throw new ApiError(404,'RESTORE_SOURCE_MISSING','历史快照不存在、已删除或已过期');return s;}
  function lock(order:number){if(busy.has(order))throw new ApiError(409,'RESTORE_BUSY','已有恢复操作正在进行，请等待结果');busy.add(order);}
  app.get('/api/orders/:id/restores/sources',(req,res)=>{
    const {u,o}=owned(req,true),offset=z.coerce.number().int().min(0).max(1000000).parse(req.query.offset??0);
    const rows=db.prepare('SELECT id,order_id,created_at,expires_at,size_bytes,sha256,manifest FROM order_archives WHERE user_id=? AND order_id<>? AND expires_at>? ORDER BY created_at DESC,id LIMIT 21 OFFSET ?').all(u.id,o.id,Date.now(),offset) as {manifest:string}[];
    res.json({sources:rows.slice(0,20).map(r=>({...r,manifest:JSON.parse(r.manifest) as unknown})),next_offset:rows.length>20?offset+20:null});
  });
  app.get('/api/orders/:id/restores',(req,res)=>{const {u,o}=owned(req);const plans=db.prepare('SELECT * FROM order_restores WHERE user_id=? AND order_id=? ORDER BY created_at DESC,id LIMIT 20').all(u.id,o.id) as Plan[];res.json({restores:plans.map(publicPlan)});});
  app.post('/api/orders/:id/restores/preview',async(req,res)=>{
    const p=sessionBody.extend({archive_id:z.string().uuid()}).parse(req.body),{u,o}=access(req,p.session);
    lock(o.id);
    try{
      db.prepare("DELETE FROM order_restores WHERE order_id=? AND state='planned' AND expires_at<=?").run(o.id,Date.now());
      if((db.prepare('SELECT COUNT(*) n FROM order_restores WHERE order_id=?').get(o.id) as {n:number}).n>=20)throw new ApiError(409,'RESTORE_QUOTA','每单最多保留 20 次恢复计划，请在新订单继续');
      const s=source(p.archive_id,u.id,o.id),payload=readArchive(s.content,s.sha256,s.manifest),id=randomUUID();
      const candidates=payload.files.map(f=>copyName(f.name,id));
      const probe=await bridge.request(o.machine_id,o.id,{kind:'restore_probe',names:[...payload.files.map(f=>f.name),...candidates]});
      access(req,p.session);source(s.id,u.id,o.id);
      if(probe.exit_code!==0||!probe.existing)throw new ApiError(502,'RESTORE_AGENT','无法预览文件，请更新并重启 agent 后重试');
      const existing=new Set(probe.existing.map(key)),chosen=new Set<string>();
      const mapping:Mapping[]=payload.files.map((f,i)=>{const name=existing.has(key(f.name))?candidates[i]:f.name;if(existing.has(key(name))||chosen.has(key(name)))throw new ApiError(409,'RESTORE_NAME_CONFLICT','副本文件名也存在冲突，请重新预览');chosen.add(key(name));return {source:f.name,name,size:Buffer.from(f.body,'base64').length,sha256:f.sha256};});
      const now=Date.now(),expires=Math.min(now+300000,s.expires_at,o.ends_at);
      db.prepare("INSERT INTO order_restores(id,order_id,source_order_id,archive_id,user_id,state,source_sha256,mapping,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,'planned',?,?,?,?,?)").run(id,o.id,s.order_id,s.id,u.id,s.sha256,JSON.stringify(mapping),now,expires,now);
      res.status(201).json(publicPlan(db.prepare('SELECT * FROM order_restores WHERE id=?').get(id) as Plan));
    }finally{busy.delete(o.id);}
  });
  app.post('/api/orders/:id/restores/:restoreId',async(req,res)=>{
    const p=sessionBody.parse(req.body),{u,o}=access(req,p.session),id=z.string().uuid().parse(req.params.restoreId);
    const plan=db.prepare('SELECT * FROM order_restores WHERE id=? AND user_id=? AND order_id=?').get(id,u.id,o.id) as Plan|undefined;
    if(!plan)throw new ApiError(404,'RESTORE_MISSING','恢复计划不存在');
    if(plan.state==='succeeded'){res.json(publicPlan(plan));return;}
    if(plan.expires_at<=Date.now())throw new ApiError(410,'RESTORE_EXPIRED','恢复计划已过期，请重新选择快照并预览');
    lock(o.id);
    try{
      const s=source(plan.archive_id,u.id,o.id);if(s.sha256!==plan.source_sha256)throw new ApiError(502,'RESTORE_SOURCE_CHANGED','快照校验值变化，请重新预览');
      const payload=readArchive(s.content,s.sha256,s.manifest),mapping=JSON.parse(plan.mapping) as Mapping[];
      if(mapping.length!==payload.files.length||mapping.some((m,i)=>m.source!==payload.files[i].name||m.sha256!==payload.files[i].sha256))throw new ApiError(502,'RESTORE_PLAN_INVALID','恢复计划校验失败');
      db.prepare("UPDATE order_restores SET state='running',message='正在恢复；中断后可按原计划重试',updated_at=? WHERE id=?").run(Date.now(),id);
      try{
        const result=await bridge.request(o.machine_id,o.id,{kind:'restore',request_id:id,payload:{files:payload.files.map((f,i)=>({...f,name:mapping[i].name}))}});
        const parsedReceipt=restoreReceipt.safeParse(result.restored);
        if(!parsedReceipt.success)throw new ApiError(502,'RESTORE_RECEIPT_INVALID','agent 未返回有效恢复回执，请核对记录后重试');
        const receipt=parsedReceipt.data,names=[...receipt.created,...receipt.reused,...receipt.conflicts],expected=new Set(mapping.map(m=>m.name));
        if(names.some(n=>!expected.has(n))||new Set(names).size!==names.length||(result.exit_code===0&&(receipt.conflicts.length!==0||names.length!==mapping.length)))throw new ApiError(502,'RESTORE_RECEIPT_INVALID','agent 返回的恢复回执不完整，请核对记录后重试');
        const state=result.exit_code===0?'succeeded':receipt.created.length||receipt.reused.length?'partial':'failed';
        db.transaction(()=>{db.prepare('UPDATE order_restores SET state=?,receipt=?,message=?,updated_at=? WHERE id=?').run(state,JSON.stringify(receipt),result.output.slice(0,500),Date.now(),id);event(db,o.id,'archive_restored',`历史订单 #${plan.source_order_id} 恢复${state==='succeeded'?'完成':'未全部完成'}：新增 ${receipt.created.length}，复用 ${receipt.reused.length}，冲突 ${receipt.conflicts.length}`);}).immediate();
      }catch(e){db.prepare("UPDATE order_restores SET state='uncertain',message=?,updated_at=? WHERE id=?").run('连接中断或回执无效，文件可能已写入；请核对记录，或在计划有效期内按原计划重试',Date.now(),id);throw e;}
      // Persist the factual receipt even if logout or order termination happened during writing.
      access(req,p.session);res.json(publicPlan(db.prepare('SELECT * FROM order_restores WHERE id=?').get(id) as Plan));
    }finally{busy.delete(o.id);}
  });
}
