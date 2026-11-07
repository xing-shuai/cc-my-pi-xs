# Sources, attribution and vendored components

cc-my-pi-xs is based on the published **cc-my-pi 1.4.3** package, not a clean-room implementation. The original project is [timvdhoorn/cc-my-pi](https://github.com/timvdhoorn/cc-my-pi/tree/v1.4.3), itself derived from [FammasMaz/pi-cc-tools](https://github.com/FammasMaz/pi-cc-tools). Original notices and changelog history are retained.

| Component | Source / version | Attribution | License |
| --- | --- | --- | --- |
| Base UI, tools, diff, spinner, settings | cc-my-pi 1.4.3; originally pi-cc-tools | Tim van den Hoorn; FammasMaz | MIT, root LICENSE |
| `extensions/pi-tasks/` | [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks), npm `@tintinweb/pi-tasks@0.7.2`, adapted by cc-my-pi | tintinweb | MIT; license retained in that directory |
| `extensions/queue-steer/` | [tmustier/pi-queue-steer](https://github.com/tmustier/pi-queue-steer), upstream cc-my-pi records commit `d395e9b` | Thomas Mustier | MIT |
| `extensions/esc-steer.ts` | standalone pi-esc-steer, bundled by cc-my-pi | Thomas Mustier | MIT |
| `extensions/double-esc-clear.ts` | [`@thisux/pi-double-esc-clear@1.0.3`](https://www.npmjs.com/package/@thisux/pi-double-esc-clear) | Sanju | MIT |
| `extensions/claude-header/` | [Phoobobo/pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui), forked scaffold; cc-my-pi records commit `e5061f0` | Phoobobo; cc-my-pi's layout/mascot/Loaded panel by Tim van den Hoorn | MIT |
| `extensions/statusline/model-info/telemetry.ts` | [OldSuns/pi-open-tui](https://github.com/OldSuns/pi-open-tui), npm 0.4.3 telemetry core | pi-open-tui contributors | MIT, full notice in source |

The xs-specific Devin view, long-user-message folding, ask_user transcript details, footer settings and telemetry integration are local customizations. Tasks retain the behavior inherited from cc-my-pi 1.4.3; this fork does not reinstate the abandoned task-navigation experiment.

`pi-paster`, Shiki, Effect and diff are runtime npm dependencies, not vendored copies. pi-usage and pi-ask are optional external integrations; neither its credentials nor its installation is bundled here. This fork does not copy the pi-ask skill or change when the model chooses to ask questions.

## Additional MIT notices

The following notices are retained for the inherited queue/Esc/header code. Source notices: [queue-steer](https://github.com/tmustier/pi-queue-steer/blob/d395e9b/LICENSE), [header](https://github.com/Phoobobo/pi-claude-code-tui/blob/e5061f0/LICENSE), and [double-esc-clear](https://unpkg.com/@thisux/pi-double-esc-clear@1.0.3/LICENSE).

```text
MIT License

Copyright (c) 2026 Thomas Mustier
Copyright (c) 2026 Phoobobo
Copyright (c) 2026 Sanju

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

See the root [LICENSE](LICENSE) and the additional notices in the individual source files. No Claude Code or Devin product source is included; those names refer only to visual design inspiration.
