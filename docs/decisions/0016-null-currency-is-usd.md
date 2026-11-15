# 0016 — a NULL `quota_ledger.currency` is the legacy shape of USD, so the label is resolved before grouping

Status: **accepted** (2026-11-14)
Date: 2026-11-14
Supersedes: nothing; it settles the meaning of the NULL that #636 left in place

## Context

`quota_ledger.currency` was added by #636 without a value for rows that already
existed, and `usdBilled()` has read NULL as USD ever since, because that is what
those rows were charged in before the column existed. `Store.costByCurrency()`
did not apply the same reading: it grouped by the raw column and only labelled
NULL as `USD` in JavaScript afterwards, so a NULL row and a `'USD'` row came back
as two buckets carrying one label, and `/admin/metrics` drew one row each. Totals
were right, which is why it survived; every upgraded instance hit it on first
deploy.

## Decision

NULL means USD, and the meaning is applied where the query groups, not after it
(`GROUP BY COALESCE(currency, 'USD')`, selected as the same expression). One
label, one bucket.

The rest of the contract is unchanged: a stored non-USD currency keeps its own
bucket and no rate is invented between buckets; `cost_known = 0` rows stay out of
the buckets and counted as the unknown floor; `semantics` still reports whether
the total is a lower bound.

Any bucket this table can show in future is a value stored in the column. A new
currency is written to `currency` when the row is created — it is never implied
by a NULL, and NULL has exactly one reading. The same rule binds `usdBilled()`:
if the ledger ever grows a second legacy shape, it gets a decision of its own,
not a second meaning for NULL.
