Written-by: HugoXK

A failed release run can now be explained from the repository page. An explicit
maintainer action reads the failed job logs of the run the release recorded
through a read-only GitHub App token that is revoked when the read ends, redacts
the text before it is cut, and shows a bounded excerpt with the exact log lines
it kept and a link to the job page. The analysis never changes the release state,
creates a Release or reruns a workflow, and a repository without an installation
is refused instead of being read with a wider user token.
