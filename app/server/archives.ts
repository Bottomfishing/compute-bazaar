import type {Express,Request} from 'express';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ApiError} from './errors.js';
import {event,settleDue,type Db,type Order,type User} from './db.js';
import {WorkspaceBridge} from './workspaces.js';
import {archiveLimits} from './archive-protocol.js';
import {makeArchive} from './archive-zip.js';
export function purgeArchives(db:Db,now=Date.now()){return db.prepare('DELETE FROM order_archives WHERE expires_at<=?').run(now).changes;}
export function mountArchives(app:Express,db:Db,auth:(req:Request)=>User,bridge:WorkspaceBridge){
  const busy=new Set<number>();
  function owned(req:Request){const u=auth(req),id=z.coerce.number().int().positive().parse(req.params.id);const o=db.prepare('SELECT o.*,l.machine_id,m.mode FROM orders o JOIN listings l ON l.id=o.listing_id JOIN machines m ON m.id=l.machine_id WHERE o.id=?').get(id) as (Order&{machine_id:number;mode:string})|undefined;if(!o)throw new ApiError(404,'NOT_FOUND','订单不存在');if(o.renter_id!==u.id)throw new ApiError(403,'FORBIDDEN','只能管理自己订单的成果');return {u,o};}
  function quota(user:number,order:number,bytes=0){const count=(db.prepare('SELECT COUNT(*) n FROM order_archives WHERE order_id=?').get(order) as {n:number}).n;const used=(db.prepare('SELECT COALESCE(SUM(size_bytes),0) n FROM order_archives WHERE user_id=?').get(user) as {n:number}).n;if(count>=archiveLimits.per_order||used+bytes>archiveLimits.user_bytes)throw new ApiError(409,'ARCHIVE_QUOTA','归档额度不足，请先下载并删除旧快照（每单 3 份、每账户 64 MiB）');return used;}
  function ready(req:Request){settleDue(db);const result=owned(req),{o}=result;if(o.status!=='running'||o.execution_status!=='ready'||o.ends_at<=Date.now())throw new ApiError(410,'ORDER_ENDED','请在环境就绪且租用结束前保存成果');if(!['docker-cpu','docker-gpu'].includes(o.mode))throw new ApiError(409,'ARCHIVE_UNSUPPORTED','成果归档仅支持真实容器工作台');return result;}
  app.get('/api/orders/:id/archives',(req,res)=>{const {u,o}=owned(req);purgeArchives(db);const rows=db.prepare('SELECT id,created_at,expires_at,size_bytes,sha256,manifest FROM order_archives WHERE order_id=? ORDER BY created_at DESC,id').all(o.id) as {manifest:string}[];res.json({archives:rows.map(r=>({...r,manifest:JSON.parse(r.manifest) as unknown})),limits:archiveLimits,used_bytes:(db.prepare('SELECT COALESCE(SUM(size_bytes),0) n FROM order_archives WHERE user_id=?').get(u.id) as {n:number}).n});});
  app.post('/api/orders/:id/archives',async(req,res)=>{
    const {u,o}=ready(req);const p=z.object({session:z.string().length(64)}).strict().parse(req.body);
    function access(){const {u:current}=ready(req);if(current.id!==u.id||!db.prepare('SELECT token_hash FROM access_sessions WHERE token_hash=? AND user_id=? AND order_id=? AND expires_at>?').get(createHash('sha256').update(p.session).digest('hex'),u.id,o.id,Date.now()))throw new ApiError(403,'ACCESS_EXPIRED','工作台会话已过期，请重新打开');}
    access();purgeArchives(db);quota(u.id,o.id);if(busy.has(u.id))throw new ApiError(409,'ARCHIVE_BUSY','已有成果正在保存，请等待完成');busy.add(u.id);
    try{
      const result=await bridge.request(o.machine_id,o.id,{kind:'archive'});access();
      if(result.exit_code!==0||!result.archive)throw new ApiError(502,'ARCHIVE_INVALID','agent 未返回归档内容，请更新并重启 agent');
      const archive=makeArchive(result.archive),id=randomUUID(),now=Date.now();
      db.transaction(()=>{access();purgeArchives(db,now);quota(u.id,o.id,archive.zip.length);db.prepare('INSERT INTO order_archives VALUES(?,?,?,?,?,?,?,?,?)').run(id,o.id,u.id,now,now+archiveLimits.retention_days*86400000,archive.zip.length,archive.sha256,JSON.stringify(archive.manifest),archive.zip);event(db,o.id,'archive_saved',`成果已保存：${archive.manifest.length} 个文件，${archive.zip.length} 字节，保留 7 天`,now);}).immediate();
      res.status(201).json({id,sha256:archive.sha256});
    }finally{busy.delete(u.id);}
  });
  app.get('/api/orders/:id/archives/:archiveId/download',(req,res)=>{const {u,o}=owned(req),id=z.string().uuid().parse(req.params.archiveId);purgeArchives(db);const a=db.prepare('SELECT content,sha256 FROM order_archives WHERE id=? AND order_id=? AND user_id=?').get(id,o.id,u.id) as {content:Buffer;sha256:string}|undefined;if(!a)throw new ApiError(404,'ARCHIVE_MISSING','成果不存在、已删除或已过期');res.set({'Content-Type':'application/zip','Content-Disposition':`attachment; filename="order-${o.id}-${id.slice(0,8)}.zip"`,'X-Content-Type-Options':'nosniff','X-Archive-SHA256':a.sha256,'Content-Security-Policy':"sandbox; default-src 'none'"}).send(a.content);});
  app.delete('/api/orders/:id/archives/:archiveId',(req,res)=>{const {u,o}=owned(req),id=z.string().uuid().parse(req.params.archiveId);z.object({}).strict().parse(req.body);const result=db.prepare('DELETE FROM order_archives WHERE id=? AND order_id=? AND user_id=?').run(id,o.id,u.id);if(!result.changes)throw new ApiError(404,'ARCHIVE_MISSING','成果不存在或已删除');event(db,o.id,'archive_deleted','租客删除了一份成果快照');res.json({ok:true});});
}
