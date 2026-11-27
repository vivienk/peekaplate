# Kaggle: a queued/running version cannot be cancelled from the CLI

On 2026-11-23, with the CLI at /tmp/dish-kaggle-cli (kaggle + kagglesdk, Python 3.14): `kaggle kernels` has no `cancel` command. kagglesdk has `KernelsApiService.cancel_kernel_session(kernel_session_id:int)` (`/api/v1/kernels/cancel-session/{id}`), but no public response exposes the session id: `ApiSaveKernelResponse` returns only `kernelId`/`versionNumber`, `ApiKernelMetadata` only `id`/`currentVersionNumber`, and the logs stream is keyed by owner/slug. Only `kernels delete` exists, and it destroys the kernel's history.
Workaround (2026-11-23): the user cancels in the web UI (notebook → Versions/Run → Cancel). Earlier CANCEL_ACKNOWLEDGED versions (benchmark-a/1-2, hero-batch-b/4, trellislast-version/5) were cancelled the same way (handoff 2026-11-22).
Environment improvement to consider: capture the session id at push time if a later SDK exposes it.
