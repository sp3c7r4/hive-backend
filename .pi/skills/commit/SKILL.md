---
name: commit
description: Generate a formatted commit message from current changes
---

Look at staged changes (`git diff --cached`). If nothing staged, look at unstaged (`git diff`).

Generate a commit message in this EXACT format:

```
[CATEGORY]: Short description. First word capitalized

* Detail bullet 1
* Detail bullet 2
```

## Categories

Pick the single most impactful category. If a change spans multiple categories,
mention the secondary categories in the bullet points.

| Category | Use for |
|----------|---------|
| `⚡[FEATURE]` | New functionality, new capabilities |
| `🐛[FIX]` | Bug fixes, incorrect behavior |
| `♻️[REFACTOR]` | Code restructure, no behavior change |
| `📐[SCHEMA]` | Database model changes, migrations, indexes, constraints |
| `🔐[AUTH]` | Authentication, authorization, OAuth, sessions |
| `💰[BILLING]` | Payments, subscriptions, credits, pricing, plan enforcement |
| `🤖[AI]` | Prompt engineering, LLM optimization, token logic, agent behavior |
| `🧪[TEST]` | Adding, updating, or fixing tests |
| `⚙️[INFRA]` | Docker, build scripts, CI/CD, clustering, worker setup |
| `📝[DOCS]` | Documentation, ADRs, CONTEXT.md, comments |
| `🧹[CHORE]` | Cleanup, dead code removal, linting, formatting |
| `🚀[PERF]` | Performance improvements, caching, query optimization |
| `🔒[SECURITY]` | Security fixes, rate limiting, input sanitization |
| `📦[DEPS]` | Dependency updates, lockfile changes |
| `💄[UI]` | Frontend, CSS, templates, email design |
| `🔧[DX]` | Developer experience, tooling, CLI improvements |

## Rules

- Short description: max 60 characters, first word capitalized, no period at end
- 3–6 bullet points, each starting with a capital letter
- Bullets describe **what changed**, not how — keep them scannable
- Schema changes: mention new columns, indexes, or constraints by name
- Multi-category: use the primary category, mention others in bullets or use multiple commits

## Multi-commit workflow

When changes span multiple distinct concerns, offer to split into separate commits.
Stage each group individually and commit one at a time. Recommended split order:

1. `📐[SCHEMA]` — model changes first (so migrations can be reviewed in isolation)
2. `⚡[FEATURE]` — core logic
3. `♻️[REFACTOR]` — wiring / integration changes
4. `📝[DOCS]` — docs and templates last

Ask the user: "Split into multiple commits or squash into one?"

## Examples

**Good:**
```
📐[SCHEMA]: Add isUnlimited flag and unique constraint on subscription

* Add boolean isUnlimited column to plan table, defaulting to false
* Uncomment unique constraint on subscription.businessId
* Seed Enterprise plan with isUnlimited true
```

**Good:**
```
⚡[FEATURE]: Add PlanHandler for centralized billing enforcement

* preflight() gate checks subscription, features, limits, and credits before operations
* deduct() atomically debits credit balance and writes ledger entry after success
* resumeAfterTopup() reactivates subscriptions and unpauses bots after payment
```

**Bad:**
```
⚡[FEATURE]: updated stuff

* changed some things
* fixed bugs
```

## After generating

Show the message and ask: "Commit with this message?" If the user says yes, run `git commit -m "..."`. If the changes aren't staged, stage them first with `git add`.
