// pokejam-judge-worker: judges the next Ranked match in the queue. Run it every minute with the service key (migration
// 20261130). See _shared/judge/worker.ts and supabase/functions/README.md.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { judgeDeps } from '../_shared/judge/deps.ts';
import { queueDeps, workerHandler } from '../_shared/judge/worker.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

Deno.serve((req) => workerHandler(req, { serviceKey }, { ...queueDeps(admin), judge: judgeDeps(admin) }));
