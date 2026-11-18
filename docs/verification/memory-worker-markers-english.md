# Memory search worker markers

Producer and English-copy owner: G2 (`server/data-dir-inventory.ts`).
Consumer owner: the data-folder inventory and backup review.

| English string | When shown |
| --- | --- |
| Memory search worker stop marker; the index is rebuilt after restore review | Inventory entry for `memory-index.db-walstop`. |
| Memory search worker seal marker; the index is rebuilt after restore review | Inventory entry for `memory-index.db-walok`. |
| Memory search worker open attempt marker; the index is rebuilt after restore review | Inventory entry for `memory-index.db-walattempt`. |
