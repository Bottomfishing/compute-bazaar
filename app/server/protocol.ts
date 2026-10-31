import {z} from 'zod';
import {environmentTemplates} from '../shared/environments.js';
import {models} from './db.js';
export const inventory=z.object({version:z.string().min(1).max(40),environment_template:z.enum(environmentTemplates).default('python'),gpus:z.array(z.object({uuid:z.string().min(8).max(100).regex(/^(MOCK-|CPU-|GPU-)[a-zA-Z0-9-]+$/),gpu_model:z.enum(models),vram_gb:z.number().int().min(0).max(1000)}).strict()).min(1).max(64),active_orders:z.array(z.number().int().positive()).max(64)}).strict();
export const heartbeat=z.object({active_orders:z.array(z.number().int().positive()).max(64)}).strict();
export const report=z.object({attempt:z.number().int().min(1),result:z.enum(['ready','failed','stopped']),message:z.string().max(300).optional()}).strict();
export interface Job {id:number;order_id:number;machine_id:number;kind:'start'|'stop';status:string;attempts:number;available_at:number;deadline:number;result:string|null}
export interface WireJob extends Job {gpu_uuids:string[];lease_ends_at:number}
