import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 녹음 파일이 실제 recordings/에 쌓이지 않게 임시 폴더를 쓴다. config.js가 읽기 전에 정해야 한다.
process.env.RECORDINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-test-'));

// 디스코드 음성 라이브러리를 가짜로 바꾼다. 테스트마다 connection/enterReady를 바꿔 상황을 만든다.
let connection;
let enterReady; // entersState가 호출될 때 실행할 함수
mock.module('@discordjs/voice', {
  namedExports: {
    joinVoiceChannel: () => connection,
    entersState: () => enterReady(),
    VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected', Signalling: 'signalling', Connecting: 'connecting' },
    EndBehaviorType: { AfterSilence: 1 },
  },
});
const { MeetingRecorder } = await import('../src/recorder.js');

function fakeConnection() {
  return Object.assign(new EventEmitter(), { receiver: { speaking: new EventEmitter() }, destroy: mock.fn() });
}

function fakeVoiceChannel() {
  return {
    id: 'voice-1',
    name: '일반',
    guild: { id: 'guild-1', voiceAdapterCreator: () => {}, members: { cache: new Map() } },
    members: new Map(),
    client: new EventEmitter(),
  };
}

test('음성 연결에서 error 이벤트가 나도 봇이 죽지 않는다', async () => {
  connection = fakeConnection();
  enterReady = async () => {};
  await new MeetingRecorder(fakeVoiceChannel()).start();

  // error를 받는 쪽이 없으면 emit이 예외를 던져 프로세스 전체가 꺼진다.
  assert.doesNotThrow(() => connection.emit('error', new Error('UDP socket closed')));
});

test('음성 채널 연결에 실패하면 반쯤 열린 연결을 정리한다', async () => {
  connection = fakeConnection();
  enterReady = async () => { throw new Error('timeout'); };

  await assert.rejects(new MeetingRecorder(fakeVoiceChannel()).start(), /timeout/);
  assert.equal(connection.destroy.mock.callCount(), 1);
});
