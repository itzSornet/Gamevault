-- What critics said: peak_lines also keeps the outlet a quoted line is from
-- (by), OpenCritic's Top Critic Average (score) and its game id (oc_id).
-- final = false: a stand-in written while OpenCritic couldn't be asked; the
-- peak-line function asks again after a day. Lines written before OpenCritic
-- are stand-ins too, so they are replaced.
alter table public.peak_lines
  add column by     text,
  add column score  integer,
  add column oc_id  integer,
  add column final  boolean not null default false;
