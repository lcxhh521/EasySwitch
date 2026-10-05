# Release tooling (private repository only; never published)

The repository stays private. A public release is a cleaned snapshot published as the FIRST COMMIT OF A NEW REPOSITORY; this repository's history is never pushed to a public repository.

```
tools/release/make-public-snapshot.sh <git-ref> <empty-output-dir>
```
Exports the files of the ref (no history), removes the private-only files (PROVENANCE.md, BACKLOG.md, HANDOVER.md, research/, .claude/, tools/release/), strips `<!-- private:start -->…<!-- private:end -->` blocks, then runs `release-check.py` (other projects' names, attribution wording, third-party notices, secrets, personal paths). It publishes nothing. Exit 0 only when nothing is found; `release-allow.json` lists the few deliberate exceptions.
