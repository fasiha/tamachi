create table _tamachi_db_state (schemaVersion integer not null);
create table user (
  id INTEGER PRIMARY KEY,
  name text unique not null,
  hashed text not null,
  salt text not null,
  iterations integer not null,
  keylen integer not null,
  digest text not null
);
create table sentence (
  id INTEGER PRIMARY KEY,
  ja text not null,
  jaHint text not null,
  en text not null,
  unique (ja, en)
);
create table audio (
  id INTEGER PRIMARY KEY,
  sentenceId integer not null,
  language text not null,
  speaker text not null,
  base64 text not null,
  created integer not null
);
create table story (id INTEGER PRIMARY KEY, title text unique not null);
create table linkstorysentence (
  id INTEGER PRIMARY KEY,
  sentenceId integer not null,
  storyId integer not null,
  idx text not null
);
create table review (
  id INTEGER PRIMARY KEY,
  userId integer not null,
  sentenceId integer not null,
  epoch integer not null,
  results text not null
);
insert into
  _tamachi_db_state (schemaVersion)
values
  (1);
