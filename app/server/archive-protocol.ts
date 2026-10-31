import {z} from 'zod';
export const archiveLimits={file_bytes:1024*1024,total_bytes:4*1024*1024,files:100,per_order:3,user_bytes:64*1024*1024,retention_days:7} as const;
// Flat, visible names keep ZIP extraction paths portable. Unicode names are supported.
export const archiveName=z.string().min(1).max(180).refine(n=>!n.startsWith('.')&&!/[\\/:\x00-\x1f\x7f]/.test(n)&&n.trim()===n&&!n.endsWith('.'),'仅支持工作目录顶层的普通文件名');
export const archivePayload=z.object({files:z.array(z.object({name:archiveName,body:z.string().max(4*Math.ceil(archiveLimits.file_bytes/3)),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(archiveLimits.files)}).strict();
export type ArchivePayload=z.infer<typeof archivePayload>;
