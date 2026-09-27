-- Applied to the Hope project on 21 September 2026 as migration
-- 20260921052015 (prospects_autoslug).
--
-- Recorded here from the database's own migration history: the change was
-- made directly in Supabase and never committed at the time.

-- Lets a prospect be inserted with just practice_name + contact_email.
-- If slug is missing, build one from practice_name that satisfies
-- prospects_slug_format (^[a-z0-9][a-z0-9-]{0,63}$) and prospects_slug_key.
-- NOT NULL is checked after BEFORE triggers, so a null slug is filled in time.
create or replace function public.prospects_autoslug()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  base text;
  candidate text;
  n int := 1;
begin
  if new.slug is not null and btrim(new.slug) <> '' then
    return new;
  end if;

  base := lower(coalesce(new.practice_name, ''));
  base := replace(base, '&', ' and ');
  base := regexp_replace(base, '[''’]', '', 'g');        -- "smith's" -> "smiths"
  base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');   -- everything else -> hyphen
  base := btrim(base, '-');
  base := btrim(left(base, 58), '-');
  if base = '' then base := 'practice'; end if;

  candidate := base;
  while exists (select 1 from public.prospects where slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;

  new.slug := candidate;
  return new;
end;
$$;

drop trigger if exists prospects_autoslug on public.prospects;
create trigger prospects_autoslug
  before insert on public.prospects
  for each row execute function public.prospects_autoslug();
