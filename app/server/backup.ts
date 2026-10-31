import Database from 'better-sqlite3';
import {resolve,dirname} from 'node:path';
import {mkdirSync} from 'node:fs';
const source=resolve(process.env.DB_PATH||'./data/market.sqlite');
const destination=resolve(process.argv[2]||`./data/backups/market-${Date.now()}.sqlite`);
if(source===destination)throw new Error('备份目标不能与源数据库相同');
mkdirSync(dirname(destination),{recursive:true});
const db=new Database(source,{readonly:true,fileMustExist:true});
try{await db.backup(destination);process.stdout.write(`备份完成：${destination}\n`);}finally{db.close();}
