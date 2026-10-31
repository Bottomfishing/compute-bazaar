import {z} from 'zod';
export const taskInfo=z.object({id:z.string().uuid(),script:z.string(),state:z.enum(['running','succeeded','failed','stopped','timed_out','interrupted']),started_at:z.number(),ended_at:z.number().nullable(),timeout_seconds:z.number(),exit_code:z.number().nullable(),log:z.string().max(70000),truncated:z.boolean()});
export type TaskInfo=z.infer<typeof taskInfo>;
