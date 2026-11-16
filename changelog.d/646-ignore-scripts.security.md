The CI lint job installs dependencies with lifecycle scripts disabled, so a compromised package's postinstall cannot execute on the runner, and a test fails if the flag is removed.
