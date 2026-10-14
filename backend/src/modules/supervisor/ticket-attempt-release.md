<!-- Describes retry-ready ticket resource ownership and failure handling for the current development phase. -->
# Ticket attempt release

- A settled Coder attempt releases its agent and file claims on completion or failure.
- Successful completion still requires the verified artifact, complete Coder report and integration gates.
- Failure releases file claims without closing the change journal. Checkpoints, source, commit history and the failed-attempt status history remain available for resume.
- The Control API enables `retryFailedTickets`: a reconciled failed attempt records `failed`, then returns to `pending` with `last_failure` diagnostics. This makes the next explicit RUN available; it does not automatically launch another execution.
- Resume must reclaim source paths and check their recorded checksums. Another ticket's claims or changed source prevent unsafe resume; partially acquired claims are rolled back.
- A settled inline executor records its exact execution/request/job disposition before clearing `launch_claim`. A crashed or explicitly unknown provider outcome remains fenced until its executor is confirmed stopped. Restart alone never proves termination.
- This policy applies to newly observed attempts after the backend loads the change; it does not blindly release historical live or unresolved claims.
