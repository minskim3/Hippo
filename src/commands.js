import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('회의시작').setDescription('지금 있는 음성 채널에서 회의 녹음을 시작합니다'),
  new SlashCommandBuilder().setName('회의종료').setDescription('녹음을 끝내고 회의록을 노션에 올립니다'),
  new SlashCommandBuilder()
    .setName('물어보기')
    .setDescription('노션·GitHub 이슈·회의록에서 찾아 답해 드려요')
    .addStringOption((o) => o.setName('질문').setDescription('예: 카테고리 칩 몇 개로 정했어?').setRequired(true)),
].map((command) => command.toJSON());
