-- Minimal key/value table for site-wide settings. First use: the
-- maintenance-mode flag, toggled from the admin panel (see
-- controllers/adminController.js, middleware/maintenance.js).
create table app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null
);

insert into app_settings (key, value) values ('maintenance_mode', 'false'::jsonb);
