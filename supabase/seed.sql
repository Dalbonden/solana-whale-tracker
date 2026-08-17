-- ===========================================================================
-- Seed the curated core meme-token universe.
-- Run after schema.sql. Idempotent.
-- Market data columns are left null; the tokens cron fills them from Birdeye.
-- ===========================================================================

insert into public.meme_tokens (mint, symbol, name, decimals, source, is_core, is_active) values
  ('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIF',    'dogwifhat',        6, 'core', true, true),
  ('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONK',   'Bonk',             5, 'core', true, true),
  ('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', 'POPCAT', 'Popcat',           9, 'core', true, true),
  ('MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',  'MEW',    'cat in a dogs world', 5, 'core', true, true),
  ('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'SAMO',   'Samoyedcoin',      9, 'core', true, true),
  ('ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',  'BOME',   'BOOK OF MEME',     6, 'core', true, true),
  ('CATSraCS8bATgSPKBBcgMDPUxLKmk1jZBEeoQGEaVKfB', 'CATS',   'Cats',             6, 'core', true, true),
  ('A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump', 'FWOG',   'Fwog',             6, 'core', true, true),
  ('HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC', 'AI16Z',  'ai16z',            9, 'core', true, true),
  ('6ogzHhzdrQr9Pgv6hZ2MNze7UrzBMAFyBBWUYp1Fhitx', 'RETARDIO', 'RETARDIO',       6, 'core', true, true)
on conflict (mint) do update
  set symbol   = excluded.symbol,
      name     = excluded.name,
      decimals = excluded.decimals,
      is_core  = true,
      source   = 'core',
      is_active = true;
