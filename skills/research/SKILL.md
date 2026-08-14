---
name: research
description: |
  Deep architectural research on this session's active topic, run by a Fable
  agent. Produces a structured report: current architecture, options with
  pros/cons, a recommendation, next steps, and risks.
  Usage: /research [optional topic override]
user-invocable: true
disable-model-invocation: true
---

# research — deep dive on the active topic

Launch a deep architectural research pass on the **active topic** of this
session, delegated to a Fable agent. You (the session) do the framing; the
agent does the thinking.

## 1. Frame the brief

Identify the active topic: the system, feature, or problem this conversation
has most recently been substantively working on. If arguments were passed to
this command, they override the inferred topic. Do not ask the user what the
topic is — a button press can't answer; pick the most recent substantive work
and say in one line what you chose.

Compose a research brief containing:
- The topic and the question actually worth answering about it
- Current architecture as you understand it from this session (components,
  data flow, key decisions already made)
- Relevant file paths, services, and constraints discovered in this session
- What has already been tried or ruled out, so the agent doesn't re-litigate it

## 2. Launch the researcher

Launch ONE Agent (`subagent_type: "general-purpose"`, `model: "fable"`) with
the brief. Instruct it to:

- Read the actual code before theorizing — claims about the current
  architecture must be grounded in files it opened
- Research alternatives seriously: for each candidate approach, what real
  systems do, what it costs to migrate, what it costs to keep
- Produce this exact report structure:

  1. **Problem** — one paragraph, what's being decided and why it matters
  2. **Current architecture** — how it works today, with file-level specifics
  3. **Options** — 2 to 4 candidate approaches; for each: how it works,
     **pros**, **cons**, migration cost, and what it forecloses
  4. **Recommendation** — which option and why, stated plainly; include when
     the recommendation would change
  5. **Suggested next steps** — ordered, concrete, first step small
  6. **Risks & unknowns** — what could invalidate this analysis

## 3. Relay

Present the agent's report to the user in full — reformat for readability if
needed, but do not compress the options or soften the recommendation. Add a
short closing note of your own only where session context contradicts or
sharpens the agent's findings.
