import review from './fixture-assets/portion-demo/review-images.json';

type Viewer = HTMLElement & { cameraOrbit: string; cameraTarget: string; fieldOfView: string };
type Job = {
  job_id: string;
  status: string;
  attempt_status: string;
  progress?: number;
  dish: { dish_id: string; revision_id: string };
  source: { review_asset_id: string; sha256: string; variant: string };
};
const prefix = '/__local3d';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const storageKey = `portion3d:${review.dish.revision_id}:${review.variants.cutout.sha256}`;

// Imported only for the explicit DEV fixture. No public menu gets generation controls.
export function bindLocal3d(
  stage: HTMLElement,
  controls: HTMLElement,
  status: HTMLElement,
  before3d: () => void,
) {
  const panel = document.createElement('section');
  panel.className = 'pp-local3d';
  const action = document.createElement('button');
  action.type = 'button';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.hidden = true;
  toggle.textContent = 'Show 2.5D';
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  message.textContent = 'Local 3D review. Your 2.5D preview stays available.';
  panel.append(action, toggle, message);
  controls.append(panel);
  let id: string | null = null;
  try {
    id = sessionStorage.getItem(storageKey);
  } catch {
    /* Browser storage may be blocked. */
  }
  if (id && !uuid.test(id)) id = null;
  action.textContent = id ? 'Check 3D job' : 'Generate 3D from cutout';
  let mode: 'check' | 'resume' | 'new' = 'check';
  let disposed = false;
  let viewer: Viewer | undefined;
  let modelReady = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const originalStatus = status.textContent;
  const show2d = () => {
    delete stage.dataset.model3d;
    if (viewer) viewer.hidden = true;
    toggle.textContent = 'Show 3D';
    status.textContent = originalStatus;
  };
  const show3d = () => {
    if (!viewer || !modelReady) return;
    before3d();
    stage.classList.remove('pp-portion--original');
    stage.dataset.model3d = 'true';
    viewer.hidden = false;
    toggle.textContent = 'Show 2.5D';
    status.textContent = 'Drag to rotate the 3D dish';
  };
  const fallback = (text: string) => {
    if (disposed) return;
    clearTimeout(loadTimer);
    show2d();
    viewer?.remove();
    viewer = undefined;
    modelReady = false;
    toggle.hidden = true;
    message.textContent = text;
    action.disabled = false;
    action.textContent = id ? 'Check 3D job' : 'Generate 3D from cutout';
  };
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(prefix + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(response.status === 503 ? 'not_configured' : 'unavailable');
    return response.json();
  };
  const validate = (job: Job) => {
    if (
      job.job_id !== id ||
      job.dish?.dish_id !== review.dish.dish_id ||
      job.dish?.revision_id !== review.dish.revision_id ||
      job.source?.review_asset_id !== review.source_asset_id ||
      job.source?.variant !== 'cutout' ||
      job.source?.sha256 !== review.variants.cutout.sha256
    )
      throw new Error('identity');
  };
  const loadModel = async () => {
    show2d();
    clearTimeout(loadTimer);
    modelReady = false;
    toggle.hidden = true;
    viewer?.remove();
    viewer = document.createElement('model-viewer') as Viewer;
    const current = viewer;
    current.className = 'pp-local3d__viewer';
    current.hidden = true;
    for (const [key, value] of Object.entries({
      src: `${prefix}/v1/model-jobs/${id}/artifacts/model.glb`,
      loading: 'eager',
      'camera-controls': '',
      'touch-action': 'pan-y',
      'interaction-prompt-style': 'basic',
      alt: 'Generated dish 3D model, local review only',
    }))
      current.setAttribute(key, value);
    current.addEventListener(
      'load',
      () => {
        if (disposed || viewer !== current) return;
        clearTimeout(loadTimer);
        modelReady = true;
        toggle.hidden = false;
        action.disabled = false;
        action.textContent = 'Check 3D job';
        message.textContent =
          '3D ready for local review. Check unseen surfaces against the original.';
        show3d();
      },
      { once: true },
    );
    current.addEventListener(
      'error',
      () => {
        if (viewer === current)
          fallback('3D could not load. Your 2.5D preview is still available.');
      },
      { once: true },
    );
    stage.append(current);
    loadTimer = setTimeout(() => fallback('3D loading timed out. Showing 2.5D.'), 30_000);
    const moduleUrl =
      'https://ajax.googleapis.com/ajax/libs/model-viewer/4.4.0/model-viewer.min.js';
    try {
      await import(/* @vite-ignore */ moduleUrl);
    } catch {
      if (viewer === current) fallback('3D viewer unavailable. Showing 2.5D.');
    }
  };
  const handle = async (job: Job, deadline: number): Promise<void> => {
    if (disposed) return;
    validate(job);
    if (job.status === 'ready') {
      message.textContent = 'Loading 3D. Your 2.5D preview stays available.';
      await loadModel();
      return;
    }
    if (['failed', 'cancelled', 'banned', 'expired'].includes(job.status)) {
      fallback('3D generation failed. Your 2.5D preview is unchanged.');
      mode = 'new';
      action.textContent = 'Generate another 3D';
      return;
    }
    if (
      ['submitting', 'submission_unknown'].includes(job.status) &&
      job.attempt_status === 'incomplete'
    ) {
      fallback('The submission needs checking in Tripo before retrying. Showing 2.5D.');
      return;
    }
    if (
      job.attempt_status === 'incomplete' ||
      (job.status === 'prepared' && !['scheduled', 'running'].includes(job.attempt_status)) ||
      (job.status === 'waiting' && job.attempt_status === 'finished')
    ) {
      mode = 'resume';
      action.disabled = false;
      action.textContent = 'Resume 3D job';
      message.textContent = 'Generation paused. Resume this job without starting another.';
      return;
    }
    message.textContent = `Generating 3D${typeof job.progress === 'number' ? ` · ${job.progress}%` : ''}. You can still tilt the 2.5D dish.`;
    if (Date.now() >= deadline) {
      action.disabled = false;
      action.textContent = 'Check 3D job';
      return;
    }
    timer = setTimeout(() => {
      void request(`/v1/model-jobs/${id}`)
        .then((next) => {
          if (!next) throw new Error('unavailable');
          return handle(next, deadline);
        })
        .catch(failed);
    }, 2000);
  };
  const failed = (error: unknown) => {
    if (disposed) return;
    fallback(
      error instanceof Error && error.message === 'not_configured'
        ? '3D generation needs the local Tripo key. Your 2.5D preview is still available.'
        : 'Could not reach or verify the local 3D job. Showing 2.5D; check the existing job before retrying.',
    );
  };
  const generate = async () => {
    action.disabled = true;
    clearTimeout(timer);
    try {
      if (!id || mode === 'new') {
        id = crypto.randomUUID();
        try {
          sessionStorage.setItem(storageKey, id);
        } catch {
          /* Keep the ID in memory. */
        }
      }
      let job =
        mode === 'resume'
          ? await request(`/v1/model-jobs/${id}/resume`, 'POST')
          : await request(`/v1/model-jobs/${id}`);
      mode = 'check';
      if (!job)
        job = await request('/v1/model-jobs', 'POST', {
          job_id: id,
          review_asset_id: review.source_asset_id,
          source: 'cutout',
        });
      if (!job) throw new Error('unavailable');
      await handle(job, Date.now() + 10 * 60_000);
    } catch (error) {
      failed(error);
    }
  };
  action.addEventListener('click', generate);
  toggle.addEventListener('click', () => (stage.dataset.model3d ? show2d() : show3d()));
  return {
    show2d,
    reset: () => {
      if (viewer) {
        viewer.cameraOrbit = '0deg 75deg 105%';
        viewer.cameraTarget = 'auto auto auto';
        viewer.fieldOfView = 'auto';
      }
    },
    dispose: () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      clearTimeout(loadTimer);
      show2d();
      viewer?.remove();
      panel.remove();
      action.removeEventListener('click', generate);
    },
  };
}
