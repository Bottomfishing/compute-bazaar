import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {openDb,createUser,type Order} from '../server/db.js';
import {placeOrder} from '../server/orders.js';
import {makeArchive} from '../server/archive-zip.js';
import {createHash,randomUUID} from 'node:crypto';
async function port(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test port');const value=address.port;await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));return value;}
async function stop(child:ChildProcess){if(child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}}
it('旧版迁移保留余额订单流水，快照可打开，重复升级不改数据',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bazaar-migration-')),path=join(dir,'old.sqlite');
  let db=openDb(path);db.close();copyFileSync(`${path}.before-v1.bak`,path);
  const legacy=new Database(path);legacy.prepare('INSERT INTO users(nickname,password_hash,balance_cents,created_at) VALUES(?,?,?,?)').run('旧账户','fixture-hash',9876,1);legacy.prepare("INSERT INTO ledger(user_id,type,amount_cents,balance_after_cents,note,created_at) VALUES(1,'bonus',9876,9876,'历史流水',1)").run();legacy.close();
  // The first snapshot predates this fixture; remove it to exercise the legacy upgrade snapshot.
  rmSync(`${path}.before-v1.bak`);
  try{db=openDb(path);expect(db.pragma('user_version',{simple:true})).toBe(5);expect((db.prepare('SELECT balance_cents n FROM users').get() as {n:number}).n).toBe(9876);expect(db.prepare('SELECT * FROM ledger').all()).toHaveLength(1);const snapshot=new Database(`${path}.before-v1.bak`,{readonly:true});expect(snapshot.pragma('user_version',{simple:true})).toBe(0);expect((snapshot.prepare('SELECT balance_cents n FROM users').get() as {n:number}).n).toBe(9876);snapshot.close();db.close();db=openDb(path);expect(db.prepare('SELECT * FROM ledger').all()).toHaveLength(1);}finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
it('真实服务进程重启保留账本，启动补结算，后台定时器独立结算到期订单',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bazaar-runtime-')),path=join(dir,'runtime.sqlite');let db=openDb(path);let child:ChildProcess|undefined;
  try{
    const provider=db.transaction(()=>createUser(db,'重启机主','test-hash')).immediate(),renter=db.transaction(()=>createUser(db,'重启租客','test-hash')).immediate();
    const machine=Number(db.prepare("INSERT INTO machines(owner_id,name,gpu_model,gpu_count,vram_gb,region,status,created_at) VALUES(?,'演示机','RTX 4090',4,24,'南京','offline',1)").run(provider).lastInsertRowid);const listing=Number(db.prepare("INSERT INTO listings(machine_id,owner_id,gpu_model,gpu_count,price_cents_per_hour,region,note,status,created_at) VALUES(?,?,'RTX 4090',4,200,'南京','','active',1)").run(machine,provider).lastInsertRowid);
    const first=placeOrder(db,renter,{listing_id:listing,gpus:1,hours:1}),second=placeOrder(db,renter,{listing_id:listing,gpus:1,hours:1});const number=await port();
    const content=Buffer.from('preserved after restart'),archive=makeArchive({files:[{name:'result.txt',body:content.toString('base64'),sha256:createHash('sha256').update(content).digest('hex')}]}),archiveId=randomUUID();db.prepare('INSERT INTO order_archives VALUES(?,?,?,?,?,?,?,?,?)').run(archiveId,first,renter,Date.now(),Date.now()+86400000,archive.zip.length,archive.sha256,JSON.stringify(archive.manifest),archive.zip);
    async function start(){child=spawn(process.execPath,['--import','tsx','server/index.ts'],{cwd:resolve('.'),env:{...process.env,PORT:String(number),DB_PATH:path,NODE_ENV:'development'},windowsHide:true,stdio:'ignore'});for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${number}/api/health`);if(r.ok)return;}catch{/* Wait for the child to bind its port. */}if(child.exitCode!==null)throw new Error('Runtime exited before ready');await delay(100);}throw new Error('Runtime start timed out');}
    await start();await stop(child!);db.prepare('UPDATE orders SET ends_at=? WHERE id=?').run(Date.now()-1,first);await start();
    expect((db.prepare('SELECT * FROM orders WHERE id=?').get(first) as Order).status).toBe('finished');
    const saved=db.prepare('SELECT content,sha256 FROM order_archives WHERE id=?').get(archiveId) as {content:Buffer;sha256:string};expect(saved.content).toEqual(archive.zip);expect(saved.sha256).toBe(archive.sha256);
    db.prepare('UPDATE orders SET ends_at=? WHERE id=?').run(Date.now()-1,second);
    for(let i=0;i<30;i++){if((db.prepare('SELECT * FROM orders WHERE id=?').get(second) as Order).status==='finished')break;await delay(100);}
    expect((db.prepare('SELECT * FROM orders WHERE id=?').get(second) as Order).status).toBe('finished');expect((db.prepare("SELECT COUNT(*) n FROM ledger WHERE type='refund'").get() as {n:number}).n).toBe(2);
  }finally{if(child)await stop(child);db.close();rmSync(dir,{recursive:true,force:true});}
},20000);

