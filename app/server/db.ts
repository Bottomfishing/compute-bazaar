import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {migrate} from './migrations.js';
export const models = ['RTX 4090','RTX 3090','RTX 5090','A100 80G','RTX 5050 8G','CPU 沙箱'] as const;
export const vram: Record<string,number> = {'RTX 4090':24,'RTX 3090':24,'RTX 5090':32,'A100 80G':80,'RTX 5050 8G':8,'CPU 沙箱':0};
export interface User {id:number; nickname:string; password_hash:string; role:string; balance_cents:number; deposit_cents:number; created_at:number}
export interface Listing {id:number; machine_id:number; owner_id:number; gpu_model:string; gpu_count:number; price_cents_per_hour:number; region:string; note:string; status:string; created_at:number; nickname:string; available:number;mode:string;machine_status:string;environment_template:string}
export interface Order {id:number; listing_id:number; renter_id:number; provider_id:number; gpu_model:string; gpus:number; hours:number; unit_price_cents:number; prepaid_cents:number; started_at:number; ends_at:number; ended_at:number|null; status:string; billed_seconds:number; charged_cents:number; refund_cents:number; provider_income_cents:number; platform_fee_cents:number; fail_reason:string|null;execution_status:string;ready_at:number|null;preparation_deadline:number|null}
export function openDb(path:string) {
  if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
  const db=new Database(path); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,nickname TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',balance_cents INTEGER NOT NULL CHECK(balance_cents>=0),deposit_cents INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS machines(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL REFERENCES users(id),name TEXT NOT NULL,gpu_model TEXT NOT NULL,gpu_count INTEGER NOT NULL,vram_gb INTEGER NOT NULL,region TEXT NOT NULL,fingerprint TEXT,status TEXT NOT NULL,last_seen_at INTEGER,agent_version TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS listings(id INTEGER PRIMARY KEY,machine_id INTEGER NOT NULL REFERENCES machines(id),owner_id INTEGER NOT NULL REFERENCES users(id),gpu_model TEXT NOT NULL,gpu_count INTEGER NOT NULL,price_cents_per_hour INTEGER NOT NULL,region TEXT NOT NULL,note TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,listing_id INTEGER NOT NULL REFERENCES listings(id),renter_id INTEGER NOT NULL REFERENCES users(id),provider_id INTEGER NOT NULL REFERENCES users(id),gpu_model TEXT NOT NULL,gpus INTEGER NOT NULL,hours INTEGER NOT NULL,unit_price_cents INTEGER NOT NULL,prepaid_cents INTEGER NOT NULL,started_at INTEGER NOT NULL,ends_at INTEGER NOT NULL,ended_at INTEGER,status TEXT NOT NULL CHECK(status IN ('running','finished','failed')),billed_seconds INTEGER NOT NULL DEFAULT 0,charged_cents INTEGER NOT NULL DEFAULT 0,refund_cents INTEGER NOT NULL DEFAULT 0,provider_income_cents INTEGER NOT NULL DEFAULT 0,platform_fee_cents INTEGER NOT NULL DEFAULT 0,fail_reason TEXT);
    CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),order_id INTEGER REFERENCES orders(id),type TEXT NOT NULL,amount_cents INTEGER NOT NULL,balance_after_cents INTEGER NOT NULL,note TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS orders_running ON orders(status,ends_at);
    CREATE INDEX IF NOT EXISTS orders_listing ON orders(listing_id,status);
    CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id,id);
  `); migrate(db,path); return db;
}
export type Db=ReturnType<typeof openDb>;
export function money(db:Db,userId:number,amount:number,type:string,note:string,orderId:number|null=null,now=Date.now()) {
  db.prepare('UPDATE users SET balance_cents=balance_cents+? WHERE id=?').run(amount,userId);
  const user=db.prepare('SELECT balance_cents FROM users WHERE id=?').get(userId) as User;
  db.prepare('INSERT INTO ledger(user_id,order_id,type,amount_cents,balance_after_cents,note,created_at) VALUES(?,?,?,?,?,?,?)').run(userId,orderId,type,amount,user.balance_cents,note,now);
}
export function createUser(db:Db,nickname:string,hash:string) {
  const id=Number(db.prepare('INSERT INTO users(nickname,password_hash,balance_cents,created_at) VALUES(?,?,0,?)').run(nickname,hash,Date.now()).lastInsertRowid);
  money(db,id,10000,'bonus','入市礼 · 虚拟演示额度'); return id;
}
export function billing(price:number,gpus:number,started:number,ends:number,now:number,prepaid:number) {
  const seconds=Math.max(60,Math.ceil((Math.min(now,ends)-started)/1000));
  const charged=Math.min(prepaid,Math.floor((price*gpus*seconds+1800)/3600));
  const income=Math.floor((charged*85+50)/100);
  return {seconds,charged,income,fee:charged-income,refund:prepaid-charged};
}
export function settle(db:Db,id:number,now=Date.now()) {
  return db.transaction(()=>{
    const o=db.prepare('SELECT * FROM orders WHERE id=?').get(id) as Order|undefined;
    if(!o || o.status!=='running') return o;
    const b=o.execution_status==='preparing'?{seconds:0,charged:0,income:0,fee:0,refund:o.prepaid_cents}:billing(o.unit_price_cents,o.gpus,o.ready_at??o.started_at,o.ends_at,now,o.prepaid_cents);
    const result=db.prepare("UPDATE orders SET status='finished',ended_at=?,billed_seconds=?,charged_cents=?,refund_cents=?,provider_income_cents=?,platform_fee_cents=? WHERE id=? AND status='running'").run(Math.min(now,o.ends_at),b.seconds,b.charged,b.refund,b.income,b.fee,id);
    if(result.changes) {money(db,o.renter_id,b.refund,'refund','结束结算 · 退还未用额度',id,now);if(b.charged>0)money(db,o.provider_id,b.income,'income','算力供给收入 · 85%',id,now);queueCleanup(db,o,now);event(db,id,'finished',`结算完成，扣费 ${b.charged} 分`,now);}
    return db.prepare('SELECT * FROM orders WHERE id=?').get(id) as Order;
  }).immediate();
}
export function event(db:Db,id:number,kind:string,message:string,now=Date.now()){db.prepare('INSERT INTO order_events(order_id,kind,message,created_at) VALUES(?,?,?,?)').run(id,kind,message,now);}
export function queueCleanup(db:Db,o:Order,now=Date.now()){
  const machine=db.prepare('SELECT m.id,m.mode FROM machines m JOIN listings l ON l.machine_id=m.id WHERE l.id=?').get(o.listing_id) as {id:number;mode:string};
  if(machine.mode==='demo'){db.prepare("UPDATE orders SET execution_status='cleaned' WHERE id=?").run(o.id);return;}
  db.prepare("UPDATE agent_jobs SET status='cancelled' WHERE order_id=? AND kind='start' AND status IN ('queued','sent')").run(o.id);
  db.prepare("UPDATE gpu_allocations SET status='quarantined' WHERE order_id=? AND status!='released'").run(o.id);
  db.prepare("UPDATE orders SET execution_status='stopping' WHERE id=?").run(o.id);
  db.prepare("INSERT OR IGNORE INTO agent_jobs(machine_id,order_id,kind,status,available_at,deadline) VALUES(?,?,'stop','queued',?,?)").run(machine.id,o.id,now,now+60000);
}
export function failOrder(db:Db,id:number,reason:string,now=Date.now()){
  return db.transaction(()=>{const o=db.prepare('SELECT * FROM orders WHERE id=?').get(id) as Order|undefined;if(!o||o.status!=='running')return;
    const r=db.prepare("UPDATE orders SET status='failed',ended_at=?,billed_seconds=0,charged_cents=0,refund_cents=prepaid_cents,fail_reason=? WHERE id=? AND status='running'").run(now,reason,id);
    if(r.changes){money(db,o.renter_id,o.prepaid_cents,'refund',`失败全额退款 · ${reason}`,id,now);queueCleanup(db,o,now);event(db,id,'failed',reason,now);}
  }).immediate();
}
export function settleDue(db:Db,now=Date.now()) {
  db.transaction(()=>{
    for(const m of db.prepare("SELECT id FROM machines WHERE mode!='demo' AND status='online' AND last_seen_at<=?").all(now-30000) as {id:number}[]){db.prepare("UPDATE machines SET status='offline' WHERE id=?").run(m.id);for(const o of db.prepare("SELECT o.id FROM orders o JOIN listings l ON l.id=o.listing_id WHERE l.machine_id=? AND o.status='running'").all(m.id) as {id:number}[])failOrder(db,o.id,'机器心跳超时',now);}
    for(const o of db.prepare("SELECT id FROM orders WHERE status='running' AND execution_status='preparing' AND preparation_deadline<=?").all(now) as {id:number}[])failOrder(db,o.id,'环境准备超时',now);
    for(const o of db.prepare("SELECT id FROM orders WHERE status='running' AND execution_status='ready' AND ends_at<=?").all(now) as {id:number}[])settle(db,o.id,now);
  }).immediate();
}
export function listRows(db:Db) {return db.prepare(`SELECT l.*,u.nickname,m.mode,m.environment_template,m.status machine_status,
 CASE WHEN m.mode='demo' THEN l.gpu_count-COALESCE((SELECT SUM(o.gpus) FROM orders o WHERE o.listing_id=l.id AND o.status='running'),0)
 WHEN m.status!='online' OR m.last_seen_at<=? THEN 0 ELSE (SELECT COUNT(*) FROM machine_gpus g WHERE g.machine_id=m.id AND NOT EXISTS(SELECT 1 FROM gpu_allocations a WHERE a.gpu_id=g.id AND a.status!='released')) END AS available
 FROM listings l JOIN users u ON u.id=l.owner_id JOIN machines m ON m.id=l.machine_id ORDER BY l.price_cents_per_hour,l.id`).all(Date.now()-30000) as Listing[];}
