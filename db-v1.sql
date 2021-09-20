create table _tamachi_db_state (schemaVersion number not null);

create table user (id INTEGER PRIMARY KEY, name text unique not null, hashed text not null, salt text not null, iterations number not null, keylen number not null, digest text not null);

create table sentence (id INTEGER PRIMARY KEY, ja text not null, en text not null);

create table audio (id INTEGER PRIMARY KEY, sentenceId number not null, language text not null, speaker text not null, base64 text not null);

create table story (id INTEGER PRIMARY KEY, title text not null);
create table linkstorysentence (id INTEGER PRIMARY KEY, sentenceId number not null, storyId number not null, lino string not null);

create table review (id INTEGER PRIMARY KEY, userId number not null, sentenceId number not null, epoch number not null, results text not null);

insert into _tamachi_db_state (schemaVersion) values (1);