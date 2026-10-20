## Thinking Path

> - Paperclip uses a lockfile to reproduce dependency installation.
> - Source manifests on the target branch can require a lockfile refresh.
> - The managed source installer requires a valid frozen installation.
> - This PR reconciles dependency resolution for the target branch.

## Linked Issues or Issue Description

The lockfile must match the target branch's package manifests before a frozen
source installation can succeed.

## What Changed

- Refresh `pnpm-lock.yaml` from the target branch's existing manifests.

## Verification

- The workflow resolved dependencies with scripts disabled and checked that only
  the lockfile changed.
- Review dependency changes and verify a frozen installation before merging.

## Risks

Dependency resolution may select new versions within existing manifest ranges.
Review the lockfile diff before deployment.

## Model Used

Model details are not disclosed under the contributor's no-attribution policy.

## Checklist

- [x] The PR contains only a lockfile update
- [x] Dependency resolution succeeded
- [ ] Frozen installation and required checks pass
- [ ] Dependency changes have been reviewed
