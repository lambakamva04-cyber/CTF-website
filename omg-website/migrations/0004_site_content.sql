-- The website's own content, so OMG can change it on the admin page's
-- Website tab: the services and prices, the photos, the contact details and
-- a few lines of text. Seeded with exactly what the site showed before.

-- Every service on the price lists. `id` is permanent (bookings and "Book"
-- buttons refer to it); everything else can be edited. `card` is where it is
-- listed: the Makeup or Hair card, the bridal package, or the Bride or
-- Bridesmaid card. Hidden services are neither shown nor bookable.
CREATE TABLE services (
  id         TEXT    PRIMARY KEY CHECK (length(id) BETWEEN 2 AND 40),
  card       TEXT    NOT NULL CHECK (card IN ('makeup', 'hair', 'package', 'bride', 'bridesmaid')),
  name       TEXT    NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  price      INTEGER NOT NULL CHECK (price BETWEEN 0 AND 100000),
  minutes    INTEGER NOT NULL CHECK (minutes BETWEEN 15 AND 720),
  note       TEXT    CHECK (note IS NULL OR length(note) <= 60),
  level      INTEGER CHECK (level IS NULL OR level BETWEEN 1 AND 3),
  details    TEXT    CHECK (details IS NULL OR length(details) <= 1000),
  sort       INTEGER NOT NULL DEFAULT 0,
  visible    INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  updated_at INTEGER NOT NULL
);
CREATE INDEX services_card_sort ON services (card, sort);

INSERT INTO services (id, card, name, price, minutes, note, level, details, sort, visible, updated_at) VALUES
  ('soft-glam', 'makeup', 'Soft Glam', 750, 90, NULL, 1, NULL, 1, 1, 0),
  ('full-glam', 'makeup', 'Full Glam', 850, 90, NULL, 2, NULL, 2, 1, 0),
  ('bold-dramatic', 'makeup', 'Bold / Dramatic', 950, 120, NULL, 3, NULL, 3, 1, 0),
  ('basic-installation', 'hair', 'Basic Installation', 400, 90, NULL, NULL, NULL, 1, 1, 0),
  ('curling-long-weave', 'hair', 'Curling Long Weave', 450, 90, NULL, NULL, NULL, 2, 1, 0),
  ('bridal-package', 'package', 'Bridal Package', 4500, 300, NULL, NULL,
   'Hair:' || char(10) || 'Weave installation (your hair)' || char(10) || 'Bridal hairstyle of your choice' || char(10) ||
   'Makeup:' || char(10) || 'Skin prep' || char(10) || 'Full bridal coverage makeup' || char(10) || 'Strip lashes' || char(10) ||
   'On the day:' || char(10) || 'Touch-ups for the photoshoot hour', 1, 1, 0),
  ('bridal-makeup-leave', 'bride', 'Bridal makeup & leave immediately', 1800, 120, NULL, NULL, NULL, 1, 1, 0),
  ('bridal-makeup-install-style', 'bride', 'Bridal makeup, installation + style & leave', 2900, 210, NULL, NULL, NULL, 2, 1, 0),
  ('bridal-natural-hairstyle', 'bride', 'Bridal natural hairstyle', 850, 90, 'We bring everything', NULL, NULL, 3, 1, 0),
  ('bridal-trial', 'bride', 'Bridal trial makeup', 750, 90, 'Not compulsory', NULL, NULL, 4, 1, 0),
  ('bridesmaid-strip-lashes', 'bridesmaid', 'Bridesmaid full glam with strip lashes', 850, 90, NULL, NULL, NULL, 1, 1, 0),
  ('bridesmaid-cut-crease', 'bridesmaid', 'Bridesmaid full glam with cut crease', 950, 120, NULL, NULL, NULL, 2, 1, 0);

-- Contact details and short texts, by name.
CREATE TABLE site_text (
  key   TEXT PRIMARY KEY CHECK (key IN ('phone', 'instagram', 'facebook_url', 'facebook_name', 'tagline', 'home_calls', 'bridal_note')),
  value TEXT NOT NULL CHECK (length(value) <= 400)
);
INSERT INTO site_text (key, value) VALUES
  ('phone', '27785767604'),
  ('instagram', 'asanda_tiwani'),
  ('facebook_url', 'https://www.facebook.com/search/top?q=Asanda%20Tiwani'),
  ('facebook_name', 'Asanda Tiwani'),
  ('tagline', 'Glam made for your moment, from soft and subtle to bold and dramatic. Home calls available on request.'),
  ('home_calls', 'Home calls are available upon request. The transport fee is not included in the prices above and depends on where you are.'),
  ('bridal_note', 'Return transport and accommodation to the bride’s location are not included in the package.');

-- The photos in "the glam": the gallery (looks) and the before-and-afters.
-- `src` is the large image and `src_small` a smaller copy for phones: files
-- shipped with the site (/img/...) or ones OMG uploaded (/media/...).
CREATE TABLE photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  album       TEXT    NOT NULL CHECK (album IN ('looks', 'before_after')),
  src         TEXT    NOT NULL CHECK (length(src) <= 200),
  src_small   TEXT    NOT NULL CHECK (length(src_small) <= 200),
  width       INTEGER NOT NULL CHECK (width BETWEEN 1 AND 10000),
  height      INTEGER NOT NULL CHECK (height BETWEEN 1 AND 10000),
  small_width INTEGER NOT NULL CHECK (small_width BETWEEN 1 AND 10000),
  alt         TEXT    NOT NULL CHECK (length(alt) BETWEEN 3 AND 160),
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX photos_album_sort ON photos (album, sort);

INSERT INTO photos (album, src, src_small, width, height, small_width, alt, sort, created_at) VALUES
  ('looks', '/img/gallery/glam-1.webp', '/img/gallery/glam-1-360.webp', 720, 665, 360, 'Soft glam makeup with a mauve lip, worn with a braided updo', 1, 0),
  ('looks', '/img/gallery/glam-2.webp', '/img/gallery/glam-2-360.webp', 720, 535, 360, 'Copper cut-crease eyeshadow with full lashes and a nude lip', 2, 0),
  ('looks', '/img/gallery/glam-3.webp', '/img/gallery/glam-3-360.webp', 720, 826, 360, 'Glam makeup with blue liner and a nude lip, worn with long brown waves', 3, 0),
  ('looks', '/img/gallery/glam-4.webp', '/img/gallery/glam-4-360.webp', 720, 900, 360, 'Bronze shimmer eyeshadow with full lashes and a nude lip', 4, 0),
  ('looks', '/img/gallery/glam-5.webp', '/img/gallery/glam-5-360.webp', 720, 1031, 360, 'Copper and gold eyeshadow with dramatic lashes and a nude lip', 5, 0),
  ('before_after', '/img/before-after/ba-1-lg.webp', '/img/before-after/ba-1.webp', 828, 1036, 720, 'Before and after: bare skin, then soft glam with smoky eyes and a glossy nude lip', 1, 0),
  ('before_after', '/img/before-after/ba-2-lg.webp', '/img/before-after/ba-2.webp', 828, 1019, 720, 'Before and after: bare skin, then glam with a soft gold eye, full lashes and a nude lip', 2, 0),
  ('before_after', '/img/before-after/ba-3-lg.webp', '/img/before-after/ba-3.webp', 1024, 1280, 720, 'Before and after: bare skin, then full glam with dark smoky eyes, dramatic lashes and a rosy nude lip', 3, 0),
  ('before_after', '/img/before-after/ba-4-lg.webp', '/img/before-after/ba-4.webp', 828, 1020, 720, 'Before and after: bare skin, then glam with a gold eye, full lashes and a nude lip', 4, 0),
  ('before_after', '/img/before-after/ba-5-lg.webp', '/img/before-after/ba-5.webp', 1080, 1350, 720, 'Before and after: bare skin, then glam with pink eyeshadow and full lashes, hair in a side-swept curled updo', 5, 0);
