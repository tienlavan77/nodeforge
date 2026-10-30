<!-- Preserves an ordered historical design section so repository cleanup retains the complete original technical discussion and supports checksum reconstruction. -->
- Mọi tool call đều có execution context đúng và được audit.
- `write_diff`, `run_test`, `commit_changes`, `report_done` tuân thủ lifecycle.
- Terminal result được persist và Supervisor nhận đúng một outcome cuối.
- Pipeline hiện tại và test regression không bị phá.
- Có feature flag để bật/tắt SDK runner và rollback về pipeline cũ.

