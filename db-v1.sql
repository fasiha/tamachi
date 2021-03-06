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
  base64 text unique not null,
  created float not null,
  unique (sentenceId, language, speaker)
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
  created float not null,
  result text not null, -- JSON
  ebisu text not null, -- JSON
  halflife float not null,
  unique (userId, sentenceId, created)
);
insert into
  _tamachi_db_state (schemaVersion)
values
  (1);
