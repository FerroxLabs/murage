---
name: security-questionnaire
description: |
  Fills security and vendor questionnaires (SIG, CAIQ, custom spreadsheets and portals) from an approved answer library, marks every answer with its source, and holds the whole response for the owner's approval before anything is submitted.
  Use when the user asks to answer a security questionnaire, a vendor assessment, a due diligence or compliance form, or to build and maintain a reusable answer library.
  Do NOT use for writing security policies from scratch, running a security audit of systems, or legal contract review.
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.0.0"
  category: "compliance"
---

# Security questionnaire filler

A questionnaire answer is a statement the business may be held to. Every answer comes from an approved source, and nothing leaves until the owner approves it.

## The answer library

Keep a library the owner approves, one entry per reusable answer:

`id | topic | question patterns | approved answer | evidence (policy, report, page) | owner | approved on | review by`

- Build it from documents the owner supplies: security policies, a SOC 2 or ISO report summary, the privacy policy, architecture notes, past approved questionnaires.
- An answer joins the library only after the owner approves it. Record who approved it and when.
- Flag entries past their review date and never reuse them silently.

## Filling a questionnaire

1. **Read the whole form first.** Note the format (spreadsheet columns, portal fields, yes/no plus comment), required attachments and the deadline.
2. **Match** each question to library entries by meaning, not wording. Record the match for every answer.
3. **Mark every answer** with one status:
   - **Library**: taken from an approved entry, cited by id.
   - **Adapted**: an approved entry reworded to fit the question; show the original id and what changed.
   - **Draft**: no approved entry covers it; a proposed answer from the supplied documents, cited.
   - **Needs owner**: no source supports an answer. Leave it blank with the question to ask.
4. **Never guess.** Do not answer "Yes" to a control the sources do not prove. Do not invent certifications, audit dates, encryption details, retention periods or staff counts.
5. **Keep it consistent.** Related questions (encryption, access control, incident response) must not contradict each other or the library.

## Approval hold

Present a review sheet: question, answer, status, source, and the open questions for the owner. Draft and Needs owner rows come first.

Submitting the form, uploading it to a portal, emailing it to the requester, or attaching policy documents is held until the owner explicitly approves the final version. A change after approval needs a fresh approval. When the owner approves new Draft answers, offer to add them to the library as new entries.

## Output

Return the filled questionnaire in its original format, the review sheet, the list of Needs owner questions, and the proposed library additions.
