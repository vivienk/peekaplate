import { afterEach, expect, it, vi } from 'vitest';
import { createPortionOrientation } from './portionOrientation';

function setup(lock = vi.fn(async () => {})) {
  const root = {
    requestFullscreen: vi.fn(async () => {
      document.fullscreenElement = root;
    }),
  };
  const document = {
    documentElement: root,
    fullscreenElement: null as unknown,
    exitFullscreen: vi.fn(async () => {
      document.fullscreenElement = null;
    }),
  };
  const unlock = vi.fn();
  vi.stubGlobal('document', document);
  vi.stubGlobal('screen', { orientation: { lock, unlock } });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  return { root, document, lock, unlock };
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(() => vi.unstubAllGlobals());
it('requests fullscreen immediately, locks landscape, and restores on close', async () => {
  const { root, document, lock, unlock } = setup();
  const controller = createPortionOrientation();
  controller.request();
  expect(root.requestFullscreen).toHaveBeenCalledOnce();
  await settle();
  expect(lock).toHaveBeenCalledWith('landscape');
  controller.release();
  expect(unlock).toHaveBeenCalledOnce();
  expect(document.exitFullscreen).toHaveBeenCalledOnce();
});
it('releases a lock which completes after the preview closed', async () => {
  let resolve!: () => void;
  const { unlock } = setup(
    vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    ),
  );
  const controller = createPortionOrientation();
  controller.request();
  await settle();
  controller.release();
  resolve();
  await settle();
  expect(unlock).toHaveBeenCalledOnce();
});
it('cleans up unsupported lock and does not take over existing fullscreen', async () => {
  const { document, root } = setup(
    vi.fn(async () => {
      throw new Error('unsupported');
    }),
  );
  const controller = createPortionOrientation();
  controller.request();
  await settle();
  expect(document.exitFullscreen).toHaveBeenCalledOnce();
  document.fullscreenElement = {};
  controller.request();
  expect(root.requestFullscreen).toHaveBeenCalledOnce();
});
it('does not request fullscreen on desktop or without orientation support', () => {
  const { root } = setup();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  createPortionOrientation().request();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('screen', { orientation: {} });
  createPortionOrientation().request();
  expect(root.requestFullscreen).not.toHaveBeenCalled();
});
