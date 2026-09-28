-- Applied to the Hope project on 28 September 2026 as migration
-- 0011_unguessable_prospect_slugs.
--
-- A slug built only from the practice name can be guessed from the name, and
-- a guessed link can be opened, or its single call spent, by anyone. New
-- slugs now end in eight random characters: rosebank-family-dental becomes
-- rosebank-family-dental-3f9c2a1e, which cannot be reached by guessing.
--
-- Only rows inserted without a slug are affected. Every existing slug is left
-- exactly as it is, because those links are in emails that have been sent, and
-- a slug given explicitly (the seed script's --slug) is still used as given.
--
-- The link to paste into an email is now read from the `slug` column of the
-- new row (Supabase -> Table Editor -> prospects), not worked out from the
-- practice name.

create or replace function public.prospects_autoslug()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  base text;
  candidate text;
begin
  if new.slug is not null and btrim(new.slug) <> '' then
    return new;
  end if;

  base := lower(coalesce(new.practice_name, ''));
  base := replace(base, '&', ' and ');
  base := regexp_replace(base, '[''’]', '', 'g');        -- "smith's" -> "smiths"
  base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');   -- everything else -> hyphen
  base := btrim(base, '-');
  -- 55 + '-' + 8 random characters is 64, the most prospects_slug_format allows.
  base := btrim(left(base, 55), '-');
  if base = '' then base := 'practice'; end if;

  -- Eight hex characters: four billion possibilities per practice name. The
  -- loop only exists to honour the unique index in the one-in-billions case.
  loop
    candidate := base || '-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
    exit when not exists (select 1 from public.prospects where slug = candidate);
  end loop;

  new.slug := candidate;
  return new;
end;
$$;

-- `create or replace` keeps the existing grants, but restate them so this file
-- reads correctly on its own: only the database's own roles may run it.
revoke execute on function public.prospects_autoslug() from public, anon, authenticated;
