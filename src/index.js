import fs from 'node:fs';
import path from 'node:path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { MeetingRecorder, closeInterruptedMeetings } from './recorder.js';
import { processMeeting, STEPS } from './pipeline/index.js';
import { buildSummaryEmbed, buildAnswerEmbed } from './summary-embed.js';
import { failureReason, canRetry } from './failure.js';
import { askBrain } from './brain/ask.js';
import { syncBrain } from './brain/sync.js';
import { loadWikiState } from './brain/wiki.js';
import { updateWiki } from './brain/wiki-update.js';
import { lintWiki } from './brain/wiki-lint.js';

// 봇이 두 개 켜지면 같은 명령을 둘이 동시에 받아 "Unknown interaction"으로 죽는다. 이미 켜져 있으면 시작하지 않는다.
const PID_FILE = '.bot.pid';
if (fs.existsSync(PID_FILE)) {
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {}
  if (alive) {
    console.error(`봇이 이미 켜져 있습니다(PID ${pid}). 다시 켜려면 먼저 끄세요: kill ${pid}`);
    process.exit(1);
  }
}
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => {
  if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8') === String(process.pid)) fs.rmSync(PID_FILE);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));

// 예상 못 한 오류 하나로 녹음 중인 봇 전체가 꺼지지 않게, 기록만 하고 계속 돈다.
process.on('unhandledRejection', (err) => console.error('[bot] 처리 안 된 오류:', err));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const meetings = new Map(); // guildId -> MeetingRecorder

const HOUR = 60 * 60 * 1000;
const WIKI_LINT_INTERVAL = 7 * 24 * HOUR;

// 1시간마다 노션·GitHub·회의 대본을 다시 모으고, 때가 되면 위키 반영(하루 1번)과 점검(주 1번)을 한다.
let brainRunning = false;
async function brainJobs() {
  if (brainRunning) return;
  brainRunning = true;
  try {
    await syncBrain();
    const state = loadWikiState();
    const since = (time) => (time ? Date.now() - Date.parse(time) : Infinity);
    if (state.pending.length && since(state.lastUpdate) >= config.brain.wikiUpdateHours * HOUR) await updateWiki();
    if (config.brain.wikiReportChannelId && since(state.lastLint) >= WIKI_LINT_INTERVAL) {
      const report = await lintWiki();
      const channel = await client.channels.fetch(config.brain.wikiReportChannelId);
      for (const part of splitMessage(report)) await channel.send(part);
    }
  } catch (err) {
    console.error('[brain] 작업 실패:', err);
  } finally {
    brainRunning = false;
  }
}

// 디스코드 메시지는 2000자까지라 긴 보고는 줄 단위로 나눠 보낸다.
function splitMessage(text, limit = 2000) {
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > limit) {
      parts.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line.slice(0, limit);
  }
  if (current.trim()) parts.push(current);
  return parts;
}

client.once(Events.ClientReady, (c) => {
  console.log(`${c.user.tag} 로그인 완료`);
  announceInterruptedMeetings();
  brainJobs();
  setInterval(brainJobs, HOUR);
});

client.on(Events.Error, (err) => console.error('[discord] 오류:', err));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guild) return;
  try {
    if (interaction.isButton() && interaction.customId.startsWith(RETRY_PREFIX)) await retryMeeting(interaction);
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === '회의시작') await startMeeting(interaction);
    if (interaction.commandName === '회의종료') await endMeeting(interaction);
    if (interaction.commandName === '물어보기') await ask(interaction);
  } catch (err) {
    console.error(err);
    // 오류를 알리는 답장 자체가 실패해도(상호작용 만료 등) 봇이 죽지 않게 한다.
    const content = `❌ ${failureReason(err)}\n-# 자세한 오류: ${err.message.replace(/\s+/g, ' ').slice(0, 200)}`;
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(content);
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (replyErr) {
      console.error('[bot] 오류 답장 실패:', replyErr.message);
    }
  }
});

// 디스코드 상호작용 답장은 15분이 지나면 수정할 수 없다. 긴 회의는 처리가 그보다 오래 걸리므로,
// 수정이 안 되면 같은 채널에 새 메시지로 보낸다.
async function reply(interaction, payload) {
  try {
    await interaction.editReply(payload);
  } catch (err) {
    try {
      await interaction.channel.send(payload);
    } catch (sendErr) {
      console.error('[bot] 메시지 전송 실패:', err.message, '/', sendErr.message);
    }
  }
}

const RETRY_PREFIX = 'retry-meeting:';
const processing = new Set(); // 지금 회의록을 만드는 중인 녹음 폴더 이름

// 녹음 폴더 → 회의록. 실패하면 "다시 시도" 버튼을 붙여, CLI 없이도 디스코드에서 다시 돌릴 수 있게 한다.
// 단계마다 결과가 저장되므로 다시 시도하면 실패한 곳부터 이어서 한다.
async function runPipeline(interaction, folder) {
  const dir = path.join(config.recordingsDir, folder);
  processing.add(folder);
  try {
    const result = await processMeeting(dir, (step) => interaction.editReply(`⏹️ 녹음 종료 · ${step}`).catch(() => {}));
    await reply(interaction, {
      content: `📝 회의록이 올라갔습니다: ${result.url}`,
      embeds: [buildSummaryEmbed(result)],
      components: [],
    });
  } catch (err) {
    console.error(err);
    const button = new ButtonBuilder().setCustomId(RETRY_PREFIX + folder).setLabel('다시 시도').setStyle(ButtonStyle.Primary);
    const components = canRetry(err) ? [new ActionRowBuilder().addComponents(button)] : [];
    await reply(interaction, { content: failureMessage(err), components });
  } finally {
    processing.delete(folder);
  }
}

// 실패 안내: 어느 단계에서, 왜 멈췄는지, 무엇을 하면 되는지를 사람이 읽을 수 있게 쓴다.
function failureMessage(err) {
  const lines = ['❌ **회의록을 만들지 못했어요.**'];
  if (err.step) {
    const progress = err.progress ? ` · ${err.progress.done.toLocaleString()}/${err.progress.total.toLocaleString()}개 완료(저장됨)` : '';
    lines.push(`**멈춘 단계:** ${STEPS[err.step]}${progress}`);
  }
  lines.push(`**원인:** ${failureReason(err)}`);
  if (canRetry(err)) lines.push('녹음과 지금까지 한 작업은 저장돼 있어서, **다시 시도**를 누르면 멈춘 곳부터 이어서 합니다.');
  lines.push(`-# 자세한 오류: ${err.message.replace(/\s+/g, ' ').slice(0, 200)}`);
  return lines.join('\n');
}

async function retryMeeting(interaction) {
  const folder = interaction.customId.slice(RETRY_PREFIX.length);
  // 버튼 값은 우리가 만든 폴더 이름(시각)뿐이어야 한다. 다른 경로로 새지 않게 형식을 확인한다.
  if (!/^[\w-]+$/.test(folder) || !fs.existsSync(path.join(config.recordingsDir, folder, 'meta.json'))) {
    return interaction.reply({ content: '녹음 폴더를 찾을 수 없습니다.', flags: MessageFlags.Ephemeral });
  }
  if ([...meetings.values()].some((recorder) => recorder.id === folder)) {
    return interaction.reply({ content: '아직 녹음 중인 회의입니다. `/회의종료`로 끝내 주세요.', flags: MessageFlags.Ephemeral });
  }
  if (processing.has(folder)) {
    return interaction.reply({ content: '이미 회의록을 만드는 중입니다.', flags: MessageFlags.Ephemeral });
  }
  await interaction.update({ content: '🔁 회의록을 다시 만드는 중...', components: [] });
  await runPipeline(interaction, folder);
}

async function startMeeting(interaction) {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: '먼저 음성 채널에 들어가 주세요.', flags: MessageFlags.Ephemeral });
  }
  if (meetings.has(interaction.guildId)) {
    return interaction.reply({ content: '이미 녹음 중인 회의가 있습니다.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();
  const guildId = interaction.guildId;
  const recorder = new MeetingRecorder(voiceChannel, {
    textChannelId: interaction.channelId,
    onLost: (message) => interaction.channel.send(message).catch((err) => console.error('[bot] 알림 실패:', err.message)),
    onEmpty: () => autoEndMeeting(guildId, interaction.channel),
  });
  await recorder.start();
  meetings.set(interaction.guildId, recorder);

  await interaction.editReply(
    `🔴 **${voiceChannel.name}** 채널의 회의 녹음을 시작합니다.\n` +
      '이 회의는 녹음되어 회의록 작성에 사용됩니다. 녹음을 원하지 않으면 지금 말씀해 주세요.\n' +
      '끝나면 `/회의종료`를 입력하세요.',
  );
}

async function endMeeting(interaction) {
  const recorder = meetings.get(interaction.guildId);
  if (!recorder) {
    return interaction.reply({ content: '진행 중인 회의가 없습니다.', flags: MessageFlags.Ephemeral });
  }
  meetings.delete(interaction.guildId);

  await interaction.deferReply();
  const dir = await recorder.stop();
  await interaction.editReply('⏹️ 녹음을 종료했습니다. 회의록을 만드는 중...');
  await runPipeline(interaction, path.basename(dir));
}

// 모두 나간 채로 몇 분이 지나면 /회의종료 없이도 녹음을 끝내고 회의록을 만든다.
async function autoEndMeeting(guildId, textChannel) {
  const recorder = meetings.get(guildId);
  if (!recorder) return;
  meetings.delete(guildId);
  const message = await textChannel.send('⏹️ 음성 채널이 5분 동안 비어 있어서 녹음을 자동으로 끝냈어요. 회의록을 만드는 중...');
  const dir = await recorder.stop();
  await runPipeline(messageTarget(message), path.basename(dir));
}

// 상호작용 없이 보낸 메시지도 runPipeline이 상호작용처럼 고쳐 쓸 수 있게 감싼다.
function messageTarget(message) {
  return { editReply: (payload) => message.edit(payload), channel: message.channel };
}

// 봇이 회의 중에 꺼졌던 녹음을 찾아, 회의를 시작한 채널에 "회의록 만들기" 버튼을 띄운다.
async function announceInterruptedMeetings() {
  try {
    for (const { folder, meta, utterances } of await closeInterruptedMeetings()) {
      console.warn(`[bot] 중단된 회의 발견: ${folder} (발화 ${utterances}개)`);
      if (!meta.textChannelId) continue;
      const channel = await client.channels.fetch(meta.textChannelId);
      const started = new Date(meta.startedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });
      const button = new ButtonBuilder().setCustomId(RETRY_PREFIX + folder).setLabel('회의록 만들기').setStyle(ButtonStyle.Primary);
      await channel.send({
        content:
          `⚠️ ${started}에 시작한 **#${meta.channelName}** 회의 녹음이 봇이 꺼지면서 중단됐어요.\n` +
          `꺼지기 전까지 녹음된 발화 ${utterances}개는 저장돼 있어요. 아래 버튼을 누르면 그 내용으로 회의록을 만들어요.`,
        components: [new ActionRowBuilder().addComponents(button)],
      });
    }
  } catch (err) {
    console.error('[bot] 중단된 회의 알림 실패:', err);
  }
}

async function ask(interaction) {
  const question = interaction.options.getString('질문', true);
  await interaction.deferReply();
  const { answer, sources } = await askBrain(question);
  await interaction.editReply({ embeds: [buildAnswerEmbed(question, answer, sources)] });
}

client.login(config.discord.token());
