import OpenAI from 'openai';
import { config } from './config.js';

// OpenRouter는 OpenAI 호환 API라서 OpenAI SDK에 주소만 바꿔 쓴다.
export const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: config.openrouter.apiKey(),
  defaultHeaders: { 'X-Title': 'moamap-secretary' },
});
