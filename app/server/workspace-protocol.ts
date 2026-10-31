import {z} from 'zod';
import {archivePayload,archiveName} from './archive-protocol.js';
import {taskInfo} from '../shared/tasks.js';
export const fileName=archiveName;
export const restoreReceipt=z.object({created:z.array(archiveName).max(100),reused:z.array(archiveName).max(100),conflicts:z.array(archiveName).max(100)}).strict();
export const workspaceAction=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('command'),command:z.string().trim().min(1).max(4000)}).strict(),
  z.object({kind:z.literal('list')}).strict(),
  z.object({kind:z.literal('task_start'),id:z.string().uuid(),script:fileName,timeout_seconds:z.number().int().min(1).max(600)}).strict(),
  z.object({kind:z.literal('task_status')}).strict(),
  z.object({kind:z.literal('task_stop'),id:z.string().uuid()}).strict(),
  z.object({kind:z.literal('archive')}).strict(),
  z.object({kind:z.literal('restore_probe'),names:z.array(archiveName).min(1).max(200)}).strict(),
  z.object({kind:z.literal('restore'),request_id:z.string().uuid(),payload:archivePayload}).strict(),
  z.object({kind:z.literal('read'),name:fileName}).strict(),
  z.object({kind:z.literal('write'),name:fileName,content:z.string().max(8192).refine(s=>new TextEncoder().encode(s).length<=8192,'文件不能超过 8KB')}).strict(),
]);
export type WorkspaceAction=z.infer<typeof workspaceAction>;
export const workspaceResult=z.object({output:z.string().max(131072),exit_code:z.number().int(),task:taskInfo.nullable().optional(),files:z.array(z.object({name:z.string(),size:z.number()})).optional(),archive:archivePayload.optional(),existing:z.array(archiveName).max(200).optional(),restored:restoreReceipt.optional()});
export type WorkspaceResult=z.infer<typeof workspaceResult>;
export const tunnelRequest=z.object({id:z.string().uuid(),order_id:z.number().int().positive(),action:workspaceAction});
export const tunnelReply=z.object({id:z.string().uuid(),result:workspaceResult.optional(),error:z.string().max(500).optional()});
