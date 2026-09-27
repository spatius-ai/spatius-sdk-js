# Releasing @spatius/server-sdk

Publishing a GitHub release runs `publish.yml`. Ordinary pushes, tags and PRs
do not publish. This follows the CLI repository's release policy:

| GitHub release                      | npm version    | npm tag  |
| ----------------------------------- | -------------- | -------- |
| `v1.2.3`, prerelease unchecked      | `1.2.3`        | `latest` |
| `v1.2.3-beta.1`, prerelease checked | `1.2.3-beta.1` | `beta`   |

Any valid SemVer prerelease (including `rc`) goes to `beta`. Tags must be
canonical, with a leading `v` and no build metadata. The tag's commit must be on
`main`. The repository must be public for npm provenance.

The workflow stamps the version into the runner's manifest and lockfile, runs
checks, installs/tests the exact npm tarball, and transfers it to a separate
publish job. That job rechecks eligibility, verifies SHA-512 integrity, and
publishes without rebuilding or running lifecycle scripts. CI never commits
version bumps or creates tags. Only the publish job has `id-token: write`.

## One-time npm setup

Use an npm account with permission to publish under `@spatius` and 2FA enabled.
The package must exist before a trusted publisher can be configured. If it does
not exist, manually publish one checked version from a clean, merged checkout:

```sh
npm ci
# Reserve a bootstrap prerelease without changing Git or creating a tag.
npm version 0.1.0-beta.0 --no-git-tag-version --ignore-scripts
npm run check
RELEASE_DIR=$(mktemp -d)
npm run test:package -- --artifact-dir "$RELEASE_DIR"
npm login --registry=https://registry.npmjs.org
npm publish "$RELEASE_DIR/spatius-server-sdk-0.1.0-beta.0.tgz" --access public --tag beta --provenance=false --ignore-scripts
```

Perform bootstrap in a disposable clone: the version command changes local
files. If the package already exists, skip bootstrap and inspect its versions.
Do not later create a GitHub release for the already-published bootstrap version.

In npm package settings, add a GitHub Actions trusted publisher:

- Organization: `spatius-ai`
- Repository: `spatius-sdk-js`
- Workflow filename: `publish.yml`
- Environment: leave blank
- Allow direct **npm publish**, not just staged publication

Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` secrets. GitHub-hosted Ubuntu and Node
24 supply npm with OIDC support (npm ≥11.5.1). See [npm's trusted publishing
guide](https://docs.npmjs.com/trusted-publishers/) and [prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).

## Routine releases and failures

After merge and green CI, publish a GitHub release targeting the intended `main`
commit, for example `v0.1.0-beta.1` (prerelease) or `v0.1.0` (stable). A tag alone
does not publish. Consumers install `@spatius/server-sdk@beta` or
`@spatius/server-sdk` respectively.

Publish one release at a time, in version order. The shared concurrency group
queues runs without cancelling a running publication, but is not a version-order
guarantee. Only an npm 404 permits publication; duplicate versions and registry
failures stop the workflow. Before retrying, inspect
`npm view @spatius/server-sdk@<version> version dist.integrity --json` and the
Actions result. A network failure is not evidence that publication failed.
If a newer release has shipped, fix forward with a new version rather than
rerunning an older release and moving a dist-tag backward.
