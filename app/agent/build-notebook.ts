import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const child=spawn('docker',['build','--pull=false','-t','bazaar-notebook:2026-10-29','images/notebook'],{stdio:'inherit',windowsHide:true});
child.on('error',()=>{process.stderr.write('Docker 构建未能启动\n');process.exitCode=1;});
child.on('exit',async code=>{if(code!==0){process.exitCode=code||1;return;}const result=await promisify(execFile)('docker',['image','inspect','bazaar-notebook:2026-10-29','--format','{{.Id}}'],{windowsHide:true});process.stdout.write(`Notebook 镜像已构建：${result.stdout.trim()}\n通过 AGENT_TEMPLATE=notebook 启用；agent 会按镜像 ID 启动，任务不从网络拉取镜像。\n`);});
