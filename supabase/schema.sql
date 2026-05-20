create table if not exists public.games (
  id text primary key,
  title text not null,
  icon_url text default '',
  trailer_url text default '',
  image_urls text[] default '{}',
  description text default '',
  release_at timestamptz,
  download_url text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists games_release_at_idx on public.games (release_at);
create index if not exists games_created_at_idx on public.games (created_at desc);

-- Create a public bucket named "games" in Supabase Storage, or run:
insert into storage.buckets (id, name, public)
values ('games', 'games', true)
on conflict (id) do update set public = true;

create policy "Public read game files"
on storage.objects for select
using (bucket_id = 'games');
