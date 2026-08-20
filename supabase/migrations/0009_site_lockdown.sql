-- Renames the flag introduced in 0008 to match what it actually does.
-- 0008's gate covered only the public pages; it was widened to a full
-- lockdown (the API, the admin panel and the dashboard included), so the
-- key follows the behaviour rather than describing a narrower one.
--
-- Set value to true to lock the site, false to unlock it. Because
-- utils/lockdownFlag.js re-reads on a short TTL, an update here reaches
-- a running server within seconds — which matters more than usual now,
-- since the lockdown blocks the admin panel too, making this table the
-- only way back in.
update app_settings set key = 'site_lockdown' where key = 'frontend_maintenance';

insert into app_settings (key, value)
values ('site_lockdown', 'false'::jsonb)
on conflict (key) do nothing;
