/** Sonda PR19 — autenticação e sincronização na nuvem (Cloudflare D1):
 *
 *  P19a  botão "Entrar" (.auth-btn) está visível na barra de controles (topo)
 *  P19b  clicar em "Entrar" abre o modal de autenticação (.auth-modal)
 *  P19c  alternância entre "Entrar" e "Criar conta" atualiza título e botão de submit
 *  P19d  validação: senha com menos de 8 caracteres impede envio e exibe alerta de erro
 *  P19e  fechar modal (botão ✕ e tecla Escape) remove o modal do DOM
 *  P19f  degradação graciosa: app funciona 100% sem backend D1 e console sem erros
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr19.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr19-evidence';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`[${ok ? 'ok' : 'FALHOU'}] ${id} :: ${detail}`);
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listObjects, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    return w.listObjects().length >= 3 && w.listObjects().every((o) => o.pose.position.y <= 2.2);
  }, { timeout: 20000 });
  await sleep(400);

  // ---------- P19a: botão Entrar visível ----------
  const authBtn = page.locator('.auth-btn');
  const btnVisivel = await authBtn.isVisible();
  const btnTexto = (await authBtn.textContent())?.trim();
  check('P19a', btnVisivel && btnTexto?.includes('Entrar'),
    `botão visível=${btnVisivel} | texto="${btnTexto}"`);
  await page.screenshot({ path: `${OUT}/p19a-botao-entrar.png` });

  // ---------- P19b: clique abre o modal ----------
  await authBtn.click();
  await sleep(300);
  const modalVisivel = await page.locator('.auth-modal').isVisible();
  const tituloInicial = (await page.locator('.auth-title').textContent())?.trim();
  check('P19b', modalVisivel && tituloInicial === 'Entrar no BumpTop',
    `modal visível=${modalVisivel} | título="${tituloInicial}"`);
  await page.screenshot({ path: `${OUT}/p19b-modal-aberto.png` });

  // ---------- P19c: alternar para Criar conta ----------
  const switchBtn = page.locator('.auth-switch');
  await switchBtn.click();
  await sleep(200);
  const tituloSignup = (await page.locator('.auth-title').textContent())?.trim();
  const submitText = (await page.locator('.auth-submit').textContent())?.trim();
  check('P19c', tituloSignup === 'Criar conta no BumpTop' && submitText === 'Criar conta',
    `título após alternar="${tituloSignup}" | botão submit="${submitText}"`);
  await page.screenshot({ path: `${OUT}/p19c-modal-signup.png` });

  // ---------- P19d: validação de senha curta ----------
  await page.locator('.auth-email').fill('teste@bumptop.com');
  await page.locator('.auth-password').fill('123');
  await page.locator('.auth-submit').click();
  await sleep(200);
  const erroVisivel = await page.locator('.auth-error').isVisible();
  const erroTexto = (await page.locator('.auth-error').textContent())?.trim();
  check('P19d', erroVisivel && erroTexto?.includes('8 caracteres'),
    `alerta visível=${erroVisivel} | texto de erro="${erroTexto}"`);
  await page.screenshot({ path: `${OUT}/p19d-validacao-senha.png` });

  // ---------- P19e: fechar modal via ✕ e Escape ----------
  await page.locator('.auth-close').click();
  await sleep(200);
  const modalAposFechar = await page.locator('.auth-modal').count();

  // Reabre e testa fechar com Escape
  await authBtn.click();
  await sleep(200);
  await page.keyboard.press('Escape');
  await sleep(200);
  const modalAposEscape = await page.locator('.auth-modal').count();

  check('P19e', modalAposFechar === 0 && modalAposEscape === 0,
    `modal após fechar no ✕ count=${modalAposFechar} | após Escape count=${modalAposEscape}`);
  await page.screenshot({ path: `${OUT}/p19e-modal-fechado.png` });

  // ---------- P19f: integridade da cena e console ----------
  const objCount = await page.evaluate(() => window.__bumptop.world.listObjects().length);
  const authExp = await page.evaluate(() => typeof window.__bumptop.auth?.signIn === 'function');
  // No preview local estático sem Pages Functions (D1), o fetch /api/auth/me retorna 404 de propósito (degradação graciosa testada)
  const filtrados = erros.filter((e) => !/opfs-sahpool|Access Handles|sqlite|404|api\/auth/i.test(e));
  check('P19f', objCount >= 3 && authExp && filtrados.length === 0,
    `objetos ativos=${objCount} | api auth exposta=${authExp} | erros de console: ${filtrados.length}${filtrados.length ? ' -> ' + filtrados.join(' ; ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR19: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
