import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import request from 'supertest';
import {createHash,randomUUID} from 'node:crypto';
import {openDb,type Db} from '../server/db.js';
import {createApp} from '../server/app.js';
import {WorkspaceBridge} from '../server/workspaces.js';
import {makeArchive,readArchive} from '../server/archive-zip.js';
import type {WorkspaceResult} from '../server/workspace-protocol.js';
import {ApiError} from '../server/errors.js';
const file=(name:string,body=Buffer.from('answer=42'))=>({name,body:body.toString('base64'),sha256:createHash('sha256').update(body).digest('hex')});
let db:Db,app:ReturnType<typeof createApp>,bridge:WorkspaceBridge,host:ReturnType<typeof request.agent>,renter:ReturnType<typeof request.agent>,other:ReturnType<typeof request.agent>,order:number,sourceOrder:number,sourceId:string,token:string;
beforeEach(async()=>{
  db=openDb(':memory:');bridge=new WorkspaceBridge(db);app=createApp(db,{seed:false,bridge});host=request.agent(app);renter=request.agent(app);other=request.agent(app);
  for(const [a,nickname]of [[host,'恢复机主'],[renter,'恢复租客'],[other,'其他租客']] as const)await a.post('/api/auth/register').send({nickname,password:'restore-test-pass'}).expect(201);
  const machine=(await host.post('/api/machines').send({name:'恢复节点',gpu_model:'RTX 4090',gpu_count:2,region:'南京'}).expect(201)).body.id as number;
  const credential=(await host.post(`/api/machines/${machine}/credentials`).send({})).body.token as string;
  await request(app).post('/api/agent/register').set('Authorization',`Bearer ${credential}`).send({version:'test',gpus:[0,1].map(i=>({uuid:`MOCK-${machine}-GPU-${i}`,gpu_model:'RTX 4090',vram_gb:24})),active_orders:[]}).expect(200);
  const listing=(await host.post('/api/listings').send({machine_id:machine,price_cents_per_hour:200,note:''}).expect(201)).body.id as number;
  sourceOrder=(await renter.post('/api/orders').send({listing_id:listing,gpus:1,hours:1}).expect(201)).body.id as number;
  order=(await renter.post('/api/orders').send({listing_id:listing,gpus:1,hours:1}).expect(201)).body.id as number;
  db.exec("UPDATE orders SET execution_status='ready',ready_at=started_at;UPDATE machines SET mode='docker-cpu'");
  sourceId=randomUUID();const a=makeArchive({files:[file('result.txt'),file('计算.bin',Buffer.from([0,255,128]))]});
  db.prepare('INSERT INTO order_archives VALUES(?,?,?,?,?,?,?,?,?)').run(sourceId,sourceOrder,2,Date.now(),Date.now()+86400000,a.zip.length,a.sha256,JSON.stringify(a.manifest),a.zip);
  const t=(await renter.post(`/api/orders/${order}/workspace/tickets`).send({}).expect(200)).body.ticket;
  token=(await renter.post(`/api/orders/${order}/workspace/sessions`).send({ticket:t}).expect(200)).body.session;
});
afterEach(()=>{vi.restoreAllMocks();db.close();});
const preview=()=>renter.post(`/api/orders/${order}/restores/preview`).send({session:token,archive_id:sourceId});
const confirm=(id:string)=>renter.post(`/api/orders/${order}/restores/${id}`).send({session:token});
function responder(existing:string[]=[]){return vi.spyOn(bridge,'request').mockImplementation(async(_machine,_order,action)=>action.kind==='restore_probe'?{output:'',exit_code:0,existing}:action.kind==='restore'?{output:'文件恢复完成',exit_code:0,restored:{created:action.payload.files.map(f=>f.name),reused:[],conflicts:[]}}:Promise.reject(new Error('unexpected action')));}

it('只解析平台确定格式的 ZIP，中文、二进制与空文件无损，篡改和伪造清单拒绝',()=>{
  const payload={files:[file('中文.bin',Buffer.from([0,255,128])),file('empty',Buffer.alloc(0))]},a=makeArchive(payload);
  expect(readArchive(a.zip,a.sha256,JSON.stringify(a.manifest))).toEqual(payload);
  const corrupt=Buffer.from(a.zip);corrupt[14]^=1;const hash=createHash('sha256').update(corrupt).digest('hex');
  expect(()=>readArchive(corrupt,hash,JSON.stringify(a.manifest))).toThrow('校验失败');
  expect(()=>readArchive(a.zip,'0'.repeat(64),JSON.stringify(a.manifest))).toThrow();
  expect(()=>readArchive(a.zip,a.sha256,JSON.stringify([{...a.manifest[0],name:'../secret'}]))).toThrow();
  expect(()=>readArchive(a.zip,a.sha256,JSON.stringify([{...a.manifest[0],size:1048577}]))).toThrow();
});
it('预览生成固定副本名；确认只发送服务端校验文件，重复确认不重发、不改账本与租期',async()=>{
  const spy=responder(['result.txt']),ledger=db.prepare('SELECT * FROM ledger').all(),ends=(db.prepare('SELECT ends_at FROM orders WHERE id=?').get(order) as {ends_at:number}).ends_at;
  const p=(await preview().expect(201)).body;expect(p.mapping[0].name).toMatch(/^result-restored-[a-f0-9]{8}\.txt$/);expect(p.mapping[1].name).toBe('计算.bin');
  const r=(await confirm(p.id).expect(200)).body;expect(r.state).toBe('succeeded');expect(r.receipt.created).toHaveLength(2);expect(spy).toHaveBeenCalledTimes(2);
  const action=spy.mock.calls[1][2];expect(action.kind).toBe('restore');if(action.kind==='restore'){expect(action.payload.files[0].name).toBe(p.mapping[0].name);expect(Buffer.from(action.payload.files[1].body,'base64')).toEqual(Buffer.from([0,255,128]));}
  await confirm(p.id).expect(200);expect(spy).toHaveBeenCalledTimes(2);expect(db.prepare('SELECT * FROM ledger').all()).toEqual(ledger);expect((db.prepare('SELECT ends_at FROM orders WHERE id=?').get(order) as {ends_at:number}).ends_at).toBe(ends);
  await renter.post(`/api/orders/${order}/finish`).send({}).expect(200);expect((await renter.get(`/api/orders/${order}/restores`).expect(200)).body.restores[0].state).toBe('succeeded');await confirm(p.id).expect(410);
});
it('来源列表不泄露正文，匿名、其他租客、机主和跨订单会话不能预览或确认',async()=>{
  responder();const path=`/api/orders/${order}/restores/sources`;await request(app).get(path).expect(401);await host.get(path).expect(403);await other.get(path).expect(403);
  const sources=(await renter.get(path).expect(200)).body.sources;expect(sources).toHaveLength(1);expect(sources[0].id).toBe(sourceId);expect(JSON.stringify(sources)).not.toContain('YW5zd2Vy');
  await renter.post(`/api/orders/${sourceOrder}/restores/preview`).send({session:token,archive_id:sourceId}).expect(403);
  const p=(await preview().expect(201)).body;
  await other.post(`/api/orders/${order}/restores/${p.id}`).send({session:token}).expect(403);
  await renter.post(`/api/orders/${order}/restores/${p.id}`).send({session:token,payload:{files:[]}}).expect(400);
  db.prepare('UPDATE order_archives SET user_id=3').run();await preview().expect(404);await confirm(p.id).expect(404);
});
it('禁止绕过恢复入口发送内部协议；模拟机器、准备中、过期会话均不能恢复',async()=>{
  const spy=responder();for(const action of [{kind:'restore_probe',names:['result.txt']},{kind:'restore',request_id:randomUUID(),payload:{files:[file('result.txt')]}}])await renter.post(`/api/orders/${order}/workspace/actions`).send({session:token,action}).expect(400);
  db.exec("UPDATE machines SET mode='mock'");await preview().expect(409);db.exec("UPDATE machines SET mode='docker-cpu';UPDATE orders SET execution_status='preparing'");await preview().expect(410);db.exec("UPDATE orders SET execution_status='ready';UPDATE access_sessions SET expires_at=0");await preview().expect(403);expect(spy).not.toHaveBeenCalled();
});
it('快照过期、删除、同订单来源与校验不符均在写入前拒绝',async()=>{
  const spy=responder();db.prepare('UPDATE order_archives SET order_id=?').run(order);await preview().expect(404);db.prepare('UPDATE order_archives SET order_id=?,expires_at=0').run(sourceOrder);await preview().expect(404);db.prepare('UPDATE order_archives SET expires_at=?,sha256=?').run(Date.now()+60000,'0'.repeat(64));await preview().expect(502);expect(spy).not.toHaveBeenCalled();
});
it('预览后源快照删除、变化或计划过期，确认均不得触发文件写入',async()=>{
  const spy=responder(),p=(await preview().expect(201)).body;db.prepare('UPDATE order_restores SET expires_at=0').run();await confirm(p.id).expect(410);db.prepare('UPDATE order_restores SET expires_at=?').run(Date.now()+60000);db.prepare('UPDATE order_archives SET sha256=?').run('0'.repeat(64));await confirm(p.id).expect(502);db.exec('DELETE FROM order_archives');await confirm(p.id).expect(404);expect(spy).toHaveBeenCalledTimes(1);
});
it('连接中断记为待核对；同一计划重试复用原文件名，可在重新登录后查询',async()=>{
  const spy=responder(),p=(await preview().expect(201)).body;spy.mockRejectedValueOnce(new ApiError(503,'DISCONNECTED','连接中断'));
  await confirm(p.id).expect(503);expect((await renter.get(`/api/orders/${order}/restores`)).body.restores[0].state).toBe('uncertain');
  spy.mockImplementationOnce(async(_m,_o,a)=>({output:'已复用',exit_code:0,restored:{created:[],reused:a.kind==='restore'?a.payload.files.map(f=>f.name):[],conflicts:[]}}));
  expect((await confirm(p.id).expect(200)).body.receipt.reused).toHaveLength(2);expect(spy.mock.calls[1][2]).toEqual(spy.mock.calls[2][2]);
  await renter.post('/api/auth/logout').send({});await renter.get(`/api/orders/${order}/restores`).expect(401);await renter.post('/api/auth/login').send({nickname:'恢复租客',password:'restore-test-pass'});expect((await renter.get(`/api/orders/${order}/restores`)).body.restores[0].state).toBe('succeeded');
});
it('在途操作互斥；退出登录后仍保存实际回执，避免把已写文件误报为未执行',async()=>{
  const spy=responder(),p=(await preview().expect(201)).body;let resolve!:(r:WorkspaceResult)=>void,started!:()=>void;const received=new Promise<void>(r=>started=r);
  spy.mockImplementationOnce(()=>{started();return new Promise(r=>resolve=r);});const pending=confirm(p.id).then(r=>r);await received;await confirm(p.id).expect(409);await preview().expect(409);await renter.post('/api/auth/logout').send({});resolve({output:'完成',exit_code:0,restored:{created:p.mapping.map((m:{name:string})=>m.name),reused:[],conflicts:[]}});
  expect((await pending).status).toBe(401);expect((db.prepare('SELECT state FROM order_restores').get() as {state:string}).state).toBe('succeeded');
});
it('冲突回执与部分结果保留；伪造或不完整成功回执不能显示完成',async()=>{
  const spy=responder(),p=(await preview().expect(201)).body;spy.mockResolvedValueOnce({output:'目标变化',exit_code:1,restored:{created:[p.mapping[0].name],reused:[],conflicts:[p.mapping[1].name]}});
  const partial=(await confirm(p.id).expect(200)).body;expect(partial.state).toBe('partial');expect(partial.receipt.created).toHaveLength(1);
  spy.mockResolvedValueOnce({output:'完成',exit_code:0,restored:{created:['foreign.txt'],reused:[],conflicts:[]}});await confirm(p.id).expect(502);expect((await renter.get(`/api/orders/${order}/restores`)).body.restores[0].state).toBe('uncertain');
});
it('服务重启留下的 running 计划可沿原映射重试，未确认过期计划回收',async()=>{
  const spy=responder(),p=(await preview().expect(201)).body;db.prepare("UPDATE order_restores SET state='running'").run();expect((await confirm(p.id).expect(200)).body.state).toBe('succeeded');
  const old=(await preview().expect(201)).body;db.prepare('UPDATE order_restores SET expires_at=0 WHERE id=?').run(old.id);await preview().expect(201);expect(db.prepare('SELECT id FROM order_restores WHERE id=?').get(old.id)).toBeUndefined();expect(spy).toHaveBeenCalledTimes(4);
});
it('显式演示重置先清理恢复记录，避免新表外键阻止重置',async()=>{
  responder();await preview().expect(201);await renter.post('/api/dev/reset').send({confirm:'RESET'}).expect(200);expect(db.prepare('SELECT * FROM order_restores').all()).toEqual([]);expect(db.prepare('SELECT * FROM order_archives').all()).toEqual([]);
});
it('长中文文件名生成的副本同时满足字符和 Linux 255 字节限制',async()=>{
  const name='计'.repeat(50)+'.'+'算'.repeat(30),a=makeArchive({files:[file(name)]});db.prepare('UPDATE order_archives SET content=?,sha256=?,manifest=?').run(a.zip,a.sha256,JSON.stringify(a.manifest));responder([name]);const p=(await preview().expect(201)).body;expect(p.mapping[0].name).toContain('-restored-');expect(p.mapping[0].name.length).toBeLessThanOrEqual(180);expect(Buffer.byteLength(p.mapping[0].name)).toBeLessThanOrEqual(255);
});
