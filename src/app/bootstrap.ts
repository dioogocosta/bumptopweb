/**
 * Bootstrap — entry point do app.
 * Liga o composition root (DI), registra a PWA e cuida do fluxo de atualização.
 */
import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { createApp } from './di';

async function main(): Promise<void> {
  const sceneRoot = document.getElementById('scene-root')!;
  const overlayRoot = document.getElementById('overlay-root')!;

  const app = await createApp(sceneRoot, overlayRoot);

  // Expose p/ debug no console (M0)
  (window as unknown as { __bumptop: unknown }).__bumptop = app;

  // PWA: registra SW com fluxo de atualização controlado (toast, nunca força reload)
  const updateSW = registerSW({
    onNeedRefresh() {
      const toast = document.getElementById('pwa-toast');
      const refresh = document.getElementById('pwa-refresh');
      const dismiss = document.getElementById('pwa-dismiss');
      if (!toast) return;
      toast.hidden = false;
      refresh?.addEventListener('click', () => updateSW(true));
      dismiss?.addEventListener('click', () => (toast.hidden = true), { once: true });
    },
    onOfflineReady() {
      console.info('[PWA] Pronto para uso offline.');
    },
  });

  console.info(
    `%cBumpTop 3D%c — réplica web (v0.1.0)\n` +
      `backend SQLite: ${app.repo.backend()}\n` +
      `objetos: ${app.world.objectCount()}\n` +
      `janela.__bumptop p/ debug`,
    'color:#4f9cff;font-weight:bold',
    'color:inherit',
  );
}

main().catch((err) => {
  console.error('Falha ao iniciar o BumpTop 3D:', err);
  document.body.innerHTML =
    '<pre style="color:#ff6b6b;padding:2rem;font-family:monospace">Erro ao iniciar: ' +
    (err as Error).message +
    '</pre>';
});
