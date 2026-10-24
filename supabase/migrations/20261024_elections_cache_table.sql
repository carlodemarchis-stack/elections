-- One row per feed for the elections-cache edge function (elections.aguywithascarf.com).
-- Service-role only: RLS on, no policies, and no grants to anon / authenticated.
create table if not exists public.elections_cache (
  kind          text primary key,
  ts_ms         bigint not null default 0,
  lock_until_ms bigint not null default 0,
  body          text   not null default ''
);
alter table public.elections_cache enable row level security;
revoke all on public.elections_cache from anon, authenticated;
comment on table public.elections_cache is
  'Shared cache for the elections-cache edge function: last civicAPI payload per feed plus a refresh lock. Service role only.';
insert into public.elections_cache (kind) values ('results'), ('forecast') on conflict do nothing;
