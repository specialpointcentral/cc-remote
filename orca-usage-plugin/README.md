# Remote Claude Usage

An Orca status-bar item for the central server configured by cc-remote. It reads private local
usage snapshots written by cc-remote and labels them as remote. On macOS, click the status-bar item
to open a compact popover with progress bars for the five-hour, seven-day and available model-specific
limits, reset countdowns and the latest completed session's token breakdown. The popover is compiled
locally with Swift on first use and cached privately. The popover currently supports macOS.
Clicking the status-bar item runs
`cc-remote usage` to refresh quota (at most once a minute), and the plugin refreshes on its own once
what it shows is 20 minutes old (30 minutes after a failure); quota data older than 30 minutes or
past its reset is marked stale. Bars are green, amber or red by pace, with the thresholds of the
remote Claude status line. When cc-remote's source checkout has a newer build, the status-bar icon
turns into a download arrow and the popover has an Update button, which runs `cc-remote update`.

The plugin's runtime files are bundled into cc-remote. Run `cc-remote setup` to check Orca and
choose whether to install it, or use `cc-remote setup --yes --orca-plugin install` to explicitly
approve an unattended install. Setup describes the trusted worker's access before submitting Orca's
approval. The worker runs as your user and reads the cc-remote host file and usage cache; its
refresh command uses the remote Claude login without copying credentials.
Orca 1.4.248 or newer is required. Normal cc-remote turns refresh the main windows and session tokens;
click the status-bar item or run `cc-remote usage` to refresh the model-specific limits.

Run `orca plugin test . --json` and `orca plugin check . --json` to verify the plugin.
