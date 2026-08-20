-- Key/value table for site-wide settings. Currently one key:
-- frontend_maintenance, which gates the public site (see
-- middleware/frontendMaintenance.js).
--
-- This replaces the 0007 version, which was dropped along with the old
-- maintenance feature. The difference that matters is in how it's READ:
-- utils/maintenanceFlag.js re-reads this on a short TTL, so flipping the
-- value here takes effect on a running server within seconds. The old
-- implementation only read it at boot, so a value changed directly in
-- the database never reached a live process at all.
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into app_settings (key, value)
values ('frontend_maintenance', 'false'::jsonb)
on conflict (key) do nothing;
