import sqlite3 from 'better-sqlite3';
import crypto from 'crypto';
import {readFileSync} from 'fs';
import * as t from 'io-ts';
import {base62} from 'mudder';
import {promisify} from 'util';

import {PREFERRED_ENGLISH_VOICES, PREFERRED_JAPANESE_VOICES, textToAudioBase64} from './audio';
import * as Table from './DbTables';
import {i} from './interfaces';

type Db = ReturnType<typeof sqlite3>;

/**
 * We need someting like `Selected` because sql-ts emits my tables' `id` as `null|number` because I don't have to
 * specify an `INTEGER PRIMARY KEY` when *inserting*, asSQLite will make it for me. However, when *selecting*, the
 * `INTEGER PRIMARY KEY` field *will* be present.
 *
 * This could also be:
 * ```
 * type Selected<T> = Required<{[k in keyof T]: NonNullable<T[k]>}>|undefined;
 * ```
 * The above says "*All* keys are required and non-nullable". But I think it's better to just use our knowledge that
 * `id` is the only column thus affected, as below. If we ever add more nullable columns, the following is safer:
 */
type Selected<T> = (T&{id: number})|undefined;

function uniqueConstraintError(e: unknown): boolean {
  return e instanceof sqlite3.SqliteError && e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

namespace secret {
  const randomBytes = promisify(crypto.randomBytes);
  const pbkdf2 = promisify(crypto.pbkdf2);
  const SALTLEN = 32;
  const ITERATIONS = 100_000;
  const KEYLEN = 32;
  const DIGEST = 'sha1';

  type Metadata = {salt: string, iterations: number, keylen: number, digest: string};
  type HashedData = Metadata&{hashed: string};
  export async function hash(clear: string, {salt = '', iterations = ITERATIONS, keylen = KEYLEN, digest = DIGEST}:
                                                Partial<Metadata> = {}): Promise<HashedData> {
    salt = salt || (await randomBytes(SALTLEN)).toString('base64url');
    const buf = await pbkdf2(clear, salt, iterations, keylen, digest);
    return {hashed: buf.toString('base64url'), salt, iterations, keylen, digest};
  }
}

export function init(fname: string) {
  interface DbState {
    schemaVersion: number;
  }
  const db = sqlite3(fname);

  let s = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`);
  const tableThere = s.get('_tamachi_db_state');

  if (tableThere) {
    // ensure it's the correct version, else bail; implement up/down migration later
    s = db.prepare(`select schemaVersion from _tamachi_db_state`);
    const dbState: DbState = s.get();
    console.log(dbState)
    if (dbState.schemaVersion !== i.version) {
      throw new Error('migrations not yet supported');
    }
  } else {
    console.log('uninitialized, will create v1 schema');
    db.exec(readFileSync('db-v1.sql', 'utf8'));
  }
  return db;
}

export namespace user {
  export async function createUser(db: Db, name: string, cleartextPass: string): Promise<sqlite3.RunResult|undefined> {
    const hashedDict = await secret.hash(cleartextPass);
    try {
      const userEntity: Table.userRow = {...hashedDict, name};
      const res =
          db.prepare(
                'insert into user (name, hashed, salt, iterations, keylen, digest) values ($name, $hashed, $salt, $iterations, $keylen, $digest)')
              .run(userEntity);
      /*
      Nota bene how I'm not concerned with typos in the string, e.g., "$nmae": better-sqlite3 will
      catch those, saying `Missing named parameter "nmae"` at runtime.
      */
      console.info('createUser', res);
      return res;
    } catch (e) {
      if (uniqueConstraintError(e)) {
        console.log(`createUser: couldn't create user, constraint check failed`)
        return undefined;
      }
      console.error(`createUser: couldn't create user, unknown error`);
      throw e;
    }
  }

  /**
   * Resets the password without checking that you know it, hence dangerous.
   * Doesn't do anything if `name` doesn't exist.
   */
  export async function resetPassword_DANGEROUS(db: Db, name: string, newCleartextPass: string) {
    const hashedDict = await secret.hash(newCleartextPass);
    const userEntity: Table.userRow = {...hashedDict, name};
    const res =
        db.prepare(
              'update user set hashed=$hashed, salt=$salt, iterations=$iterations, keylen=$keylen, digest=$digest where name is $name')
            .run(userEntity);
    console.info('resetPassword_DANGEROUS', res);
  }

  export async function authenticate(db: Db, name: string, cleartextPass: string): Promise<boolean> {
    const row: Selected<Table.userRow> =
        db.prepare('select hashed, salt, iterations, keylen, digest from user where name = $name').get({name});
    if (row) {
      // `secret.hash` doesn't use `hashed` but I feel better not giving this to it
      const {hashed: hashedSubmission} = await secret.hash(cleartextPass, {
        salt: row.salt,
        keylen: row.keylen,
        iterations: row.iterations,
        digest: row.digest,
      });

      return hashedSubmission === row.hashed;
    }
    return false;
  }
}

export namespace sentence {
  type Meta = {lexIdxs: string[]};
  const Link = t.type({sentenceId: t.number, ja: t.string, jaHint: t.string, en: t.string, idx: t.string});
  type Link = t.TypeOf<typeof Link>;

  const noAudio: i.Sentence['audio'] = {en: [], ja: []};

  export function getOrCreateStory(db: Db, title: string): i.Story|undefined {
    const _meta: Meta = {lexIdxs: []};
    const storyRow: Selected<Table.storyRow> = db.prepare('select * from story where title=$title').get({title});
    if (storyRow) {
      // story exists. Don't write anything to db, just read.
      const story: i.Story = {id: storyRow.id, title: storyRow.title, sentences: [], _meta};
      // Note above we've assumed the db returned the expected shape of the data.
      // We can't io-ts this easily because io-ts needs to define types in its format,
      // it can't take an existing TypeScript interface as input. But I think this is ok.
      // By discipline if we insert only formats that conform to the types inferred by
      // sql-ts (in `Database.ts`), we can be reasonably sure raw SELECTs will be ok.
      // However, the following join might return an unexpected shape if we typo the query!
      // So we'll io-ts-ify that.
      const links: Link[] =
          db.prepare(
                `select linkstorysentence.sentenceId, linkstorysentence.idx, sentence.ja, sentence.en, sentence.jaHint
        from linkstorysentence inner join sentence
        on linkstorysentence.sentenceId = sentence.id
        where linkstorysentence.storyId=$storyId
        order by linkstorysentence.idx`)
              .all({storyId: storyRow.id});
      for (const row of links) {
        /*
        This is how io-ts works: you `decode`, then the result is an `Either`.
        By convention, the Either's `_tag` is Right or Left, meaning decoded or not.
        fp-ts has nice helper functions for this, in case this is too esoreric.
        */
        const decoded = Link.decode(row);
        if (decoded._tag === 'Right') {
          const link = decoded.right;
          story.sentences.push({
            id: row.sentenceId,
            en: row.en,
            ja: JSON.parse(row.ja).map(deserialize),
            jaHint: row.jaHint,
            audio: noAudio,
          })
        } else {
          throw new Error('link failed to decode as expected');
        }
      }
      _meta.lexIdxs = links.map(l => l.idx);
      return story;
    }
    // story doesn't exist. Create it.
    try {
      const row: Table.storyRow = {title};
      const res = db.prepare('insert into story (title) values ($title)').run(row)
      if (res.changes) {
        const story: i.Story = {id: Number(res.lastInsertRowid), title, sentences: [], _meta};
        return story;
      }
    } catch (e) {
      if (uniqueConstraintError(e)) {
        console.error('getOrCreateStory: failed to insert due to constraint, race condition? retry');
        return undefined;
      }
      console.error('getOrCreateStory: unknown error');
      throw e;
    }
  }

  type JaEn = {ja: i.Words, en: string, jaHint: string};
  function serialize(word: i.Word): string|string[] { return typeof word === 'string' ? word : [word.ruby, word.rt]; }
  function deserialize(word: string|string[]): i.Word {
    return typeof word === 'string' ? word : {ruby: word[0], rt: word[1]};
  }

  export async function addSentences(db: Db, story: i.Story, startIdx: number, deleteCount: number,
                                     lines: JaEn[]): Promise<i.Story> {
    // `startIdx` will be used with `Array.splice` below, whose API for starts greater than the length of the array is
    // to append to the end. This enforces that API via Mudder:
    startIdx = Math.min(startIdx, story.sentences.length);
    // Without this, if we passed in `startIdx` much bigger than the number of sentences, Mudder would interpolate
    // between '' and '', i.e., over the whole lexicographic range of base62, because it doesn't know that there's a
    // left-hand bookend.

    const sentences: i.Sentence[] = lines.map(({ja, en, jaHint}) => ({ja, jaHint, en, id: -1, audio: noAudio}));

    // Let's update the story object first: its array of sentences
    const deletedSentences = story.sentences.splice(startIdx, deleteCount, ...sentences);

    // Update the story object's metadata, containing the sort order indexes via Mudder
    const meta = story._meta as Meta;
    const leftIdx = meta.lexIdxs[startIdx - 1] || ''; // yes, if `startIdx===0`, this will be '' for Mudder
    const rightIdx = meta.lexIdxs[startIdx] || '';    // and even if there's no sentences, this will be ''
    const newIdxs = base62.mudder(leftIdx, rightIdx, lines.length);
    const deletedIdxs = meta.lexIdxs.splice(startIdx, deleteCount, ...newIdxs);

    // Now let's write to the db.

    const sentenceIdxNeedingAudio: number[] = []; // not id! Hopefully not confusing

    // given that we got a `i.Story`, that means it has an `id` which means it's been inserted into db

    // one of the lines might already be in the db
    const insertSentence = db.prepare('insert or ignore into sentence (ja, en, jaHint) values ($ja, $en, $jaHint)');
    const selectSentence = db.prepare('select id from sentence where ja=$ja and en=$en');
    const insertLink =
        db.prepare('insert into linkstorysentence (sentenceId, storyId, idx) values ($sentenceId, $storyId, $idx)');
    for (const [i, {ja: jaOrig, en}] of sentences.entries()) {
      // Make sure sentence is in db
      const jaEn:
          Table.sentenceRow = {ja: JSON.stringify(jaOrig.map(serialize)), en, jaHint: sentenceToPlainJapanese(jaOrig)};
      const res = insertSentence.run(jaEn);
      console.log('1', res)
      let sentenceId = -1;
      if (res.changes) {
        // successful insert!
        sentenceId = Number(res.lastInsertRowid); // lose bigint
        sentenceIdxNeedingAudio.push(i);
      } else {
        // sentence didn't insert, it's already there
        const res: Selected<Table.sentenceRow> = selectSentence.get(jaEn);
        if (res) {
          sentenceId = res.id;
        } else {
          throw new Error('sentence failed to insert and select?')
        }
      }

      // Add the link in the db
      const link: Table.linkstorysentenceRow = {sentenceId, storyId: story.id, idx: newIdxs[i]};
      insertLink.run(link);

      // Add the sentence id: this comes from the db, overwriting the above initialization of -1
      sentences[i].id = sentenceId;
    }

    // Take care of deleted links
    if (deleteCount > 0) {
      const deleter =
          db.prepare('delete from linkstorysentence where storyId=$storyId and sentenceId=$sentenceId and idx=$idx');
      for (const [i, s] of deletedSentences.entries()) {
        const row: Table.linkstorysentenceRow = {sentenceId: s.id, storyId: story.id, idx: deletedIdxs[i]};
        deleter.run(row)
      }
    }

    // We could add audio to all new sentences here but since that costs money (AWS Polly), let's only do that when
    // users explicitly ask for audio
    // E.g., `await audio.addAudio(db, sentenceIdxNeedingAudio.map(i => sentences[i]));`
    console.log(`addSentences: ${sentenceIdxNeedingAudio.length} missing audio`)

    return story;
  }

  export function sentenceToPlainJapanese(words: i.Sentence['ja']): string {
    return words.map(w => typeof w === 'string' ? w : w.ruby).join('');
  }
}

namespace audio {
  require('dotenv').config();
  const aws_region = process.env['aws_region'];
  const aws_access_key_id = process.env['aws_access_key_id'];
  const aws_secret_access_key = process.env['aws_secret_access_key'];
  console.log({aws_region, aws_access_key_id, aws_secret_access_key})
  if(!(aws_region && aws_access_key_id && aws_secret_access_key)) {
    throw new Error('cannot create audio: invalid .env or missing environment variables');
  }
  const aws = {aws_region, aws_access_key_id, aws_secret_access_key};

  export async function addAudio(db: Db, sentences: i.Sentence[]) {
    const insert = db.prepare(
        'insert into audio (sentenceId, language, speaker, base64, created) values ($sentenceId, $language, $speaker, $base64, $created)');
    const update = db.prepare('update audio set base64=$base64 where id=$id');
    for (const s of sentences) {
      for (const voice of PREFERRED_JAPANESE_VOICES.concat(PREFERRED_ENGLISH_VOICES)) {
        const row: Table.audioRow = {
          base64: "",
          sentenceId: s.id,
          speaker: `${voice.name} ${voice.engine}`,
          language: voice.language,
          created: Date.now()
        };
        try {
          // insert with blank base64, ensure no unique constraints aren't broken
          const res = insert.run(row);
          if (res.changes) {
            // and only THEN spend money on AWS Polly
            const text = voice.language === 'ja' ? s.jaHint : s.en;
            row.base64 = await textToAudioBase64({...aws, text, voice: voice.name, engine: voice.engine});
            // update
            update.run({base64: row.base64, id: res.lastInsertRowid});
          }
        } catch (e) {
          if (uniqueConstraintError(e)) {
            console.log('addAudio: this mp3 already exists, skipping');
            continue;
          } else {
            throw e;
          }
        }
      }
    }
  }
}

if (require.main === module) {
  (async function() {
    require('dotenv').config();
    var assert = require('assert');
    const db = init('tamachi.db');
    await user.createUser(db, 'ahmed', 'whee');
    await user.resetPassword_DANGEROUS(db, 'ahmed', 'whoo');
    await user.resetPassword_DANGEROUS(db, '__', 'whoo');
    assert(await user.authenticate(db, 'ahmed', 'whee') === false)
    assert(await user.authenticate(db, 'ahmed', 'whoo') === true)
    assert(await user.authenticate(db, 'qqq', 'qqq') === false)

    {
      const name = 'ahmed';
      const hashedDict = await secret.hash('well', {salt: 's', keylen: 32, iterations: 1000, digest: 'sha1'});
      const row: Table.userRow = {...hashedDict, name};
      db.prepare(
            'update user set hashed=$hashed, salt=$salt, iterations=$iterations, keylen=$keylen, digest=$digest where name is $name')
          .run(row);
      assert(await user.authenticate(db, 'ahmed', 'well') === true);
      assert(await user.authenticate(db, 'ahmed', 'x') === false);
      assert(await user.authenticate(db, 'z', 'x') === false);
    }

    {
      let story = sentence.getOrCreateStory(db, "Nail");
      console.log('init')
      console.dir(story, {depth: null});

      if (story) {
        story = await sentence.addSentences(db, story, 0, 0, [
          {ja: ['x'], en: 'x', jaHint: 'x'},
          {ja: ['z'], en: 'z', jaHint: 'z'},
          {ja: ['x'], en: 'x', jaHint: 'x'},
        ]);
        console.log('after adding')
        console.dir(story, {depth: null});
      }
    }
    {
      let story = sentence.getOrCreateStory(db, "Nail");
      console.log('init')
      console.dir(story, {depth: null});
      if (story) {
        story = await sentence.addSentences(db, story, 99999, 0, [
          {ja: ['owari'], en: 'the end', jaHint: 'owari'},
          {ja: ['lol'], en: 'lol', jaHint: 'w'},
        ]);
        console.log('after adding')
        console.dir(story, {depth: null});
      }
    }
    {
      let story = sentence.getOrCreateStory(db, "Nail");
      console.log('init')
      console.dir(story, {depth: null});
      if (story) {
        story = await sentence.addSentences(db, story, story.sentences.length - 1, 100, []);
        console.log('after removing')
        console.dir(story, {depth: null});
      }
    }
    {
      let story = sentence.getOrCreateStory(db, "Nail");
      console.log('init')
      console.dir(story, {depth: null});
    }
  })();
}