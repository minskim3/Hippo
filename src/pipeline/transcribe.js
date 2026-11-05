import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { openrouter } from '../openrouter.js';
import { speakerName } from '../members.js';
import { saveCost } from './cost.js';

const CONCURRENCY = 2; // 동시에 보내는 STT 요청 수. 너무 많으면 OpenRouter가 429(잔액 확인 지연)로 막는다.
const MAX_RETRIES = 8; // 429·5xx는 OpenAI SDK가 retry-after만큼 기다렸다가 다시 보낸다.

/**
 * 회의 폴더의 발화 WAV들을 시간순으로 전사해 하나의 대본으로 합친다.
 * 결과는 transcript.md로도 저장해 두어, 이후 단계가 실패해도 다시 전사하지 않게 한다.
 */
export async function transcribeMeeting(dir) {
  const cached = path.join(dir, 'transcript.md');
  if (fs.existsSync(cached)) return fsp.readFile(cached, 'utf8');

  const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.wav')).sort();
  // 파일별 전사 결과를 바로바로 저장해 두어, 중간에 실패해도 다시 돌릴 때 남은 파일만 보낸다.
  const partialPath = path.join(dir, 'stt-partial.json');
  const partial = fs.existsSync(partialPath) ? JSON.parse(await fsp.readFile(partialPath, 'utf8')) : {};

  // 파일 순서(= 시간순) 자리에 결과를 채워 넣으므로, 끝나는 순서와 상관없이 대본 순서가 유지된다.
  const lines = new Array(files.length);
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const i = next++;
      const [offset, userId] = path.basename(files[i], '.wav').split('-');
      if (partial[files[i]] === undefined) {
        const { text, usage } = await transcribeFile(path.join(dir, files[i]));
        partial[files[i]] = { text, seconds: usage?.seconds ?? 0, cost: usage?.cost ?? 0 };
        fs.writeFileSync(partialPath, JSON.stringify(partial)); // 동기 쓰기라 여러 작업자가 동시에 써도 파일이 섞이지 않는다
      }
      const cleaned = removeHallucinations(partial[files[i]].text);
      if (cleaned) lines[i] = `[${formatOffset(Number(offset))}] ${speakerName(userId, meta)}: ${cleaned}`;
    }
  }
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } catch (err) {
    // 디스코드 실패 안내에 "몇 개까지 됐는지"를 보여 주려고 진행 상황을 붙인다.
    err.progress = { done: Object.keys(partial).length, total: files.length };
    throw err;
  }

  const transcript = lines.filter(Boolean).join('\n');
  const results = Object.values(partial);
  await saveCost(dir, 'stt', {
    model: config.openrouter.sttModel,
    files: files.length,
    audioMinutes: Math.round(results.reduce((sum, r) => sum + r.seconds, 0) / 6) / 10,
    cost: results.reduce((sum, r) => sum + r.cost, 0),
  });
  await fsp.writeFile(cached, transcript);
  await fsp.rm(partialPath, { force: true });
  return transcript;
}

// SDK 재시도(짧은 간격)를 다 써도 OpenRouter가 429로 계속 막을 때가 있어, 30초씩 쉬었다가 몇 번 더 보낸다.
async function transcribeFile(file) {
  for (let attempt = 1; ; attempt++) {
    try {
      // OpenRouter가 usage에 들은 시간(초)과 실제 비용(달러)을 알려 준다.
      return await openrouter.audio.transcriptions.create(
        { file: fs.createReadStream(file), model: config.openrouter.sttModel, language: 'ko' },
        { maxRetries: MAX_RETRIES },
      );
    } catch (err) {
      if (err.status !== 429 || attempt >= 10) throw err;
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
}

// Whisper는 무음·잡음 구간에서 유튜브 자막에 흔한 문구를 지어내는 경우가 많다.
// 실제로 말했을 수도 있으므로, 발화의 맨 앞이나 맨 뒤에 문장 하나로 따로 떨어져 있을 때만 지운다.
const HALLUCINATION_PATTERNS = [
  /^(감사합니다|고맙습니다)$/,
  /^시청(해주셔서|해주신여러분|해주셔서진심으로)?감사(합니다|드립니다)$/,
  /^구독(과|이랑)?좋아요/,
  /^(다음|다음에|다음영상에서)(또)?만나요$/,
  /^(한국어|한글)?자막(제공|by)/i,
];

function isHallucination(sentence) {
  const normalized = sentence.replace(/[\s.,!?…~"'·]/g, '');
  return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function removeHallucinations(text) {
  const sentences = text.trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  while (sentences.length && isHallucination(sentences[0])) sentences.shift();
  while (sentences.length && isHallucination(sentences.at(-1))) sentences.pop();
  return sentences.join(' ');
}

function formatOffset(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
