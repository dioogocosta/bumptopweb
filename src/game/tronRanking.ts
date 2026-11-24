/**
 * Cliente para Ranking e Nickname do TRON Light Cycles (`/api/tron-ranking`).
 * Só opera quando o usuário está autenticado (BumpTop Cloud ou Taiga).
 */

import { t } from '@core/i18n/i18n';

export interface TronRankEntry {
  rank: number;
  userId: string;
  nickname: string;
  bestScore: number;
  maxLevel: number;
  isMe: boolean;
}

export interface TronRankingResponse {
  me: {
    userId: string;
    nickname: string;
    bestScore: number;
    maxLevel: number;
  } | null;
  ranking: TronRankEntry[];
}

const NICK_KEY = 'bumptop.tron.nickname';
const LOCAL_BEST_KEY = 'bumptop.tron.localBest';

export function getSavedTronNickname(): string {
  try {
    return localStorage.getItem(NICK_KEY) || '';
  } catch {
    return '';
  }
}

export function saveTronNickname(nick: string): void {
  try {
    const clean = nick.trim().slice(0, 20);
    if (clean) localStorage.setItem(NICK_KEY, clean);
  } catch {
    // ignore storage errors
  }
}

function buildHeaders(taigaToken?: string | null, taigaName?: string | null): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (taigaToken) {
    headers['Authorization'] = `Bearer ${taigaToken}`;
  }
  if (taigaName) {
    headers['X-Taiga-Name'] = taigaName;
  }
  return headers;
}

export async function fetchTronRanking(opts?: {
  taigaToken?: string | null;
  taigaName?: string | null;
}): Promise<TronRankingResponse | null> {
  try {
    const res = await fetch('/api/tron-ranking', {
      method: 'GET',
      credentials: 'same-origin',
      headers: buildHeaders(opts?.taigaToken, opts?.taigaName),
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 503) {
        return getLocalFallbackRanking(opts?.taigaName);
      }
      return null;
    }
    const data = (await res.json()) as TronRankingResponse;
    if (data.me?.nickname) saveTronNickname(data.me.nickname);
    return data;
  } catch {
    return getLocalFallbackRanking(opts?.taigaName);
  }
}

export async function submitTronScore(opts: {
  nickname?: string;
  score: number;
  level: number;
  taigaToken?: string | null;
  taigaName?: string | null;
}): Promise<TronRankingResponse | null> {
  if (opts.nickname) saveTronNickname(opts.nickname);
  try {
    const res = await fetch('/api/tron-ranking', {
      method: 'POST',
      credentials: 'same-origin',
      headers: buildHeaders(opts.taigaToken, opts.taigaName),
      body: JSON.stringify({
        nickname: opts.nickname,
        score: opts.score,
        level: opts.level,
      }),
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 503) {
        return saveLocalFallbackScore(opts.nickname || opts.taigaName || 'Piloto', opts.score, opts.level);
      }
      return null;
    }
    const data = (await res.json()) as TronRankingResponse;
    if (data.me?.nickname) saveTronNickname(data.me.nickname);
    return data;
  } catch {
    return saveLocalFallbackScore(opts.nickname || opts.taigaName || 'Piloto', opts.score, opts.level);
  }
}

function getLocalFallbackRanking(defaultName?: string | null): TronRankingResponse | null {
  try {
    const raw = localStorage.getItem(LOCAL_BEST_KEY);
    const nick = getSavedTronNickname() || defaultName?.trim().slice(0, 20) || 'Piloto';
    if (!raw) return { me: null, ranking: [] };
    const parsed = JSON.parse(raw) as { nickname?: string; bestScore?: number; maxLevel?: number };
    const bestScore = Number(parsed.bestScore) || 0;
    const maxLevel = Number(parsed.maxLevel) || 1;
    const finalNick = parsed.nickname || nick;
    const me = { userId: 'local', nickname: finalNick, bestScore, maxLevel };
    return {
      me,
      ranking: [{ rank: 1, ...me, isMe: true }],
    };
  } catch {
    return null;
  }
}

function saveLocalFallbackScore(nick: string, score: number, level: number): TronRankingResponse | null {
  try {
    const prev = getLocalFallbackRanking(nick);
    const bestScore = Math.max(prev?.me?.bestScore ?? 0, Math.floor(score));
    const maxLevel = Math.max(prev?.me?.maxLevel ?? 1, Math.floor(level));
    const cleanNick = nick.trim().slice(0, 20) || 'Piloto';
    localStorage.setItem(LOCAL_BEST_KEY, JSON.stringify({ nickname: cleanNick, bestScore, maxLevel }));
    const me = { userId: 'local', nickname: cleanNick, bestScore, maxLevel };
    return {
      me,
      ranking: [{ rank: 1, ...me, isMe: true }],
    };
  } catch {
    return null;
  }
}

/** Renderiza a tabela de Ranking TRON compartilhada entre Game Grid e Fim de Jogo. */
export function renderTronRankingBox(container: HTMLElement, data: TronRankingResponse | null): void {
  container.textContent = '';

  const title = document.createElement('div');
  title.className = 'tron-ranking-title';
  title.textContent = `🏆 ${t('ui.tron.rankingTitle')}`;
  container.appendChild(title);

  if (data?.me) {
    const meBest = document.createElement('div');
    meBest.className = 'tron-ranking-me-best';
    meBest.textContent = t('ui.tron.personalBest', {
      score: data.me.bestScore,
      level: data.me.maxLevel,
    });
    container.appendChild(meBest);
  }

  if (!data || data.ranking.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tron-ranking-empty';
    empty.textContent = t('ui.tron.noRanking');
    container.appendChild(empty);
    return;
  }

  const table = document.createElement('div');
  table.className = 'tron-ranking-table';

  const head = document.createElement('div');
  head.className = 'tron-ranking-row head';
  head.innerHTML =
    `<span>${t('ui.tron.colPos')}</span>` +
    `<span>${t('ui.tron.colPilot')}</span>` +
    `<span>${t('ui.tron.colLevel')}</span>` +
    `<span>${t('ui.tron.colScore')}</span>`;
  table.appendChild(head);

  for (const r of data.ranking.slice(0, 10)) {
    const row = document.createElement('div');
    row.className = r.isMe ? 'tron-ranking-row me' : 'tron-ranking-row';

    const cPos = document.createElement('span');
    cPos.textContent = r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1]! : `${r.rank}º`;

    const cNick = document.createElement('span');
    cNick.className = 'tron-ranking-nick';
    cNick.textContent = r.nickname;

    const cLvl = document.createElement('span');
    cLvl.textContent = `Nív. ${r.maxLevel}`;

    const cScore = document.createElement('span');
    cScore.className = 'tron-ranking-score';
    cScore.textContent = String(r.bestScore);

    row.append(cPos, cNick, cLvl, cScore);
    table.appendChild(row);
  }

  container.appendChild(table);
}
