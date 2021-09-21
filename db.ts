import sqlite3 from 'better-sqlite3';
import crypto from 'crypto';
import {readFileSync} from 'fs';
import {base62} from 'mudder';
import {promisify} from 'util';

import {i} from './interfaces';

type Db = ReturnType<typeof sqlite3>;

namespace secret {
  const randomBytes = promisify(crypto.randomBytes);
  const pbkdf2 = promisify(crypto.pbkdf2);
  const SALTLEN = 32;
  const ITERATIONS = 100_000;
  const KEYLEN = 32;
  const DIGEST = 'sha1';

  export type Metadata = {salt: string, iterations: number, keylen: number, digest: string};
  export type HashedData = Metadata&{hashed: string};
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
      const res =
          db.prepare(
                'insert into user (name, hashed, salt, iterations, keylen, digest) values ($name, $hashed, $salt, $iterations, $keylen, $digest)')
              .run({...hashedDict, name});
      console.info('createUser', res);
      return res;
    } catch (e) {
      if (e instanceof sqlite3.SqliteError && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
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
    const res =
        db.prepare(
              'update user set hashed=$hashed, salt=$salt, iterations=$iterations, keylen=$keylen, digest=$digest where name is $name')
            .run({...hashedDict, name});
    console.info('resetPassword_DANGEROUS', res);
  }

  export async function authenticate(db: Db, name: string, cleartextPass: string): Promise<boolean> {
    const row: secret.HashedData|undefined =
        db.prepare('select hashed, salt, iterations, keylen, digest from user where name = $name').get({name});
    if (row) {
      // `secret.hash` doesn't use `hashed` but I feel better not giving this to it
      const withoutHash: secret.Metadata = {
        salt: row.salt,
        keylen: row.keylen,
        iterations: row.iterations,
        digest: row.digest,
      };
      const {hashed: hashedSubmission} = await secret.hash(cleartextPass, withoutHash);

      return hashedSubmission === row.hashed;
    }
    return false;
  }
}

export namespace sentence {
  type Meta = {lexIdxs: string[]};
  type JSONEnc = string;
  type Link = {sentenceId: number, ja: JSONEnc, en: string, idx: string};

  export function getOrCreateStory(db: Db, title: string): i.Story|undefined {
    const _meta: Meta = {lexIdxs: []};
    const storyRow = db.prepare('select * from story where title=$title').get({title});
    if (storyRow) {
      // story exists. Don't write anything to db, just read.
      const story: i.Story = {id: storyRow.id, title: storyRow.title, sentences: [], _meta};
      const links: Link[] =
          db.prepare(`select linkstorysentence.sentenceId, linkstorysentence.idx, sentence.ja, sentence.en
        from linkstorysentence inner join sentence
        on linkstorysentence.sentenceId = sentence.id
        where linkstorysentence.storyId=$storyId
        order by linkstorysentence.idx`)
              .all({storyId: storyRow.id});
      story.sentences = links.map(row => ({id: row.sentenceId, en: row.en, ja: JSON.parse(row.ja).map(deserialize)}));
      _meta.lexIdxs = links.map(l => l.idx);
      return story;
    }
    // story doesn't exist. Create it.
    try {
      const res = db.prepare('insert into story (title) values ($title)').run({title})
      if (res.changes) {
        const story: i.Story = {id: Number(res.lastInsertRowid), title, sentences: [], _meta};
        return story;
      }
    } catch (e) {
      if (e instanceof sqlite3.SqliteError && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        console.error('getOrCreateStory: failed to insert due to constraint, race condition? retry');
        return undefined;
      }
      console.error('getOrCreateStory: unknown error');
      throw e;
    }
  }

  type JaEn = {ja: i.Words, en: string};
  function serialize(word: i.Word): string|string[] { return typeof word === 'string' ? word : [word.ruby, word.rt]; }
  function deserialize(word: string|string[]): i.Word {
    return typeof word === 'string' ? word : {ruby: word[0], rt: word[1]};
  }

  export function addSentences(db: Db, story: i.Story, startIdx: number, lines: JaEn[]): i.Story {
    // `startIdx` will be used with `Array.splice` below, whose API for starts greater than the length of the array is
    // to append to the end. This enforces that API via Mudder:
    startIdx = Math.min(startIdx, story.sentences.length);
    // Without this, if we passed in `startIdx` much bigger than the number of sentences, Mudder would interpolate
    // between '' and '', i.e., over the whole lexicographic range of base62, because it doesn't know that there's a
    // left-hand bookend.

    const sentences: i.Sentence[] = lines.map(({ja, en}) => ({ja, en, id: -1}))

    // Let's update the story object first: its array of sentences
    story.sentences.splice(startIdx, 0, ...sentences);

    // Update the story object's metadata, containing the sort order indexes via Mudder
    const meta = story._meta as Meta;
    const leftIdx = meta.lexIdxs[startIdx - 1] || ''; // yes, if `startIdx===0`, this will be '' for Mudder
    const rightIdx = meta.lexIdxs[startIdx] || '';    // and even if there's no sentences, this will be ''
    const newIdxs = base62.mudder(leftIdx, rightIdx, lines.length);
    meta.lexIdxs.splice(startIdx, 0, ...newIdxs);

    // Now let's write to the db.

    // given that we got a `i.Story`, that means it has an `id` which means it's been inserted into db

    // one of the lines might already be in the db
    const insertSentence = db.prepare('insert or ignore into sentence (ja, en) values ($ja, $en)');
    const selectSelectence = db.prepare('select id from sentence where ja=$ja and en=$en');
    const link =
        db.prepare('insert into linkstorysentence (sentenceId, storyId, idx) values ($sentenceId, $storyId, $idx)');
    for (const [i, {ja: jaOrig, en}] of sentences.entries()) {
      // Make sure sentence is in db
      const jaEn = {ja: JSON.stringify(jaOrig.map(serialize)), en};
      const res = insertSentence.run(jaEn);
      let sentenceId = -1;
      if (res.changes) {
        sentenceId = Number(res.lastInsertRowid); // lose bigint
      } else {
        const res = selectSelectence.get(jaEn);
        if (typeof res === 'object' && 'id' in res) {
          sentenceId = res.id;
        } else {
          throw new Error('sentence failed to insert and select?')
        }
      }

      // Add the link in the db
      link.run({sentenceId, storyId: story.id, idx: newIdxs[i]});

      // Add the sentence id: this comes from the db, overwriting the above initialization of -1
      sentences[i].id = sentenceId;
    }

    return story;
  }
}

if (require.main === module) {
  (async function() {
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
      db.prepare(
            'update user set hashed=$hashed, salt=$salt, iterations=$iterations, keylen=$keylen, digest=$digest where name is $name')
          .run({...hashedDict, name});
      assert(await user.authenticate(db, 'ahmed', 'well') === true);
      assert(await user.authenticate(db, 'ahmed', 'x') === false);
      assert(await user.authenticate(db, 'z', 'x') === false);
    }

    {
      let story = sentence.getOrCreateStory(db, "Nail");
      console.log('init')
      console.dir(story, {depth: null});

      if (story) {
        story = sentence.addSentences(db, story, 0, [
          {ja: ['x'], en: 'x'},
          {ja: ['z'], en: 'z'},
          {ja: ['x'], en: 'x'},
        ]);
        console.log('after adding')
        console.dir(story, {depth: null});
      }
    }
    {
      const story = sentence.getOrCreateStory(db, "Nail");
      console.log('init')
      console.dir(story, {depth: null});
      if (story) {
        sentence.addSentences(db, story, 99999, [
          {ja: ['owari'], en: 'the end'},
          {ja: ['lol'], en: 'lol'},
        ]);
        console.log('after adding')
        console.dir(story, {depth: null});
      }
    }
    {}
  })();
}