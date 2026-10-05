# Repository instructions

## Commit messages

All commits must follow Conventional Commits:

```text
<type>[optional scope][!]: <description>
```

Use an appropriate type, such as `feat`, `fix`, `docs`, `refactor`, `test`,
`build`, `ci`, `perf`, `style`, `chore`, or `revert`. Keep the description concise
and imperative. Mark breaking changes with `!` or a `BREAKING CHANGE:` footer. Descriptions should not add coding agents as co-authors.

Before pushing, check every commit introduced by the branch for compliance.
PR titles must also follow this format so squash merges produce compliant
commit messages.

## Branch names

Branch names should follow the `<developer-name>/<short-description>`
convention. Use the human developer's established name as the prefix, not the
agent or tool name. For example, use `aidan/add-export-feature` rather than
`codex/add-export-feature`.
