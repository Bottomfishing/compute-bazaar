import express,{type Request,type Response,type NextFunction} from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes,createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createUser,listRows,models,money,settle,settleDue,vram,type Db,type User,type Order,type Listing } from './db.js';
import {ApiError} from './errors.js';
import {placeOrder} from './orders.js';
import {mountNotebooks} from './notebooks.js';
import {WorkspaceBridge,mountWorkspaces} from './workspaces.js';
import {mountMachines} from './machines.js';
import {mountArchives} from './archives.js';
import {mountRestores} from './restores.js';
const idSchema=z.coerce.number().int().positive();
const credentials=z.object({nickname:z.string().trim().min(2).max(24),password:z.string().min(8).max(72).refine(v=>Buffer.byteLength(v,'utf8')<=72,'密码不得超过 72 字节')}).strict();
const listingSchema=z.object({gpu_model:z.enum(models),gpu_count:z.number().int().min(1).max(64),price_cents_per_hour:z.number().int().min(30).max(6000),region:z.string().trim().min(2).max(40),note:z.string().trim().max(240)}).strict();
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export function createApp(db:Db,options:{seed?:boolean;bridge?:WorkspaceBridge}={}) {
  const app=express(); const production=process.env.NODE_ENV==='production';
  if(production&&!process.env.JWT_SECRET) throw new Error('Production requires JWT_SECRET');
  const secret=process.env.JWT_SECRET||randomBytes(48).toString('hex');
  if(options.seed!==false) seed(db);
  app.disable('x-powered-by');app.set('trust proxy','loopback');app.use('/notebooks',express.raw({type:()=>true,limit:'1mb'}));app.use(express.json({limit:'16kb'})); app.use(cookieParser());
  app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');res.set('X-Request-Id',randomUUID());next();});
  app.get('/api/health',(_req,res)=>{db.prepare('SELECT 1').get();res.json({status:'ok',schema_version:db.pragma('user_version',{simple:true})});});
  app.use('/api',(req,_res,next)=>{
    if(!['GET','HEAD','OPTIONS'].includes(req.method)) {
      if(req.get('sec-fetch-site')==='cross-site') return next(new ApiError(403,'ORIGIN','不允许跨站操作'));
      const origin=req.get('origin');
      if(origin) {try {const allowed=[`${req.protocol}://${req.get('host')}`,...(!production?['http://127.0.0.1:5173','http://localhost:5173','http://127.0.0.1:5183','http://localhost:5183']:[])];if(!allowed.includes(origin)) throw new Error();}catch{return next(new ApiError(403,'ORIGIN','请求来源无效'));}}
      if(!req.is('application/json')) return next(new ApiError(415,'CONTENT_TYPE','请使用 JSON 请求'));
    } next();
  });
  function current(req:Request):User|undefined {
    const token:unknown=req.cookies?.session;if(typeof token!=='string') return;
    try {const payload=jwt.verify(token,secret);if(typeof payload==='string'||typeof payload.jti!=='string')return;
      return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?').get(sha(payload.jti),Date.now()) as User|undefined;
    } catch{return;}
  }
  function auth(req:Request) {const u=current(req);if(!u) throw new ApiError(401,'UNAUTHENTICATED','请先登录后继续');return u;}
  function login(res:Response,id:number) {
    const jti=randomBytes(32).toString('hex');const expires=Date.now()+7*86400000;
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(jti),id,expires);
    res.cookie('session',jwt.sign({sub:String(id),jti},secret,{expiresIn:'7d'}),{httpOnly:true,sameSite:'lax',secure:production,maxAge:7*86400000,path:'/'});
  }
  const limited=new Map<string,{count:number;until:number}>();
  app.use(['/api/auth/login','/api/auth/register','/api/auth/demo'],(req,_res,next)=>{
    const key=req.ip||'local';const now=Date.now();for(const [k,v] of limited) if(v.until<now)limited.delete(k);
    const record=limited.get(key)||{count:0,until:now+60000};record.count++;limited.set(key,record);
    next(record.count>30?new ApiError(429,'RATE_LIMIT','操作过于频繁，请一分钟后再试'):undefined);
  });
  app.get('/api/me',(req,res)=>{const u=current(req);res.json({user:u?publicUser(u):null,server_now:Date.now(),development:!production});});
  app.post('/api/auth/register',(req,res)=>{const p=credentials.parse(req.body);if(db.prepare('SELECT id FROM users WHERE nickname=?').get(p.nickname))throw new ApiError(409,'NICKNAME_TAKEN','这个昵称已被使用');const hash=bcrypt.hashSync(p.password,10);const id=db.transaction(()=>createUser(db,p.nickname,hash)).immediate();login(res,id);res.status(201).json({ok:true});});
  app.post('/api/auth/login',(req,res)=>{const p=credentials.parse(req.body);const u=db.prepare('SELECT * FROM users WHERE nickname=?').get(p.nickname) as User|undefined;if(!u||!bcrypt.compareSync(p.password,u.password_hash))throw new ApiError(401,'BAD_CREDENTIALS','昵称或密码不正确');login(res,u.id);res.json({ok:true});});
  app.post('/api/auth/demo',(req,res)=>{z.object({}).strict().parse(req.body);if(production)throw new ApiError(404,'NOT_FOUND','接口不存在');const id=db.transaction(()=>createUser(db,`体验访客·${randomBytes(4).toString('hex')}`,bcrypt.hashSync(randomBytes(24).toString('hex'),10))).immediate();login(res,id);res.json({ok:true});});
  app.post('/api/auth/logout',(req,res)=>{z.object({}).strict().parse(req.body);const token:unknown=req.cookies?.session;if(typeof token==='string'){try{const p=jwt.verify(token,secret);if(typeof p!=='string'&&p.jti)db.prepare('DELETE FROM sessions WHERE token=?').run(sha(p.jti));}catch{/* An expired cookie is cleared as well. */}}res.clearCookie('session',{path:'/'}).json({ok:true});});
  app.get('/api/market',(_req,res)=>{settleDue(db);const rows=listRows(db);const active=rows.filter(l=>l.status==='active');res.json({listings:rows,stats:{available:active.reduce((s,l)=>s+l.available,0),listings:active.length,average:active.length?Math.round(active.reduce((s,l)=>s+l.price_cents_per_hour,0)/active.length):0,running:(db.prepare("SELECT COUNT(*) n FROM orders WHERE status='running'").get() as {n:number}).n},server_now:Date.now()});});
  app.get('/api/listings/mine',(req,res)=>{const u=auth(req);settleDue(db);res.json(listRows(db).filter(l=>l.owner_id===u.id));});
  app.post('/api/listings',(req,res)=>{const u=auth(req);const linked=z.object({machine_id:z.number().int().positive(),price_cents_per_hour:z.number().int().min(30).max(6000),note:z.string().trim().max(240)}).strict();
    if(req.body&&'machine_id' in req.body){const p=linked.parse(req.body);const id=db.transaction(()=>{const m=db.prepare('SELECT * FROM machines WHERE id=?').get(p.machine_id) as {id:number;owner_id:number;mode:string;status:string;gpu_model:string;gpu_count:number;region:string}|undefined;if(!m)throw new ApiError(404,'NOT_FOUND','机器不存在');if(m.owner_id!==u.id)throw new ApiError(403,'FORBIDDEN','只能挂牌自己的机器');if(m.mode==='demo'||m.status!=='online')throw new ApiError(409,'MACHINE_OFFLINE','请先启动 mock agent 并等待机器上线');if(db.prepare('SELECT id FROM listings WHERE machine_id=?').get(m.id))throw new ApiError(409,'ALREADY_LISTED','同一机器只能创建一张挂牌，请管理现有挂牌');return Number(db.prepare("INSERT INTO listings(machine_id,owner_id,gpu_model,gpu_count,price_cents_per_hour,region,note,status,created_at) VALUES(?,?,?,?,?,?,?,'active',?)").run(m.id,u.id,m.gpu_model,m.gpu_count,p.price_cents_per_hour,m.region,p.note,Date.now()).lastInsertRowid);}).immediate();res.status(201).json({id});return;}
    const p=listingSchema.parse(req.body);const id=db.transaction(()=>{const now=Date.now();const machine=Number(db.prepare("INSERT INTO machines(owner_id,name,gpu_model,gpu_count,vram_gb,region,status,created_at) VALUES(?,?,?,?,?,?,'offline',?)").run(u.id,`${p.gpu_model} 演示机器`,p.gpu_model,p.gpu_count,vram[p.gpu_model],p.region,now).lastInsertRowid);return Number(db.prepare("INSERT INTO listings(machine_id,owner_id,gpu_model,gpu_count,price_cents_per_hour,region,note,status,created_at) VALUES(?,?,?,?,?,?,?,'active',?)").run(machine,u.id,p.gpu_model,p.gpu_count,p.price_cents_per_hour,p.region,p.note,now).lastInsertRowid);}).immediate();res.status(201).json({id});});
  app.patch('/api/listings/:id',(req,res)=>{const u=auth(req);const id=idSchema.parse(req.params.id);const p=z.object({status:z.enum(['active','paused'])}).strict().parse(req.body);const l=db.prepare('SELECT * FROM listings WHERE id=?').get(id) as Listing|undefined;if(!l)throw new ApiError(404,'NOT_FOUND','挂牌不存在');if(l.owner_id!==u.id)throw new ApiError(403,'FORBIDDEN','只能操作自己的挂牌');db.prepare('UPDATE listings SET status=? WHERE id=?').run(p.status,id);res.json({ok:true});});
  app.post('/api/orders',(req,res)=>{const u=auth(req);const id=placeOrder(db,u.id,req.body,req.get('Idempotency-Key'));res.status(201).json({id});});
  app.get('/api/orders',(req,res)=>{const u=auth(req);settleDue(db);res.json({orders:db.prepare('SELECT o.*,m.mode FROM orders o JOIN listings l ON l.id=o.listing_id JOIN machines m ON m.id=l.machine_id WHERE o.renter_id=? ORDER BY o.id DESC').all(u.id),server_now:Date.now()});});
  app.post('/api/orders/:id/finish',(req,res)=>{const u=auth(req);const id=idSchema.parse(req.params.id);z.object({}).strict().parse(req.body);const o=db.prepare('SELECT * FROM orders WHERE id=?').get(id) as Order|undefined;if(!o)throw new ApiError(404,'NOT_FOUND','订单不存在');if(o.renter_id!==u.id)throw new ApiError(403,'FORBIDDEN','只能结束自己的订单');res.json(settle(db,id));});
  app.get('/api/wallet',(req,res)=>{const u=auth(req);settleDue(db);const fresh=db.prepare('SELECT * FROM users WHERE id=?').get(u.id) as User;const totals=db.prepare("SELECT COALESCE(SUM(CASE WHEN type='rent' THEN -amount_cents WHEN type='refund' THEN -amount_cents ELSE 0 END),0) spent,COALESCE(SUM(CASE WHEN type='income' THEN amount_cents ELSE 0 END),0) income FROM ledger WHERE user_id=?").get(u.id);res.json({balance_cents:fresh.balance_cents,totals,ledger:db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC').all(u.id)});});
  mountMachines(app,db,auth);
  const workspaceBridge=options.bridge??new WorkspaceBridge(db);
  mountWorkspaces(app,db,auth,workspaceBridge);
  mountArchives(app,db,auth,workspaceBridge);
  mountRestores(app,db,auth,workspaceBridge);
  mountNotebooks(app,db,auth,workspaceBridge);
  app.post('/api/dev/reset',(req,res)=>{if(production)throw new ApiError(404,'NOT_FOUND','接口不存在');auth(req);z.object({confirm:z.literal('RESET')}).strict().parse(req.body);db.transaction(()=>{db.exec('DELETE FROM order_restores;DELETE FROM order_archives;DELETE FROM access_tokens;DELETE FROM access_sessions;DELETE FROM machine_test_grants;DELETE FROM order_requests;DELETE FROM order_events;DELETE FROM agent_jobs;DELETE FROM gpu_allocations;DELETE FROM agent_credentials;DELETE FROM machine_gpus;DELETE FROM ledger;DELETE FROM orders;DELETE FROM listings;DELETE FROM machines;DELETE FROM sessions;DELETE FROM users;');seed(db);}).immediate();res.clearCookie('session',{path:'/'}).json({ok:true});});
  app.use('/api',(_req,_res,next)=>next(new ApiError(404,'NOT_FOUND','接口不存在')));
  app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>{if(err instanceof z.ZodError)return res.status(400).json({code:'VALIDATION',message:'参数不正确，请检查填写范围',details:err.issues.map(i=>({path:i.path.join('.'),message:i.message}))});if(err instanceof ApiError)return res.status(err.status).json({code:err.code,message:err.message});if(typeof err==='object'&&err&&'status' in err&&err.status===413)return res.status(413).json({code:'PAYLOAD_TOO_LARGE',message:'请求内容过大'});if(err instanceof SyntaxError)return res.status(400).json({code:'BAD_JSON',message:'JSON 格式不正确'});process.stderr.write(`${err instanceof Error?err.message:'Unknown error'}\n`);res.status(500).json({code:'INTERNAL',message:'服务暂时不可用，请稍后重试'});});
  return app;
}
function publicUser(u:User){return {id:u.id,nickname:u.nickname,balance_cents:u.balance_cents};}
export function seed(db:Db){if((db.prepare('SELECT COUNT(*) n FROM users').get() as {n:number}).n)return;
  db.transaction(()=>{const hash=bcrypt.hashSync(randomBytes(32).toString('hex'),10);const specs=[['城南算力铺','RTX 4090',8,200,'江苏 · 南京','适合图像创作、模型实验。独立卡位，灵活租用。'],['蓉城工作室','RTX 3090',6,120,'四川 · 成都','24G 大显存，给灵感留一点余量。'],['湾区计算所','RTX 5090',4,357,'广东 · 深圳','32G 显存，探索新一代创作体验。'],['湖畔实验室','A100 80G',2,650,'浙江 · 杭州','大模型研究与微调场景。阶段一模拟挂牌。']] as const;
  for(const [name,model,count,price,region,note]of specs){const owner=createUser(db,name,hash);const now=Date.now();const machine=Number(db.prepare("INSERT INTO machines(owner_id,name,gpu_model,gpu_count,vram_gb,region,status,created_at) VALUES(?,?,?,?,?,?,'offline',?)").run(owner,`${name}演示机器`,model,count,vram[model],region,now).lastInsertRowid);db.prepare("INSERT INTO listings(machine_id,owner_id,gpu_model,gpu_count,price_cents_per_hour,region,note,status,created_at) VALUES(?,?,?,?,?,?,?,'active',?)").run(machine,owner,model,count,price,region,note,now);}}).immediate();
}
