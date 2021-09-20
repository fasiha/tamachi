import * as t from 'io-ts';

export namespace v1 {
  export const version = 1;
  export const User = t.type({
    id: t.number,
    name: t.string,
    // hashed: t.string,
    // salt: t.string,
  });

  export const Ruby = t.type({rt: t.string, ruby: t.string});
  export const Word = t.union([Ruby, t.string]);

  export const Sentence = t.type({
    id: t.number,
    // ja: t.string,
    ja: t.array(Word),
    en: t.string,
  });

  export const Audio = t.type({
    id: t.number,
    sentenceId: t.number,
    language: t.string,
    speaker: t.string,
    base64: t.string,
  });

  export const Review = t.type({
    id: t.number,
    userId: t.number,
    sentenceId: t.number,
    epoch: t.number,
    results: t.unknown,
  });
}

export namespace vDemo {
  export const version = v1.version + 1; // Updated
  export const Sentence = v1.Sentence;   // Same
  export const User = t.type({
    id: t.number,
    name: t.string,
    passDigest: t.string,
    created: t.number, // Updated
  });

}
