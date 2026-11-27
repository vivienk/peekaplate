# /tmp is a RAM disk: keep Kaggle outputs out of it

On 2026-11-23 /tmp (tmpfs, 7.6 GB) reached 99% from Kaggle pulls, and a grading subagent's re-download failed with `OSError: [Errno 28] No space left on device`. The chief-of-staff session moved 16 output dirs to `/home/yacine105/kaggle-evals/from-tmp/`, leaving symlinks at the old paths. /tmp dropped to 35%. The schedule prompt now pulls into `/home/yacine105/kaggle-evals/out-<slug>-<version>/`. Note: this host's `find` is bfs, which rejects `-newermt '-10 minutes'`.
