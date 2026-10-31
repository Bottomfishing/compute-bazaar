import {it,expect,afterAll} from 'vitest';
import {DockerExecutor} from '../agent/docker-executor.js';
import {createHash,randomUUID} from 'node:crypto';
const enabled=process.env.RUN_DOCKER_TESTS==='1';
const machine=800000+process.pid,executor=new DockerExecutor(machine,false);const order=1;
afterAll(async()=>{if(enabled)await executor.stop(order);});
it.skipIf(!enabled)('真实 Docker 沙箱：脚本执行、文件、权限、租约与销毁',async()=>{try{await executor.start(order,[`CPU-${machine}-SLOT-0`],Date.now()+30000);expect((await executor.inspect(order))?.State.Running).toBe(true);await executor.execute(order,{kind:'write',name:'example.py',content:'print(6*7)\n'});expect((await executor.execute(order,{kind:'command',command:'python example.py'})).output.trim()).toBe('42');expect((await executor.execute(order,{kind:'list'})).files?.[0].name).toBe('example.py');expect((await executor.execute(order,{kind:'read',name:'example.py'})).output).toContain('6*7');expect((await executor.execute(order,{kind:'command',command:'id -u'})).output.trim()).toBe('1000');expect((await executor.execute(order,{kind:'command',command:'cat /lease/deadline'})).exit_code).not.toBe(0);expect((await executor.execute(order,{kind:'command',command:'ln -s /etc/passwd link.txt'})).exit_code).toBe(0);await expect(executor.execute(order,{kind:'read',name:'link.txt'})).rejects.toThrow();await executor.updateLease(order,Date.now()+1200);await expect.poll(async()=>(await executor.inspect(order))?.State.Running,{timeout:8000}).toBe(false);await executor.stop(order);expect(await executor.inspect(order)).toBeNull();}finally{await executor.stop(order);}},30000);

it.skipIf(!enabled)('真实容器成果：大于编辑器上限的二进制和中文文件可归档，危险文件与超限拒绝',async()=>{
  const id=2;try{await executor.start(id,[`CPU-${machine}-SLOT-0`],Date.now()+90000);
    const created=await executor.execute(id,{kind:'command',command:`python -c "import json; from pathlib import Path; Path('计算结果.bin').write_bytes(bytes(range(256))*40); Path('welcome.ipynb').write_text(json.dumps(dict(cells=[]))); Path('.hidden').write_text('private')"`});expect(created.exit_code).toBe(0);
    const result=await executor.execute(id,{kind:'archive'});expect(result.archive?.files.map(f=>f.name)).toEqual(['welcome.ipynb','计算结果.bin']);expect(Buffer.from(result.archive!.files[1].body,'base64')).toEqual(Buffer.from(Array.from({length:10240},(_,i)=>i%256)));
    await executor.execute(id,{kind:'command',command:'ln -s /etc/passwd link.txt'});await expect(executor.execute(id,{kind:'archive'})).rejects.toThrow('归档失败');
    await executor.execute(id,{kind:'command',command:'rm link.txt; mkdir results'});await expect(executor.execute(id,{kind:'archive'})).rejects.toThrow('归档失败');
    await executor.execute(id,{kind:'command',command:'rmdir results; mkfifo pipe.txt'});await expect(executor.execute(id,{kind:'archive'})).rejects.toThrow('归档失败');
    await executor.execute(id,{kind:'command',command:'rm pipe.txt; python -c "open(\'large.bin\',\'wb\').write(b\'a\' * 1048577)"'});await expect(executor.execute(id,{kind:'archive'})).rejects.toThrow('归档失败');
  }finally{await executor.stop(id);}
},30000);

it.skipIf(!enabled)('真实恢复：4 MiB 二进制、中文、空文件通过 stdin 无损写入，同计划重试只复用',async()=>{
  const id=3,body=Buffer.from(Array.from({length:1048576},(_,i)=>i%256)),hash=createHash('sha256').update(body).digest('hex');
  try{
    await executor.start(id,[`CPU-${machine}-SLOT-0`],Date.now()+60000);
    const files=Array.from({length:4},(_,i)=>({name:`计算结果${i}.bin`,body:body.toString('base64'),sha256:hash}));
    expect((await executor.execute(id,{kind:'restore_probe',names:files.map(f=>f.name)})).existing).toEqual([]);
    const action={kind:'restore' as const,request_id:randomUUID(),payload:{files}};
    const restored=await executor.execute(id,action);expect(restored.exit_code,restored.output).toBe(0);expect(restored.restored?.created).toEqual(files.map(f=>f.name));
    const archived=await executor.execute(id,{kind:'archive'});expect(archived.archive?.files).toEqual(files);
    const retried=await executor.execute(id,action);expect(retried.exit_code,retried.output).toBe(0);expect(retried.restored?.created).toEqual([]);expect(retried.restored?.reused).toEqual(files.map(f=>f.name));
    const empty=await executor.execute(id,{kind:'restore',request_id:randomUUID(),payload:{files:[{name:'empty.txt',body:'',sha256:createHash('sha256').update('').digest('hex')}]}});expect(empty.exit_code,empty.output).toBe(0);
    expect((await executor.execute(id,{kind:'command',command:'find . -maxdepth 1 -name ".bazaar-restore-*"'})).output.trim()).toBe('');
  }finally{await executor.stop(id);}
},30000);

it.skipIf(!enabled)('真实恢复：文件变化、大小写别名、链接、目录、FIFO、摘要和路径错误均在写入前拒绝',async()=>{
  const id=4,body=Buffer.from('from snapshot'),make=(name:string)=>({name,body:body.toString('base64'),sha256:createHash('sha256').update(body).digest('hex')});
  try{
    await executor.start(id,[`CPU-${machine}-SLOT-0`],Date.now()+60000);
    await executor.execute(id,{kind:'command',command:'printf keep > result.txt; ln -s /etc/passwd link.txt; mkdir directory; mkfifo pipe.txt; touch ALIAS.txt'});
    const names=['result.txt','link.txt','directory','pipe.txt','alias.txt'];expect((await executor.execute(id,{kind:'restore_probe',names})).existing).toEqual(names);
    const rejected=await executor.execute(id,{kind:'restore',request_id:randomUUID(),payload:{files:[make('new.txt'),...names.map(make)]}});expect(rejected.exit_code).toBe(1);expect(rejected.restored?.created).toEqual([]);expect(rejected.restored?.conflicts).toEqual(names);
    expect((await executor.execute(id,{kind:'read',name:'result.txt'})).output).toBe('keep');expect((await executor.execute(id,{kind:'command',command:'test ! -e new.txt && test -L link.txt && test -d directory && test -p pipe.txt'})).exit_code).toBe(0);
    for(const file of [{...make('new.txt'),sha256:'0'.repeat(64)},make('../escape'),{...make('new.txt'),body:'###'}])expect((await executor.execute(id,{kind:'restore',request_id:randomUUID(),payload:{files:[file]}})).exit_code).toBe(1);
    expect((await executor.execute(id,{kind:'command',command:'test ! -e new.txt && test ! -e /escape'})).exit_code).toBe(0);
    // Partial retry preserves previously published bytes and fills only the missing destination.
    await executor.execute(id,{kind:'write',name:'one.txt',content:'from snapshot'});
    const partial=await executor.execute(id,{kind:'restore',request_id:randomUUID(),payload:{files:[make('one.txt'),make('two.txt')]}});expect(partial.restored).toEqual({created:['two.txt'],reused:['one.txt'],conflicts:[]});
  }finally{await executor.stop(id);}
},30000);
