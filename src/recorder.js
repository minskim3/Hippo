import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} from '@discordjs/voice';
import prism from 'prism-media';
import { config } from './config.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
// 이보다 짧은 소리는 버림. 13차 회의에서 2초 미만이 777개(전체 67%)였지만 대부분 "네"·잡음·오인식이었다.
// 의견·반박은 보통 2초를 넘는다. STT 요청 수를 줄이려고 짧은 맞장구는 포기한다.
const MIN_UTTERANCE_MS = 2000;
const SILENCE_END_MS = 1000; // 1초 침묵이면 발화 하나가 끝난 것으로 봄
const MAX_REJOIN = 5; // 음성 연결이 끊겼을 때 다시 들어가 보는 횟수
const EMPTY_END_MS = 5 * 60 * 1000; // 채널에 사람이 없는 채로 이만큼 지나면 회의를 자동으로 끝냄

/**
 * 음성 채널 하나에서 진행되는 회의 녹음.
 * 디스코드는 사용자별로 오디오를 따로 보내므로, "발화 단위"로 WAV 파일을 저장한다.
 * 파일명: <회의 시작 후 ms>-<userId>.wav → 시간순 정렬과 화자 구분이 저절로 됨.
 *
 * events: { onLost(message) 연결을 되살리지 못했을 때, onEmpty() 채널이 한동안 비었을 때 }
 */
export class MeetingRecorder {
  constructor(voiceChannel, { textChannelId, onLost = () => {}, onEmpty = () => {} } = {}) {
    this.channel = voiceChannel;
    this.textChannelId = textChannelId;
    this.onLost = onLost;
    this.onEmpty = onEmpty;
    this.startedAt = Date.now();
    this.id = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-');
    this.dir = path.join(config.recordingsDir, this.id);
    this.speakers = {}; // userId -> 표시 이름 (목소리가 녹음된 사람)
    this.attendees = {}; // userId -> 표시 이름 (말을 안 했어도 회의 중 음성 채널에 들어왔던 사람)
    this.activeStreams = new Map(); // userId -> AudioReceiveStream
    this.pendingWrites = new Set();
    this.stopped = false;
    this.emptyTimer = null;
    this.onVoiceState = (before, after) => {
      if (after.channelId === this.channel.id) this.#addAttendee(after.member);
      if (before.channelId === this.channel.id || after.channelId === this.channel.id) this.#checkEmpty();
    };
  }

  async start() {
    await fs.mkdir(this.dir, { recursive: true });

    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false, // 들어야 녹음할 수 있음
      selfMute: true,
    });
    // error를 받는 쪽이 없으면 Node가 프로세스를 끈다. 끊김 자체는 Disconnected 처리에서 되살린다.
    this.connection.on('error', (err) => console.warn('[recorder] 음성 연결 오류:', err.message));
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      // 반쯤 열린 연결이 남으면 다음 /회의시작이 그 연결을 재사용해 꼬인다.
      this.connection.destroy();
      throw err;
    }

    this.connection.receiver.speaking.on('start', (userId) => this.#onSpeakingStart(userId));
    this.connection.on(VoiceConnectionStatus.Disconnected, () => this.#onDisconnected());

    // 시작할 때 채널에 있던 사람과, 회의 중에 들어온 사람을 참석자로 기록한다.
    for (const member of this.channel.members.values()) this.#addAttendee(member);
    this.channel.client.on('voiceStateUpdate', this.onVoiceState);
    this.#writeMeta(); // 봇이 회의 중에 꺼져도 녹음을 처리할 수 있게 시작하자마자 남긴다
  }

  #addAttendee(member) {
    if (!member || member.user.bot || this.attendees[member.id]) return;
    this.attendees[member.id] = member.displayName;
    if (this.connection) this.#writeMeta();
  }

  // 사람이 다 나가면 타이머를 걸고, 누가 다시 들어오면 취소한다. /회의종료를 잊어도 녹음이 끝없이 이어지지 않게.
  #checkEmpty() {
    if (this.stopped) return;
    const humans = this.channel.members.filter((m) => !m.user.bot).size;
    if (humans > 0) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    } else if (!this.emptyTimer) {
      this.emptyTimer = setTimeout(() => this.onEmpty(), EMPTY_END_MS);
    }
  }

  // 네트워크·디스코드 음성 서버 문제로 끊기면 스스로 다시 붙어 본다. 끝내 안 되면 알린다.
  async #onDisconnected() {
    if (this.stopped) return;
    try {
      // 음성 서버 이동처럼 곧 다시 붙는 경우
      await Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      return;
    } catch {}
    for (let attempt = 1; attempt <= MAX_REJOIN && !this.stopped; attempt++) {
      console.warn(`[recorder] 음성 연결 끊김, 다시 연결 시도 ${attempt}/${MAX_REJOIN}`);
      try {
        this.connection.rejoin();
        await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
        console.warn('[recorder] 음성 연결 복구');
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
      }
    }
    if (!this.stopped) {
      this.onLost(
        `⚠️ 음성 연결이 끊겨 다시 연결하지 못했어요. 지금부터는 녹음되지 않아요.\n` +
          '`/회의종료`를 입력하면 여기까지 녹음된 내용으로 회의록을 만들고, 그다음 `/회의시작`으로 다시 녹음할 수 있어요.',
      );
    }
  }

  #onSpeakingStart(userId) {
    if (this.activeStreams.has(userId)) return;

    const member = this.channel.guild.members.cache.get(userId);
    if (member?.user.bot) return;
    if (!this.speakers[userId]) {
      this.speakers[userId] = member?.displayName ?? userId;
      this.#writeMeta();
    }

    const offsetMs = Date.now() - this.startedAt;
    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
    });
    this.activeStreams.set(userId, opusStream);

    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });
    const chunks = [];
    opusStream.pipe(decoder);
    decoder.on('data', (chunk) => chunks.push(chunk));

    const done = new Promise((resolve) => {
      decoder.once('end', resolve);
      decoder.once('error', (err) => {
        console.warn(`[recorder] ${userId} 디코딩 오류:`, err.message);
        resolve();
      });
    }).then(async () => {
      this.activeStreams.delete(userId);
      const pcm = Buffer.concat(chunks);
      const durationMs = (pcm.length / (SAMPLE_RATE * CHANNELS * 2)) * 1000;
      if (durationMs < MIN_UTTERANCE_MS) return;
      const file = path.join(this.dir, `${String(offsetMs).padStart(9, '0')}-${userId}.wav`);
      await fs.writeFile(file, toWav(pcm));
    });

    this.pendingWrites.add(done);
    done.finally(() => this.pendingWrites.delete(done));
  }

  // 동기 쓰기: 여러 이벤트가 겹쳐도 파일이 섞이지 않는다. endedAt이 없으면 "녹음 중(또는 중단됨)"이라는 뜻.
  #writeMeta(endedAt = null) {
    writeFileSync(
      path.join(this.dir, 'meta.json'),
      JSON.stringify(
        {
          channelName: this.channel.name,
          textChannelId: this.textChannelId,
          startedAt: new Date(this.startedAt).toISOString(),
          endedAt,
          speakers: this.speakers,
          attendees: { ...this.attendees, ...this.speakers },
        },
        null,
        2,
      ),
    );
  }

  /** 녹음을 끝내고 회의 폴더 경로를 돌려준다. */
  async stop() {
    this.stopped = true;
    clearTimeout(this.emptyTimer);
    for (const stream of this.activeStreams.values()) stream.push(null); // 말하는 중인 스트림도 끝냄
    await Promise.all(this.pendingWrites);
    this.channel.client.off('voiceStateUpdate', this.onVoiceState);
    this.connection.destroy();
    this.#writeMeta(new Date().toISOString());
    return this.dir;
  }
}

/**
 * 봇이 회의 중에 꺼져서 끝나지 않은 녹음 폴더(meta.json에 endedAt이 없음)를 찾아,
 * 마지막 발화 파일 시각을 종료 시각으로 적고 돌려준다. 녹음 중인 회의가 없는 봇 시작 시에만 부른다.
 */
export async function closeInterruptedMeetings() {
  const closed = [];
  let names = [];
  try {
    names = await fs.readdir(config.recordingsDir);
  } catch {
    return closed;
  }
  for (const name of names) {
    const dir = path.join(config.recordingsDir, name);
    const metaFile = path.join(dir, 'meta.json');
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    } catch {
      continue;
    }
    if (meta.endedAt) continue;
    const wavs = (await fs.readdir(dir)).filter((f) => f.endsWith('.wav'));
    const times = await Promise.all(wavs.map(async (f) => (await fs.stat(path.join(dir, f))).mtimeMs));
    meta.endedAt = new Date(times.length ? Math.max(...times) : Date.parse(meta.startedAt)).toISOString();
    meta.interrupted = true;
    await fs.writeFile(metaFile, JSON.stringify(meta, null, 2));
    closed.push({ folder: name, meta, utterances: wavs.length });
  }
  return closed;
}

function toWav(pcm) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
