---
name: website-publisher
description: "Build, publish, update and take down small static websites for non-technical owners using four templates, Netlify Forms and Murage's publish_site tool. Use for quizzes, surveys, lead capture and landing pages."
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.0.0"
  tags: "website netlify publishing static-html"
  category: "web-development"
  subcategory: "web-development"
  depends: ""
  disclaimer: "none"
  difficulty: "beginner"
---

# Website Publisher

Help an owner turn an idea into a small website they can review, share and edit.
Use plain language. Follow Krug: give one clear next step at a time. Follow
Sutherland: explain what is happening and why before each meaningful action.
For example: "I’m making a short preview so you can check the words and layout."
Describe observed progress; keep technical details in the project files.

## Choose and prepare

1. Use any brief already supplied. Otherwise ask: "What is this website for?"
   Next establish its audience and the one thing visitors should do. Ask only
   for missing decisions as they become relevant, one question at a time.
2. Recommend one template and explain its fit:
   - `assets/templates/quiz/`: questions in steps, a result based on score,
     and optional email capture after the result.
   - `assets/templates/survey/`: questions and a separate thank-you page.
   - `assets/templates/lead-capture/`: headline, benefits and a contact form.
   - `assets/templates/landing-page/`: hero, features and a call to action.
3. Resolve these paths relative to this skill's folder. Murage copies the
   skill's `assets/` folder with `SKILL.md` when it installs the skill. When
   the folder is absent, look in the accessible bundled library at
   `skills-library/website-publisher/assets/templates/`, using the library
   location supplied by the runtime. The packaged app includes that library.
   If neither location is accessible, explain that the template files need to
   be made available. Continue the brief, and report copying as pending.
4. Copy the selected folder's contents into the current project’s `site/`,
   including its thank-you page if present. Inspect an existing `site/` first
   and preserve the owner's edits. Edit the marked CONTENT BLOCK near the top
   of each HTML file, then adjust styles as needed. Keep only public website
   files in `site/`; store drafts, private notes, credentials, tokens, `.env`
   files and publishing receipts elsewhere. Never put secrets or private
   notes in `site/`, including comments, filenames and hidden fields.

## Build and review

- Use plain HTML, CSS and JavaScript with no build step or backend. Keep
  fonts, scripts and images local. Use no external dependencies or external
  trackers by default. Add integrations only for an explicit owner request.
- Write truthful, positive placeholder copy. Use ordinary hyphens or full
  stops, plain words and specific next actions. Apply the owner's house copy
  rules to visible text, metadata, comments and instructions. Include only
  claims, contact details and testimonials the owner has supplied or approved.
- All form fields must exist in the static HTML for Netlify to discover them.
  Keep each form's unique `name`, `method="POST"`, `data-netlify="true"`,
  `netlify-honeypot="bot-field"`, hidden `form-name` input and hidden honeypot
  field. The `form-name` value must match the form name. Keep the local action
  destination, `thank-you.html`, in the published folder.
- The quiz shows a result before requesting contact information. Set
  `data-email-capture="true"` only when the owner wants contact requests.
  Adjust question scores and result ranges together, covering every possible
  score. Email capture stores a request; Netlify Forms alone does not send a
  personalized result email or subscribe someone to a mailing list.
- Collect only the information needed for the stated purpose. Agree the
  contact consent wording with the owner. Keep results available to visitors
  who choose to skip contact. Explain where submissions will be stored and
  who will read them; add the owner's privacy information before publishing.
- Check a narrow mobile viewport, zoom, headings, visible labels, useful image
  alt text (empty alt for decorative images), text contrast, visible focus,
  keyboard navigation, validation messages and the thank-you destination.
  Exercise every quiz result range, back, restart and optional capture.
  Check text contrast of at least 4.5:1 and large text of at least 3:1.
- Show the owner a local preview with one next step: "Review the page and tell
  me what you would like changed." Report only checks actually performed.
  A local preview demonstrates the page; form delivery requires Netlify.

## Connect and publish

1. Inspect the available tools and connection state. A skill describes the
   workflow; the runtime supplies `publish_site`. Follow its actual schema
   and connection instructions. Keep publishing pending if the tool is absent.
   Do not invent arguments, credentials, connection actions or tool results.
2. If the owner has no Netlify account, give one link and one next step:
   "Create a Netlify account at https://app.netlify.com/signup so your
   website has a home." Wait for them to say the account is ready. When
   Netlify is not connected, Murage shows a "Connect Netlify" card in the
   chat; tell the owner to press it and wait for them. Existing account
   holders go directly to that card. Keep passwords and tokens in the card,
   outside chat and files, and never ask the owner to type one into chat.
3. Tell the owner to check Netlify's current terms for commercial use. State
   that terms can change; make no promise about commercial eligibility. Offer
   https://www.netlify.com/legal/ when they reach that decision, separately
   from the account creation step. Keep account guidance focused on setup.
4. For forms, guide the owner to enable form detection in the Netlify project's
   Forms area. If the project is created by the first publication, do this
   after creation and publish the same site again so Netlify processes the
   forms. Confirm the intended forms appear in Netlify. See the official
   [form setup](https://docs.netlify.com/manage/forms/setup/) and
   [honeypot guide](https://docs.netlify.com/manage/forms/spam-filters/).
5. Explain that publishing makes everything in `site/` public. After the
   owner has reviewed the page and requested publication, call `publish_site`
   with the project’s `site/` as the publish directory using the exposed schema.
   Publish this folder alone. Preserve any returned site identifier outside
   `site/` so later updates target the same site. Honour permission results.
6. Use the returned deployment status and URL. Report the live link only after
   the tool confirms publication; check that URL when tools allow. For a
   pending or failed deployment, state its actual status and one next step.
   After an interruption or uncertain result, inspect deployment state before
   retrying so another site is not created by accident.
7. With the owner's agreement, submit clearly labelled sample data and confirm
   it appears in Netlify Forms. A thank-you page alone does not prove delivery.
   Report form delivery as unverified until the stored submission is checked.
   Give the owner the live link and one next action, such as opening it on
   their phone. Keep receipts and the site identifier in private project notes.

## Update or take down

For updates, read the existing files and saved site identifier, make the requested
edit in `site/`, preview it and repeat the relevant checks. Use `publish_site`
with the existing site identifier according to its current schema so the owner
keeps their link. Clarify the target if multiple sites could match.

For taking a site down, identify the exact live link and explain the effect.
Act on an explicit request for that site. Inspect the available tool schema:
use a supported unpublish operation only when one is actually offered. If it
is absent, guide the owner through the current Netlify project controls one
step at a time. Explain the distinction between taking a site offline and
deleting its project, deployment history or form submissions; confirm deletion
separately when that is the only offered action. Check the result and report
what was observed. Deleting local `site/` files leaves the hosted site online.
Retain the local source for later edits unless the owner requests its deletion.
