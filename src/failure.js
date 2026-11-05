// 오류 → 팀원이 읽을 한 줄 설명. 왜 멈췄고, 다시 시도하면 되는지 아니면 무엇을 해야 하는지를 쓴다.
export function failureReason(err) {
  const notion = err.message.match(/^Notion API (\d+)/);
  if (notion) {
    const status = Number(notion[1]);
    if (status === 401 || status === 403 || status === 404) return '노션 연결 권한이 없거나 올릴 페이지를 찾지 못했어요. 노션 통합 연결을 확인한 뒤 다시 시도하세요.';
    if (status === 429 || status >= 500) return '노션 서버가 바쁘거나 오류가 났어요. 잠시 후 다시 시도하세요.';
    return `노션이 요청을 거절했어요(${status}). 아래 자세한 오류를 개발자에게 알려 주세요.`;
  }
  switch (err.status) {
    case 429:
      return 'OpenRouter에 요청이 몰려 잠시 막혔어요. 잔액 문제는 아니에요. 1~2분 뒤 다시 시도하세요.';
    case 402:
      return 'OpenRouter 잔액이 부족해요. 충전한 뒤 다시 시도하세요.';
    case 403:
      return 'OpenRouter 키 한도나 워크스페이스 월 예산을 넘었어요. 한도를 올린 뒤 다시 시도하세요.';
    case 401:
      return 'OpenRouter API 키가 잘못됐거나 만료됐어요. .env의 키를 확인하세요.';
    case 413:
      return '한 사람이 쉬지 않고 너무 길어서 녹음 파일 하나가 받아쓰기 한도를 넘었어요. 다시 시도해도 같아요. 개발자에게 알려 주세요.';
    case 404:
      return '설정된 AI 모델을 찾지 못했어요. .env의 모델 이름(STT_MODEL·SUMMARY_MODELS·BRAIN_MODEL)을 확인하세요.';
    case 400:
      return 'OpenRouter가 요청을 거절했어요. 다시 시도해도 같을 수 있어요. 아래 자세한 오류를 개발자에게 알려 주세요.';
  }
  if (err.status >= 500 || err.name === 'APIConnectionError' || err.name === 'APIConnectionTimeoutError') {
    return 'OpenRouter나 모델 서버에 일시적인 문제가 있어요. 잠시 후 다시 시도하세요.';
  }
  if (/^회의록 (JSON을 해석하지|형식이 올바르지)/.test(err.message)) {
    return 'AI가 회의록을 잘못된 형식으로 돌려줬어요. 다시 시도하면 대부분 해결돼요.';
  }
  if (err.name === 'AbortError') {
    return '음성 채널에 들어가지 못했어요. 봇에 채널 연결 권한이 있는지 확인하고 `/회의시작`을 다시 입력하세요.';
  }
  if (err.message === '녹음된 발화가 없습니다.') return '녹음된 말소리가 없어요. 다시 시도해도 결과는 같아요.';
  return '예상하지 못한 오류예요. 다시 시도해 보고, 또 실패하면 아래 자세한 오류를 개발자에게 알려 주세요.';
}

// 다시 시도해도 결과가 같은 오류(녹음 자체의 문제)면 false. 이때는 다시 시도 버튼을 붙이지 않는다.
export function canRetry(err) {
  return err.status !== 413 && err.message !== '녹음된 발화가 없습니다.';
}
