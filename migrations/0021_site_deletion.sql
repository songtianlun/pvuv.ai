-- ============================================================================
-- Site deletion.
--
-- Deleting a site removes its `sites` row at once, so every owner check, the
-- ingest gate, the public dashboard and the API stop seeing it immediately.
-- Its data is a different matter: events, sessions and visitor profiles can
-- run to millions of rows, far more than one console request may delete. The
-- site id is parked here instead, and the daily cron purge works the rows off
-- in bounded batches, dropping the tombstone once nothing is left.
-- ============================================================================

CREATE TABLE IF NOT EXISTS deleted_sites (
  site_id    TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  deleted_at INTEGER NOT NULL
);
