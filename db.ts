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
  const db = sqlite3(fname);

  let s = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`);
  const tableThere = s.get('_tamachi_db_state');

  if (tableThere) {
    // ensure it's the correct version, else bail; implement up/down migration later
    s = db.prepare(`select schemaVersion from _tamachi_db_state`);
    const dbState: Selected<Table._tamachi_db_stateRow> = s.get();
    if (!dbState || dbState.schemaVersion !== i.version) {
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

  export async function authenticate(db: Db, name: string, cleartextPass: string): Promise<i.User|undefined> {
    const row: Selected<Table.userRow> = db.prepare('select * from user where name = $name').get({name});
    if (row) {
      // `secret.hash` doesn't use `hashed` but I feel better not giving this to it
      const {hashed: hashedSubmission} = await secret.hash(cleartextPass, {
        salt: row.salt,
        keylen: row.keylen,
        iterations: row.iterations,
        digest: row.digest,
      });

      return hashedSubmission === row.hashed ? {id: row.id, name} : undefined;
    }
    return undefined;
  }
}

export namespace sentence {
  type Meta = {lexIdxs: string[]};

  export function getSentence(db: Db, sentenceId: number): undefined|i.Sentence {
    const row: Selected<Table.sentenceRow> = db.prepare('select * from sentence where id=?').get(sentenceId);
    const audioRows: Table.audioRow[] = db.prepare(`select * from audio where sentenceId=?`).all(sentenceId);
    const audio: (i.Sentence)['audio'] = {en: [], ja: []};
    for (const row of audioRows) {
      if (row.language === 'ja' || row.language === 'en') {
        const thisAudio: i.Audio = {
          language: row.language,
          speaker: row.speaker,
          base64: row.base64,
          created: row.created,
        };
        audio[row.language].push(thisAudio);
      }
    }
    return row ? {...row, ja: JSON.parse(row.ja).map(deserialize), audio} : undefined;
  }

  export function getOrCreateStory(db: Db, title: string): i.Story|undefined {
    const _meta: Meta = {lexIdxs: []};
    const storyRow: Selected<Table.storyRow> = db.prepare('select * from story where title=$title').get({title});
    if (storyRow) {
      // story exists. Don't write anything to db, just read.
      const story: i.Story = {id: storyRow.id, title: storyRow.title, sentences: [], _meta};
      const links: (NonNullable<Selected<Table.linkstorysentenceRow>>)[] =
          db.prepare(`select * from linkstorysentence where storyId=? order by idx`).all(storyRow.id);
      for (const row of links) {
        const sentence = getSentence(db, row.sentenceId);
        if (!sentence) {
          throw new Error(`story refers to nonexistent sentenceId ${row.sentenceId}`)
        }
        story.sentences.push(sentence);
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

    const noAudio: i.Sentence['audio'] = {en: [], ja: []};
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

export namespace audio {
  require('dotenv').config();
  const aws_region = process.env['aws_region'];
  const aws_access_key_id = process.env['aws_access_key_id'];
  const aws_secret_access_key = process.env['aws_secret_access_key'];
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
            console.warn('addAudio calling AWS Polly');
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

export namespace review {
  export function reviewed(db: Db, user: i.User, sentence: i.Sentence, result: i.ReviewResult) {
    const row: Table.reviewRow = {
      userId: user.id,
      sentenceId: sentence.id,
      created: Date.now(),
      result: JSON.stringify(result),
      ebisu: '',
      halflife: Math.random()
    };
    const res =
        db.prepare(
              'insert into review (userId, sentenceId, created,result,ebisu,halflife) values ($userId, $sentenceId, $created, $result, $ebisu, $halflife)')
            .run(row);
  }

  const ForReview = t.type({id: t.number, sentenceId: t.number, neglogprob: t.number, maxcreated: t.number});
  type ForReview = t.TypeOf<typeof ForReview>;
  export function toReview(db: Db, user: i.User): i.Sentence|undefined {
    // get the sentence MOST needing review
    const row = db.prepare(`select id, sentenceId, ($now - created) / halflife neglogprob, max(created) maxcreated
from review
where userId=$userId
group by userId, sentenceId
order by neglogprob desc
limit 1`).get({userId: user.id, now: Date.now()});
    if (row) {
      const decoded = ForReview.decode(row);
      if (decoded._tag === 'Right') {
        const right = decoded.right;
        return sentence.getSentence(db, right.sentenceId);
      }
      throw new Error('returned row failed to decode?')
    }
    return undefined;
  }
}

if (require.main === module) {
  function groupBy<T, U>(f: (t: T) => U, v: T[]): Map<U, T[]> {
    const ret = new Map();
    for (const x of v) {
      const y = f(x);
      if (ret.has(y)) {
        ret.get(y).push(x);
      } else {
        ret.set(y, [x]);
      }
    }
    return ret;
  }
  function maxBy<T>(f: (t: T) => number, v: T[]): undefined|T {
    if (v.length === 0) {
      return undefined;
    }
    let ret = v[0];
    let y = f(ret);
    for (let i = 1; i < v.length; ++i) {
      const thisy = f(v[i]);
      if (thisy > y) {
        ret = v[i];
      }
    }
    return ret;
  }
  (async function() {
    require('dotenv').config();
    var assert = require('assert');
    const db = init('tamachi.db');
    await user.createUser(db, 'ahmed', 'whee');
    await user.resetPassword_DANGEROUS(db, 'ahmed', 'whoo');
    await user.resetPassword_DANGEROUS(db, '__', 'whoo');
    assert(await user.authenticate(db, 'ahmed', 'whee') === undefined)
    assert(await user.authenticate(db, 'ahmed', 'whoo') !== undefined)
    assert(await user.authenticate(db, 'qqq', 'qqq') === undefined)

    {
      const name = 'ahmed';
      const hashedDict = await secret.hash('well', {salt: 's', keylen: 32, iterations: 1000, digest: 'sha1'});
      const row: Table.userRow = {...hashedDict, name};
      db.prepare(
            'update user set hashed=$hashed, salt=$salt, iterations=$iterations, keylen=$keylen, digest=$digest where name is $name')
          .run(row);
      assert(await user.authenticate(db, 'ahmed', 'well') !== undefined);
      assert(await user.authenticate(db, 'ahmed', 'x') === undefined);
      assert(await user.authenticate(db, 'z', 'x') === undefined);
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
    {
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      const story = sentence.getOrCreateStory(db, "Nail");
      const ahmed = await user.authenticate(db, 'ahmed', 'well');
      if (story && ahmed) {
        console.log({story, ahmed})
        const rev: i.ReviewResult = {initial: true, type: 'quizresult', value: 1};
        review.reviewed(db, ahmed, story.sentences[0], rev);
        await sleep(100);
        review.reviewed(db, ahmed, story.sentences[1], rev);
        await sleep(100);
        review.reviewed(db, ahmed, story.sentences[0], rev);
        await sleep(100);
        review.reviewed(db, ahmed, story.sentences[1], rev);
        await sleep(100);
        review.reviewed(db, ahmed, story.sentences[0], rev);
        await sleep(100);
        review.reviewed(db, ahmed, story.sentences[0], rev);

        const rows: (Table.reviewRow&{neglogprob: number})[] =
            db.prepare('select *, (? - created) / halflife neglogprob from review ').all(Date.now());
        console.log('maxTime',
                    Array.from(groupBy(r => r.sentenceId, rows), ([k, v]) => ({[k]: maxBy(x => x.created, v)})));
        const sentence = review.toReview(db, ahmed);
        console.log(sentence)
      }
    }
    {
      let story = sentence.getOrCreateStory(db, "Nail");
      if (story) {
        const row: Table.audioRow = {
          base64: "audio:x",
          sentenceId: story.sentences[0].id,
          speaker: `Takumi standard`,
          language: 'ja',
          created: Date.now()
        };
        const s = db.prepare(
            'insert into audio (sentenceId, language, speaker, base64, created) values ($sentenceId, $language, $speaker, $base64, $created)');
        s.run(row);
        row.speaker = 'Jackie neural';
        row.language = 'en';
        row.base64 = 'audio:enx'
        s.run(row);
      }
      story = sentence.getOrCreateStory(db, "Nail");
      console.dir(story, {depth: null})
    }
  })();
}