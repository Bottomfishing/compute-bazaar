import type Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
export function migrate(db:Database.Database,path:string){
  const version=(db.pragma('user_version',{simple:true}) as number);
  if(version>=5)return;
  if(version<1){
  if(path!==':memory:'&&existsSync(path)){
    const backup=`${path}.before-v1.bak`;
    if(!existsSync(backup))db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);
  }
  db.transaction(()=>{
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
      ALTER TABLE machines ADD COLUMN mode TEXT NOT NULL DEFAULT 'demo';
      ALTER TABLE orders ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'ready';
      ALTER TABLE orders ADD COLUMN ready_at INTEGER;
      ALTER TABLE orders ADD COLUMN preparation_deadline INTEGER;
      CREATE TABLE machine_gpus(id INTEGER PRIMARY KEY,machine_id INTEGER NOT NULL REFERENCES machines(id),uuid TEXT NOT NULL UNIQUE,gpu_model TEXT NOT NULL,vram_gb INTEGER NOT NULL);
      CREATE TABLE agent_credentials(id INTEGER PRIMARY KEY,machine_id INTEGER NOT NULL REFERENCES machines(id),token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,revoked_at INTEGER);
      CREATE TABLE gpu_allocations(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),gpu_id INTEGER NOT NULL REFERENCES machine_gpus(id),status TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX gpu_exclusive ON gpu_allocations(gpu_id) WHERE status!='released';
      CREATE TABLE agent_jobs(id INTEGER PRIMARY KEY,machine_id INTEGER NOT NULL REFERENCES machines(id),order_id INTEGER NOT NULL REFERENCES orders(id),kind TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,deadline INTEGER NOT NULL,result TEXT,UNIQUE(order_id,kind));
      CREATE TABLE order_events(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),kind TEXT NOT NULL,message TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE order_requests(user_id INTEGER NOT NULL REFERENCES users(id),request_key TEXT NOT NULL,digest TEXT NOT NULL,order_id INTEGER NOT NULL REFERENCES orders(id),PRIMARY KEY(user_id,request_key));
      CREATE UNIQUE INDEX ledger_settlement_once ON ledger(order_id,type) WHERE order_id IS NOT NULL AND type IN ('rent','refund','income');
      UPDATE orders SET ready_at=started_at;
    `);
    db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(Date.now());db.pragma('user_version = 1');
  }).immediate();
  }
  if(version<2){
  if(path!==':memory:'&&existsSync(path)){const backup=`${path}.before-v2.bak`;if(!existsSync(backup))db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
  db.transaction(()=>{db.exec(`
    CREATE TABLE access_tokens(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),order_id INTEGER NOT NULL REFERENCES orders(id),expires_at INTEGER NOT NULL,consumed_at INTEGER);
    CREATE TABLE access_sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),order_id INTEGER NOT NULL REFERENCES orders(id),expires_at INTEGER NOT NULL);
    CREATE TABLE machine_test_grants(machine_id INTEGER NOT NULL REFERENCES machines(id),user_id INTEGER NOT NULL REFERENCES users(id),PRIMARY KEY(machine_id,user_id));
  `);db.prepare('INSERT INTO schema_migrations VALUES(2,?)').run(Date.now());db.pragma('user_version = 2');}).immediate();

  }
  if(version<3){
  if(path!==':memory:'&&existsSync(path)){const backup=`${path}.before-v3.bak`;if(!existsSync(backup))db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
  db.transaction(()=>{db.exec("ALTER TABLE machines ADD COLUMN environment_template TEXT NOT NULL DEFAULT 'python'");db.prepare('INSERT INTO schema_migrations VALUES(3,?)').run(Date.now());db.pragma('user_version=3');}).immediate();
  }
  if(version<4){
  if(path!==':memory:'&&existsSync(path)){const backup=`${path}.before-v4.bak`;if(!existsSync(backup))db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
  db.transaction(()=>{db.exec(`
    CREATE TABLE order_archives(id TEXT PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),user_id INTEGER NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,manifest TEXT NOT NULL,content BLOB NOT NULL);
    CREATE INDEX archives_owner ON order_archives(user_id,order_id);
    CREATE INDEX archives_expiry ON order_archives(expires_at);
  `);db.prepare('INSERT INTO schema_migrations VALUES(4,?)').run(Date.now());db.pragma('user_version=4');}).immediate();
  }
  if(path!==':memory:'&&existsSync(path)){const backup=`${path}.before-v5.bak`;if(!existsSync(backup))db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
  db.transaction(()=>{db.exec(`
    CREATE TABLE order_restores(
      id TEXT PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),source_order_id INTEGER NOT NULL REFERENCES orders(id),
      archive_id TEXT NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id),
      state TEXT NOT NULL CHECK(state IN ('planned','running','succeeded','partial','failed','uncertain')),
      source_sha256 TEXT NOT NULL,mapping TEXT NOT NULL,receipt TEXT,message TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    );
    CREATE INDEX restores_owner ON order_restores(user_id,order_id,created_at);
  `);db.prepare('INSERT INTO schema_migrations VALUES(5,?)').run(Date.now());db.pragma('user_version=5');}).immediate();
}
