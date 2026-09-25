# Repository instructions

## Commit messages

All commits must follow Conventional Commits:

```text
<type>[optional scope][!]: <description>
```

Use an appropriate type, such as `feat`, `fix`, `docs`, `refactor`, `test`,
`build`, `ci`, `perf`, `style`, `chore`, or `revert`. Keep the description concise
and imperative. Mark breaking changes with `!` or a `BREAKING CHANGE:` footer.

Before pushing, check every commit introduced by the branch for compliance.
PR titles must also follow this format so squash merges produce compliant
commit messages.
