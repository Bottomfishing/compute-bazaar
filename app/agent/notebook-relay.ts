import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {notebookMessage,notebookPath,type NotebookMessage} from '../server/notebook-protocol.js';
import type {DockerExecutor} from './docker-executor.js';
export class NotebookRelays {
  private relays=new Map<string,{order:number;child:ChildProcessWithoutNullStreams}>();
  constructor(private executor:DockerExecutor|null,private active:(order:number)=>boolean){}
  async receive(raw:unknown,reply:(message:NotebookMessage)=>void){const parsed=notebookMessage.safeParse(raw);if(!parsed.success)return false;const m=parsed.data;if(process.env.DEBUG_NOTEBOOK==='1'&&m.kind.startsWith('ws'))process.stderr.write('[nb-agent] '+m.kind+' binary='+m.binary+' bytes='+(m.body?.length||0)+'\n');if(!this.executor||!this.active(m.order_id)){reply({...m,kind:'error',body:undefined,error:'Notebook 只适用于正在运行的 Notebook 容器'});return true;}
    if(m.path&&!notebookPath(m.order_id,m.path)){reply({...m,kind:'error',body:undefined,error:'Notebook 路径无效'});return true;}
    const key=String(m.order_id)+':'+(m.kind.startsWith('ws')?m.id:'http');
    let relay=this.relays.get(key)?.child;if(m.kind==='ws-close'&&!relay)return true;
    if(!relay){const c=await this.executor.inspect(m.order_id);if(!c?.State.Running||c.Config.Labels['bazaar.template']!=='notebook'){reply({...m,kind:'error',body:undefined,error:'当前环境未启用 Notebook 模板'});return true;}relay=this.relays.get(key)?.child;if(!relay){relay=spawn('docker',['exec','-i','--user','1000:1000',this.executor.name(m.order_id),'python','-u','/opt/bazaar/relay.py'],{windowsHide:true,stdio:'pipe'});this.relays.set(key,{order:m.order_id,child:relay});let buffer='';const order=m.order_id;
      relay.stdout.on('data',(data:Buffer)=>{buffer+=data.toString();if(buffer.length>13*1024*1024){this.stop(order);return;}let pos:number;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);try{const output=JSON.parse(line) as object;const checked=notebookMessage.safeParse({...output,notebook:true,order_id:order});if(checked.success){if(checked.data.kind==='error')process.stderr.write(`[notebook] ${checked.data.error}\n`);reply(checked.data);}}catch{/* Reject malformed helper output. */}}});relay.stderr.resume();relay.on('error',()=>this.stop(order));relay.on('exit',()=>{if(this.relays.get(key)?.child===relay)this.relays.delete(key);});
    }}
    if(!relay.stdin.destroyed)relay.stdin.write(JSON.stringify(m)+'\n');return true;
  }
  stop(order:number){for(const [key,r]of this.relays)if(r.order===order){this.relays.delete(key);r.child.stdin.end();r.child.kill();}}
  close(){for(const r of [...this.relays.values()])this.stop(r.order);}
}
