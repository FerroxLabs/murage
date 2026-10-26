---
name: repro-pack
description: |
  Turns a bug report, a playtest session or a QA pass into a repro pack: exact steps, environment, expected versus actual, evidence (screenshots, console and network notes), a severity call and a minimal reproduction a developer can run first time.
  Use when the user asks to reproduce a bug, confirm a report, playtest a build or page, run an exploratory QA pass, or write up an issue for developers.
  Do NOT use for writing automated test suites (use e2e-test-architect) or for fixing the code (use debug-production-issue).
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.0.0"
  category: "engineering"
---

# Repro pack

A bug a developer cannot reproduce is a bug that stays. The job is to make it reproduce on demand and hand over everything needed to see it.

## 1. Pin the target

Confirm before testing: the build, URL or app version; the account or test data to use; the device, OS and browser; and what "working" looks like. Use only test accounts and data the owner names. Never use real customer data or real payment details.

## 2. Reproduce

- Follow the report literally first, then vary one thing at a time (browser, account role, data, timing, window size) to find the smallest path that still fails.
- Use the browser or computer tools when they are switched on for you. Take a screenshot at the step before the failure and at the failure.
- Read the browser console and network panel when you can. Note errors, failed requests (method, path, status) and timings. Copy messages exactly.
- Run each path at least twice. Record how often it fails: `3 of 3`, `1 of 5`.
- If it does not reproduce, say so plainly, list what you tried, and name what would most likely change the result.

## 3. Playtest and exploratory passes

When there is no single report, work a charter: one area, one goal, a time box. Walk the main path, then edges: empty and very long input, back and refresh mid-flow, double clicks, slow network, two tabs, a smaller window, keyboard only. Log every finding as its own pack.

## 4. Write the pack

```
Title: <what fails> when <trigger> on <where>
Severity: blocker | major | minor | cosmetic, with one line of why
Frequency: <n of m runs>
Environment: build/version, URL, OS, browser and version, window size, account role
Preconditions: data and settings needed before step 1
Steps:
  1. ...
Expected: ...
Actual: ...
Evidence: screenshots (step and file name), console lines, failed requests
Minimal repro: the shortest steps or the smallest input that still fails
Not affected: paths and environments that were tried and work
Notes: suspected area, recent change it may relate to, open questions
```

Keep one bug per pack. Link duplicates instead of merging them.

## Rules

- Report what you saw. Mark guesses as guesses.
- Filing the issue in a tracker, messaging the team, or changing settings, data or accounts in the product under test is the owner's call. Prepare the issue text and ask first.
- Stop and hand back when a step needs a password, a payment, or a real person's data.

## Output

Return the packs ordered by severity, then a one-paragraph summary: what was tested, what failed, what could not be reproduced, and what to test next.
