# #1198 — clock-fail banner frames

Dashboard screenshots at 1280x900 and 360x800, en and zh, from a Fledge instance
booted out of the pull request's tip.

- **before**: no GitHub App configured (`clock.state: not-configured`), the
  dashboard as it renders with no clock surface.
- **after**: `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY_PATH` set and
  `GITHUB_API_BASE` pointed at a local fake whose `Date` header is 1688 s behind,
  so `GithubApp.measureSkew()` measures the same offset production reported and
  `/readyz` answers `503` with `clock.state: "fail"`, `skewSeconds: 1688`,
  `thresholdSeconds: 120`. That is the banner the frames show.

Both runs use the same data directory, development login, and mock runner; the
only difference between the before and after runs is the clock verdict.

The banner measured in the after run: 1116x69 at 1280 (x=82, y=414), 328x178 at
360 (x=16, y=545); `document.scrollWidth` never exceeds the viewport, so the
360 frame has no horizontal scroll.
