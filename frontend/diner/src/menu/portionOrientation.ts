// Fullscreen must be requested in the View Portion click, before asset loading.
// Browsers without orientation lock keep normal rotation and use the portal hint.
export function createPortionOrientation() {
  type Lockable = ScreenOrientation & { lock?: (value: 'landscape') => Promise<void> };
  let run:
    | { cancelled: boolean; settled: boolean; fullscreen: boolean; locked: boolean }
    | undefined;
  const orientation = screen.orientation as Lockable | undefined;
  const root = document.documentElement;
  const clean = (current: NonNullable<typeof run>) => {
    if (current.locked) {
      try {
        orientation?.unlock();
      } catch {
        /* Some browsers reject unlock after page hide. */
      }
      current.locked = false;
    }
    if (current.fullscreen && document.fullscreenElement === root) {
      void document.exitFullscreen().catch(() => {});
      current.fullscreen = false;
    }
  };
  return {
    request() {
      if (
        run ||
        !matchMedia('(pointer: coarse)').matches ||
        !orientation?.lock ||
        !root.requestFullscreen ||
        document.fullscreenElement
      )
        return;
      const current = { cancelled: false, settled: false, fullscreen: false, locked: false };
      run = current;
      // Do not defer this call: transient user activation expires during image decoding.
      try {
        void root
          .requestFullscreen()
          .then(async () => {
            current.fullscreen = true;
            if (current.cancelled) return;
            await orientation.lock!('landscape');
            current.locked = true;
          })
          .catch(() => {
            // Unsupported or rejected requests must never prevent camera/2.5D use.
            current.cancelled = true;
          })
          .finally(() => {
            current.settled = true;
            if (current.cancelled) {
              clean(current);
              if (run === current) run = undefined;
            }
          });
      } catch {
        run = undefined;
      }
    },
    release() {
      if (!run) return;
      run.cancelled = true;
      clean(run);
      if (run.settled) run = undefined;
    },
  };
}
