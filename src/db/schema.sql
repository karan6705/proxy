-- Proxy ledger. Run once in the Supabase SQL editor. Server side only (service role key).
create table if not exists intents (
  task_id text primary key,
  task_email text not null,
  goal text not null,
  constraints jsonb not null default '{}',
  preferences jsonb not null,
  idempotency_key text unique not null,
  created_at timestamptz not null
);

create table if not exists actions (
  action_id text primary key,
  task_id text not null,
  merchant text not null,
  category text not null,
  summary text not null,
  amount bigint not null,
  dates jsonb,
  ref text not null,
  source text not null,
  received_at timestamptz not null,
  state text not null
);
create index if not exists actions_task on actions (task_id);

create table if not exists chains (
  chain_id text primary key,
  task_id text not null,
  root_action_id text not null,
  action_ids jsonb not null,
  money_at_risk bigint not null,
  window_ends_at timestamptz,
  state text not null,
  alerts jsonb not null default '[]',
  plan jsonb not null default '[]'
);
create index if not exists chains_task on chains (task_id);

create table if not exists steps (
  id bigserial primary key,
  chain_id text not null,
  action_id text not null,
  route text not null,
  protocol_state text,
  round int not null,
  message text not null,
  outcome text not null,
  stripe_ref text,
  at timestamptz not null
);
create index if not exists steps_chain on steps (chain_id);

create table if not exists lessons (
  mistake_code text primary key,
  what_happened text not null,
  lesson text not null,
  created_at timestamptz not null
);

-- Append-only log. Inserts only; the trigger rejects updates and deletes, even for the service role.
create table if not exists events (
  id bigserial primary key,
  run_id text not null,
  arm text not null,
  scenario_id text not null,
  layer text not null,
  kind text not null,
  tool_name text,
  task_id text,
  chain_id text,
  action_id text,
  outcome text,
  tokens_in int,
  tokens_out int,
  timestamp timestamptz not null
);
create index if not exists events_task_kind on events (task_id, kind);

create or replace function events_append_only() returns trigger as $$
begin
  raise exception 'events is append-only';
end;
$$ language plpgsql;

drop trigger if exists events_no_update on events;
create trigger events_no_update before update or delete on events
  for each row execute function events_append_only();
drop trigger if exists events_no_truncate on events;
create trigger events_no_truncate before truncate on events
  for each statement execute function events_append_only();

alter table intents enable row level security;
alter table actions enable row level security;
alter table chains enable row level security;
alter table steps enable row level security;
alter table lessons enable row level security;
alter table events enable row level security;
-- No policies: only the service role key (which bypasses RLS) can read or write.
