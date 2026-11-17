/**
 * PR27 — sonda de validação: login com Cloudflare D1 + persistência na nuvem.
 *
 *   BASE_URL=http://localhost:4173 node scripts/validate-pr27.mjs
 *
 * Testes A/B/D rodam em QUALQUER ambiente (modo degradação: sem API o app
 * segue 100% funcional). O teste C (fluxo real na nuvem: signup → sync →
 * logout → login → cena restaurada) só roda se /api/session responder —
 * local (wrangler pages dev) ou produção com D1 configurado.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resultados = [];
let falhas = 0;

function ok(nome, detalhe, pass) {
  resultados.push({ nome, detalhe, pass });
  if (!pass) falhas++;
  console.log(`[${pass ? 'ok' : 'FALHA'}] ${nome} :: ${detalhe}`);
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'pt-BR' });
  const page = await ctx.newPage();
  const errosConsole = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errosConsole.push(m.text());
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__bumptop, null, { timeout: 30000 });
  await sleep(1500);

  // ------------------------------------------------------------------ A
  // Botão de conta existe; modal abre com e-mail/senha; alterna criar conta;
  // fecha com ✕. App continua funcional (modo sem login).
  const baseObjs = await page.evaluate(() => window.__bumptop.world.listObjects().length);
  ok('P27a-objetos', `cena carregou com ${baseObjs} objetos`, baseObjs >= 3);
  const temBtn = (await page.locator('.auth-btn').count()) === 1;
  ok('P27a-botao', `auth-btn presente=${temBtn}`, temBtn);
  await page.locator('.auth-btn').click();
  await sleep(300);
  let vis = await page.locator('.auth-modal').isVisible();
  let temEmail = (await page.locator('.auth-modal input[type="email"]').count()) === 1;
  let temSenha = (await page.locator('.auth-modal input[type="password"]').count()) === 1;
  ok(
    'P27a-modal',
    `modal=${vis} email=${temEmail} senha=${temSenha}`,
    vis && temEmail && temSenha,
  );
  await page.locator('.auth-switch').click();
  await sleep(250);
  const trocou = (await page.locator('.auth-title').textContent())?.includes('riar conta');
  ok('P27a-troca', `alternou p/ criar conta=${trocou}`, !!trocou);
  await page.locator('.auth-close').click();
  await sleep(250);
  ok('P27a-fecha', `modal fechou=${!(await page.locator('.auth-modal').isVisible())}`, !(await page.locator('.auth-modal').isVisible()));
  // App 100% funcional sem login: cria + busca + remove uma nota
  const funcional = await page.evaluate(() => {
    const w = window.__bumptop.world;
    const id = w.addStickyNote({ x: 20, y: 1.2, z: 12 }, 'P27local');
    const achou = w.listObjects().some((o) => o.meta?.noteText === 'P27local');
    w.removeObject(id);
    return achou;
  });
  ok('P27a-funcional', `app funciona sem login=${funcional}`, funcional);

  // ------------------------------------------------------------------ B
  // Login errado: mensagem de erro GENÉRICA; app não quebra.
  await page.locator('.auth-btn').click();
  await sleep(250);
  await page.locator('.auth-modal input[type="email"]').fill('p27@exemplo.com');
  await page.locator('.auth-modal input[type="password"]').fill('senha-errada-1');
  await page.locator('.auth-submit').first().click();
  await sleep(900);
  const errTxt = (await page.locator('.auth-error').textContent()) ?? '';
  const errVis = await page.locator('.auth-error').isVisible();
  ok('P27b-erro', `erro visível=${errVis} ("${errTxt.trim().slice(0, 40)}")`, errVis && errTxt.length > 3);
  const aindaOk = await page.evaluate(() => window.__bumptop.world.listObjects().length > 0);
  ok('P27b-appvivo', `app vivo após falha=${aindaOk}`, aindaOk);
  await page.locator('.auth-close').click();
  await sleep(200);

  // ------------------------------------------------------------------ C
  // Fluxo real na nuvem (só com /api/* no ar E D1 configurado).
  // Sonda: POST dummy no login — sem D1 bindado → 503 AUTH_UNAVAILABLE;
  // com D1 no ar → 400 AUTH_FAILED (login dummy errado, como esperado).
  // (o /api/session responde 200 SEM sinal de erro quando DB é undefined)
  let apiOk = false;
  try {
    const probe = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'p27-probe@probe.invalid', password: 'p27-probe-pass' }),
    });
    apiOk = probe.status !== 503;
  } catch {
    apiOk = false;
  }
  if (apiOk) {
    const email = `p27-${Date.now()}@probe.local`;
    const senha = 'senha-forte-1';
    // C1: signup pela UI
    await page.locator('.auth-btn').click();
    await sleep(250);
    await page.locator('.auth-switch').click(); // p/ "criar conta"
    await page.locator('.auth-modal input[type="email"]').fill(email);
    await page.locator('.auth-modal input[type="password"]').fill(senha);
    await page.locator('.auth-submit').first().click();
    await sleep(2500);
    const logado = await page.evaluate(() => document.querySelector('.auth-btn')?.classList.contains('logged') ?? false);
    ok('P27c-signup', `conta criada e logada=${logado}`, logado);
    if (!logado) {
      // Signup falhou (ex.: D1 sem schema): fecha o modal p/ não bloquear o resto
      if (await page.locator('.auth-modal').isVisible()) await page.locator('.auth-close').click();
    }
    // C2: cena sobe automaticamente na 1ª vez (toast de upload) — nota nova
    // depois disso vai pelo sync com debounce (~3 s após o flush de 2 s).
    await sleep(5000); // deixa o sync inicial + debounce assentar
    const nota = await page.evaluate(() => {
      const w = window.__bumptop.world;
      return w.addStickyNote({ x: 20, y: 1.2, z: 12 }, 'P27SYNC');
    });
    await sleep(7000); // flush 2 s + debounce 3 s + folga
    const nuvem = await page.evaluate(async () => {
      const r = await fetch('/api/scene');
      if (!r.ok) return null;
      const j = await r.json();
      const objs = j.scene?.objects ?? [];
      return { n: objs.length, tem: objs.some((o) => o.meta?.noteText === 'P27SYNC') };
    });
    ok('P27c-sync', `cena na nuvem: ${nuvem ? `${nuvem.n} objetos, nota sync=${nuvem.tem}` : 'null'}`, !!nuvem && nuvem.tem);
    // C3: logout pela UI; sessão morre (scene → 401)
    await page.locator('.auth-btn').click();
    await sleep(300);
    await page.locator('.auth-logged .auth-submit').click();
    await sleep(1500);
    const saiu = await page.evaluate(async () => {
      const r = await fetch('/api/scene');
      return r.status === 401;
    });
    const botaoLimpo = await page.evaluate(() => !document.querySelector('.auth-btn')?.classList.contains('logged'));
    ok('P27c-logout', `sessão encerrada (scene 401)=${saiu} botão limpo=${botaoLimpo}`, saiu && botaoLimpo);
    // C4: login de novo → cena da nuvem restaurada (a nota volta)
    await page.locator('.auth-btn').click();
    await sleep(250);
    await page.locator('.auth-modal input[type="email"]').fill(email);
    await page.locator('.auth-modal input[type="password"]').fill(senha);
    await page.locator('.auth-submit').first().click();
    const voltou = await page
      .waitForFunction(
        () => window.__bumptop.world.listObjects().some((o) => o.meta?.noteText === 'P27SYNC'),
        null,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    ok('P27c-restore', `cena restaurada após login=${voltou}`, voltou);
    await page.evaluate((id) => window.__bumptop.world.removeObject(id), nota);
  } else {
    console.log('[skip] P27c :: /api/* indisponível (modo degradação — D1 não configurado neste ambiente)');
  }

  // ------------------------------------------------------------------ D
  const errosReais = errosConsole.filter(
    (t) =>
      !t.includes('favicon') &&
      !t.includes('X-Frame') &&
      !t.includes('401') &&
      !t.includes('Unauthorized') &&
      // 400 de console = os POSTs dummy da própria sonda (login fake/UI) —
      // texto varia por versão do Chromium ("400 (Bad Request)" ou só "400 ()")
      !/status of 400/.test(t) &&
      // 503 = D1 ainda não bindado pelo dono (degradação esperada em produção)
      !t.includes('503'),
  );
  if (errosReais.length > 0) {
    console.log('ERROS RESTANTES:');
    errosReais.forEach((e) => console.log(' -', e.slice(0, 300)));
  }
  ok('P27d-console', `erros de console: ${errosReais.length}`, errosReais.length === 0);

  await ctx.close();
} finally {
  await browser.close();
}

const passados = resultados.filter((r) => r.pass).length;
console.log(`\n===== PR27: ${passados}/${resultados.length} =====`);
process.exit(falhas > 0 ? 1 : 0);
