import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ApiError} from './errors.js';
import {event,listRows,money,settleDue,type Db,type User} from './db.js';
export const orderInput=z.object({listing_id:z.number().int().positive(),gpus:z.number().int().min(1).max(64),hours:z.number().int().min(1).max(72)}).strict();
export function placeOrder(db:Db,userId:number,input:unknown,key?:string){
  const p=orderInput.parse(input);
  if(key!==undefined)z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/).parse(key);
  const digest=createHash('sha256').update(JSON.stringify(p)).digest('hex');
  return db.transaction(()=>{
    if(key){const old=db.prepare('SELECT * FROM order_requests WHERE user_id=? AND request_key=?').get(userId,key) as {digest:string;order_id:number}|undefined;if(old){if(old.digest!==digest)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','同一请求编号不能用于不同订单');return old.order_id;}}
    settleDue(db);const l=listRows(db).find(l=>l.id===p.listing_id);
    if(!l)throw new ApiError(404,'NOT_FOUND','挂牌不存在');if(l.owner_id===userId)throw new ApiError(400,'OWN_LISTING','不能租用自己的算力');if(l.status!=='active')throw new ApiError(409,'PAUSED','该挂牌已下架');if(p.gpus>l.available)throw new ApiError(409,'CAPACITY',`仅剩 ${l.available} 卡，请减少租用数量`);
    if(l.mode.startsWith('docker')&&!db.prepare('SELECT user_id FROM machine_test_grants WHERE machine_id=? AND user_id=?').get(l.machine_id,userId))throw new ApiError(403,'TEST_INVITE_REQUIRED','容器内测资源需要机主邀请，请联系机主授权测试账号');
    const prepaid=l.price_cents_per_hour*p.gpus*p.hours;const u=db.prepare('SELECT * FROM users WHERE id=?').get(userId) as User;if(u.balance_cents<prepaid)throw new ApiError(400,'BALANCE',`余额不足，需要 ¥${(prepaid/100).toFixed(2)}，当前 ¥${(u.balance_cents/100).toFixed(2)}`);
    const now=Date.now(),managed=l.mode!=='demo';const id=Number(db.prepare("INSERT INTO orders(listing_id,renter_id,provider_id,gpu_model,gpus,hours,unit_price_cents,prepaid_cents,started_at,ends_at,status,execution_status,preparation_deadline) VALUES(?,?,?,?,?,?,?,?,?,?,'running',?,?)").run(l.id,userId,l.owner_id,l.gpu_model,p.gpus,p.hours,l.price_cents_per_hour,prepaid,now,now+p.hours*3600000,managed?'preparing':'ready',managed?now+60000:null).lastInsertRowid);
    money(db,userId,-prepaid,'rent','租用预付 · 未用额度结算后退回',id,now);event(db,id,'created',managed?'预付完成，已预留 GPU，等待环境准备':'模拟租用已就绪',now);
    if(managed){const cards=db.prepare("SELECT id FROM machine_gpus g WHERE machine_id=? AND NOT EXISTS(SELECT 1 FROM gpu_allocations a WHERE a.gpu_id=g.id AND a.status!='released') ORDER BY id LIMIT ?").all(l.machine_id,p.gpus) as {id:number}[];if(cards.length!==p.gpus)throw new ApiError(409,'CAPACITY','资源已被其他订单预留');for(const c of cards)db.prepare("INSERT INTO gpu_allocations(order_id,gpu_id,status,created_at) VALUES(?,?,'reserved',?)").run(id,c.id,now);db.prepare("INSERT INTO agent_jobs(machine_id,order_id,kind,status,available_at,deadline) VALUES(?,?,'start','queued',?,?)").run(l.machine_id,id,now,now+60000);}
    if(key)db.prepare('INSERT INTO order_requests VALUES(?,?,?,?)').run(userId,key,digest,id);return id;
  }).immediate();
}
