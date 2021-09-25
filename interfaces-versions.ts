import * as t from 'io-ts';

export namespace v1 {
  export const version = 1;
  export const User = t.type({
    id: t.number,
    name: t.string,
  });
  export type User = t.TypeOf<typeof User>;

  export const Ruby = t.type({rt: t.string, ruby: t.string});
  export const Word = t.union([Ruby, t.string]);
  export type Word = t.TypeOf<typeof Word>;
  export const Words = t.array(Word);
  export type Words = t.TypeOf<typeof Words>;

  export const Audio = t.type({
    language: t.string,
    speaker: t.string,
    base64: t.string,
    created: t.number,
  });

  export const Sentence = t.type({
    id: t.number,
    ja: Words,
    jaHint: t.string,
    en: t.string,
    audio: t.type({en: t.array(Audio), ja: t.array(Audio)}),
  });
  export type Sentence = t.TypeOf<typeof Sentence>;

  // for db-only things (like sort)
  const WithMeta = t.type({_meta: t.unknown});
  export const Story = t.intersection([
    t.type({
      id: t.number,
      title: t.string,
      sentences: t.array(Sentence),
    }),
    WithMeta,
  ]);
  export type Story = t.TypeOf<typeof Story>;

  export const ReviewType = t.union([t.literal('quizresult'), t.literal('probability')]);
  export const ReviewResult = t.type({
    initial: t.boolean,
    type: ReviewType,
    value: t.number,
  });
  export const Review = t.type({
    id: t.number,
    userId: t.number,
    sentenceId: t.number,
    created: t.number,
    result: ReviewResult,
    ebisu: t.array(t.number),
    halflife: t.number,
  });
  export type Review = t.TypeOf<typeof Review>;
  export type ReviewResult = t.TypeOf<typeof ReviewResult>;
  export type ReviewType = t.TypeOf<typeof ReviewType>;
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
