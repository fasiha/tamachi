const {PollyClient, SynthesizeSpeechCommand} = require("@aws-sdk/client-polly");
import {Stream} from 'stream';
import {writeFile} from 'fs/promises';

export type Engine = 'standard'|'neural';
export interface Voice {
  name: string;
  language: 'ja'|'en';
  engine: Engine;
}
export const PREFERRED_JAPANESE_VOICES: Voice[] = [
  {name: 'Mizuki', language: 'ja', engine: 'standard'},
  {name: 'Takumi', language: 'ja', engine: 'standard'},
];
export const PREFERRED_ENGLISH_VOICES: Voice[] = [
  {name: 'Joanna', language: 'en', engine: 'neural'},
];

interface Args {
  aws_region: string;
  aws_access_key_id: string;
  aws_secret_access_key: string;
  voice: string;
  text: string;
  path?: string;
  engine?: Engine;
}
export async function textToAudioBase64({
  text,
  voice,
  aws_region,
  aws_access_key_id,
  aws_secret_access_key,
  path,
  engine = 'standard',
}: Args): Promise<string> {
  const polly = new PollyClient({
    region: aws_region,
    credentials: {accessKeyId: aws_access_key_id, secretAccessKey: aws_secret_access_key},
  });
  const response = await polly.send(new SynthesizeSpeechCommand({
    VoiceId: voice,
    OutputFormat: 'mp3',
    Engine: engine,
    Text: text,
  }));
  const buf = await audioStreamToBuffer(response.AudioStream);
  if (path) {
    writeFile(path, buf).catch(e => console.error('unable to save audio', e)); // don't await here
  }
  const base64 = buf.toString('base64');
  return `data:${response.ContentType};base64,${base64}`;
}

function audioStreamToBuffer(stream: Stream): Promise<Buffer> {
  const chunks: any[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('close', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (e) => reject(e))
  });
}

if (require.main === module) {
  require('dotenv').config();
  (async function main() {
    var fs = require('fs');
    const aws_region = process.env['aws_region'];
    const aws_access_key_id = process.env['aws_access_key_id'];
    const aws_secret_access_key = process.env['aws_secret_access_key'];
    if (!(aws_region && aws_access_key_id && aws_secret_access_key)) {
      throw new Error('invalid .env or missing environment variables');
    }
    const aws = {aws_region, aws_access_key_id, aws_secret_access_key};
    {
      const encoded: string = await textToAudioBase64({
        ...aws,
        text: 'Kevin is neural',
        voice: "Kevin",
        path: 'test2.mp3',
        engine: 'neural',
      });
      fs.writeFileSync('test2.html', `<audio controls src="${encoded}"></audio>`);
      console.log('check test2.mp3 and test2.html');
    }
    {
      const encoded: string = await textToAudioBase64({
        ...aws,
        text: '田中と鈴木',
        voice: "Mizuki",
        path: 'test.mp3',
      });
      fs.writeFileSync('test.html', `<audio controls src="${encoded}"></audio>`);
      console.log('check test.mp3 and test.html');
    }
  })();
}