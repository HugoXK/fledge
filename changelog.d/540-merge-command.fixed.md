Written-by: HugoXK

The console merge button now runs through the management contract: a merge whose answer from GitHub is lost leaves an `unknown` receipt instead of a 500, and submitting the same form again reads the pull request back, records the merge once (work item, PR state, audit) and never merges it twice.
