Lane chrome-t15 notes.
- Side observation: hz-test.sh uses plain ssh/rsync without the new ControlMaster=no options; I ran a scratchpad copy with them. Not changed.
- Browser behaviour of the page scripts (overlay, shadow, popup, dialogs) is not exercised here; the smoke test serves and parses everything. Real-browser use is for the chromelive/chromeproof harnesses.
