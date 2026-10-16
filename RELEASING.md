# Releasing

New versions publish to npm from GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)) when a GitHub release is published. The workflow uses npm trusted publishing (OIDC), so there is no npm token to manage and no 2FA prompt, and every version gets a provenance attestation.

## One-time setup on npmjs.com

Do this once before the first CI release:

1. Sign in to npmjs.com, open https://www.npmjs.com/package/retry-jitter and go to the **Settings** tab.
2. Under **Trusted publishers**, choose **GitHub Actions** and enter:
   - Organization or user: `acus9345`
   - Repository: `retry-jitter`
   - Workflow filename: `release.yml`
   - Environment: leave empty
3. Save.

## Cutting a release

1. Bump the version in `package.json` (this also updates `package-lock.json`):

   ```bash
   npm version 0.2.0 --no-git-tag-version
   ```

2. Add a section for the new version to `CHANGELOG.md`, plus its link at the bottom.
3. Commit and push to `main`:

   ```bash
   git commit -am "Release 0.2.0"
   git push
   ```

4. Tag the commit and push the tag:

   ```bash
   git tag v0.2.0
   git push --tags
   ```

5. Publish the GitHub release. This starts the publish workflow:

   ```bash
   gh release create v0.2.0 --title v0.2.0 --generate-notes
   ```

   You can paste the `CHANGELOG.md` section in as the notes instead, with `--notes` or in the GitHub web UI.

The workflow fails before publishing if the tag does not match the `package.json` version. Watch it with `gh run watch`, then check the provenance badge on https://www.npmjs.com/package/retry-jitter.
