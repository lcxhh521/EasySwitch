# Release tooling (private repository only; never published)

The repository stays private. A public release is a cleaned snapshot published as the FIRST COMMIT OF A NEW REPOSITORY; this repository's history is never pushed to a public repository.

```
tools/release/make-public-snapshot.sh <git-ref> <empty-output-dir>
```
Exports the files of the ref (no history), keeps the user-facing `docs/` directory, removes the private-only files (PROVENANCE.md, BACKLOG.md, HANDOVER.md, research/, .claude/, tools/release/), strips `<!-- private:start -->…<!-- private:end -->` blocks, then runs `release-check.py` (other projects' names, attribution wording, third-party notices, secrets, personal paths, internal work markers and broken local Markdown links). It publishes nothing. Exit 0 only means no automated findings; it is not legal, credential or publication approval. `release-allow.json` lists the few deliberate attribution exceptions; internal work markers cannot be allowed through it.

The scanner's offline regression suite reads only synthetic temporary trees:

```sh
python3 -B -m unittest discover -s tools/release -p 'test_*.py'
```

Do not use those fixture results to claim the real source tree is public-ready. Existing attribution, icon and credential blockers remain until separately resolved.
