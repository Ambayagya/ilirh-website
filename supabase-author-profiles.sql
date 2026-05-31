-- Run this in the Supabase SQL editor before relying on saved author profiles.
create table if not exists public.author_profiles (
  id bigserial primary key,
  email text not null unique,
  name text not null,
  occupation text,
  institution text,
  bio text,
  phone text,
  photo_url text,
  published_article_count integer not null default 0,
  article_ids bigint[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.author_profiles enable row level security;

drop policy if exists "Public can read author profiles" on public.author_profiles;
create policy "Public can read author profiles"
on public.author_profiles for select
using (true);

drop policy if exists "Public can create author profiles" on public.author_profiles;
create policy "Public can create author profiles"
on public.author_profiles for insert
with check (true);

drop policy if exists "Public can update author profiles" on public.author_profiles;
create policy "Public can update author profiles"
on public.author_profiles for update
using (true)
with check (true);

-- Optional columns. The website works without them, but adding them lets article
-- records carry enough author information to render profile boxes immediately.
alter table public.article_submissions add column if not exists author_bio text;
alter table public.article_submissions add column if not exists phone text;
alter table public.author_profiles add column if not exists phone text;
alter table public.articles add column if not exists author_email text;
alter table public.articles add column if not exists occupation text;
alter table public.articles add column if not exists institution text;
alter table public.articles add column if not exists author_bio text;
alter table public.articles add column if not exists author_photo_url text;

-- Live article analytics used for exact reader/share/download counters.
create table if not exists public.article_events (
  id bigserial primary key,
  article_id bigint not null,
  event_type text not null check (event_type in ('view','share','download')),
  visitor_key text,
  created_at timestamptz not null default now()
);

create index if not exists article_events_article_idx on public.article_events(article_id);
create index if not exists article_events_type_idx on public.article_events(event_type);

alter table public.article_events enable row level security;

drop policy if exists "Public can log article events" on public.article_events;
create policy "Public can log article events"
on public.article_events for insert
with check (true);

drop policy if exists "Public can read article events" on public.article_events;
create policy "Public can read article events"
on public.article_events for select
using (true);

create or replace function public.log_article_event(
  p_article_id bigint,
  p_event_type text,
  p_visitor_key text
)
returns void
language plpgsql
security definer
as $$
begin
  if p_article_id is null or p_event_type not in ('view','share','download') then
    return;
  end if;

  insert into public.article_events(article_id, event_type, visitor_key)
  values (p_article_id, p_event_type, nullif(p_visitor_key, ''));
end;
$$;

create or replace function public.get_article_stats()
returns table(article_id bigint, views bigint, unique_readers bigint, shares bigint, downloads bigint)
language sql
stable
security definer
as $$
  select
    e.article_id,
    count(*) filter (where e.event_type = 'view')::bigint as views,
    count(distinct e.visitor_key) filter (where e.event_type = 'view' and e.visitor_key is not null)::bigint as unique_readers,
    count(*) filter (where e.event_type = 'share')::bigint as shares,
    count(*) filter (where e.event_type = 'download')::bigint as downloads
  from public.article_events e
  group by e.article_id;
$$;

grant execute on function public.log_article_event(bigint,text,text) to anon, authenticated;
grant execute on function public.get_article_stats() to anon, authenticated;

-- Exact likes by visitor. The old article_likes table is still supported as a fallback.
create table if not exists public.article_like_visitors (
  article_id bigint not null,
  visitor_key text not null,
  liked boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (article_id, visitor_key)
);

alter table public.article_like_visitors enable row level security;

drop policy if exists "Public can read article like visitors" on public.article_like_visitors;
create policy "Public can read article like visitors"
on public.article_like_visitors for select
using (true);

drop policy if exists "Public can upsert article like visitors" on public.article_like_visitors;
create policy "Public can upsert article like visitors"
on public.article_like_visitors for insert
with check (true);

drop policy if exists "Public can update article like visitors" on public.article_like_visitors;
create policy "Public can update article like visitors"
on public.article_like_visitors for update
using (true)
with check (true);

create table if not exists public.article_likes (
  article_id bigint primary key,
  like_count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.article_likes enable row level security;

drop policy if exists "Public can read article likes" on public.article_likes;
create policy "Public can read article likes"
on public.article_likes for select
using (true);

drop policy if exists "Public can upsert article likes" on public.article_likes;
create policy "Public can upsert article likes"
on public.article_likes for insert
with check (true);

drop policy if exists "Public can update article likes" on public.article_likes;
create policy "Public can update article likes"
on public.article_likes for update
using (true)
with check (true);

create or replace function public.set_article_like(
  p_article_id bigint,
  p_visitor_key text,
  p_liked boolean
)
returns integer
language plpgsql
security definer
as $$
declare
  next_count integer;
begin
  if p_article_id is null or nullif(p_visitor_key, '') is null then
    return 0;
  end if;

  insert into public.article_like_visitors(article_id, visitor_key, liked, updated_at)
  values (p_article_id, p_visitor_key, coalesce(p_liked, false), now())
  on conflict (article_id, visitor_key)
  do update set liked = excluded.liked, updated_at = now();

  select count(*)::integer into next_count
  from public.article_like_visitors
  where article_id = p_article_id and liked = true;

  insert into public.article_likes(article_id, like_count, updated_at)
  values (p_article_id, next_count, now())
  on conflict (article_id)
  do update set like_count = excluded.like_count, updated_at = now();

  return next_count;
end;
$$;

grant execute on function public.set_article_like(bigint,text,boolean) to anon, authenticated;
