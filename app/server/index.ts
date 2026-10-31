import { openDb,settleDue } from './db.js';
import { createApp } from './app.js';
import {purgeArchives} from './archives.js';
import {WorkspaceBridge} from './workspaces.js';
import { resolve } from 'node:path';
const db=openDb(process.env.DB_PATH||'./data/market.sqlite');const bridge=new WorkspaceBridge(db);const app=createApp(db,{bridge});
if(process.env.NODE_ENV==='production'){app.use((await import('express')).default.static(resolve('dist')));app.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/index.html')));}
settleDue(db);purgeArchives(db);const archiveTimer=setInterval(()=>{try{purgeArchives(db);}catch{process.stderr.write("Archive expiry sweep failed\n");}},60000);const timer=setInterval(()=>{try{settleDue(db);}catch(e){process.stderr.write(`Settlement error: ${e instanceof Error?e.message:'unknown'}\n`);}},1000);
const server=app.listen(Number(process.env.PORT||3001),'127.0.0.1',()=>process.stdout.write(`算力集市 API http://127.0.0.1:${process.env.PORT||3001}\n`));
const closeTunnel=bridge.attach(server);
function stop(){closeTunnel();clearInterval(timer);clearInterval(archiveTimer);server.close(()=>{db.close();process.exit(0);});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
