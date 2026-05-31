-- Run this in the Supabase SQL editor before relying on saved author profiles.
create table if not exists public.author_profiles (
  id bigserial primary key,
  email text not null unique,
  name text not null,
  occupation text,
  institution text,
  bio text,
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
alter table public.articles add column if not exists author_email text;
alter table public.articles add column if not exists occupation text;
alter table public.articles add column if not exists institution text;
alter table public.articles add column if not exists author_bio text;
alter table public.articles add column if not exists author_photo_url text;
