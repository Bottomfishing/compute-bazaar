import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {image} from './docker-executor.js';
import {pytorchImage,environmentTemplates,type EnvironmentTemplate} from '../shared/environments.js';
const exec=promisify(execFile);
const template=process.env.AGENT_TEMPLATE||'python';
if(!environmentTemplates.includes(template as EnvironmentTemplate))throw new Error('无效 AGENT_TEMPLATE');
const selected=template==='pytorch'?pytorchImage:template==='notebook'?'bazaar-notebook:2026-10-29':image;
let failed=false;
for(const [name,bin,args]of [['Docker 引擎','docker',['version','--format','{{.Server.Version}}']],['固定工作台镜像','docker',['image','inspect',selected,'--format','{{.Id}}']],['NVIDIA 硬件','nvidia-smi',['--query-gpu=uuid,name,memory.total','--format=csv,noheader,nounits']]] as const){if(name==='NVIDIA 硬件'&&process.env.AGENT_EXECUTOR==='docker-cpu')continue;try{const r=await exec(bin,[...args],{timeout:10000,windowsHide:true});process.stdout.write(`${name}：${r.stdout.trim()}\n`);}catch{failed=true;process.stdout.write(`${name}：未就绪。请检查 Docker Desktop、镜像构建或 NVIDIA 驱动。\n`);}}
process.stdout.write(`环境模板 ${template}，镜像 ${selected}\nPyTorch CUDA 的实际计算校验请执行 npm run gpu:check；CPU 沙箱不要求 NVIDIA。\n`);if(failed)process.exitCode=1;
