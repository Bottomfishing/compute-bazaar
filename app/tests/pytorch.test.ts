import {it,expect} from 'vitest';
import {DockerExecutor} from '../agent/docker-executor.js';
import {makeArchive} from '../server/archive-zip.js';
it('PyTorch CUDA 不允许使用 CPU 执行器',()=>{expect(()=>new DockerExecutor(1,false,'test','pytorch')).toThrow('GPU');});
it.skipIf(process.env.RUN_PYTORCH_TESTS!=='1')('真实 CUDA：矩阵、梯度、单卡隔离、结果归档、重复启动与销毁',async()=>{
  const e=new DockerExecutor(700000+process.pid,true,'pytorchtest','pytorch'),order=1;
  try{const [gpu]=await e.inventory();await e.start(order,[gpu.uuid],Date.now()+60000);const original=(await e.inspect(order))!.Id;
    const result=JSON.parse((await e.execute(order,{kind:'read',name:'gpu_result.json'})).output) as {passed:boolean;torch:string;numpy:string;cuda:string;device_count:number;tensor_device:string;product:number[][];gradient:number[]};expect(result.passed).toBe(true);expect(result.torch).toBe('2.10.0+cu128');expect(result.numpy).toBe('2.3.5');expect(result.cuda).toBe('12.8');expect(result.device_count).toBe(1);expect(result.tensor_device).toBe('cuda:0');expect(result.product).toEqual([[19,22],[43,50]]);expect(result.gradient).toEqual([2,4,6]);
    const rerun=await e.execute(order,{kind:'command',command:'python gpu_check.py'});expect(rerun.exit_code).toBe(0);expect(rerun.output).toContain('"passed": true');expect(rerun.output).not.toContain('Failed to initialize NumPy');await e.start(order,[gpu.uuid],Date.now()+60000);expect((await e.inspect(order))!.Id).toBe(original);
    expect((await e.execute(order,{kind:'command',command:'touch /lease/pytorch-ready'})).exit_code).not.toBe(0);const payload=(await e.execute(order,{kind:'archive'})).archive!;expect(makeArchive(payload).manifest.map(f=>f.name)).toEqual(['gpu_check.py','gpu_result.json']);
  }finally{await e.stop(order);expect(await e.inspect(order)).toBeNull();}
},60000);
