---
name: shift-coverage-checklist
description: |
  Creates and checks a proposed staff rota against supplied coverage requirements, availability, role qualifications, approved absences and hour limits. Separates hard constraints from preferences, reports unfilled shifts and identifies infeasible requests. Use for multi-person shift planning; use calendar-optimizer for individual appointment planning. Publishing a rota or contacting staff needs the owner's approval.
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.0.0"
  tags: "rota shifts coverage staff"
  category: "operations"
---
# Shift Coverage Checklist

Prepare a staff rota from the owner's actual requirements and records. The result is a proposal with a constraint check, not a published schedule or a statement that employment rules have been independently verified.

## First task

Ask for the planning period and timezone, plus the staffing requirements and availability records. Use supplied information immediately. If a required field is missing, produce the partial coverage picture and ask the one question that changes feasibility.

## Define the constraints

List every shift with its local date, start, end, location, role and required headcount. Represent overnight shifts with an explicit end date. List each worker's identifier, relevant qualifications, availability, approved absences and supplied hour or rest limits.

Separate hard constraints from preferences. Hard constraints include the supplied staffing minimum, required qualification, approved absence, availability, overlapping assignments and applicable limits provided by the owner. Preferences include requested patterns, balanced hours and favored shifts unless the owner marks them mandatory. Do not infer employment rules from a person's location or invent a required qualification.

## Build the proposal

1. Validate the source records. Identify duplicate worker identities, ambiguous timezones, reversed dates, missing role requirements and conflicting availability. Keep each unresolved field visible.
2. Compute each shift's duration from its dates and times. Treat unpaid breaks only as supplied. Use actual elapsed time when a timezone change affects a shift, and mark any missing time information.
3. List eligible workers for each shift before assigning anyone. Record why a worker is ineligible.
4. Allocate the most constrained shifts first. Check each proposed assignment against all existing assignments, cumulative hours, approved absences, qualification and supplied rest limits.
5. Apply preferences only after hard constraints. Explain any preference that the proposal cannot satisfy.
6. Recompute coverage and worker totals from the completed assignments. Keep gaps as gaps; never invent a worker or silently relax a rule to fill the grid.

## When the request is infeasible

Show the smallest concrete conflict you can establish. Name the affected shift, the staffing requirement, the eligible people and the constraints preventing coverage. Offer changes for the owner to consider, such as another qualified worker or a changed requirement. Label them as proposals. Do not alter a hard rule without the owner's decision.

A heuristic proposal is not proof that no better rota exists. If you cannot establish infeasibility, say which gap remains unresolved rather than claiming a mathematical impossibility.

## Approval and recovery

Present the dated rota, unfilled shifts, worker totals and preference trade-offs. Ask for the owner's explicit yes before writing to a connected scheduling tool, publishing the rota, booking an assignment or messaging a worker. An approved absence remains protected unless the owner supplies a revised record.

Keep a revision identifier based on the supplied planning period and revision label. On a later change, preserve unaffected assignments, explain affected totals and recheck all constraints touched by the change. After interruption, inspect the latest approved draft and action receipts before any external update.

## Output and checks

Return a coverage summary, the proposed rota, per-worker totals, unresolved constraints and the decisions needed. Every assignment must trace to a supplied worker and a supplied shift. Check overlaps, qualifications, absences, hours, rest limits and headcount. End with the actual state of publication and messages.
