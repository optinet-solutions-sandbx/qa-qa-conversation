-- trio_rotation — the allocation ledger behind the Geri/Martin/Allan rotation.
--
-- Run this once in the Supabase SQL editor (or via the CLI). Until it exists,
-- ticket creation keeps working: lib/asana.ts logs a warning and falls back to
-- the old conversation-id hash, so escalations are never blocked on this table.
--
-- Why a table with a sequence rather than a counter the app increments:
-- escalations are created concurrently (app/api/batch-analysis/route.ts flushes
-- a batch with Promise.all), so "read the count, pick the next name, write it
-- back" would hand the same slot to every ticket in the batch — which is the
-- lopsided distribution this whole change exists to fix. A bigserial is
-- allocated by Postgres itself, so N concurrent inserts get N distinct slots
-- with no locking on our side.
--
-- Val asked for strict rotation on 2026-08-13: "1 Geri, 1 Martin, 1 Allan,
-- repeat" regardless of who is busy, so each of them gets an equal share of the
-- stream whenever they come on shift. seq drives that directly —
-- AM_TRIO_OWNERS[(seq - 1) % 3] in lib/asana.ts.
--
-- conversation_id is UNIQUE so the allocation is idempotent: a retried or
-- re-analysed conversation resolves to the slot it already holds instead of
-- consuming a second one and skipping someone in the cycle.
--
-- owner is written back after the fact and is purely for reporting ("how many
-- did each get this week"). It is derivable from seq, so a null owner on a row
-- means the follow-up write failed, never that the ticket went unassigned.

create table if not exists trio_rotation (
  seq             bigserial   primary key,
  conversation_id text        not null unique,
  owner           text,
  created_at      timestamptz not null default now()
);

-- Reporting queries filter by owner and date; the unique index on
-- conversation_id already covers the allocation lookup.
create index if not exists trio_rotation_owner_created_idx
  on trio_rotation (owner, created_at desc);
