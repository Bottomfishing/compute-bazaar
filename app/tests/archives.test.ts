import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {makeArchive} from '../server/archive-zip.js';
const file=(name:string,body:Buffer)=>({name,body:body.toString('base64'),sha256:createHash('sha256').update(body).digest('hex')});
it('标准 Python zipfile 可解压中文名、二进制、空文件并通过 CRC',()=>{
  const inputs=[file('计算结果.bin',Buffer.from([0,1,255,128])),file('empty.txt',Buffer.alloc(0)),file('notebook.ipynb',Buffer.from('{"cells":[]}'))],archive=makeArchive({files:inputs});
  const result=execFileSync('python',['-c',"import sys,zipfile,io,json,hashlib; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}))"],{input:archive.zip,windowsHide:true}).toString();expect(JSON.parse(result)).toEqual(Object.fromEntries(inputs.map(f=>[f.name,f.sha256])));
});
it('控制面拒绝路径穿越、大小写重名、摘要不符与容量超限',()=>{
  for(const name of ['../result','a/b','a\\b','C:secret','.hidden','bad\nname'])expect(()=>makeArchive({files:[file(name,Buffer.from('x'))]})).toThrow();
  expect(()=>makeArchive({files:[file('A.txt',Buffer.alloc(0)),file('a.txt',Buffer.alloc(0))]})).toThrow();expect(()=>makeArchive({files:[{...file('a',Buffer.from('x')),sha256:'0'.repeat(64)}]})).toThrow();expect(()=>makeArchive({files:[file('a',Buffer.alloc(1024*1024+1))]})).toThrow();expect(()=>makeArchive({files:Array.from({length:5},(_,i)=>file(`f${i}`,Buffer.alloc(1024*1024)))})).toThrow();
});
