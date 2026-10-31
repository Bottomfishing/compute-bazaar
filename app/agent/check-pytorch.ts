import {DockerExecutor} from './docker-executor.js';
const executor=new DockerExecutor(process.pid,true,'pytorchcheck','pytorch'),order=1;
try{
  const [gpu]=await executor.inventory();if(!gpu)throw new Error('没有 NVIDIA GPU');
  await executor.start(order,[gpu.uuid],Date.now()+60000);
  const result=await executor.execute(order,{kind:'read',name:'gpu_result.json'});
  process.stdout.write(`真实 CUDA 校验通过：\n${result.output}\n`);
}catch(e){process.stderr.write(`CUDA 校验失败：${e instanceof Error?e.message:'未知错误'}\n`);process.exitCode=1;}
finally{await executor.stop(order).catch(()=>{process.stderr.write('清理失败，请检查 pytorchcheck 标签容器；本地租约会停止容器。\n');process.exitCode=1;});}
