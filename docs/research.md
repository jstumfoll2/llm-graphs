# Research notes

Full write-up: [Agent loops vs graph harnesses](https://claude.ai/artifact/4SVsptnQvuZnBVe2A8mK3B) (private doc).

## Design direction

One OMP plugin, in two parts:

1. **Report** (this release). A change ledger written by a hook, a fixed-shape `report_step` tool, and `/report` to build one page per task.
2. **Step graph** (next). The task's step list lives in a file and is shown as OMP's todo list. The model ticks a step only with evidence. A hook sends the next step when the agent stops with work left. The advisor gets one rework per step.

The lead agent you talk to delegates steps to subagents working in place in the checkout.

## Papers the design draws on

| Paper | Used for |
| --- | --- |
| [SGH: From Agent Loops to Structured Graphs, arXiv:2604.11378](https://arxiv.org/abs/2604.11378) | Fixed step graph, bounded recovery, separate plan and recovery layers |
| [PILOT in the Loop, arXiv:2608.26530](https://arxiv.org/html/2608.26530v1) | Supervisor and workers, learning skills during runs |
| [StateHarness, arXiv:2610.17616](https://arxiv.org/html/2610.17616v1) | State in plain files, briefs rebuilt by rules, stall signals |
| [LongHorizon-Harness, arXiv:2608.01964](https://arxiv.org/abs/2608.01964) | Fresh context per step, independent check after each step |
| [Intelligent AI Delegation, arXiv:2602.11865](https://arxiv.org/pdf/2602.11865.pdf) | Every delegated step ends in something checkable |
| [From Memory to Skills, arXiv:2607.16621](https://arxiv.org/html/2607.16621v1) | Promote lessons to skills only with evidence |
| [Agentic Harness Engineering, arXiv:2604.25850](https://arxiv.org/html/2604.25850v3) | Improve prompts, tools and memory between runs |
| [Self-Harness, arXiv:2606.09498](https://arxiv.org/html/2606.09498v1) | Keep a harness change only if a held-out set does not regress |
| [Empirical Study of Harness Design, arXiv:2609.20804](https://arxiv.org/html/2609.20804v1) | Small models gain most from a plan step and specific tools |
| [Beyond the Model, arXiv:2609.32459](https://arxiv.org/html/2609.32459v1) | Specialist workers help; context compression hurts |
