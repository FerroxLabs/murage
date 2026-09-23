#!/usr/bin/env python3
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Convert NVIDIA SkillSpector's static pattern tables to TypeScript.

Usage: extract_skillspector.py <skillspector-src-root> <commit> <out.ts>
Reads src/skillspector/nodes/analyzers/static_patterns_*.py with the ast
module (no SkillSpector code is imported or run). A `<X>_PATTERNS = [...]`
list of (regex, confidence) tuples, possibly built as `A + B`, becomes one
group; its severity comes from the module's registry tuple
("<X>", "<title>", Severity.<LEVEL>, COMPILED_<X>_PATTERNS) and defaults to
MEDIUM when a group has none.
"""
import ast, json, pathlib, re, sys

CATEGORY = {
    "prompt_injection": "Prompt Injection", "data_exfiltration": "Data Exfiltration",
    "privilege_escalation": "Privilege Escalation", "supply_chain": "Supply Chain",
    "excessive_agency": "Excessive Agency", "output_handling": "Output Handling",
    "system_prompt_leakage": "System Prompt Leakage", "memory_poisoning": "Memory Poisoning",
    "tool_misuse": "Tool Misuse", "rogue_agent": "Rogue Agent", "agent_snooping": "Agent Snooping",
    "anti_refusal": "Anti-Refusal", "ssrf": "Server-Side Request Forgery",
    "deserialization": "Insecure Deserialization", "harmful_content": "Harmful Content",
}

def to_js(src: str) -> str:
    src = src.replace("(?P<", "(?<")
    src = re.sub(r"\(\?P=(\w+)\)", r"\\k<\1>", src)
    src = src.replace(r"\A", "^").replace(r"\Z", "$")
    # SkillSpector matches one line at a time, so a negated class such as
    # [^|] never crosses a line there; over a whole file it would.
    src = re.sub(r"(?<!\\)\[\^(?!\])", r"[^\\n", src)
    return re.sub(r"^\(\?i\)", "", src)

def resolve(node, names, seen=()):
    if isinstance(node, ast.List):
        out = []
        for element in node.elts:
            if (isinstance(element, ast.Tuple) and len(element.elts) == 2
                    and isinstance(element.elts[0], ast.Constant) and isinstance(element.elts[0].value, str)
                    and isinstance(element.elts[1], ast.Constant) and isinstance(element.elts[1].value, (int, float))):
                out.append((element.elts[0].value, float(element.elts[1].value)))
            else:
                return None
        return out
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = resolve(node.left, names, seen), resolve(node.right, names, seen)
        return None if left is None or right is None else left + right
    if isinstance(node, ast.Name) and node.id in names and node.id not in seen:
        return resolve(names[node.id], names, seen + (node.id,))
    return None

def main(root, commit, out):
    files = sorted(pathlib.Path(root, "src/skillspector/nodes/analyzers").glob("static_patterns_*.py"))
    rows = []
    for path in files:
        key = path.stem.removeprefix("static_patterns_")
        category = CATEGORY.get(key)
        if not category:
            continue
        tree = ast.parse(path.read_text())
        names = {t.id: n.value for n in ast.walk(tree) if isinstance(n, ast.Assign) for t in n.targets if isinstance(t, ast.Name)}
        severity = {}
        for n in ast.walk(tree):
            if (isinstance(n, ast.Tuple) and len(n.elts) >= 4 and isinstance(n.elts[0], ast.Constant) and isinstance(n.elts[0].value, str)
                    and isinstance(n.elts[2], ast.Attribute) and isinstance(n.elts[2].value, ast.Name) and n.elts[2].value.id == "Severity"):
                severity[n.elts[0].value] = n.elts[2].attr.lower()
        # Most modules set severity where each finding is made:
        # AnalyzerFinding(rule_id="E2", ..., severity=Severity.HIGH). The most
        # severe level seen for a rule id wins.
        rank = {"low": 0, "medium": 1, "high": 2, "critical": 3}
        for n in ast.walk(tree):
            if not isinstance(n, ast.Call):
                continue
            kw = {k.arg: k.value for k in n.keywords if k.arg}
            rid, sev = kw.get("rule_id"), kw.get("severity")
            if (isinstance(rid, ast.Constant) and isinstance(rid.value, str) and isinstance(sev, ast.Attribute)
                    and isinstance(sev.value, ast.Name) and sev.value.id == "Severity"):
                level = sev.attr.lower()
                if rank.get(level, -1) > rank.get(severity.get(rid.value, ""), -1):
                    severity[rid.value] = level
        used = set()
        for name, value in names.items():
            if not name.endswith("_PATTERNS") or name.startswith("COMPILED_"):
                continue
            group = name.removesuffix("_PATTERNS")
            patterns = resolve(value, names)
            if not patterns:
                continue
            # A composite (E2 = E2_PYTHON + E2_OTHER) repeats its parts: keep
            # each regex once, under the most specific group seen first.
            for index, (regex, confidence) in enumerate(patterns):
                if regex in used:
                    continue
                used.add(regex)
                # SkillSpector keeps separate lists for code and for prose, and
                # SC1_CODE (unpinned dependencies) reads dependency manifests
                # only; running them over the wrong text is noise.
                applies = ("manifest" if group == "SC1_CODE" else "code" if group.endswith("_CODE")
                           else "prose" if group.endswith("_PROSE") else "any")
                rows.append({"id": f"{group}.{index + 1}", "category": category, "applies": applies,
                             "severity": severity.get(group, severity.get(group.split("_")[0], "medium")),
                             "confidence": confidence, "source": to_js(regex)})
    header = (
        "// GENERATED by scripts/skill-guard/extract_skillspector.py. Do not edit.\n"
        "// Patterns from NVIDIA SkillSpector (https://github.com/NVIDIA/SkillSpector),\n"
        "// Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES, Apache-2.0; converted\n"
        "// to JavaScript regex syntax by Ferrox Labs. See NOTICE.\n"
        "import type { SkillSeverity } from \"./types.ts\";\n\n"
        "export interface SpectorPattern { id: string; category: string; applies: \"code\" | \"prose\" | \"manifest\" | \"any\"; severity: SkillSeverity; confidence: number; source: string }\n"
        f"export const SPECTOR_COMMIT = {json.dumps(commit)};\n"
    )
    body = "export const SPECTOR_PATTERNS: SpectorPattern[] = " + json.dumps(rows, indent=1) + ";\n"
    pathlib.Path(out).write_text(header + body)
    print(f"{len(rows)} patterns from {len(files)} files")

if __name__ == "__main__":
    main(*sys.argv[1:4])
