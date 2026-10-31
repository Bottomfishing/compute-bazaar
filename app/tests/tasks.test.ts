import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {DockerExecutor} from '../agent/docker-executor.js';
import {workspaceAction} from '../server/workspace-protocol.js';
const enabled=process.env.RUN_DOCKER_TESTS==='1',e=new DockerExecutor(700000+process.pid,false,'tasks');
it('任务协议限制 UUID、路径和时限',()=>{
  for(const script of ['../a.py','/etc/a.py','a/b.py'])expect(workspaceAction.safeParse({kind:'task_start',id:randomUUID(),script,timeout_seconds:30}).success).toBe(false);
  for(const timeout_seconds of [0,601,1.5])expect(workspaceAction.safeParse({kind:'task_start',id:randomUUID(),script:'a.py',timeout_seconds}).success).toBe(false);
});
it.skipIf(!enabled)('真实长时任务：超过终端时限、实时日志、UID、幂等、重连查询和结果',async()=>{
 const o=1;try{
  await e.start(o,['CPU-test'],Date.now()+90000);await e.execute(o,{kind:'write',name:'任务.py',content:'import time,os\nprint("started",os.getuid(),flush=True)\ntime.sleep(16)\nopen("task-result.txt","w").write("answer=42")\nprint("done",flush=True)\n'});
  await e.execute(o,{kind:'write',name:'subprocess.py',content:'raise RuntimeError("untrusted module must not load in supervisor")'});
  const action={kind:'task_start' as const,id:randomUUID(),script:'任务.py',timeout_seconds:30};const started=await e.execute(o,action);expect(started.exit_code,started.output).toBe(0);expect(started.task?.state).toBe('running');expect((await e.execute(o,action)).task?.id).toBe(action.id);
  await expect.poll(async()=>(await e.execute(o,{kind:'task_status'})).task?.log).toContain('started 1000');
  expect((await e.execute(o,{kind:'command',command:'grep CapEff /proc/self/status'})).output).toContain('0000000000000000');
  expect((await e.execute(o,{...action,id:randomUUID()})).exit_code).toBe(1);await expect(e.execute(o,{kind:'archive'})).rejects.toThrow('请先停止');
  const reconnected=new DockerExecutor(e.machine,false,e.scope);await expect.poll(async()=>(await reconnected.execute(o,{kind:'task_status'})).task?.state,{timeout:25000,interval:1000}).toBe('succeeded');expect((await e.execute(o,{kind:'task_status'})).task?.log).toContain('done');expect((await e.execute(o,{kind:'read',name:'task-result.txt'})).output).toBe('answer=42');
  expect((await e.execute(o,{kind:'command',command:'cat /lease/task.json'})).exit_code).not.toBe(0);expect((await e.execute(o,action)).task?.state).toBe('succeeded');
 }finally{await e.stop(o);}
},40000);
it.skipIf(!enabled)('真实任务停止、超时、日志限额、异常退出、危险脚本和租约销毁',async()=>{
 const o=2;try{
  await e.start(o,['CPU-test'],Date.now()+90000);await e.execute(o,{kind:'write',name:'wait.py',content:'import time\nprint("x"*30000,flush=True)\ntime.sleep(30)\nopen("should-not-exist","w").write("bad")\n'});
  const start=async(seconds:number)=>(await e.execute(o,{kind:'task_start',id:randomUUID(),script:'wait.py',timeout_seconds:seconds}));
  const first=await start(30);await expect.poll(async()=>(await e.execute(o,{kind:'task_status'})).task?.truncated).toBe(true);expect((await e.execute(o,{kind:'task_status'})).task!.log.length).toBeLessThanOrEqual(16384);
  await e.execute(o,{kind:'task_stop',id:first.task!.id});await expect.poll(async()=>(await e.execute(o,{kind:'task_status'})).task?.state).toBe('stopped');
  await start(1);await expect.poll(async()=>(await e.execute(o,{kind:'task_status'})).task?.state,{timeout:7000}).toBe('timed_out');expect((await e.execute(o,{kind:'command',command:'test ! -e should-not-exist'})).exit_code).toBe(0);
  await e.execute(o,{kind:'write',name:'fail.py',content:'raise ValueError("expected failure")'});await e.execute(o,{kind:'task_start',id:randomUUID(),script:'fail.py',timeout_seconds:10});await expect.poll(async()=>(await e.execute(o,{kind:'task_status'})).task?.state).toBe('failed');expect((await e.execute(o,{kind:'task_status'})).task?.log).toContain('expected failure');
  await e.execute(o,{kind:'write',name:'future.py',content:'\ufefffrom __future__ import annotations\nprint(__file__)\nprint(int(next(x for x in open("/proc/self/status") if x.startswith("CapEff:")).split()[1],16))\n'});await e.execute(o,{kind:'task_start',id:randomUUID(),script:'future.py',timeout_seconds:10});await expect.poll(async()=>(await e.execute(o,{kind:'task_status'})).task?.state).toBe('succeeded');expect((await e.execute(o,{kind:'task_status'})).task?.log).toBe('/workspace/future.py\n0\n');
  await e.execute(o,{kind:'command',command:'ln -s /etc/passwd link.py; mkfifo fifo.py'});for(const script of ['link.py','fifo.py','../escape.py'])expect((await e.execute(o,{kind:'task_start',id:randomUUID(),script,timeout_seconds:10})).exit_code).toBe(1);
  await start(30);await e.updateLease(o,Date.now()+1000);await expect.poll(async()=>(await e.inspect(o))?.State.Running,{timeout:7000}).toBe(false);
 }finally{await e.stop(o);}
},40000);

