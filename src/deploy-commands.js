import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';

// 길드(서버) 단위로 등록하면 바로 반영된다. 전역 등록은 반영까지 시간이 걸림.
const rest = new REST().setToken(config.discord.token());
await rest.put(Routes.applicationGuildCommands(config.discord.clientId(), config.discord.guildId()), {
  body: commands,
});
console.log(`슬래시 커맨드 ${commands.length}개를 등록했습니다.`);
