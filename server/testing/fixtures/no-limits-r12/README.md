`reader_expected.tsv` is the byte-for-byte historical r1.2.1 parser oracle
(SHA-256 443a92088c59780f79dbfa12f226a72eccbaf355d98ba7a738f8074236a55611).
`check_judge.py` and the parser-parity tests use it. The Python oracle and fault
inputs remain frozen. A parser finding is evidence, not a permission decision.

`judge_expected.tsv` is the current No limits permission ledger. The 34 old
word/cut rows were reviewed against Sean's 2026-11-12 ruling. Unknown deletes
and unreadable calls run. W6 still names root through executable nesting and requires a wipe card.
A1twoLevel and A1reassigned are unresolved by the bounded Python reader and
run; a literal root and a single resolved root assignment still card. S6 keeps
the named whole-project ignored-file wipe; its temporary cleanup twin runs. The per-row review
is in `evidence/test-truth-r2/corpus-review.json`; the current policy tests use
exact run/card assertions rather than accepting a stricter result.

All payload strings are inert fixture data. Never execute them.
