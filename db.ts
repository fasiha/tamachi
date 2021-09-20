import sqlite3 from 'better-sqlite3';
import crypto from 'crypto';
import {string} from 'fp-ts';
import {readFileSync} from 'fs';
// import * as t from 'io-ts';
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
  })();
}