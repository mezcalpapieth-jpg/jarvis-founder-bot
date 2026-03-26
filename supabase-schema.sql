-- Run this in your Supabase SQL editor to set up the schema.

-- Message log: every message the bot sees
create table if not exists messages (
  id           bigserial primary key,
  chat_id      bigint       not null,
  message_id   bigint       not null,
  user_id      bigint       not null,
  username     text,
  first_name   text,
  text         text         not null,
  created_at   timestamptz  not null default now()
);
create index on messages (chat_id, created_at desc);

-- Decisions extracted from the conversation
create table if not exists decisions (
  id           bigserial primary key,
  chat_id      bigint       not null,
  summary      text         not null,
  raw_context  text,                        -- snippet of messages that led to the decision
  decided_at   timestamptz  not null default now()
);
create index on decisions (chat_id, decided_at desc);

-- Action items / tasks the founders commit to
create table if not exists action_items (
  id           bigserial primary key,
  chat_id      bigint       not null,
  task         text         not null,
  assigned_to  text,                        -- username or "both"
  due_date     date,
  status       text         not null default 'open',  -- open | done | cancelled
  created_at   timestamptz  not null default now(),
  updated_at   timestamptz  not null default now()
);
create index on action_items (chat_id, status);

-- Rolling context window the bot uses to reason about recent conversation
-- (one row per chat; updated on every message)
create table if not exists chat_context (
  chat_id      bigint       primary key,
  summary      text         not null default '',   -- Claude-generated rolling summary
  updated_at   timestamptz  not null default now()
);
