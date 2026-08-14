---
name: btw
description: |
  Structured status update on the current work in this session — done / current /
  remaining / risks, plus a 3-sentence plain-language standup summary. Answered
  inline by the session itself, so the update appears right in the conversation.
  Usage: /btw
user-invocable: true
disable-model-invocation: true
allowed-tools: Read, Bash(git status:*), Bash(git log:*), Bash(git diff --stat:*)
---

# btw — session status update

Report on the CURRENT WORK in this session — what this conversation has
actually been doing, not this skill invocation itself. This is a status
readout, not a work step: do not take any action on the work, do not modify
anything, and after answering, return to whatever you were doing. The
conversation is your primary source; git is corroboration. Careful: other
sessions may share this working directory, so the repo's current branch and
recent commits can belong to a DIFFERENT session's work — never report git
activity this conversation doesn't corroborate.

Produce exactly these five sections:

## 1) Done
What has been completed so far in this piece of work. Bullet points, concrete,
past tense. Include verification state where it matters (tested / deployed /
merely written).

## 2) Current
What the session is working on right now and the specific issue being dealt
with. If the last turn hit a problem, name it plainly and say what the working
theory is.

## 3) Remaining
What is left before this work is finished. Ordered, so the next step is the
first bullet. Call out anything blocked and what it's blocked on.

## 4) Risks
Anything that could change the plan: unverified assumptions, flaky
dependencies, decisions waiting on someone else, deadline pressure.

## 5) Standup
Exactly 3 sentences that sound like a human engineer giving a short verbal
update at a standup attended by both engineers and non-technical people:
plain language, first person, present tense, no jargon, no file paths, no
tool names. Someone from marketing should understand every word, and an
engineer should still find it accurate.
