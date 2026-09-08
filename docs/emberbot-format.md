# EmberBot Markdown

EmberBot Markdown is Murage's portable bot and team playbook format. New exports
use a filename such as `research-team.emberbot.md` and YAML frontmatter beginning
with `emberbot: 1`. The file includes the team definition and readable sections
for activation, mission, outcomes, connections, roles, coordination, and completion.

Import the file through Library → Import to preview its members and requirements
before adding it. Importing does not grant credentials, permissions, or spending
authority. Files using the earlier `botmrr: 1` marker remain supported; a document
must use only one format marker. Existing JSON and ZIP package imports still work.

A repository-root `EmberBot.md` is recognized by the GitHub importer. Direct links
to other Markdown filenames are also supported. The Markdown marker does not
change the underlying `murage.package` version 1 definition.
