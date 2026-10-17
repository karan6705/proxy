import type { Store } from "../types.js";
import { createMemoryStore } from "./memory.js";
import { createSupabaseStore } from "./supabase.js";

export { createMemoryStore, type MemoryStore } from "./memory.js";
export { createSupabaseStore, type SupabaseConfig } from "./supabase.js";

/** Supabase when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set, otherwise in memory. */
export function createStoreFromEnv(env: NodeJS.ProcessEnv = process.env): Store {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && serviceRoleKey ? createSupabaseStore({ url, serviceRoleKey }) : createMemoryStore();
}
export { DEMO_EVENT_CONTEXT, makeEvent, type EventContext } from "./events.js";
