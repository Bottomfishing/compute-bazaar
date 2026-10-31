import {createHash} from 'node:crypto';
import {archivePayload,archiveLimits,type ArchivePayload} from './archive-protocol.js';
import {ApiError} from './errors.js';
import {z} from 'zod';
import {archiveName} from './archive-protocol.js';
const table=Array.from({length:256},(_,i)=>{let n=i;for(let j=0;j<8;j++)n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});
function crc32(body:Buffer){let n=0xffffffff;for(const b of body)n=(n>>>8)^table[(n^b)&255];return (n^0xffffffff)>>>0;}
export function makeArchive(raw:ArchivePayload){
  const parsed=archivePayload.safeParse(raw);
  if(!parsed.success)throw new ApiError(502,'ARCHIVE_INVALID','归档内容无效，请保存文件后重试');
  const local:Buffer[]=[],central:Buffer[]=[],names=new Set<string>(),manifest:{name:string;size:number;sha256:string}[]=[];let offset=0,total=0;
  for(const f of parsed.data.files){
    const name=f.name.normalize('NFC'),key=name.toLocaleLowerCase('en-US');
    if(names.has(key))throw new ApiError(502,'ARCHIVE_INVALID','文件名存在大小写或 Unicode 冲突，请重命名后归档');names.add(key);
    const body=Buffer.from(f.body,'base64'),hash=createHash('sha256').update(body).digest('hex');total+=body.length;
    if(body.toString('base64')!==f.body||hash!==f.sha256||body.length>archiveLimits.file_bytes||total>archiveLimits.total_bytes)throw new ApiError(502,'ARCHIVE_INVALID','归档文件校验失败或容量超限');
    // ZIP method 0 (stored) avoids compression bombs and uses fixed UTF-8, flat entry paths.
    const filename=Buffer.from(name),crc=crc32(body),header=Buffer.alloc(30),entry=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(filename.length,26);
    entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(33,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(body.length,20);entry.writeUInt32LE(body.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(offset,42);
    local.push(header,filename,body);central.push(entry,filename);offset+=header.length+filename.length+body.length;manifest.push({name,size:body.length,sha256:hash});
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(manifest.length,8);end.writeUInt16LE(manifest.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  const zip=Buffer.concat([...local,directory,end]);return {zip,manifest,total,sha256:createHash('sha256').update(zip).digest('hex')};
}
// Accept only byte-for-byte output of our own stored ZIP writer, never arbitrary ZIP uploads.
export function readArchive(content:Buffer,sha256:string,manifestJson:string):ArchivePayload{
  try{
    if(content.length>archiveLimits.total_bytes+160000||createHash('sha256').update(content).digest('hex')!==sha256)throw new Error('checksum');
    const manifest=z.array(z.object({name:archiveName,size:z.number().int().min(0).max(archiveLimits.file_bytes),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(100).parse(JSON.parse(manifestJson));
    const files:ArchivePayload['files']=[];let offset=0,total=0;
    for(const item of manifest){
      if(offset+30>content.length||content.readUInt32LE(offset)!==0x04034b50)throw new Error('header');
      const size=content.readUInt32LE(offset+18),length=content.readUInt16LE(offset+26),extra=content.readUInt16LE(offset+28);
      total+=size;if(size!==item.size||total>archiveLimits.total_bytes||length>720||extra!==0||offset+30+length+size>content.length)throw new Error('size');
      const name=new TextDecoder('utf-8',{fatal:true}).decode(content.subarray(offset+30,offset+30+length));
      if(name!==item.name)throw new Error('name');
      files.push({name,body:content.subarray(offset+30+length,offset+30+length+size).toString('base64'),sha256:item.sha256});offset+=30+length+size;
    }
    const payload={files},rebuilt=makeArchive(payload);
    if(!rebuilt.zip.equals(content)||rebuilt.manifest.some((f,i)=>f.size!==manifest[i].size||f.sha256!==manifest[i].sha256))throw new Error('format');
    return payload;
  }catch{throw new ApiError(502,'RESTORE_SOURCE_INVALID','快照校验失败，未开始恢复');}
}
