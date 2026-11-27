# Kaggle: two batch GPU sessions maximum

As of 2026-11-22 (docs/CONTEXT.md handoff 2026-11-22): a third GPU push is rejected with "Maximum batch GPU session count of 2 reached", not queued. On 2026-11-22 hero-batch-b/5 sat QUEUED ~2 h for 2xT4 capacity yet still held a slot, so queued sessions count.
Implication: one push per cycle; free slots deliberately ([decision-2026-11-23-free-slot-for-sweep](decision-2026-11-23-free-slot-for-sweep.md)).
